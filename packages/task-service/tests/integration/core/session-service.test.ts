/// <reference types="node" />

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeConfig } from "../../../src/config/runtime-config.js";
import {
  SessionService,
  type SessionContextInput,
  type SessionRebindInput
} from "../../../src/core/session-service.js";
import { SqliteDatabase } from "../../../src/storage/database.js";
import type {
  ActiveTaskLease,
  ProgressStore
} from "../../../src/storage/progress-store.js";
import type { TaskRecord } from "../../../src/shared/task-contracts.js";

const temporaryDirectories: string[] = [];
const startedAt = "2026-08-17T10:00:00.000Z";

function createSessionService(): {
  store: ProgressStore;
  database: SqliteDatabase;
  service: SessionService;
} {
  const dataDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-"));
  temporaryDirectories.push(dataDir);
  const config = createRuntimeConfig(dataDir);
  const database = SqliteDatabase.open(config);
  seedRepository(config.databasePath);
  const store = database.createProgressStore();
  return { store, database, service: new SessionService(store, config) };
}

function seedRepository(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("BEGIN IMMEDIATE");
  database.prepare(`
    INSERT INTO projects(project_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run("project-1", "Project One", startedAt, startedAt);
  database.prepare(`
    INSERT INTO repositories(
      repository_id, project_id, path, label, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run("repo-1", "project-1", "/tmp/project-one", "Project One", startedAt, startedAt);
  database.exec("COMMIT");
  database.close();
}

function sessionInput(overrides: Partial<SessionContextInput> = {}): SessionContextInput {
  return {
    transport_session_id: "transport-1",
    client_name: "codex-cli",
    client_version: "0.147.0",
    protocol_version: "2025-06-18",
    capabilities: { roots: { listChanged: true } },
    workspace_path: "/tmp/project-one",
    repository_id: "repo-1",
    worktree_path: "/tmp/project-one/worktrees/feature",
    ...overrides
  };
}

function taskForSession(sessionId: string): TaskRecord {
  return {
    task_id: "task-1",
    repository_id: "repo-1",
    session_id: sessionId,
    title: "Persist task progress",
    status: "in_progress",
    priority: "P1",
    created_at: startedAt,
    updated_at: startedAt
  };
}

function leaseForSession(sessionId: string): ActiveTaskLease {
  return {
    task_id: "task-1",
    session_id: sessionId,
    acquired_at: startedAt,
    heartbeat_at: startedAt,
    expires_at: "2026-08-17T10:30:00.000Z"
  };
}

function rebindInput(
  sessionId: string,
  overrides: Partial<SessionRebindInput> = {}
): SessionRebindInput {
  return {
    session_id: sessionId,
    operation_id: "op-rebind-1",
    repository_id: "repo-1",
    owner: "jande",
    expected_worktree_path: "/tmp/project-one/worktrees/feature",
    workspace_path: "/tmp/project-one/worktrees/feature-b",
    worktree_path: "/tmp/project-one/worktrees/feature-b",
    ...overrides
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SessionService", () => {
  it("atomically transfers the predecessor task to an explicit successor worktree", () => {
    const { database, service, store } = createSessionService();
    const predecessor = service.sessionContext(
      sessionInput({ owner: "jande" }),
      "2026-08-17T10:00:00.000Z"
    );
    store.transaction((tx) => {
      tx.insertTask({ ...taskForSession(predecessor.session_id), owner: "jande" });
      tx.replaceTaskWorktreeScope({
        task_scope_id: "scope-1",
        task_id: "task-1",
        scope_type: "worktree_path",
        scope_value: "/tmp/project-one/worktrees/feature"
      });
      tx.putLease(leaseForSession(predecessor.session_id));
    });

    const successor = service.sessionContext(sessionInput({
      transport_session_id: "transport-2",
      owner: "jande",
      workspace_path: "/tmp/project-one/worktrees/feature-b",
      worktree_path: "/tmp/project-one/worktrees/feature-b",
      successor_session_id: predecessor.session_id,
      successor_ctx_id: "ctx-1"
    }), "2026-08-17T10:05:00.000Z");

    expect(store.transaction((tx) => tx.getLeaseByTask("task-1")))
      .toMatchObject({
        session_id: successor.session_id,
        generation: 2,
        heartbeat_at: "2026-08-17T10:05:00.000Z",
        expires_at: "2026-08-17T10:35:00.000Z"
      });
    expect(store.transaction((tx) => tx.getTask("task-1")))
      .toMatchObject({ session_id: successor.session_id });
    expect(store.transaction((tx) => tx.listActiveScopesByWorktree(
      "/tmp/project-one/worktrees/feature-b"
    ))).toEqual([expect.objectContaining({ task_id: "task-1" })]);
    expect(store.transaction((tx) => tx.getSession(predecessor.session_id)))
      .toMatchObject({ stale_at: "2026-08-17T10:05:00.000Z" });
    database.close();
  });

  it("reuses the platform session when the same transport session reconnects", () => {
    const { database, service, store } = createSessionService();

    const first = service.sessionContext(sessionInput(), "2026-08-17T10:00:00.000Z");
    const second = service.sessionContext(sessionInput(), "2026-08-17T10:05:00.000Z");

    expect(second.session_id).toBe(first.session_id);
    expect(second.started_at).toBe("2026-08-17T10:00:00.000Z");
    expect(second.last_activity_at).toBe("2026-08-17T10:05:00.000Z");
    expect(store.transaction((tx) => tx.getSession(first.session_id))).toMatchObject({
      session_id: first.session_id,
      last_activity_at: "2026-08-17T10:05:00.000Z"
    });
    database.close();
  });

  it("rejects a silent context change on a previously bound transport", () => {
    const { database, service } = createSessionService();
    service.sessionContext(
      sessionInput({ owner: "jande" }),
      "2026-08-17T10:00:00.000Z"
    );

    expect(() => service.sessionContext(sessionInput({
      owner: "jande",
      worktree_path: "/tmp/project-one/worktrees/feature-b"
    }), "2026-08-17T10:01:00.000Z")).toThrowError(expect.objectContaining({
      code: "SESSION_CONTEXT_CONFLICT"
    }));
    database.close();
  });

  it("rebinds an idle session in place and records one idempotent audit event", () => {
    const { database, service, store } = createSessionService();
    const session = service.sessionContext(
      sessionInput({ owner: "jande" }),
      "2026-08-17T10:00:00.000Z"
    );
    const input = rebindInput(session.session_id);

    const first = service.rebindSession(input, "2026-08-17T10:05:00.000Z");
    const replay = service.rebindSession(input, "2026-08-17T10:06:00.000Z");

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      session_id: session.session_id,
      previous_worktree_path: "/tmp/project-one/worktrees/feature",
      worktree_path: "/tmp/project-one/worktrees/feature-b",
      rebound: true
    });
    expect(store.transaction((tx) => tx.getSession(session.session_id))).toMatchObject({
      owner: "jande",
      repository_id: "repo-1",
      workspace_path: "/tmp/project-one/worktrees/feature-b",
      worktree_path: "/tmp/project-one/worktrees/feature-b",
      last_activity_at: "2026-08-17T10:05:00.000Z"
    });
    expect(store.listSessionEvents(session.session_id)).toEqual([
      expect.objectContaining({
        event_type: "session_rebound",
        payload: expect.objectContaining({
          previous_worktree_path: "/tmp/project-one/worktrees/feature",
          worktree_path: "/tmp/project-one/worktrees/feature-b",
          via: "session_rebind"
        })
      })
    ]);
    database.close();
  });

  it("rejects rebind owner drift and a stale expected worktree", () => {
    const { database, service } = createSessionService();
    const session = service.sessionContext(
      sessionInput({ owner: "jande" }),
      "2026-08-17T10:00:00.000Z"
    );

    expect(() => service.rebindSession(rebindInput(session.session_id, {
      owner: "lisi"
    }), "2026-08-17T10:05:00.000Z")).toThrowError(expect.objectContaining({
      code: "OWNER_MISMATCH"
    }));
    expect(() => service.rebindSession(rebindInput(session.session_id, {
      operation_id: "op-rebind-stale",
      expected_worktree_path: "/tmp/project-one/worktrees/stale"
    }), "2026-08-17T10:05:00.000Z")).toThrowError(expect.objectContaining({
      code: "SESSION_CONTEXT_CONFLICT"
    }));
    database.close();
  });

  it("requires task_switch instead of rebinding a session with an active lease", () => {
    const { database, service, store } = createSessionService();
    const session = service.sessionContext(
      sessionInput({ owner: "jande" }),
      "2026-08-17T10:00:00.000Z"
    );
    store.transaction((tx) => {
      tx.insertTask(taskForSession(session.session_id));
      tx.putLease(leaseForSession(session.session_id));
    });

    expect(() => service.rebindSession(
      rebindInput(session.session_id),
      "2026-08-17T10:05:00.000Z"
    )).toThrowError(expect.objectContaining({ code: "TASK_LEASE_CONFLICT" }));
    expect(store.transaction((tx) => tx.getSession(session.session_id)?.worktree_path))
      .toBe("/tmp/project-one/worktrees/feature");
    database.close();
  });

  it("rejects rebinding onto a worktree leased by another task", () => {
    const { database, service, store } = createSessionService();
    const session = service.sessionContext(
      sessionInput({ owner: "jande" }),
      "2026-08-17T10:00:00.000Z"
    );
    store.transaction((tx) => {
      tx.insertSession({
        session_id: "session-other",
        repository_id: "repo-1",
        label: "Other session",
        started_at: startedAt,
        owner: "lisi",
        worktree_path: "/tmp/project-one/worktrees/feature-b"
      });
      tx.insertTask({
        task_id: "task-other",
        repository_id: "repo-1",
        session_id: "session-other",
        owner: "lisi",
        title: "Other task",
        status: "in_progress",
        priority: "P1",
        created_at: startedAt,
        updated_at: startedAt
      });
      tx.insertTaskScope({
        task_scope_id: "scope-other",
        task_id: "task-other",
        scope_type: "worktree_path",
        scope_value: "/tmp/project-one/worktrees/feature-b"
      });
      tx.putLease({
        task_id: "task-other",
        session_id: "session-other",
        acquired_at: startedAt,
        heartbeat_at: startedAt,
        expires_at: "2026-08-17T10:30:00.000Z"
      });
    });

    expect(() => service.rebindSession(
      rebindInput(session.session_id),
      "2026-08-17T10:05:00.000Z"
    )).toThrowError(expect.objectContaining({ code: "WORKTREE_CONFLICT" }));
    expect(store.transaction((tx) => tx.getSession(session.session_id)?.worktree_path))
      .toBe("/tmp/project-one/worktrees/feature");
    database.close();
  });

  it("creates a new platform session for a new process even with the same client and workspace", () => {
    const { database, service, store } = createSessionService();

    const first = service.sessionContext(sessionInput(), "2026-08-17T10:00:00.000Z");
    const second = service.sessionContext(sessionInput({
      transport_session_id: "transport-2"
    }), "2026-08-17T10:01:00.000Z");

    expect(second.session_id).not.toBe(first.session_id);
    expect(first.client_family).toBe("codex");
    expect(store.transaction((tx) => tx.getSessionByTransportId("transport-1")?.session_id))
      .toBe(first.session_id);
    expect(store.transaction((tx) => tx.getSessionByTransportId("transport-2")?.session_id))
      .toBe(second.session_id);
    expect(store.transaction((tx) => tx.getSession(first.session_id))).toMatchObject({
      session_id: first.session_id
    });
    database.close();
  });

  it("registers a session when the optional capabilities are missing", () => {
    const { database, service, store } = createSessionService();
    const { capabilities: _omitted, ...withoutCapabilities } = sessionInput();

    const session = service.sessionContext(withoutCapabilities, "2026-08-17T10:00:00.000Z");

    expect(session.session_id).toEqual(expect.any(String));
    expect(session.capabilities).toBeUndefined();
    const persisted = store.transaction((tx) => tx.getSession(session.session_id));
    expect(persisted).toMatchObject({ session_id: session.session_id });
    expect(persisted?.capabilities).toBeUndefined();
    database.close();
  });

  it("marks a session stale at exactly thirty minutes of inactivity", () => {
    const { database, service, store } = createSessionService();
    const session = service.sessionContext(sessionInput(), "2026-08-17T10:00:00.000Z");

    const marked = service.markStale("2026-08-17T10:30:00.000Z");

    expect(marked.map((entry) => entry.session_id)).toEqual([session.session_id]);
    expect(store.transaction((tx) => tx.getSession(session.session_id))).toMatchObject({
      stale_at: "2026-08-17T10:30:00.000Z"
    });
    database.close();
  });

  it("keeps a session fresh at twenty-nine minutes and fifty-nine seconds", () => {
    const { database, service, store } = createSessionService();
    const session = service.sessionContext(sessionInput(), "2026-08-17T10:00:00.000Z");

    const marked = service.markStale("2026-08-17T10:29:59.000Z");

    expect(marked).toEqual([]);
    const persisted = store.transaction((tx) => tx.getSession(session.session_id));
    expect(persisted?.stale_at).toBeUndefined();
    database.close();
  });

  it("marks stale without touching task status or active leases", () => {
    const { database, service, store } = createSessionService();
    const session = service.sessionContext(sessionInput(), "2026-08-17T10:00:00.000Z");
    store.transaction((tx) => {
      tx.insertTask(taskForSession(session.session_id));
      tx.putLease(leaseForSession(session.session_id));
    });

    service.markStale("2026-08-17T10:30:00.000Z");

    expect(store.getTaskDetail("task-1")).toMatchObject({ status: "in_progress" });
    expect(store.transaction((tx) => tx.getLeaseByTask("task-1"))).toMatchObject({
      task_id: "task-1",
      session_id: session.session_id
    });
    database.close();
  });

  it("keeps the first stale marker on repeated sweeps", () => {
    const { database, service, store } = createSessionService();
    const session = service.sessionContext(sessionInput(), "2026-08-17T10:00:00.000Z");

    const firstSweep = service.markStale("2026-08-17T10:30:00.000Z");
    const secondSweep = service.markStale("2026-08-17T10:31:00.000Z");

    expect(firstSweep.map((entry) => entry.session_id)).toEqual([session.session_id]);
    expect(secondSweep).toEqual([]);
    expect(store.transaction((tx) => tx.getSession(session.session_id))).toMatchObject({
      stale_at: "2026-08-17T10:30:00.000Z"
    });
    database.close();
  });

  it("clears the stale marker when the transport session reconnects", () => {
    const { database, service, store } = createSessionService();
    const session = service.sessionContext(sessionInput(), "2026-08-17T10:00:00.000Z");
    service.markStale("2026-08-17T10:30:00.000Z");

    const revived = service.sessionContext(sessionInput(), "2026-08-17T10:45:00.000Z");

    expect(revived.session_id).toBe(session.session_id);
    expect(revived.stale_at).toBeUndefined();
    expect(store.transaction((tx) => tx.getSession(session.session_id))).toMatchObject({
      last_activity_at: "2026-08-17T10:45:00.000Z"
    });
    expect(store.transaction((tx) => tx.getSession(session.session_id)?.stale_at))
      .toBeUndefined();
    database.close();
  });

  it("rejects a second session row for the same transport session id", () => {
    const { database, service, store } = createSessionService();
    const session = service.sessionContext(sessionInput(), "2026-08-17T10:00:00.000Z");

    expect(() => store.transaction((tx) => tx.insertSession({
      ...session,
      session_id: "session-duplicate"
    }))).toThrowError(expect.objectContaining({ code: "CONSTRAINT_VIOLATION" }));
    database.close();
  });
});
