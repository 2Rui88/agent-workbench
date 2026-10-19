/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import { createRuntimeConfig } from "../../../src/config/runtime-config.js";
import { BoardAuthService } from "../../../src/core/board-auth-service.js";
import { SessionService } from "../../../src/core/session-service.js";
import { RegistryService } from "../../../src/core/registry-service.js";
import { TaskService } from "../../../src/core/task-service.js";
import { RepoProbe } from "../../../src/repo/repo-probe.js";
import { SqliteDatabase } from "../../../src/storage/database.js";
import type { ActiveTaskLease, ProgressStore } from "../../../src/storage/progress-store.js";
import { mountMcpTransport } from "../../../src/mcp/http-transport.js";
import { createHttpApp } from "../../../src/server/http-app.js";

const temporaryDirectories: string[] = [];
const startedAt = "2026-08-17T10:00:00.000Z";
let clockTick = 0;

function nowIso(): string {
  return new Date(Date.parse(startedAt) + (clockTick += 1_000)).toISOString();
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const bound = probe.address();
      if (bound === null || typeof bound === "string") {
        reject(new Error("Expected a TCP address for the port probe"));
        return;
      }
      probe.close(() => resolve(bound.port));
    });
  });
}

interface TransportFixture {
  port: number;
  store: ProgressStore;
  database: SqliteDatabase;
  worktreePath: string;
  close(): Promise<void>;
  connect(clientName?: string, clientVersion?: string): Promise<Client>;
  leaseOf(sessionId: string): ActiveTaskLease | undefined;
}

async function createFixture(): Promise<TransportFixture> {
  const dataDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-"));
  temporaryDirectories.push(dataDir);
  const workDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-repo-"));
  temporaryDirectories.push(workDir);

  const rootPath = realpathSync((() => {
    const path = join(workDir, "main-repo");
    mkdirSync(path);
    git(path, ["init", "-b", "main"]);
    git(path, ["config", "user.email", "mcp@example.com"]);
    git(path, ["config", "user.name", "MCP Transport Test"]);
    writeFileSync(join(path, "base.txt"), "base\n");
    git(path, ["add", "."]);
    git(path, ["commit", "-m", "base"]);
    return path;
  })());
  git(rootPath, ["worktree", "add", "-b", "feature-a", join(workDir, "wt-a")]);
  const worktreePath = realpathSync(join(workDir, "wt-a"));

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
      path: rootPath,
      label: "Project One",
      created_at: startedAt,
      updated_at: startedAt
    });
  });

  const taskService = new TaskService({ store, probe: new RepoProbe(), now: nowIso });
  const sessionService = new SessionService(store, config);
  const boardAuthService = new BoardAuthService(store, { now: nowIso });

  const app = express();
  const sessions = mountMcpTransport(app, {
    taskService,
    sessionService,
    boardAuthService,
    now: nowIso,
    registryService: new RegistryService(store, () => new Date().toISOString()),
    isRepositoryAllowed: (repositoryId) => store.getRepository(repositoryId) !== undefined,
    getActiveLease: (sessionId) => store.transaction((tx) => tx.getLeaseBySession(sessionId)),
    resolveSessionByTransport: (transportSessionId) => (
      store.transaction((tx) => (
        tx.getSessionByTransportId(transportSessionId)?.session_id
      ))
    )
  });

  const httpServer = createServer(app);
  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      const bound = httpServer.address();
      if (bound === null || typeof bound === "string") {
        reject(new Error("Expected a TCP address for the MCP test server"));
        return;
      }
      resolve(bound.port);
    });
  });

  return {
    port,
    store,
    database,
    worktreePath,
    async close() {
      await sessions.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      database.close();
    },
    async connect(clientName = "codex-cli", clientVersion = "0.147.0") {
      const client = new Client({ name: clientName, version: clientVersion });
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`)
      );
      // The concrete transport widens its callbacks with `| undefined`, which
      // exactOptionalPropertyTypes rejects against the Transport interface.
      await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
      return client;
    },
    leaseOf(sessionId: string) {
      return store.transaction((tx) => tx.getLeaseBySession(sessionId));
    }
  };
}

interface StructuredBody {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    evidence: string[];
    recovery_actions: string[];
    current_version?: string;
  };
  meta?: { request_id?: string; schema_version?: string; task_version?: number };
  next?: string;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<StructuredBody> {
  const result = await client.callTool({ name, arguments: args });
  return result.structuredContent as StructuredBody;
}

function checkpoint() {
  return {
    completed_items: ["drafted the transport layer"],
    current_state: "streamable http mounted",
    human_context: [],
    confirmed_decisions: [],
    pending_decisions: [],
    blockers: [],
    verification: [],
    next_action: "checkpoint before switching"
  };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("streamable http transport sessions", () => {
  it("initializes over POST /mcp and binds a transport session", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect();
    try {
      expect(client.getServerVersion()?.name).toBe("cli-session-task-mcp");
      const transportSessionId = (client.transport as StreamableHTTPClientTransport)
        .sessionId;
      expect(transportSessionId).toEqual(expect.any(String));
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("keeps the old lease until a fresh transport declares explicit succession", async () => {
    const fixture = await createFixture();
    const first = await fixture.connect();
    const sessionBody = await callTool(first, "session_context", {
      workspace_path: "/tmp/project-one",
      repository_id: "repo-1",
      worktree_path: fixture.worktreePath,
      owner: "jande"
    });
    const firstSessionId = (sessionBody.data as { session_id: string }).session_id;
    const created = await callTool(first, "task_create", {
      session_id: firstSessionId,
      operation_id: "op-create-1",
      expected_version: 0,
      repository_id: "repo-1",
      title: "Hold the worktree lease",
      goal: "Prove leases survive transport teardown",
      acceptance_criteria: ["lease kept after DELETE"],
      next_action: "start the task",
      priority: "P1"
    });
    const taskId = (created.data as { task_id: string }).task_id;
    const started = await callTool(first, "task_start", {
      session_id: firstSessionId,
      operation_id: "op-start-1",
      expected_version: 0,
      task_id: taskId
    });
    expect(started.ok).toBe(true);
    expect(started.data).toMatchObject({ status: "in_progress", version: 1 });
    expect(fixture.leaseOf(firstSessionId)).toMatchObject({ task_id: taskId });

    const transportSessionId = (first.transport as StreamableHTTPClientTransport)
      .sessionId;
    await (first.transport as StreamableHTTPClientTransport).terminateSession();

    // Deleting the transport session releases the connection object only;
    // the platform lease of the old session survives.
    expect(fixture.leaseOf(firstSessionId)).toMatchObject({ task_id: taskId });
    const replay = await fetch(`http://127.0.0.1:${fixture.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": transportSessionId ?? "unknown"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping", params: {} })
    });
    expect(replay.status).toBe(404);
    await first.close();

    // A fresh transport session maps to a fresh platform session and cannot
    // simply take over the old lease.
    const second = await fixture.connect();
    try {
      const secondSession = await callTool(second, "session_context", {
        workspace_path: "/tmp/project-one",
        repository_id: "repo-1",
        worktree_path: fixture.worktreePath,
        owner: "jande"
      });
      const secondSessionId = (secondSession.data as { session_id: string }).session_id;
      expect(secondSessionId).not.toBe(firstSessionId);

      const implicitTakeover = await callTool(second, "task_checkpoint", {
        session_id: secondSessionId,
        operation_id: "op-checkpoint-2",
        task_id: taskId,
        expected_version: 1,
        checkpoint: {
          completed_items: ["reconnected after transport rotation"],
          current_state: "successor checkpoint",
          human_context: [],
          confirmed_decisions: [],
          pending_decisions: [],
          blockers: [],
          verification: [],
          next_action: "continue working"
        }
      });
      expect(implicitTakeover.ok).toBe(false);
      expect(implicitTakeover.error).toMatchObject({ code: "TASK_LEASE_CONFLICT" });
      expect(fixture.leaseOf(firstSessionId)).toMatchObject({
        task_id: taskId,
        generation: 1
      });

      const successor = await fixture.connect();
      try {
        const successorSession = await callTool(successor, "session_context", {
          workspace_path: "/tmp/project-one",
          repository_id: "repo-1",
          worktree_path: fixture.worktreePath,
          owner: "jande",
          successor_session_id: firstSessionId,
          successor_ctx_id: "transport-rotation-1"
        });
        const successorSessionId = (successorSession.data as { session_id: string }).session_id;
        const succeeded = await callTool(successor, "task_checkpoint", {
          session_id: successorSessionId,
          operation_id: "op-checkpoint-explicit-successor",
          task_id: taskId,
          expected_version: 2,
          checkpoint: {
            completed_items: ["resumed through explicit succession"],
            current_state: "explicit successor checkpoint",
            human_context: [],
            confirmed_decisions: [],
            pending_decisions: [],
            blockers: [],
            verification: [],
            next_action: "continue working"
          }
        });
        expect(succeeded.ok).toBe(true);
        expect(fixture.leaseOf(successorSessionId)).toMatchObject({
          task_id: taskId,
          generation: 2
        });
      } finally {
        await successor.close();
      }
    } finally {
      await second.close();
      await fixture.close();
    }
  });

  it("recovers predecessor results in the successor direction and permanently fences predecessor writes", async () => {
    const fixture = await createFixture();
    const predecessor = await fixture.connect();
    const successor = await fixture.connect();
    try {
      const predecessorContext = await callTool(predecessor, "session_context", {
        workspace_path: "/tmp/project-one",
        repository_id: "repo-1",
        worktree_path: fixture.worktreePath,
        owner: "jande"
      });
      const predecessorId = (predecessorContext.data as { session_id: string }).session_id;
      const created = await callTool(predecessor, "task_create", {
        session_id: predecessorId,
        operation_id: "op-before-succession",
        expected_version: 0,
        repository_id: "repo-1",
        title: "Explicit succession fence",
        goal: "Fence the replaced executor",
        acceptance_criteria: ["predecessor cannot write after succession"],
        next_action: "start",
        priority: "P1"
      });
      const taskId = (created.data as { task_id: string }).task_id;
      await callTool(predecessor, "task_start", {
        session_id: predecessorId,
        operation_id: "op-start-before-succession",
        task_id: taskId,
        expected_version: 0
      });

      const successorContext = await callTool(successor, "session_context", {
        workspace_path: "/tmp/project-one",
        repository_id: "repo-1",
        worktree_path: fixture.worktreePath,
        owner: "jande",
        successor_session_id: predecessorId,
        successor_ctx_id: "ctx-explicit-succession"
      });
      const successorId = (successorContext.data as { session_id: string }).session_id;
      const recovered = await callTool(successor, "operation_result_get", {
        session_id: successorId,
        operation_id: "op-before-succession"
      });
      expect(recovered.data).toMatchObject({
        operation_result: {
          source_session_id: predecessorId,
          tool_name: "task_create",
          result: created.data
        }
      });

      const successorOnly = await callTool(successor, "task_create", {
        session_id: successorId,
        operation_id: "op-successor-only",
        expected_version: 0,
        repository_id: "repo-1",
        title: "Successor-only result",
        goal: "Prove recovery does not traverse forward",
        acceptance_criteria: ["predecessor cannot read successor-only operation"],
        next_action: "wait",
        priority: "P2",
        scopes: [{ scope_type: "module_path", scope_value: "src/successor-only" }]
      });
      expect(successorOnly.ok).toBe(true);
      const forwardLookup = await callTool(predecessor, "operation_result_get", {
        session_id: predecessorId,
        operation_id: "op-successor-only"
      });
      expect(forwardLookup.data).toEqual({ operation_result: null });

      const paused = await callTool(successor, "task_checkpoint", {
        session_id: successorId,
        operation_id: "op-successor-pause",
        task_id: taskId,
        expected_version: 2,
        checkpoint: checkpoint(),
        target_status: "paused"
      });
      expect(paused.ok).toBe(true);
      expect(fixture.leaseOf(successorId)).toBeUndefined();

      const predecessorRestart = await callTool(predecessor, "task_start", {
        session_id: predecessorId,
        operation_id: "op-predecessor-restart",
        task_id: taskId,
        expected_version: 3
      });
      expect(predecessorRestart.ok).toBe(false);
      expect(predecessorRestart.error?.code).toBe("SESSION_SUPERSEDED");
      const predecessorReconnect = await callTool(predecessor, "session_context", {
        workspace_path: "/tmp/project-one",
        repository_id: "repo-1",
        worktree_path: fixture.worktreePath,
        owner: "jande"
      });
      expect(predecessorReconnect.ok).toBe(false);
      expect(predecessorReconnect.error?.code).toBe("SESSION_SUPERSEDED");
      expect(fixture.store.transaction((tx) => tx.getSession(predecessorId)))
        .toMatchObject({ successor_session_id: successorId, stale_at: expect.any(String) });
    } finally {
      await successor.close();
      await predecessor.close();
      await fixture.close();
    }
  });

  it("runs the full checkpoint and submit flow over the transport", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect();
    try {
      const session = await callTool(client, "session_context", {
        workspace_path: "/tmp/project-one",
        repository_id: "repo-1",
        worktree_path: fixture.worktreePath
      });
      const sessionId = (session.data as { session_id: string }).session_id;
      const created = await callTool(client, "task_create", {
        session_id: sessionId,
        operation_id: "op-create-1",
        expected_version: 0,
        repository_id: "repo-1",
        title: "Drive the full agent flow",
        goal: "Exercise checkpoint and submit over the transport",
        acceptance_criteria: ["task reaches pending_acceptance"],
        next_action: "start the task",
        priority: "P1"
      });
      const taskId = (created.data as { task_id: string }).task_id;
      await callTool(client, "task_start", {
        session_id: sessionId,
        operation_id: "op-start-1",
        expected_version: 0,
        task_id: taskId
      });
      const checkpointed = await callTool(client, "task_checkpoint", {
        session_id: sessionId,
        operation_id: "op-checkpoint-1",
        expected_version: 1,
        task_id: taskId,
        checkpoint: checkpoint(),
        target_status: "paused"
      });
      expect(checkpointed.ok).toBe(true);
      expect(checkpointed.data).toMatchObject({ status: "paused", version: 2 });
      expect(checkpointed.meta).toMatchObject({ task_version: 2 });

      const resumed = await callTool(client, "task_start", {
        session_id: sessionId,
        operation_id: "op-start-2",
        expected_version: 2,
        task_id: taskId
      });
      expect(resumed.data).toMatchObject({ status: "in_progress", version: 3 });

      const verification = [{
        command: "npm test",
        outcome: "passed" as const,
        summary: "all suites green"
      }];
      const verified = await callTool(client, "task_checkpoint", {
        session_id: sessionId,
        operation_id: "op-checkpoint-verified",
        expected_version: 3,
        task_id: taskId,
        checkpoint: { ...checkpoint(), verification },
        target_status: "verifying"
      });
      expect(verified.data).toMatchObject({ status: "verifying", version: 4 });

      const submitted = await callTool(client, "task_submit", {
        session_id: sessionId,
        operation_id: "op-submit-1",
        expected_version: 4,
        task_id: taskId,
        verification
      });
      expect(submitted.ok).toBe(true);
      expect(submitted.data).toMatchObject({ status: "pending_acceptance" });
      expect(fixture.leaseOf(sessionId)).toBeUndefined();
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("lets a new transport recover an in-progress task after its lease expires", async () => {
    const fixture = await createFixture();
    const first = await fixture.connect();
    const second = await fixture.connect();
    try {
      const context = {
        workspace_path: "/tmp/project-one",
        repository_id: "repo-1",
        worktree_path: fixture.worktreePath
      };
      const firstSession = await callTool(first, "session_context", context);
      const firstSessionId = (firstSession.data as { session_id: string }).session_id;
      const created = await callTool(first, "task_create", {
        session_id: firstSessionId,
        operation_id: "op-expired-create",
        expected_version: 0,
        repository_id: "repo-1",
        title: "Recover expired lease",
        goal: "Keep work moving after a lost transport",
        acceptance_criteria: ["new session checkpoints without manual release"],
        next_action: "start work",
        priority: "P1"
      });
      const taskId = (created.data as { task_id: string }).task_id;
      const started = await callTool(first, "task_start", {
        session_id: firstSessionId,
        operation_id: "op-expired-start",
        expected_version: 0,
        task_id: taskId
      });
      expect(started.data).toMatchObject({ status: "in_progress", version: 1 });
      fixture.store.transaction((tx) => {
        tx.deleteLeaseByTask(taskId);
        tx.putLease({
          task_id: taskId,
          session_id: firstSessionId,
          acquired_at: "2026-08-17T08:00:00.000Z",
          heartbeat_at: "2026-08-17T08:00:00.000Z",
          expires_at: "2026-08-17T09:00:00.000Z"
        });
      });

      const nextSession = await callTool(second, "session_context", context);
      const nextSessionId = (nextSession.data as { session_id: string }).session_id;
      const recovered = await callTool(second, "task_start", {
        session_id: nextSessionId,
        operation_id: "op-expired-recover",
        expected_version: 1,
        task_id: taskId
      });
      expect(recovered.data).toMatchObject({ status: "in_progress", version: 2 });
      expect(fixture.leaseOf(nextSessionId)).toMatchObject({ task_id: taskId });
      const checkpointed = await callTool(second, "task_checkpoint", {
        session_id: nextSessionId,
        operation_id: "op-expired-checkpoint",
        expected_version: 2,
        task_id: taskId,
        checkpoint: checkpoint()
      });
      expect(checkpointed.data).toMatchObject({ status: "in_progress", version: 3 });
      expect(fixture.store.transaction((tx) => tx.listRecentTaskEvents(taskId, 5)))
        .toContainEqual(expect.objectContaining({ event_type: "task_lease_recovered" }));
    } finally {
      await second.close();
      await first.close();
      await fixture.close();
    }
  });

  it("checks conflicts for an existing task and for a proposed scope", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect();
    try {
      const session = await callTool(client, "session_context", {
        workspace_path: "/tmp/project-one",
        repository_id: "repo-1",
        worktree_path: fixture.worktreePath
      });
      const sessionId = (session.data as { session_id: string }).session_id;
      const created = await callTool(client, "task_create", {
        session_id: sessionId,
        operation_id: "op-create-1",
        expected_version: 0,
        repository_id: "repo-1",
        title: "Hold the worktree",
        goal: "Prove both conflict modes",
        acceptance_criteria: ["conflict modes verified"],
        next_action: "start the task",
        priority: "P1"
      });
      const taskId = (created.data as { task_id: string }).task_id;
      await callTool(client, "task_start", {
        session_id: sessionId,
        operation_id: "op-start-1",
        expected_version: 0,
        task_id: taskId
      });

      const taskMode = await callTool(client, "task_conflicts", { task_id: taskId });
      expect(taskMode.ok).toBe(true);
      expect(taskMode.data).toMatchObject({ conflict: { level: "none" } });

      const contested = await callTool(client, "task_conflicts", {
        proposed: {
          repository_id: "repo-1",
          worktree_path: fixture.worktreePath,
          changed_files: ["src/anything.ts"]
        }
      });
      expect(contested.ok).toBe(true);
      expect(contested.data).toMatchObject({ conflict: { level: "hard" } });

      const free = await callTool(client, "task_conflicts", {
        proposed: {
          repository_id: "repo-1",
          worktree_path: "/nowhere/contested",
          scopes: [{ scope_type: "module_path", scope_value: "src/elsewhere" }]
        }
      });
      expect(free.ok).toBe(true);
      expect(free.data).toMatchObject({ conflict: { level: "none" } });
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("rejects http methods other than POST, GET, and DELETE on /mcp", async () => {
    const fixture = await createFixture();
    try {
      const response = await fetch(`http://127.0.0.1:${fixture.port}/mcp`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
      expect(response.status).toBe(405);
    } finally {
      await fixture.close();
    }
  });

  it("rejects a GET stream without a transport session", async () => {
    const fixture = await createFixture();
    try {
      const response = await fetch(`http://127.0.0.1:${fixture.port}/mcp`, {
        method: "GET",
        headers: { accept: "text/event-stream" }
      });
      expect(response.status).toBe(405);
    } finally {
      await fixture.close();
    }
  });

  it("stays reachable when mounted after the fully assembled web app", async () => {
    // main.ts mounts the MCP transport on the app returned by createHttpApp,
    // which already installed its 404 catch-all; /mcp requests must fall
    // through that catch-all instead of being shadowed by it.
    const dataDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-"));
    temporaryDirectories.push(dataDir);
    const config = createRuntimeConfig(dataDir);
    const database = SqliteDatabase.open(config);
    const store = database.createProgressStore();
    const taskService = new TaskService({ store, probe: new RepoProbe(), now: nowIso });
    const sessionService = new SessionService(store, config);
    const boardAuthService = new BoardAuthService(store, { now: nowIso });
    const port = await reservePort();
    const app = createHttpApp({
      taskService,
      sessionService,
      store,
      registryService: new RegistryService(store, () => new Date().toISOString()),
      boardAuthService,
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      now: nowIso
    });
    const mounted = mountMcpTransport(app, {
      taskService,
      sessionService,
      boardAuthService,
      now: nowIso,
      registryService: new RegistryService(store, () => new Date().toISOString()),
    isRepositoryAllowed: (repositoryId) => store.getRepository(repositoryId) !== undefined,
      getActiveLease: (sessionId) => store.transaction((tx) => tx.getLeaseBySession(sessionId)),
      resolveSessionByTransport: (transportSessionId) => (
        store.transaction((tx) => (
          tx.getSessionByTransportId(transportSessionId)?.session_id
        ))
      )
    });
    const httpServer = createServer(app);
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, "127.0.0.1", () => resolve());
    });

    const client = new Client({ name: "codex-cli", version: "0.147.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`)
    );
    try {
      await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
      expect(client.getServerVersion()?.name).toBe("cli-session-task-mcp");
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
    } finally {
      await client.close();
      await mounted.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      database.close();
    }
  });
});
