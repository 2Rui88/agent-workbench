/// <reference types="node" />

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeConfig } from "../../../src/config/runtime-config.js";
import { BoardAuthService } from "../../../src/core/board-auth-service.js";
import { ProjectAccessService } from "../../../src/core/project-access-service.js";
import { SessionService } from "../../../src/core/session-service.js";
import { RegistryService } from "../../../src/core/registry-service.js";
import { TaskService } from "../../../src/core/task-service.js";
import { createHttpApp } from "../../../src/server/http-app.js";
import { SqliteDatabase } from "../../../src/storage/database.js";
import type { PlatformStore } from "../../../src/storage/board-auth-store.js";
import type {
  ProgressTransaction
} from "../../../src/storage/progress-store.js";
import type { TaskRecord } from "../../../src/shared/task-contracts.js";
import { DatabaseSync } from "node:sqlite";

const startedAt = "2026-08-17T10:00:00.000Z";

interface Fixture {
  app: ReturnType<typeof createHttpApp>;
  server: Server;
  baseUrl: string;
  databasePath: string;
  client: ReturnType<typeof request.agent>;
  sessionCookie: string;
  store: PlatformStore;
  taskService: TaskService;
  sessionService: SessionService;
  boardAuthService: BoardAuthService;
  pairClient: (owner: string) => Promise<{
    client: ReturnType<typeof request.agent>;
    sessionCookie: string;
  }>;
  close: () => Promise<void>;
}

const fixtures: Fixture[] = [];

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

function seedRepository(store: PlatformStore): void {
  store.transaction((tx: ProgressTransaction) => {
    tx.upsertProject({
      project_id: "project-1",
      name: "Project One",
      created_at: startedAt,
      updated_at: startedAt
    });
    tx.upsertRepository({
      repository_id: "repo-1",
      project_id: "project-1",
      path: "/tmp/project-one",
      label: "Project One",
      created_at: startedAt,
      updated_at: startedAt
    });
    tx.upsertRepository({
      repository_id: "repo-2",
      project_id: "project-1",
      path: "/tmp/project-two",
      label: "Project Two",
      created_at: startedAt,
      updated_at: startedAt
    });
  });
}

function seedSession(
  store: PlatformStore,
  sessionId: string,
  owner = "jande",
  repositoryId = "repo-1"
): void {
  store.transaction((tx) => {
    tx.insertSession({
      session_id: sessionId,
      repository_id: repositoryId,
      label: "Seeded session",
      started_at: startedAt,
      owner
    });
  });
}

function seedTask(
  store: PlatformStore,
  overrides: Partial<TaskRecord> & { task_id: string }
): void {
  const { task_id, ...rest } = overrides;
  store.transaction((tx) => {
    tx.insertTask({
      task_id,
      repository_id: "repo-1",
      title: "Placeholder",
      status: "backlog",
      priority: "P1",
      owner: "jande",
      created_at: startedAt,
      updated_at: startedAt,
      ...rest
    });
  });
}

function bumpVersion(databasePath: string, taskId: string, version: number): void {
  const database = new DatabaseSync(databasePath);
  database.prepare("UPDATE tasks SET version = ? WHERE task_id = ?").run(version, taskId);
  database.close();
}

async function createFixture(options: {
  boardDir?: string;
  owner?: string;
  seed?: (fixture: {
    store: PlatformStore;
    taskService: TaskService;
    sessionService: SessionService;
    boardAuthService: BoardAuthService;
    databasePath: string;
  }) => void;
}): Promise<Fixture> {
  const dataDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-"));
  const config = createRuntimeConfig(dataDir);
  const database = SqliteDatabase.open(config);
  const store = database.createProgressStore();
  seedRepository(store);
  const probe = {
    inspect: async () => ({
      repository_id: "repo-1",
      repository_path: "/tmp/project-one",
      worktree_path: "/tmp/project-one/worktrees/feature",
      branch: "feature",
      head_commit: "a1b2c3",
      captured_at: startedAt,
      changed_files: [] as string[]
    })
  };
  const projectAccess = new ProjectAccessService(store, { now: () => startedAt });
  const taskService = new TaskService({
    store,
    probe,
    projectAccess,
    now: () => startedAt
  });
  const sessionService = new SessionService(store, config);
  const boardAuthService = new BoardAuthService(store, { now: () => startedAt });
  options.seed?.({
    store,
    taskService,
    sessionService,
    boardAuthService,
    databasePath: config.databasePath
  });

  const port = await reservePort();
  const app = createHttpApp({
    taskService,
    sessionService,
    store,
    registryService: new RegistryService(store, () => new Date().toISOString()),
    boardAuthService,
    projectAccess,
    allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
    ...(options.boardDir !== undefined ? { boardDir: options.boardDir } : {}),
    now: () => startedAt
  });
  const server = app.listen(port, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${port}`;
  let pairSequence = 0;
  const pair = async (owner: string): Promise<{
    client: ReturnType<typeof request.agent>;
    sessionCookie: string;
  }> => {
    pairSequence += 1;
    const sessionId = `board-agent-${pairSequence}`;
    seedSession(store, sessionId, owner);
    const client = request.agent(baseUrl);
    const started = await client.post("/api/board-auth/pairings").expect(201);
    boardAuthService.approvePairing(started.body.pairing_code as string, sessionId);
    const completed = await client
      .get(`/api/board-auth/pairings/${started.body.challenge_id as string}`)
      .expect(200);
    const setCookies = completed.headers["set-cookie"] as string[] | undefined;
    const sessionCookie = setCookies
      ?.find((cookie) => cookie.startsWith("board_session="))
      ?.split(";", 1)[0];
    if (sessionCookie === undefined) {
      throw new Error("Pairing response did not set board_session cookie");
    }
    return { client, sessionCookie };
  };
  const paired = await pair(options.owner ?? "jande");
  const fixture: Fixture = {
    app,
    server,
    baseUrl,
    databasePath: config.databasePath,
    client: paired.client,
    sessionCookie: paired.sessionCookie,
    store,
    taskService,
    sessionService,
    boardAuthService,
    pairClient: pair,
    close: async () => {
      // SSE clients keep connections open; drop them so close() completes.
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => (
        error === undefined ? resolve(undefined) : reject(error)
      )));
      database.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
  }
});

describe("board api", () => {
  it("reports health", async () => {
    const fixture = await createFixture({});
    await fixture.client.get("/health").expect(200, { ok: true });
  });


  it("fails closed until an initialized Agent approves a one-time pairing", async () => {
    const fixture = await createFixture({});
    const anonymous = request.agent(fixture.baseUrl);

    await anonymous.get("/api/board-auth/session")
      .expect(200, { authenticated: false });
    await anonymous.get("/api/tasks")
      .expect(401)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: "BOARD_AUTH_REQUIRED" });
      });
    await anonymous.get("/api/overview/projects")
      .expect(401)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: "BOARD_AUTH_REQUIRED" });
      });

    seedSession(fixture.store, "explicit-pair-session", "alice");
    const started = await anonymous.post("/api/board-auth/pairings").expect(201);
    fixture.boardAuthService.approvePairing(
      started.body.pairing_code as string,
      "explicit-pair-session"
    );
    await anonymous
      .get(`/api/board-auth/pairings/${started.body.challenge_id as string}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ status: "paired", owner: "alice" });
      });
    await anonymous.get("/api/board-auth/session")
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ authenticated: true, owner: "alice" });
      });
  });

  it("keeps paired sessions valid and refreshes their persistent cookie", async () => {
    const fixture = await createFixture({});
    const expiredAt = "2026-08-16T10:00:00.000Z";
    const expectedCookieExpiry = "2027-09-21T10:00:00.000Z";
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare("UPDATE board_sessions SET expires_at = ?").run(expiredAt);
    database.close();

    const sessionResponse = await request(fixture.baseUrl)
      .get("/api/board-auth/session")
      .set("Cookie", fixture.sessionCookie)
      .expect(200);
    expect(sessionResponse.body).toMatchObject({
      authenticated: true,
      owner: "jande",
      expires_at: expectedCookieExpiry
    });
    const refreshedCookie = (sessionResponse.headers["set-cookie"] as string[] | undefined)
      ?.find((cookie) => cookie.startsWith("board_session="));
    expect(refreshedCookie).toContain("Max-Age=34560000");

    const protectedResponse = await request(fixture.baseUrl)
      .get("/api/tasks")
      .set("Cookie", fixture.sessionCookie)
      .expect(200);
    expect(protectedResponse.headers["set-cookie"]).toEqual(expect.arrayContaining([
      expect.stringContaining("Max-Age=34560000")
    ]));

    const verificationDatabase = new DatabaseSync(fixture.databasePath, { readOnly: true });
    const row = verificationDatabase.prepare(
      "SELECT expires_at, last_seen_at FROM board_sessions"
    ).get() as { expires_at: string; last_seen_at: string };
    verificationDatabase.close();
    expect(row).toEqual({
      expires_at: expectedCookieExpiry,
      last_seen_at: startedAt
    });
  });

  it("revokes the server session and clears the cookie on logout", async () => {
    const fixture = await createFixture({});

    const logoutResponse = await fixture.client
      .post("/api/board-auth/logout")
      .expect(204);
    const clearedCookie = (logoutResponse.headers["set-cookie"] as string[] | undefined)
      ?.find((cookie) => cookie.startsWith("board_session="));
    expect(clearedCookie).toContain("Max-Age=0");

    await request(fixture.baseUrl)
      .get("/api/board-auth/session")
      .set("Cookie", fixture.sessionCookie)
      .expect(200, { authenticated: false });
  });

  it("keeps pairing challenges short-lived and one-time", async () => {
    const fixture = await createFixture({});
    let now = startedAt;
    const boardAuthService = new BoardAuthService(fixture.store, {
      now: () => now,
      pairingTtlMs: 1_000
    });

    const expiredPairing = boardAuthService.createPairing();
    now = new Date(Date.parse(startedAt) + 2_000).toISOString();
    expect(() => boardAuthService.approvePairing(
      expiredPairing.pairing_code,
      "board-agent-1"
    )).toThrowError("The pairing code is invalid, expired, or already used");

    now = startedAt;
    const oneTimePairing = boardAuthService.createPairing();
    boardAuthService.approvePairing(oneTimePairing.pairing_code, "board-agent-1");
    expect(boardAuthService.completePairing(
      oneTimePairing.challenge_id,
      oneTimePairing.browser_secret
    )).toMatchObject({ status: "paired", owner: "jande" });
    expect(() => boardAuthService.completePairing(
      oneTimePairing.challenge_id,
      oneTimePairing.browser_secret
    )).toThrowError("The Board pairing request is invalid or already used");
  });

  it("lists tasks and returns task detail with goal and acceptance criteria", async () => {
    const fixture = await createFixture({
      seed: ({ store }) => {
        seedTask(store, {
          task_id: "task-1",
          title: "Persist progress",
          status: "in_progress",
          goal: "Ship the storage layer",
          acceptance_criteria: ["All tests pass"]
        });
      }
    });

    const listResponse = await fixture.client.get("/api/tasks").expect(200);
    expect(listResponse.body.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ task_id: "task-1", goal: "Ship the storage layer" })
    ]));

    const detailResponse = await fixture.client.get("/api/tasks/task-1")
      .expect(200);
    expect(detailResponse.body.task).toMatchObject({
      task_id: "task-1",
      acceptance_criteria: ["All tests pass"]
    });
  });

  it("lists projects with repositories and per-repository task counts", async () => {
    const fixture = await createFixture({
      seed: ({ store }) => {
        seedTask(store, { task_id: "task-one", status: "backlog" });
        seedTask(store, { task_id: "task-two", status: "in_progress" });
        seedTask(store, {
          task_id: "task-three",
          repository_id: "repo-2",
          status: "done"
        });
      }
    });

    const response = await fixture.client.get("/api/projects").expect(200);
    expect(response.body.projects).toEqual([
      {
        project_id: "project-1",
        name: "Project One",
        created_by: null,
        archived_at: null,
        archived_by: null,
        repositories: [
          {
            repository_id: "repo-1",
            label: "Project One",
            task_count: 2,
            attention: { pending_acceptance: 0, blocked: 0, stale: 1 }
          },
          {
            repository_id: "repo-2",
            label: "Project Two",
            task_count: 1,
            attention: { pending_acceptance: 0, blocked: 0, stale: 0 }
          }
        ]
      }
    ]);
  });

  it("shares a project for read-only cross-owner task visibility", async () => {
    const fixture = await createFixture({
      seed: ({ store }) => {
        store.transaction((tx) => {
          tx.upsertProject({
            project_id: "project-collab",
            name: "Collaboration",
            created_by: "jande",
            created_at: startedAt,
            updated_at: startedAt
          });
          tx.upsertRepository({
            repository_id: "repo-collab",
            project_id: "project-collab",
            path: "/tmp/project-collab",
            label: "Collaboration",
            created_at: startedAt,
            updated_at: startedAt
          });
          tx.insertTask({
            task_id: "task-collab-creator",
            repository_id: "repo-collab",
            title: "Creator task",
            status: "backlog",
            priority: "P1",
            owner: "jande",
            created_at: startedAt,
            updated_at: startedAt
          });
          tx.insertTask({
            task_id: "task-collab-member",
            repository_id: "repo-collab",
            title: "Member task",
            status: "backlog",
            priority: "P1",
            owner: "member",
            created_at: startedAt,
            updated_at: startedAt
          });
        });
      }
    });
    const shareResponse = await fixture.client
        .post("/api/projects/project-collab/shares")
        .send({ operation_id: "share-project-collab" })
        .expect(201);
    const token = shareResponse.body.share.token as string;
    const member = await fixture.pairClient("member");
    await member.client
        .post(`/api/project-invitations/${token}/accept`)
        .send({ operation_id: "accept-project-collab" })
        .expect(200);
      const members = await member.client
        .get("/api/projects/project-collab/members")
        .expect(200);
      expect(members.body.creator).toBe("jande");
      expect(members.body.members).toEqual([
        expect.objectContaining({ owner: "member", role: "member" })
      ]);
      const projects = await member.client.get("/api/projects").expect(200);
      expect(projects.body.projects).toEqual(expect.arrayContaining([
        expect.objectContaining({
          project_id: "project-collab",
          created_by: "jande",
          repositories: [expect.objectContaining({ repository_id: "repo-collab", task_count: 2 })]
        })
      ]));
      const visible = await member.client
        .get("/api/tasks")
        .query({ repository_id: "repo-collab", scope: "project" })
        .expect(200);
      expect(visible.body.tasks.map((task: TaskRecord) => task.task_id)).toEqual(
        expect.arrayContaining(["task-collab-member", "task-collab-creator"])
      );
      await member.client
        .patch("/api/tasks/task-collab-creator")
        .send({ operation_id: "member-edit-creator", expected_version: 0, title: "Nope" })
        .expect(403);
      await member.client
        .patch("/api/tasks/task-collab-member")
        .send({ operation_id: "member-edit-own", expected_version: 0, title: "Updated by member" })
        .expect(200);
      await fixture.client
        .delete("/api/projects/project-collab/members/member")
        .send({ operation_id: "remove-project-member" })
        .expect(200);
      await member.client
        .get("/api/tasks")
        .query({ repository_id: "repo-collab", scope: "project" })
        .expect(403);
  });

  it("streams shared project task changes to members without leaking them to outsiders", async () => {
    const fixture = await createFixture({
      seed: ({ store }) => {
        store.transaction((tx) => {
          tx.upsertProject({
            project_id: "project-collab-sse",
            name: "Collaboration SSE",
            created_by: "jande",
            created_at: startedAt,
            updated_at: startedAt
          });
          tx.upsertRepository({
            repository_id: "repo-collab-sse",
            project_id: "project-collab-sse",
            path: "/tmp/project-collab-sse",
            label: "Collaboration SSE",
            created_at: startedAt,
            updated_at: startedAt
          });
          tx.insertTask({
            task_id: "task-collab-sse-creator",
            repository_id: "repo-collab-sse",
            title: "Creator task",
            status: "backlog",
            priority: "P1",
            owner: "jande",
            created_at: startedAt,
            updated_at: startedAt
          });
        });
      }
    });
    const share = await fixture.client
      .post("/api/projects/project-collab-sse/shares")
      .send({ operation_id: "share-project-collab-sse" })
      .expect(201);
    const member = await fixture.pairClient("member");
    await member.client
      .post(`/api/project-invitations/${share.body.share.token as string}/accept`)
      .send({ operation_id: "accept-project-collab-sse" })
      .expect(200);
    const outsider = await fixture.pairClient("outsider");
    const events = await import("node:http");

    function openStream(cookie: string): {
      received: string[];
      request: import("node:http").ClientRequest;
      taskEvent: Promise<void>;
    } {
      const received: string[] = [];
      let resolveTaskEvent: () => void = () => undefined;
      const taskEvent = new Promise<void>((resolve) => {
        resolveTaskEvent = resolve;
      });
      const request = events.get(
        new URL("/events", fixture.baseUrl),
        { headers: { cookie } },
        (response) => {
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            received.push(chunk);
            if (chunk.includes("task-collab-sse-creator")) {
              resolveTaskEvent();
            }
          });
        }
      );
      request.on("error", () => undefined);
      return { received, request, taskEvent };
    }

    const memberStream = openStream(member.sessionCookie);
    const outsiderStream = openStream(outsider.sessionCookie);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fixture.client
      .patch("/api/tasks/task-collab-sse-creator")
      .send({
        operation_id: "update-project-collab-sse",
        expected_version: 0,
        title: "Creator task updated"
      })
      .expect(200);
    await Promise.race([
      memberStream.taskEvent,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for member SSE")), 2_000))
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    memberStream.request.destroy();
    outsiderStream.request.destroy();
    expect(memberStream.received.join("")).toContain("task-collab-sse-creator");
    expect(outsiderStream.received.join("")).not.toContain("task-collab-sse-creator");
  });

  it("returns dependencies, events and snapshots in the task detail", async () => {
    const fixture = await createFixture({
      seed: ({ store }) => {
        seedTask(store, { task_id: "task-dep-target", title: "被依赖任务", status: "backlog" });
        seedTask(store, { task_id: "task-main", title: "主任务", status: "in_progress" });
        store.transaction((tx) => {
          tx.insertTaskDependency({
            task_id: "task-main",
            depends_on_task_id: "task-dep-target",
            created_at: startedAt
          });
          tx.appendTaskEvent({
            event_id: "event-1",
            task_id: "task-main",
            event_type: "task_started",
            payload: { actor: "agent" },
            created_at: startedAt
          });
          tx.insertRepoSnapshot({
            snapshot_id: "snap-1",
            task_id: "task-main",
            repository_id: "repo-1",
            repository_path: "/tmp/project-one",
            head_commit: "abc123",
            captured_at: startedAt
          });
        });
      }
    });

    const response = await fixture.client.get("/api/tasks/task-main").expect(200);
    expect(response.body.dependencies).toEqual([
      {
        task_id: "task-main",
        depends_on_task_id: "task-dep-target",
        title: "被依赖任务",
        status: "backlog",
        repository_id: "repo-1",
        created_at: startedAt,
        policy: "acceptance_gate",
        ctx_id: "repo-1:task-dep-target:repo-1:task-main:1",
        generation: 1
      }
    ]);
    expect(response.body.events).toEqual([
      {
        event_id: "event-1",
        event_type: "task_started",
        payload: { actor: "agent" },
        created_at: startedAt
      }
    ]);
    expect(response.body.snapshots).toEqual([
      {
        snapshot_id: "snap-1",
        head_commit: "abc123",
        captured_at: startedAt
      }
    ]);
    expect(response.body.recovery).toMatchObject({
      task: { task_id: "task-main" },
      evidence_state: "missing",
      next_action: expect.any(String)
    });
    expect(response.body.dependency_repairs).toEqual([]);

    const context = await fixture.client
      .get("/api/dependency-contexts/repo-1:task-dep-target:repo-1:task-main:1")
      .expect(200);
    expect(context.body.context).toMatchObject({
      ctx_id: "repo-1:task-dep-target:repo-1:task-main:1",
      upstream_task_id: "task-dep-target",
      downstream_task_id: "task-main",
      policy: "acceptance_gate",
      generation: 1,
      status: "active"
    });
    expect(context.body.events).toEqual([
      expect.objectContaining({
        sequence: 1,
        event_type: "dependency_bound",
        payload: expect.objectContaining({ generation: 1 })
      })
    ]);
  });

  it("lets an authenticated viewer select a read-only target owner", async () => {
    const fixture = await createFixture({
      owner: "zhangsan",
      seed: ({ store }) => {
        seedTask(store, {
          task_id: "task-zhangsan",
          title: "张三的任务",
          status: "backlog"
        });
        store.transaction((tx) => {
          const existing = tx.getTask("task-zhangsan");
          if (existing) {
            tx.updateTask({ ...existing, owner: "zhangsan" }, 0);
          }
        });
        seedTask(store, {
          task_id: "task-lisi",
          title: "李四的任务",
          status: "backlog"
        });
        store.transaction((tx) => {
          const existing = tx.getTask("task-lisi");
          if (existing) {
            tx.updateTask({ ...existing, owner: "lisi" }, 0);
          }
        });
        seedTask(store, { task_id: "task-unassigned", status: "backlog" });
      }
    });

    const lisi = await fixture.client
      .get("/api/tasks?owner=lisi")
      .expect(200);
    expect(lisi.body.tasks).toHaveLength(1);
    expect(lisi.body.tasks[0]).toMatchObject({ owner: "lisi" });

    const personalPeople = await fixture.client.get("/api/people").expect(200);
    expect(personalPeople.body.people).toEqual([
      expect.objectContaining({
        owner: "zhangsan",
        task_count: 1,
        task_counts: { "repo-1": 1 }
      })
    ]);
    const targetPeople = await fixture.client.get("/api/people?owner=lisi").expect(200);
    expect(targetPeople.body.people).toEqual([
      expect.objectContaining({
        owner: "lisi",
        task_count: 1,
        task_counts: { "repo-1": 1 }
      })
    ]);
  });

  it("keeps personal endpoints owner-scoped while global overview lists every owner", async () => {
    const fixture = await createFixture({
      owner: "jande",
      seed: ({ store }) => {
        seedTask(store, {
          task_id: "task-jande",
          repository_id: "repo-1",
          owner: "jande",
          status: "blocked"
        });
        seedTask(store, {
          task_id: "task-lisi",
          repository_id: "repo-2",
          owner: "lisi",
          status: "pending_acceptance"
        });
      }
    });

    const personalProjects = await fixture.client.get("/api/projects").expect(200);
    expect(personalProjects.body.projects).toEqual([
      expect.objectContaining({
        repositories: expect.arrayContaining([
          expect.objectContaining({
            repository_id: "repo-1",
            task_count: 1,
            attention: { pending_acceptance: 0, blocked: 1, stale: 0 }
          }),
          expect.objectContaining({ repository_id: "repo-2", task_count: 0 })
        ])
      })
    ]);
    const personalPeople = await fixture.client.get("/api/people").expect(200);
    expect(personalPeople.body.people).toEqual([
      expect.objectContaining({ owner: "jande", task_count: 1 })
    ]);

    const overviewProjects = await fixture.client
      .get("/api/overview/projects")
      .expect(200);
    expect(overviewProjects.body.projects[0].repositories).toEqual([
      expect.objectContaining({
        repository_id: "repo-1",
        task_count: 1,
        attention: { pending_acceptance: 0, blocked: 1, stale: 0 }
      }),
      expect.objectContaining({
        repository_id: "repo-2",
        task_count: 1,
        attention: { pending_acceptance: 1, blocked: 0, stale: 0 }
      })
    ]);
    const overviewPeople = await fixture.client.get("/api/overview/people").expect(200);
    expect(overviewPeople.body.people).toEqual(expect.arrayContaining([
      expect.objectContaining({ owner: "jande", task_count: 1 }),
      expect.objectContaining({ owner: "lisi", task_count: 1 })
    ]));

    const crossOwnerDetail = await fixture.client.get("/api/tasks/task-lisi").expect(200);
    expect(crossOwnerDetail.body.task).toMatchObject({ owner: "lisi" });
    await fixture.client.post("/api/tasks/task-lisi/accept")
      .send({ operation_id: "op-cross-owner-accept", expected_version: 0 })
      .expect(403);
  });

  it("registers a repository with a new project from the board", async () => {
    const fixture = await createFixture({});

    const created = await fixture.client
      .post("/api/repositories")
      .send({
        project_id: "project-new",
        project_name: "新项目",
        repository_id: "repo-new",
        repository_name: "新仓库",
        path: "/Users/someone/code/repo-new"
      })
      .expect(201);
    expect(created.body.repository).toMatchObject({
      repository_id: "repo-new",
      project_id: "project-new",
      path: "/Users/someone/code/repo-new"
    });
    expect(created.body.project).toMatchObject({
      project_id: "project-new",
      name: "新项目",
      created_by: "jande"
    });

    const beforeContext = await fixture.client.get("/api/repositories").expect(200);
    expect(beforeContext.body.repositories).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ repository_id: "repo-new" })
    ]));

    seedSession(fixture.store, "new-repo-session", "jande", "repo-new");
    const repositories = await fixture.client.get("/api/repositories").expect(200);
    expect(repositories.body.repositories).toEqual(expect.arrayContaining([
      expect.objectContaining({ repository_id: "repo-new" })
    ]));
    const projects = await fixture.client.get("/api/projects").expect(200);
    expect(projects.body.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        project_id: "project-new",
        name: "新项目",
        created_by: "jande"
      })
    ]));

    const creatorProjects = await fixture.client
      .get("/api/projects?owner=jande")
      .expect(200);
    expect(creatorProjects.body.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ project_id: "project-new", created_by: "jande" })
    ]));

    await fixture.client
      .post("/api/repositories")
      .send({
        project_id: "project-new",
        project_name: "新项目",
        repository_id: "repo-new",
        repository_name: "重复登记",
        path: "/Users/someone/code/other"
      })
      .expect(409);

    await fixture.client
      .post("/api/repositories")
      .send({ project_id: "x" })
      .expect(400);
  });

  it("keeps a target owner's session-bound project visible with zero tasks", async () => {
    const fixture = await createFixture({
      seed: ({ store }) => {
        seedSession(store, "session-yorn-empty-repo", "yorn", "repo-2");
      }
    });

    const projects = await fixture.client.get("/api/projects?owner=yorn").expect(200);
    expect(projects.body.projects).toEqual([
      expect.objectContaining({
        repositories: expect.arrayContaining([
          expect.objectContaining({ repository_id: "repo-1", task_count: 0 }),
          expect.objectContaining({ repository_id: "repo-2", task_count: 0 })
        ])
      })
    ]);
    await fixture.client.get("/api/tasks?owner=yorn").expect(200, { tasks: [] });
  });

  it("includes sibling zero-task repositories in an owner-visible project", async () => {
    const fixture = await createFixture({});

    const projects = await fixture.client.get("/api/projects").expect(200);
    expect(projects.body.projects).toEqual([
      expect.objectContaining({
        project_id: "project-1",
        repositories: expect.arrayContaining([
          expect.objectContaining({ repository_id: "repo-1" }),
          expect.objectContaining({ repository_id: "repo-2", task_count: 0 })
        ])
      })
    ]);
  });

  it("supports auditable dependency validation history as read-only data", async () => {
    const fixture = await createFixture({
      owner: "owner-alpha",
      seed: ({ store }) => {
        seedTask(store, { task_id: "task-upstream", title: "上游任务", status: "pending_acceptance" });
        seedTask(store, {
          task_id: "task-downstream",
          repository_id: "repo-2",
          title: "下游任务",
          owner: "owner-alpha"
        });
        store.transaction((tx) => {
          tx.insertSession({
            session_id: "session-agent",
            repository_id: "repo-2",
            label: "Validation agent",
            started_at: startedAt,
            owner: "owner-alpha"
          });
          tx.insertTaskDependency({ task_id: "task-downstream", depends_on_task_id: "task-upstream", created_at: startedAt });
          tx.insertDependencyValidation({
            validation_id: "validation-read-only",
            upstream_task_id: "task-upstream",
            downstream_task_id: "task-downstream",
            cycle: 1,
            status: "pending",
            requested_by_actor: "agent",
            requested_by_owner: "owner-alpha",
            requested_at: startedAt,
            request_read_at: null,
            responded_by_owner: null,
            response_reason: null,
            responded_at: null,
            response_read_at: null,
            validation_spec: {
              schema_version: "dependency-validation.v1",
              upstream_task_id: "task-upstream",
              upstream_task_version: 0,
              upstream_repository_id: "repo-1",
              downstream_task_id: "task-downstream",
              downstream_repository_id: "repo-2",
              cycle: 1,
              target_revision: "board-head-1",
              target_head_commit: "board-head-1",
              scope: {
                worktree_path: "/tmp/validation",
                changed_files: ["src/validation.ts"],
                module_paths: ["src"]
              },
              command: "npm test",
              commands: ["npm test"],
              timeout_strategy: {
                kind: "rolling_lease",
                lease_ttl_ms: 1_800_000,
                max_attempts: 2
              }
            }
          });
          tx.insertDependencyValidationRun({
            run_id: "run-read-only",
            validation_id: "validation-read-only",
            attempt: 1,
            status: "running",
            owner: "owner-alpha",
            session_id: "session-agent",
            worktree_path: "/tmp/validation",
            heartbeat_at: startedAt,
            expires_at: startedAt,
            started_at: startedAt,
            completed_at: null,
            verification: [{
              command: "npm test -- validation",
              outcome: "failed",
              summary: "validation is still running",
              revision: "board-agent-revision",
              target_revision: "board-head-1",
              worktree_path: "/tmp/validation"
            }],
            progress: { step: "contract" },
            failure_reason: null,
            error_reason: null,
            operation_id: "op-agent",
            created_at: startedAt,
            updated_at: startedAt
          });
        });
      }
    });

    const history = await fixture.client
      .get("/api/dependency-validation-activities?repository_id=repo-2")
      .expect(200);
    expect(history.body.activities[0]).toMatchObject({
      validation_id: "validation-read-only",
      status: "pending",
      perspective: "request",
      latest_run: expect.objectContaining({ run_id: "run-read-only", attempt: 1, status: "running" })
    });
  });

  it("keeps dependency validation Board endpoints read-only", async () => {
    const fixture = await createFixture({
      owner: "owner-alpha",
      seed: ({ store }) => {
        seedTask(store, {
          task_id: "task-board-upstream",
          title: "Board 上游",
          status: "pending_acceptance",
          owner: "owner-alpha"
        });
        seedTask(store, {
          task_id: "task-board-downstream",
          repository_id: "repo-2",
          title: "Board 下游",
          owner: "owner-alpha"
        });
        store.transaction((tx) => {
          tx.insertTaskDependency({
            task_id: "task-board-downstream",
            depends_on_task_id: "task-board-upstream",
            created_at: startedAt
          });
          tx.insertDependencyValidation({
            validation_id: "validation-board-read-only",
            upstream_task_id: "task-board-upstream",
            downstream_task_id: "task-board-downstream",
            cycle: 1,
            status: "pending",
            requested_by_actor: "agent",
            requested_by_owner: "owner-alpha",
            requested_at: startedAt,
            request_read_at: null,
            responded_by_owner: null,
            response_reason: null,
            responded_at: null,
            response_read_at: null,
            validation_spec: {
              schema_version: "dependency-validation.v1",
              upstream_task_id: "task-board-upstream",
              upstream_task_version: 0,
              upstream_repository_id: "repo-1",
              downstream_task_id: "task-board-downstream",
              downstream_repository_id: "repo-2",
              cycle: 1,
              target_revision: "board-head-1",
              target_head_commit: "board-head-1",
              scope: {
                worktree_path: "/tmp/validation",
                changed_files: ["src/validation.ts"],
                module_paths: ["src"]
              },
              command: "npm test",
              commands: ["npm test"],
              timeout_strategy: {
                kind: "rolling_lease",
                lease_ttl_ms: 1_800_000,
                max_attempts: 2
              }
            }
          });
        });
      }
    });

    await fixture.client
      .post("/api/dependency-validations/validation-board-read-only/respond")
      .send({ operation_id: "board-write", status: "passed" })
      .expect(404);
    await fixture.client
      .post("/api/tasks/task-board-upstream/request-dependency-validation")
      .send({ operation_id: "board-request-write", expected_version: 0 })
      .expect(404);

    const history = await fixture.client
      .get("/api/dependency-validation-activities?repository_id=repo-2")
      .expect(200);
    expect(history.body.activities[0]).toMatchObject({
      validation_id: "validation-board-read-only",
      status: "pending",
      response_reason: null,
      responded_at: null
    });
    await fixture.client
      .get("/api/tasks/task-board-upstream")
      .expect(200)
      .expect(({ body }) => {
        expect(body.task.version).toBe(0);
        expect(body.task.status).toBe("pending_acceptance");
        expect(body.dependency_validations[0].status).toBe("pending");
      });

    await fixture.client
      .post("/api/tasks/task-board-upstream/accept")
      .send({ operation_id: "board-accept-blocked", expected_version: 0 })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe("DEPENDENCY_VALIDATION_REQUIRED"));
  });

  it("ignores x-owner and authorizes the server-issued Board owner", async () => {
    const fixture = await createFixture({
      owner: "jang",
      seed: ({ store }) => {
        seedTask(store, {
          task_id: "task-jang",
          title: "jang 的任务",
          status: "pending_acceptance"
        });
        store.transaction((tx) => {
          const existing = tx.getTask("task-jang");
          if (existing) tx.updateTask({ ...existing, owner: "jang" }, 0);
        });
      }
    });

    // The authenticated owner is jang even though the spoofed header says jande.
    await fixture.client.post("/api/tasks/task-jang/accept")
      .set("x-owner", "jande")
      .send({ operation_id: "op-jang-accept", expected_version: 1 })
      .expect(200);

    // Reset to pending_acceptance for the next assertion
    // (skip — one positive and one negative is enough)
  });

  it("rejects cross-owner mutation with or without a spoofed x-owner header", async () => {
    const fixture = await createFixture({
      seed: ({ store }) => {
        seedTask(store, {
          task_id: "task-jang-2",
          title: "jang 的另一个任务",
          status: "pending_acceptance"
        });
        store.transaction((tx) => {
          const existing = tx.getTask("task-jang-2");
          if (existing) tx.updateTask({ ...existing, owner: "jang" }, 0);
        });
      }
    });

    // The browser cannot become jang by sending X-Owner.
    const response = await fixture.client.post("/api/tasks/task-jang-2/accept")
      .set("x-owner", "jang")
      .send({ operation_id: "op-cross-owner", expected_version: 1 })
      .expect(403);
    expect(response.body).toMatchObject({ code: "OWNER_MISMATCH" });

    // Missing X-Owner is no longer an admin bypass.
    await fixture.client.post("/api/tasks/task-jang-2/accept")
      .send({ operation_id: "op-admin-accept", expected_version: 1 })
      .expect(403);
  });

  it("does not expose the removed compatibility mode endpoint", async () => {
    const fixture = await createFixture({});
    await fixture.client.get("/api/mode").expect(404);
  });

  it("no longer offers a web task-creation endpoint", async () => {
    const fixture = await createFixture({});
    await fixture.client.post("/api/tasks").send({}).expect(404);
  });

  it("lists registered repositories for the board switcher", async () => {
    const fixture = await createFixture({
      seed: ({ store }) => {
        seedTask(store, {
          task_id: "repo-two-task",
          repository_id: "repo-2",
          status: "backlog"
        });
      }
    });
    const response = await fixture.client.get("/api/repositories").expect(200);
    expect(response.body.repositories).toEqual([
      expect.objectContaining({ repository_id: "repo-1", label: "Project One" }),
      expect.objectContaining({ repository_id: "repo-2", label: "Project Two" })
    ]);
  });

  it("filters the task list by repository_id", async () => {
    const fixture = await createFixture({
      seed: ({ store }) => {
        seedTask(store, {
          task_id: "task-one",
          title: "Repo one task",
          status: "backlog"
        });
        seedTask(store, {
          task_id: "task-two",
          repository_id: "repo-2",
          title: "Repo two task",
          status: "backlog"
        });
      }
    });

    const filtered = await fixture.client
      .get("/api/tasks?repository_id=repo-1")
      .expect(200);
    expect(filtered.body.tasks.map((task: { task_id: string }) => task.task_id))
      .toEqual(["task-one"]);

    const other = await fixture.client
      .get("/api/tasks?repository_id=repo-2")
      .expect(200);
    expect(other.body.tasks.map((task: { task_id: string }) => task.task_id))
      .toEqual(["task-two"]);

    await fixture.client.get("/api/tasks?repository_id=").expect(400);
  });

  it("patches task metadata with optimistic version and rejects stale writes", async () => {
    const fixture = await createFixture({
      seed: ({ store }) => {
        seedTask(store, { task_id: "task-1", title: "Old title", status: "backlog" });
      }
    });

    await fixture.client.patch("/api/tasks/task-1").send({
      operation_id: "op-patch-1",
      expected_version: 0,
      priority: "P0"
    }).expect(200).expect((response) => {
      expect(response.body.task).toMatchObject({ priority: "P0", version: 1 });
    });

    const conflict = await fixture.client.patch("/api/tasks/task-1").send({
      operation_id: "op-patch-2",
      expected_version: 0,
      priority: "P2"
    }).expect(409);
    expect(conflict.body).toMatchObject({ code: "TASK_VERSION_CONFLICT" });
  });

  it("accepts a pending_acceptance task with the exact version", async () => {
    const fixture = await createFixture({
      seed: ({ store, databasePath }) => {
        seedTask(store, {
          task_id: "task-1",
          title: "Verified work",
          status: "pending_acceptance"
        });
        bumpVersion(databasePath, "task-1", 2);
      }
    });

    await fixture.client.post("/api/tasks/task-1/accept")
      .send({ operation_id: "op-accept-1", expected_version: 2 })
      .expect(200)
      .expect((response) => {
        expect(response.body.task).toMatchObject({ status: "done", version: 3 });
      });
  });

  it("rejects and cancels tasks but exposes no Board decision mutation", async () => {
    const fixture = await createFixture({
      seed: ({ store, databasePath }) => {
        seedTask(store, {
          task_id: "task-reject",
          title: "Rejected work",
          status: "pending_acceptance"
        });
        bumpVersion(databasePath, "task-reject", 1);
        seedTask(store, {
          task_id: "task-resume",
          title: "Resumable work",
          status: "pending_acceptance"
        });
        bumpVersion(databasePath, "task-resume", 1);
        seedTask(store, {
          task_id: "task-cancel",
          title: "Cancelled work",
          status: "backlog"
        });
        bumpVersion(databasePath, "task-cancel", 1);
        seedTask(store, {
          task_id: "task-decide",
          title: "Decision work",
          status: "waiting_human",
          checkpoint: {
            completed_items: [],
            current_state: "awaiting decision",
            human_context: [],
            confirmed_decisions: [],
            pending_decisions: ["Which database?"],
            blockers: [],
            verification: [],
            next_action: "ask human"
          }
        });
      }
    });

    await fixture.client.post("/api/tasks/task-reject/reject")
      .send({ operation_id: "op-reject-1", expected_version: 1 })
      .expect(200)
      .expect((response) => {
        expect(response.body.task).toMatchObject({ status: "paused" });
      });

    await fixture.client.post("/api/tasks/task-resume/resume")
      .send({ operation_id: "op-resume-1", expected_version: 1 })
      .expect(200)
      .expect((response) => {
        expect(response.body.task).toMatchObject({ status: "paused", version: 2 });
      });

    await fixture.client.post("/api/tasks/task-cancel/cancel")
      .send({ operation_id: "op-cancel-1", expected_version: 1 })
      .expect(200)
      .expect((response) => {
        expect(response.body.task).toMatchObject({ status: "cancelled" });
      });

    await fixture.client.post("/api/tasks/task-decide/decisions")
      .send({
        operation_id: "op-decide-1",
        expected_version: 0,
        question: "Which database?",
        decision: "SQLite"
      })
      .expect(404);

    await fixture.client.get("/api/tasks/task-decide")
      .expect(200)
      .expect((response) => {
        expect(response.body.task).toMatchObject({
          status: "waiting_human",
          version: 0,
          checkpoint: {
            confirmed_decisions: [],
            pending_decisions: ["Which database?"]
          }
        });
      });
  });

  it("cancels the task and preserves the dependency edge when the upstream is active", async () => {
    const fixture = await createFixture({
      seed: ({ store, databasePath }) => {
        seedTask(store, {
          task_id: "task-upstream",
          title: "Active upstream",
          status: "in_progress"
        });
        seedTask(store, {
          task_id: "task-downstream",
          title: "Blocked downstream",
          status: "backlog"
        });
        bumpVersion(databasePath, "task-downstream", 1);
        store.transaction((tx) => {
          tx.insertTaskDependency({
            task_id: "task-downstream",
            depends_on_task_id: "task-upstream",
            created_at: startedAt
          });
        });
      }
    });

    await fixture.client.post("/api/tasks/task-downstream/cancel")
      .send({ operation_id: "op-cancel-blocked-1", expected_version: 1 })
      .expect(200)
      .expect((response) => {
        expect(response.body.task).toMatchObject({ status: "cancelled", version: 2 });
      });

    await fixture.client.get("/api/tasks/task-downstream")
      .expect(200)
      .expect((response) => {
        expect(response.body.task).toMatchObject({
          status: "cancelled",
          version: 2
        });
      });
    await fixture.client
      .get("/api/dependency-contexts/repo-1:task-upstream:repo-1:task-downstream:1")
      .expect(200)
      .expect((response) => {
        expect(response.body.context).toMatchObject({ status: "cancelled" });
        expect(response.body.events).toEqual(expect.arrayContaining([
          expect.objectContaining({ event_type: "task_cancelled" })
        ]));
      });
  });

  it("releases a session lease", async () => {
    const fixture = await createFixture({
      seed: ({ store }) => {
        seedSession(store, "session-1");
        seedTask(store, {
          task_id: "task-1",
          status: "in_progress",
          session_id: "session-1"
        });
        store.transaction((tx) => {
          tx.putLease({
            task_id: "task-1",
            session_id: "session-1",
            acquired_at: startedAt,
            heartbeat_at: startedAt,
            expires_at: "2026-08-17T10:30:00.000Z"
          });
        });
      }
    });

    await fixture.client.post("/api/sessions/session-1/release")
      .send({ operation_id: "op-release-1", expected_version: 0 })
      .expect(200);
    expect(fixture.store.transaction((tx) => tx.getLeaseByTask("task-1"))).toBeUndefined();
  });

  it("replays the stored response when the same operation id is retried", async () => {
    const fixture = await createFixture({
      seed: ({ store, databasePath }) => {
        seedTask(store, {
          task_id: "task-1",
          title: "Idempotent work",
          status: "pending_acceptance"
        });
        bumpVersion(databasePath, "task-1", 2);
      }
    });

    const first = await fixture.client.post("/api/tasks/task-1/accept")
      .send({ operation_id: "op-retry-1", expected_version: 2 })
      .expect(200);
    const second = await fixture.client.post("/api/tasks/task-1/accept")
      .send({ operation_id: "op-retry-1", expected_version: 2 })
      .expect(200);

    expect(second.body).toEqual(first.body);
    expect(fixture.store.getTaskDetail("task-1")).toMatchObject({ version: 3 });
  });

  it("broadcasts task.changed over sse after a mutation", async () => {
    const fixture = await createFixture({
      seed: ({ store, databasePath }) => {
        seedTask(store, {
          task_id: "task-1",
          title: "Broadcast",
          status: "pending_acceptance"
        });
        bumpVersion(databasePath, "task-1", 2);
      }
    });

    const events = await import("node:http");
    const received: string[] = [];
    const eventStream = new Promise<void>((resolve, reject) => {
      const client = events.get(
        new URL("/events", fixture.baseUrl),
        { headers: { cookie: fixture.sessionCookie } },
        (response) => {
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            received.push(chunk);
            if (chunk.includes("\"version\":3")) {
              resolve();
            }
          });
          response.on("error", reject);
        }
      );
      client.on("error", reject);
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    await fixture.client.post("/api/tasks/task-1/accept")
      .send({ operation_id: "op-sse-1", expected_version: 2 })
      .expect(200);
    await eventStream;

    const stream = received.join("");
    expect(stream).toContain("event: task.changed");
    expect(stream).toContain("data: {\"task_id\":\"task-1\",\"version\":3}");
  });

  it("broadcasts identity-only terminal repair changes across projects", async () => {
    const fixture = await createFixture({
      seed: ({ store }) => {
        store.transaction((tx) => {
          tx.upsertProject({
            project_id: "project-repair-upstream",
            name: "Repair Upstream",
            created_at: startedAt,
            updated_at: startedAt
          });
          tx.upsertRepository({
            repository_id: "repo-repair-upstream",
            project_id: "project-repair-upstream",
            path: "/tmp/repair-upstream",
            label: "Repair Upstream",
            created_at: startedAt,
            updated_at: startedAt
          });
          tx.insertSession({
            session_id: "repair-run-session",
            repository_id: "repo-1",
            label: "Repair validation run",
            owner: "jande",
            started_at: startedAt,
            worktree_path: "/tmp/project-one/worktrees/repair"
          });
          tx.insertTask({
            task_id: "task-repair-upstream",
            repository_id: "repo-repair-upstream",
            title: "Upstream repair",
            status: "done",
            priority: "P1",
            owner: "upstream-owner",
            created_at: startedAt,
            updated_at: startedAt
          });
          tx.insertTask({
            task_id: "task-repair-downstream",
            repository_id: "repo-1",
            title: "Downstream terminal",
            status: "backlog",
            priority: "P1",
            owner: "jande",
            created_at: startedAt,
            updated_at: startedAt
          });
          tx.insertTaskDependency({
            task_id: "task-repair-downstream",
            depends_on_task_id: "task-repair-upstream",
            created_at: startedAt,
            policy: "acceptance_gate",
            ctx_id: "ctx-terminal-repair",
            generation: 1
          });
          tx.insertDependencyValidation({
            ctx_id: "ctx-terminal-repair",
            validation_id: "validation-terminal-repair",
            upstream_task_id: "task-repair-upstream",
            downstream_task_id: "task-repair-downstream",
            cycle: 1,
            status: "rejected",
            requested_by_actor: "agent",
            requested_by_owner: "upstream-owner",
            requested_at: startedAt,
            request_read_at: null,
            responded_by_owner: "jande",
            response_reason: "private reason must stay off SSE",
            responded_at: startedAt,
            response_read_at: null,
            validation_spec: {}
          });
          tx.insertDependencyValidationRun({
            run_id: "run-terminal-repair",
            validation_id: "validation-terminal-repair",
            attempt: 1,
            status: "rejected",
            owner: "jande",
            session_id: "repair-run-session",
            worktree_path: "/tmp/project-one/worktrees/repair",
            heartbeat_at: startedAt,
            expires_at: "2026-08-17T10:30:00.000Z",
            started_at: startedAt,
            completed_at: startedAt,
            verification: [{
              command: "npm test",
              outcome: "failed",
              summary: "private evidence"
            }],
            failure_reason: "private reason must stay off SSE",
            error_reason: null,
            operation_id: "terminal-repair-run",
            created_at: startedAt,
            updated_at: startedAt
          });
          tx.insertSession({
            session_id: "repair-downstream-run-session",
            repository_id: "repo-repair-upstream",
            label: "Outgoing repair validation run",
            owner: "upstream-owner",
            started_at: startedAt,
            worktree_path: "/tmp/repair-upstream/worktrees/validation"
          });
          tx.insertTask({
            task_id: "task-cancel-repair-upstream",
            repository_id: "repo-1",
            title: "Cancel upstream repair",
            status: "backlog",
            priority: "P1",
            owner: "jande",
            created_at: startedAt,
            updated_at: startedAt
          });
          tx.insertTask({
            task_id: "task-cancel-repair-downstream",
            repository_id: "repo-repair-upstream",
            title: "Observe cancelled repair",
            status: "backlog",
            priority: "P1",
            owner: "upstream-owner",
            created_at: startedAt,
            updated_at: startedAt
          });
          tx.insertTaskDependency({
            task_id: "task-cancel-repair-downstream",
            depends_on_task_id: "task-cancel-repair-upstream",
            created_at: startedAt,
            policy: "acceptance_gate",
            ctx_id: "ctx-cancelled-repair",
            generation: 1
          });
          tx.insertDependencyValidation({
            ctx_id: "ctx-cancelled-repair",
            validation_id: "validation-cancelled-repair",
            upstream_task_id: "task-cancel-repair-upstream",
            downstream_task_id: "task-cancel-repair-downstream",
            cycle: 1,
            status: "rejected",
            requested_by_actor: "agent",
            requested_by_owner: "jande",
            requested_at: startedAt,
            request_read_at: null,
            responded_by_owner: "upstream-owner",
            response_reason: "another private reason",
            responded_at: startedAt,
            response_read_at: null,
            validation_spec: {}
          });
          tx.insertDependencyValidationRun({
            run_id: "run-cancelled-repair",
            validation_id: "validation-cancelled-repair",
            attempt: 1,
            status: "rejected",
            owner: "upstream-owner",
            session_id: "repair-downstream-run-session",
            worktree_path: "/tmp/repair-upstream/worktrees/validation",
            heartbeat_at: startedAt,
            expires_at: "2026-08-17T10:30:00.000Z",
            started_at: startedAt,
            completed_at: startedAt,
            verification: [{ command: "npm test", outcome: "failed", summary: "private" }],
            failure_reason: "another private reason",
            error_reason: null,
            operation_id: "cancelled-repair-run",
            created_at: startedAt,
            updated_at: startedAt
          });
          tx.insertDependencyRepairRequest({
            repair_id: "repair-cancelled-with-upstream",
            validation_id: "validation-cancelled-repair",
            source_run_id: "run-cancelled-repair",
            ctx_id: "ctx-cancelled-repair",
            upstream_task_id: "task-cancel-repair-upstream",
            downstream_task_id: "task-cancel-repair-downstream",
            cycle: 1,
            status: "pending",
            rejection_reason: "another private reason",
            claimed_session_id: null,
            claimed_worktree_path: null,
            claimed_at: null,
            resolved_at: null,
            superseded_at: null,
            created_at: startedAt,
            updated_at: startedAt
          });
        });
      }
    });
    const originalCancel = fixture.taskService.humanCancel.bind(fixture.taskService);
    let injected = false;
    Object.defineProperty(fixture.taskService, "humanCancel", {
      configurable: true,
      value: async (...args: Parameters<TaskService["humanCancel"]>) => {
        if (!injected) {
          injected = true;
          fixture.store.transaction((tx) => tx.insertDependencyRepairRequest({
            repair_id: "repair-terminal-repair",
            validation_id: "validation-terminal-repair",
            source_run_id: "run-terminal-repair",
            ctx_id: "ctx-terminal-repair",
            upstream_task_id: "task-repair-upstream",
            downstream_task_id: "task-repair-downstream",
            cycle: 1,
            status: "pending",
            rejection_reason: "private reason must stay off SSE",
            claimed_session_id: null,
            claimed_worktree_path: null,
            claimed_at: null,
            resolved_at: null,
            superseded_at: null,
            created_at: startedAt,
            updated_at: startedAt
          }));
        }
        return originalCancel(...args);
      }
    });
    const upstream = await fixture.pairClient("upstream-owner");
    const events = await import("node:http");
    const received: string[] = [];
    let eventRequest: import("node:http").ClientRequest | undefined;
    let resolveCancelledRepair: () => void = () => undefined;
    const cancelledRepairEvent = new Promise<void>((resolve) => {
      resolveCancelledRepair = resolve;
    });
    const repairEvent = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for repair SSE")), 2_000);
      eventRequest = events.get(
        new URL("/events", fixture.baseUrl),
        { headers: { cookie: upstream.sessionCookie } },
        (response) => {
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            received.push(chunk);
            if (chunk.includes("repair-terminal-repair")) {
              clearTimeout(timeout);
              resolve();
            }
            if (chunk.includes("repair-cancelled-with-upstream")) {
              resolveCancelledRepair();
            }
          });
          response.on("error", reject);
        }
      );
      eventRequest.on("error", reject);
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    await fixture.client.post("/api/tasks/task-repair-downstream/cancel")
      .send({ operation_id: "cancel-terminal-repair", expected_version: 0 })
      .expect(200);
    await repairEvent;
    await fixture.client.post("/api/tasks/task-cancel-repair-upstream/cancel")
      .send({ operation_id: "cancel-upstream-repair-task", expected_version: 0 })
      .expect(200);
    await Promise.race([
      cancelledRepairEvent,
      new Promise((_, reject) => setTimeout(() => reject(
        new Error("Timed out waiting for cancelled repair SSE")
      ), 2_000))
    ]);
    eventRequest?.destroy();

    const stream = received.join("");
    expect(stream).toContain("event: dependency_repair.changed");
    expect(stream).toContain('"repair_id":"repair-terminal-repair"');
    expect(stream).toContain('"status":"superseded"');
    expect(stream).toContain('"repair_id":"repair-cancelled-with-upstream"');
    expect(stream).toContain('"status":"cancelled"');
    expect(stream).not.toContain("private reason");
    expect(stream).not.toContain("evidence");
    expect(fixture.store.listTaskEventViews("task-repair-upstream"))
      .toEqual(expect.arrayContaining([expect.objectContaining({
        event_type: "dependency_repair_superseded"
      })]));
    expect(fixture.store.listDependencyContextEvents?.("ctx-terminal-repair"))
      .toEqual(expect.arrayContaining([expect.objectContaining({
        event_type: "dependency_repair_superseded"
      })]));
  });

  it("archives a legacy project from the board and restores it from the archived list", async () => {
    const fixture = await createFixture({
      seed: ({ store }) => {
        seedTask(store, { task_id: "task-finished", status: "done" });
        seedTask(store, { task_id: "task-dropped", status: "cancelled", owner: "member" });
      }
    });

    const archived = await fixture.client.post("/api/projects/project-1/archive")
      .send({ operation_id: "op-archive-1" })
      .expect(200);
    expect(archived.body.project).toMatchObject({
      project_id: "project-1",
      created_by: null,
      archived_at: startedAt,
      archived_by: "jande"
    });
    const replayed = await fixture.client.post("/api/projects/project-1/archive")
      .send({ operation_id: "op-archive-1" })
      .expect(200);
    expect(replayed.body).toEqual(archived.body);

    expect((await fixture.client.get("/api/projects").expect(200)).body.projects).toEqual([]);
    expect((await fixture.client.get("/api/overview/projects").expect(200)).body.projects)
      .toEqual([]);
    const withArchived = await fixture.client.get("/api/projects?include_archived=true")
      .expect(200);
    expect(withArchived.body.projects).toEqual([
      expect.objectContaining({
        project_id: "project-1",
        archived_at: startedAt,
        archived_by: "jande",
        repositories: expect.arrayContaining([
          expect.objectContaining({ repository_id: "repo-1" })
        ])
      })
    ]);
    // History stays readable after archive.
    await fixture.client.get("/api/tasks/task-finished").expect(200);

    const restored = await fixture.client.post("/api/projects/project-1/unarchive")
      .send({ operation_id: "op-unarchive-1" })
      .expect(200);
    expect(restored.body.project).toMatchObject({ archived_at: null, archived_by: null });
    expect((await fixture.client.get("/api/projects").expect(200)).body.projects)
      .toEqual([expect.objectContaining({ project_id: "project-1", archived_at: null })]);
  });

  it("rejects archiving while any member task is unfinished and returns the breakdown", async () => {
    const fixture = await createFixture({
      seed: ({ store }) => {
        store.transaction((tx) => {
          tx.upsertProject({
            project_id: "project-owned",
            name: "Owned",
            created_by: "jande",
            created_at: startedAt,
            updated_at: startedAt
          });
          tx.upsertRepository({
            repository_id: "repo-owned",
            project_id: "project-owned",
            path: "/tmp/project-owned",
            label: "Owned",
            created_at: startedAt,
            updated_at: startedAt
          });
        });
        seedTask(store, {
          task_id: "task-member-open",
          repository_id: "repo-owned",
          status: "in_progress",
          owner: "member"
        });
      }
    });

    const rejected = await fixture.client.post("/api/projects/project-owned/archive")
      .send({ operation_id: "op-archive-open" })
      .expect(409);
    expect(rejected.body).toMatchObject({
      code: "PROJECT_HAS_OPEN_TASKS",
      details: {
        open_task_counts: { in_progress: 1 },
        open_tasks: [{
          task_id: "task-member-open",
          owner: "member",
          status: "in_progress",
          repository_id: "repo-owned"
        }]
      }
    });
    expect(rejected.body.evidence).toContain("task task-member-open (owner member, in_progress)");
    expect(fixture.store.getProject("project-owned")?.archived_at).toBeNull();
  });

  it("allows only the creator to archive a project with a creator", async () => {
    const fixture = await createFixture({
      seed: ({ store }) => {
        store.transaction((tx) => {
          tx.upsertProject({
            project_id: "project-foreign",
            name: "Foreign",
            created_by: "someone-else",
            created_at: startedAt,
            updated_at: startedAt
          });
          tx.upsertRepository({
            repository_id: "repo-foreign",
            project_id: "project-foreign",
            path: "/tmp/project-foreign",
            label: "Foreign",
            created_at: startedAt,
            updated_at: startedAt
          });
        });
      }
    });

    const rejected = await fixture.client.post("/api/projects/project-foreign/archive")
      .send({ operation_id: "op-archive-foreign" })
      .expect(403);
    expect(rejected.body.code).toBe("PROJECT_CREATOR_REQUIRED");
    await fixture.client.post("/api/projects/project-foreign/archive")
      .send({})
      .expect(400);
  });

  it("rejects registering a board repository into an archived project", async () => {
    const fixture = await createFixture({});
    await fixture.client.post("/api/projects/project-1/archive")
      .send({ operation_id: "op-archive-before-register" })
      .expect(200);

    const rejected = await fixture.client.post("/api/repositories")
      .send({
        project_id: "project-1",
        project_name: "Project One",
        repository_id: "repo-into-archived",
        repository_name: "Into Archived",
        path: "/tmp/into-archived"
      })
      .expect(409);
    expect(rejected.body.code).toBe("PROJECT_ARCHIVED");
    expect(fixture.store.getRepository("repo-into-archived")).toBeUndefined();
    expect(fixture.store.getProject("project-1")?.archived_at).toBe(startedAt);
  });

  it("validates the include_archived project list flag", async () => {
    const fixture = await createFixture({});
    await fixture.client.get("/api/projects?include_archived=maybe").expect(400);
    await fixture.client.get("/api/projects?include_archived=false").expect(200);
  });

  it("broadcasts overview.changed after archiving a project", async () => {
    const fixture = await createFixture({});
    const events = await import("node:http");
    const overviewEvent = new Promise<void>((resolve, reject) => {
      const client = events.get(
        new URL("/events", fixture.baseUrl),
        { headers: { cookie: fixture.sessionCookie } },
        (response) => {
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            if (chunk.includes("event: overview.changed")) {
              resolve();
            }
          });
          response.on("error", reject);
        }
      );
      client.on("error", reject);
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    await fixture.client.post("/api/projects/project-1/archive")
      .send({ operation_id: "op-archive-sse" })
      .expect(200);
    await overviewEvent;
  });

  it("broadcasts overview.changed after registering a repository", async () => {
    const fixture = await createFixture({});
    const events = await import("node:http");
    const received: string[] = [];
    const overviewEvent = new Promise<void>((resolve, reject) => {
      const client = events.get(
        new URL("/events", fixture.baseUrl),
        { headers: { cookie: fixture.sessionCookie } },
        (response) => {
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            received.push(chunk);
            if (chunk.includes("event: overview.changed")) {
              resolve();
            }
          });
          response.on("error", reject);
        }
      );
      client.on("error", reject);
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    await fixture.client.post("/api/repositories")
      .send({
        project_id: "project-1",
        project_name: "Project One",
        repository_id: "repo-registered-from-board",
        repository_name: "Board Registered",
        path: "/tmp/board-registered"
      })
      .expect(201);
    await overviewEvent;

    expect(received.join("")).toContain("event: overview.changed");
  });

  it("does not send another owner's task events to an authenticated sse client", async () => {
    const fixture = await createFixture({
      seed: ({ store }) => {
        seedTask(store, {
          task_id: "task-jande-sse",
          status: "pending_acceptance"
        });
        seedTask(store, {
          task_id: "task-jang-sse",
          status: "pending_acceptance"
        });
        store.transaction((tx) => {
          const jangTask = tx.getTask("task-jang-sse");
          if (jangTask !== undefined) {
            tx.updateTask({ ...jangTask, owner: "jang" }, 0);
          }
        });
      }
    });
    const jang = await fixture.pairClient("jang");
    const events = await import("node:http");
    const received: string[] = [];
    let eventRequest: import("node:http").ClientRequest | undefined;
    const ownEvent = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for owner SSE")), 2_000);
      eventRequest = events.get(
        new URL("/events", fixture.baseUrl),
        { headers: { cookie: fixture.sessionCookie } },
        (response) => {
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            received.push(chunk);
            if (chunk.includes("task-jande-sse")) {
              clearTimeout(timeout);
              resolve();
            }
          });
          response.on("error", reject);
        }
      );
      eventRequest.on("error", reject);
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    await jang.client.post("/api/tasks/task-jang-sse/accept")
      .send({ operation_id: "op-jang-sse", expected_version: 1 })
      .expect(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received.join("")).not.toContain("task-jang-sse");
    expect(received.join("")).toContain("event: overview.changed");
    expect(received.join("")).toContain("data: {}");

    await fixture.client.post("/api/tasks/task-jande-sse/accept")
      .send({ operation_id: "op-jande-sse", expected_version: 0 })
      .expect(200);
    await ownEvent;
    eventRequest?.destroy();
    expect(received.join("")).toContain("task-jande-sse");
  });

  it("streams a selected target owner's task events as read-only data", async () => {
    const fixture = await createFixture({
      seed: ({ store }) => {
        seedTask(store, {
          task_id: "task-target-sse",
          status: "pending_acceptance",
          owner: "jang"
        });
      }
    });
    const jang = await fixture.pairClient("jang");
    const events = await import("node:http");
    const received: string[] = [];
    let eventRequest: import("node:http").ClientRequest | undefined;
    const targetEvent = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for target SSE")), 2_000);
      eventRequest = events.get(
        new URL("/events?owner=jang", fixture.baseUrl),
        { headers: { cookie: fixture.sessionCookie } },
        (response) => {
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            received.push(chunk);
            if (chunk.includes("task-target-sse")) {
              clearTimeout(timeout);
              resolve();
            }
          });
          response.on("error", reject);
        }
      );
      eventRequest.on("error", reject);
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    await jang.client.post("/api/tasks/task-target-sse/accept")
      .send({ operation_id: "op-target-sse", expected_version: 0 })
      .expect(200);
    await targetEvent;
    eventRequest?.destroy();
    expect(received.join("")).toContain("task-target-sse");
  });

  it("serves the board placeholder when no built assets exist", async () => {
    const fixture = await createFixture({
      boardDir: "/nonexistent-board-dir-for-placeholder"
    });
    const response = await fixture.client.get("/board").expect(200);
    expect(response.text).toContain("CLI Session Task MCP");
  });
});
