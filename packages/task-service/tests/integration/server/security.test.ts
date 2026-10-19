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
import { SessionService } from "../../../src/core/session-service.js";
import { RegistryService } from "../../../src/core/registry-service.js";
import { TaskService } from "../../../src/core/task-service.js";
import { createHttpApp } from "../../../src/server/http-app.js";
import { SqliteDatabase } from "../../../src/storage/database.js";
import type { PlatformStore } from "../../../src/storage/board-auth-store.js";

const startedAt = "2026-08-17T10:00:00.000Z";

interface Fixture {
  baseUrl: string;
  client: ReturnType<typeof request.agent>;
  store: PlatformStore;
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

async function createFixture(): Promise<Fixture> {
  const dataDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-"));
  const config = createRuntimeConfig(dataDir);
  const database = SqliteDatabase.open(config);
  const store = database.createProgressStore();
  store.transaction((tx) => {
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
  });
  const taskService = new TaskService({
    store,
    probe: {
      inspect: async () => ({
        repository_id: "repo-1",
        repository_path: "/tmp/project-one",
        head_commit: "a1b2c3",
        captured_at: startedAt,
        worktree_path: "/tmp/project-one/worktrees/feature",
        branch: "feature",
        changed_files: []
      })
    },
    now: () => startedAt
  });
  const sessionService = new SessionService(store, config);
  store.transaction((tx) => {
    tx.insertSession({
      session_id: "session-1",
      repository_id: "repo-1",
      label: "Seeded session",
      started_at: startedAt,
      owner: "jande"
    });
    tx.insertTask({
      task_id: "task-1",
      repository_id: "repo-1",
      title: "Security probe task",
      status: "backlog",
      priority: "P2",
      owner: "jande",
      created_at: startedAt,
      updated_at: startedAt
    });
  });

  const port = await reservePort();
  const boardAuthService = new BoardAuthService(store, { now: () => startedAt });
  const app = createHttpApp({
    taskService,
    sessionService,
    store,
    registryService: new RegistryService(store, () => new Date().toISOString()),
    boardAuthService,
    allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
    now: () => startedAt
  });
  const server: Server = app.listen(port, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${port}`;
  const client = request.agent(baseUrl);
  const pairing = await client.post("/api/board-auth/pairings").expect(201);
  boardAuthService.approvePairing(pairing.body.pairing_code as string, "session-1");
  await client
    .get(`/api/board-auth/pairings/${pairing.body.challenge_id as string}`)
    .expect(200);

  const fixture: Fixture = {
    baseUrl,
    client,
    store,
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

const validMutation = {
  operation_id: "op-security-1",
  expected_version: 0,
  priority: "P3"
};

describe("local security boundary", () => {
  it("rejects requests with a foreign Host header", async () => {
    const fixture = await createFixture();
    await fixture.client.get("/api/tasks").set("Host", "evil.example").expect(403);
    await fixture.client.get("/health").set("Host", "evil.example:47321")
      .expect(403);
    await fixture.client.post("/mcp").set("Host", "evil.example").send({})
      .expect(403);
  });

  it("rejects cross-origin mutations on the web api", async () => {
    const fixture = await createFixture();
    await fixture.client.patch("/api/tasks/task-1")
      .set("Origin", "https://evil.example")
      .send(validMutation)
      .expect(403);
    await fixture.client.patch("/API/tasks/task-1")
      .set("Origin", "https://evil.example")
      .send(validMutation)
      .expect(403);
    const detail = await fixture.client.get("/api/tasks/task-1").expect(200);
    expect(detail.body.task).toMatchObject({ priority: "P2" });
  });

  it("allows same-origin and origin-less mutations", async () => {
    const fixture = await createFixture();
    const port = new URL(fixture.baseUrl).port;
    await fixture.client.patch("/api/tasks/task-1")
      .set("Origin", `http://127.0.0.1:${port}`)
      .send(validMutation)
      .expect(200);
    await fixture.client.patch("/api/tasks/task-1")
      .send({ ...validMutation, operation_id: "op-security-2", expected_version: 1 })
      .expect(200);
  });

  it("accepts loopback hosts regardless of header case", async () => {
    const fixture = await createFixture();
    const port = new URL(fixture.baseUrl).port;
    await fixture.client.get("/health")
      .set("Host", `LOCALHOST:${port}`)
      .expect(200, { ok: true });
    await fixture.client.get("/health")
      .set("Host", `127.0.0.1:${port}`)
      .expect(200, { ok: true });
  });

  it("does not expose mutating verbs on read-only endpoints", async () => {
    const fixture = await createFixture();
    await fixture.client.post("/api/tasks/task-1").expect(404);
    await fixture.client.delete("/api/tasks").expect(404);
  });
});
