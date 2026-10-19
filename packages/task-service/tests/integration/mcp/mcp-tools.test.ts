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
import express, { type Express } from "express";
import { createRuntimeConfig } from "../../../src/config/runtime-config.js";
import { BoardAuthService } from "../../../src/core/board-auth-service.js";
import { RepositoryBootstrapService } from "../../../src/core/repository-bootstrap-service.js";
import { SessionService } from "../../../src/core/session-service.js";
import { TaskService } from "../../../src/core/task-service.js";
import { RegistryService } from "../../../src/core/registry-service.js";
import { mountMcpTransport } from "../../../src/mcp/http-transport.js";
import { SqliteDatabase } from "../../../src/storage/database.js";
import type { ProgressStore } from "../../../src/storage/progress-store.js";

const temporaryDirectories: string[] = [];
const startedAt = "2026-08-17T10:00:00.000Z";
let clockTick = 0;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
}

interface McpFixture {
  app: Express;
  httpServer: Server;
  port: number;
  store: ProgressStore;
  boardAuthService: BoardAuthService;
  repositoryBootstrapService: RepositoryBootstrapService;
  database: SqliteDatabase;
  overviewChangedCount(): number;
  close(): Promise<void>;
  connect(clientName?: string, clientVersion?: string): Promise<Client>;
}

interface McpFixtureOptions {
  enableSyntheticProbe?: boolean;
}

async function createFixture(options: McpFixtureOptions = {}): Promise<McpFixture> {
  const dataDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-"));
  temporaryDirectories.push(dataDir);
  const workDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-repo-"));
  temporaryDirectories.push(workDir);

  const rootPath = join(workDir, "main-repo");
  mkdirSync(rootPath);
  git(rootPath, ["init", "-b", "main"]);
  git(rootPath, ["config", "user.email", "mcp@example.com"]);
  git(rootPath, ["config", "user.name", "MCP Test"]);
  writeFileSync(join(rootPath, "base.txt"), "base\n");
  git(rootPath, ["add", "."]);
  git(rootPath, ["commit", "-m", "base"]);
  git(realpathSync(rootPath), ["worktree", "add", "-b", "feature-a", join(workDir, "wt-a")]);
  const worktreePath = realpathSync(join(workDir, "wt-a"));
  const repositoryPath = realpathSync(rootPath);

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
      path: repositoryPath,
      label: "Project One",
      created_at: startedAt,
      updated_at: startedAt
    });
  });

  const taskService = new TaskService({
    store,
    probe: {
      async inspect(input) {
        if (options.enableSyntheticProbe !== true) {
          throw new Error("probe must not run in the tool catalog fixture");
        }
        return {
          repository_id: input.repository.repository_id,
          repository_path: input.worktree_path,
          worktree_path: input.worktree_path,
          branch: "test",
          head_commit: `test:${input.worktree_path}`,
          changed_files: [],
          captured_at: startedAt
        };
      }
    },
    now: () => new Date(Date.parse(startedAt) + (clockTick += 1_000)).toISOString()
  });
  const sessionService = new SessionService(store, config);
  const registryService = new RegistryService(store, () => new Date().toISOString());
  const boardAuthService = new BoardAuthService(store, {
    now: () => new Date(Date.parse(startedAt) + clockTick).toISOString()
  });
  const repositoryBootstrapService = new RepositoryBootstrapService(
    store,
    sessionService,
    registryService
  );
  let overviewChangedCount = 0;

  const app = express();
  const sessions = mountMcpTransport(app, {
    taskService,
    sessionService,
    registryService,
    boardAuthService,
    repositoryBootstrapService,
    now: () => new Date(Date.parse(startedAt) + (clockTick += 1_000)).toISOString(),
    isRepositoryAllowed: (repositoryId) => store.getRepository(repositoryId) !== undefined,
    getRepositoryPath: (repositoryId) => store.getRepository(repositoryId)?.path,
    getActiveLease: (sessionId) => (
      store.transaction((tx) => tx.getLeaseBySession(sessionId))
    ),
    resolveSessionByTransport: (transportSessionId) => (
      store.transaction((tx) => (
        tx.getSessionByTransportId(transportSessionId)?.session_id
      ))
    ),
    publishOverviewChanged: () => {
      overviewChangedCount += 1;
    }
  });

  const httpServer = createServer(app);
  const address = await new Promise<{ port: number }>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      const bound = httpServer.address();
      if (bound === null || typeof bound === "string") {
        reject(new Error("Expected a TCP address for the MCP test server"));
        return;
      }
      resolve(bound);
    });
  });

  return {
    app,
    httpServer,
    port: address.port,
    store,
    boardAuthService,
    repositoryBootstrapService,
    database,
    overviewChangedCount: () => overviewChangedCount,
    async close() {
      await sessions.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      database.close();
    },
    async connect(clientName = "codex-cli", clientVersion = "0.147.0") {
      const client = new Client({ name: clientName, version: clientVersion });
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${address.port}/mcp`)
      );
      // The concrete transport widens its callbacks with `| undefined`, which
      // exactOptionalPropertyTypes rejects against the Transport interface.
      await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
      return client;
    }
  };
}

interface StructuredBody {
  ok: boolean;
  data?: unknown;
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

async function listToolNames(client: Client): Promise<string[]> {
  const tools = await client.listTools();
  return tools.tools.map((tool) => tool.name);
}

const sessionContextArgs = {
  workspace_path: "/tmp/project-one",
  repository_id: "repo-1",
  worktree_path: "/tmp/project-one/worktrees/feature-a"
};

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("mcp tool catalog over streamable http", () => {
  it("lists the workflow and Board pairing tools with documented annotations", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect();
    try {
      expect((await listToolNames(client)).sort()).toEqual([
        "session_context", "session_rebind", "board_pair", "repository_bootstrap", "repository_register", "repository_rebind", "task_list", "task_get", "task_recovery_get", "operation_result_get", "dependency_repair_list", "dependency_repair_receive",
        "task_conflicts", "dependency_context_get", "dependency_validation_list", "dependency_validation_receive", "dependency_validation_checkpoint", "dependency_validation_complete", "task_attach",
        "task_create", "task_adopt", "task_confirm_decision", "task_start", "task_checkpoint", "task_switch",
        "task_dependencies_update", "task_submit", "task_dependency_validation_request", "project_share_create", "project_share_accept",
        "project_members_list", "project_member_remove", "project_share_revoke"
      ].sort());

      const tools = (await client.listTools()).tools;
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      for (const name of ["task_list", "task_get", "task_recovery_get", "operation_result_get", "dependency_repair_list", "task_conflicts", "dependency_context_get", "dependency_validation_list", "project_members_list"]) {
        expect(byName.get(name)?.annotations, `${name} should be read-only`).toMatchObject({
          readOnlyHint: true
        });
      }
      for (const name of [
        "session_context", "session_rebind", "board_pair", "repository_bootstrap", "repository_register", "repository_rebind", "task_attach", "task_create", "task_adopt",
        "task_confirm_decision", "task_start", "task_checkpoint", "task_switch",
        "dependency_validation_receive", "dependency_validation_checkpoint", "dependency_validation_complete", "dependency_repair_receive",
        "task_dependencies_update", "task_submit", "task_dependency_validation_request", "project_share_create", "project_share_accept",
        "project_member_remove", "project_share_revoke"
      ]) {
        expect(byName.get(name)?.annotations, `${name} should be a non-destructive write`).toMatchObject({
          readOnlyHint: false,
          destructiveHint: false
        });
      }
      expect(byName.get("task_switch")).toMatchObject({
        description: expect.stringContaining("target_worktree_path"),
        inputSchema: {
          properties: {
            target_worktree_path: {
              type: "string",
              minLength: 1
            }
          }
        }
      });
      expect(byName.get("task_switch")?.inputSchema.required)
        .not.toContain("target_worktree_path");
      expect(byName.get("task_confirm_decision")?.description)
        .toContain("current Agent conversation");
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("publishes the workflow instructions", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect();
    try {
      const serverInstructions = client.getInstructions() ?? "";
      expect(serverInstructions).toContain("切换或停止前必须 checkpoint");
      for (const toolName of [
        "dependency_validation_list",
        "dependency_validation_receive",
        "dependency_validation_checkpoint",
        "dependency_validation_complete"
      ]) {
        expect(serverInstructions).toContain(toolName);
      }
      expect(serverInstructions).toContain("rejected requires a reason plus failed evidence");
      expect(serverInstructions).toContain("error leaves the request pending for retry");
      expect(serverInstructions).toContain("structured capped result");
      expect(serverInstructions).toContain("pending_acceptance");
      expect(serverInstructions).toContain("idempotent retry");
      expect(serverInstructions).toContain("read-only compatibility paths");
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("records a directly confirmed decision through MCP and resumes the task", async () => {
    const fixture = await createFixture({ enableSyntheticProbe: true });
    const client = await fixture.connect();
    try {
      const context = await callTool(client, "session_context", {
        ...sessionContextArgs,
        owner: "zhangsan"
      });
      const sessionId = (context.data as { session_id: string }).session_id;
      const created = await callTool(client, "task_create", {
        session_id: sessionId,
        operation_id: "op-create-decision",
        expected_version: 0,
        owner: "zhangsan",
        repository_id: "repo-1",
        title: "Decision task",
        goal: "Confirm one decision in the Agent conversation",
        acceptance_criteria: ["Task resumes after confirmation"],
        next_action: "ask the user",
        priority: "P1"
      });
      const taskId = (created.data as { task_id: string }).task_id;
      await callTool(client, "task_start", {
        session_id: sessionId,
        operation_id: "op-start-decision",
        task_id: taskId,
        expected_version: 0
      });
      await callTool(client, "task_checkpoint", {
        session_id: sessionId,
        operation_id: "op-wait-decision",
        task_id: taskId,
        expected_version: 1,
        checkpoint: {
          completed_items: [],
          current_state: "waiting for user",
          human_context: [],
          confirmed_decisions: [],
          pending_decisions: ["Use SQLite?"],
          blockers: [],
          verification: [],
          next_action: "confirm with user"
        },
        target_status: "waiting_human"
      });

      const confirmationArgs = {
        session_id: sessionId,
        operation_id: "op-confirm-decision",
        task_id: taskId,
        expected_version: 2,
        question: "Use SQLite?",
        decision: "Yes, use SQLite"
      };
      const confirmed = await callTool(client, "task_confirm_decision", confirmationArgs);
      const replayed = await callTool(client, "task_confirm_decision", confirmationArgs);

      expect(confirmed).toMatchObject({
        ok: true,
        data: { task_id: taskId, status: "waiting_human", version: 3 },
        meta: { task_version: 3 },
        next: expect.stringContaining("task_start")
      });
      expect(replayed.data).toEqual(confirmed.data);
      expect(fixture.store.getTaskDetail(taskId)?.checkpoint).toMatchObject({
        pending_decisions: [],
        confirmed_decisions: ["Use SQLite? => Yes, use SQLite"]
      });

      const resumed = await callTool(client, "task_start", {
        session_id: sessionId,
        operation_id: "op-resume-decision",
        task_id: taskId,
        expected_version: 3
      });
      expect(resumed).toMatchObject({
        ok: true,
        data: { task_id: taskId, status: "in_progress", version: 4 }
      });
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("forwards an explicit task_switch worktree and replaces the target scope", async () => {
    const fixture = await createFixture({ enableSyntheticProbe: true });
    const client = await fixture.connect();
    try {
      const currentWorktree = "/tmp/project-one/worktrees/feature-a";
      const targetWorktree = "/tmp/project-one/worktrees/feature-b";
      const context = await callTool(client, "session_context", {
        ...sessionContextArgs,
        worktree_path: currentWorktree
      });
      const sessionId = (context.data as { session_id: string }).session_id;
      const current = await callTool(client, "task_create", {
        session_id: sessionId,
        operation_id: "op-create-current",
        expected_version: 0,
        repository_id: "repo-1",
        title: "Current task",
        goal: "Checkpoint before switching",
        acceptance_criteria: ["Target task starts"],
        next_action: "switch tasks",
        priority: "P1"
      });
      const currentTaskId = (current.data as { task_id: string }).task_id;
      await callTool(client, "task_start", {
        session_id: sessionId,
        operation_id: "op-start-current",
        task_id: currentTaskId,
        expected_version: 0
      });
      const target = await callTool(client, "task_create", {
        session_id: sessionId,
        operation_id: "op-create-target",
        expected_version: 0,
        repository_id: "repo-1",
        title: "Target task",
        goal: "Run in the explicit worktree",
        acceptance_criteria: ["Scope matches target worktree"],
        next_action: "continue in target",
        priority: "P1",
        scopes: [{ scope_type: "worktree_path", scope_value: currentWorktree }]
      });
      const targetTaskId = (target.data as { task_id: string }).task_id;

      const switched = await callTool(client, "task_switch", {
        session_id: sessionId,
        operation_id: "op-switch-explicit-worktree",
        task_id: currentTaskId,
        expected_version: 1,
        checkpoint: {
          completed_items: [],
          current_state: "ready to switch",
          human_context: [],
          confirmed_decisions: [],
          pending_decisions: [],
          blockers: [],
          verification: [],
          next_action: "continue in target"
        },
        target_task_id: targetTaskId,
        target_expected_version: 0,
        target_worktree_path: targetWorktree
      });

      expect(switched.ok).toBe(true);
      expect(switched.data).toMatchObject({
        task_id: targetTaskId,
        previous_worktree_path: currentWorktree,
        worktree_path: targetWorktree
      });
      expect(fixture.store.getTaskDetail(targetTaskId)?.scopes
        .filter((scope) => scope.scope_type === "worktree_path"))
        .toEqual([
          expect.objectContaining({ scope_value: targetWorktree })
        ]);
      expect(fixture.store.transaction((tx) => tx.getSession(sessionId))).toMatchObject({
        workspace_path: targetWorktree,
        worktree_path: targetWorktree
      });
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("registers a session from the transport handshake", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect("codex-cli", "0.147.0");
    try {
      const body = await callTool(client, "session_context", sessionContextArgs);
      expect(body.ok).toBe(true);
      expect(body.data).toMatchObject({
        session_id: expect.any(String),
        repository_id: "repo-1",
        client: { name: "codex-cli", version: "0.147.0", family: "codex" },
        stale: false,
        active_lease: null
      });
      expect(body.meta).toMatchObject({
        request_id: expect.any(String),
        schema_version: "1"
      });
      expect(body.next).toEqual(expect.any(String));
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("binds validation backfill to the calling MCP transport", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect();
    const other = await fixture.connect();
    try {
      const context = await callTool(client, "session_context", { ...sessionContextArgs, owner: "jande" });
      const sessionId = (context.data as { session_id: string }).session_id;
      const args = { session_id: sessionId, operation_id: "request-cycle", task_id: "missing-task", expected_version: 0, verification: [{ command: "npm test", outcome: "passed", summary: "green" }] };
      const wrongTransport = await callTool(other, "task_dependency_validation_request", args);
      expect(wrongTransport.ok).toBe(false);
      expect(wrongTransport.error?.code).toBe("SESSION_MISMATCH");
      const bound = await callTool(client, "task_dependency_validation_request", args);
      expect(bound.ok).toBe(false);
      expect(bound.error?.code).toBe("TASK_NOT_FOUND");
    } finally {
      await client.close();
      await other.close();
      await fixture.close();
    }
  });

  it("pairs the Board only after session_context binds an owner", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect();
    try {
      const unboundPairing = fixture.boardAuthService.createPairing();
      const unbound = await callTool(client, "board_pair", {
        pairing_code: unboundPairing.pairing_code
      });
      expect(unbound.ok).toBe(false);
      expect(unbound.error?.code).toBe("SESSION_NOT_FOUND");

      await callTool(client, "session_context", {
        ...sessionContextArgs,
        owner: "jande"
      });
      const pairing = fixture.boardAuthService.createPairing();
      const approved = await callTool(client, "board_pair", {
        pairing_code: pairing.pairing_code
      });
      expect(approved.ok).toBe(true);
      expect(approved.data).toMatchObject({ paired: true, owner: "jande" });

      const completed = fixture.boardAuthService.completePairing(
        pairing.challenge_id,
        pairing.browser_secret
      );
      expect(completed).toMatchObject({ status: "paired", owner: "jande" });
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("classifies unknown clients as generic_mcp", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect("unknown-agent", "1.2.3");
    try {
      const body = await callTool(client, "session_context", sessionContextArgs);
      expect(body.ok).toBe(true);
      expect(body.data).toMatchObject({
        client: { name: "unknown-agent", family: "generic_mcp" }
      });
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("ignores handshake fields the agent tries to override", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect("codex-cli", "0.147.0");
    try {
      const body = await callTool(client, "session_context", {
        ...sessionContextArgs,
        client_name: "claude-code",
        client_version: "9.9.9",
        protocol_version: "1999-01-01",
        capabilities: { sampling: {} },
        transport_session_id: "spoofed-transport"
      });
      expect(body.ok).toBe(true);
      expect(body.data).toMatchObject({
        client: { name: "codex-cli", version: "0.147.0", family: "codex" }
      });
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("rejects an unregistered repository with REPOSITORY_NOT_ALLOWED", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect();
    try {
      const body = await callTool(client, "session_context", {
        ...sessionContextArgs,
        repository_id: "repo-not-registered"
      });
      expect(body.ok).toBe(false);
      expect(body.error).toMatchObject({
        code: "REPOSITORY_NOT_ALLOWED",
        retryable: false,
        evidence: ["repo-not-registered"]
      });
      expect(body.meta).toMatchObject({ schema_version: "1" });
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("bootstraps an unregistered repository directly from the Agent", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect("codex-cli", "0.147.0");
    const bootstrapArgs = {
      owner: "jande",
      operation_id: "op-bootstrap-new-repository",
      project_name: "Bootstrapped Project",
      repository_id: "repo-bootstrapped",
      repository_name: "Bootstrapped Repository",
      path: "/tmp/bootstrapped-repository",
      workspace_path: "/tmp/bootstrapped-repository",
      worktree_path: "/tmp/bootstrapped-repository"
    };
    try {
      const first = await callTool(client, "repository_bootstrap", bootstrapArgs);
      expect(first.ok).toBe(true);
      expect(first.data).toMatchObject({
        created_project: true,
        project: { name: "Bootstrapped Project" },
        repository: { repository_id: "repo-bootstrapped" },
        session: {
          repository_id: "repo-bootstrapped",
          owner: "jande",
          session_id: expect.any(String)
        }
      });
      expect(fixture.store.getRepository("repo-bootstrapped")).toMatchObject({
        project_id: (first.data as { project: { project_id: string } }).project.project_id
      });
      const retried = await callTool(client, "repository_bootstrap", bootstrapArgs);
      expect(retried.ok).toBe(true);
      expect(retried.data).toEqual(first.data);
      const sessionId = (first.data as { session: { session_id: string } }).session.session_id;
      expect(fixture.store.transaction((tx) => tx.getOperationResult(
        sessionId,
        bootstrapArgs.operation_id
      ))).toMatchObject({
        tool_name: "repository_bootstrap",
        request_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
      });
      const changed = await callTool(client, "repository_bootstrap", {
        ...bootstrapArgs,
        repository_name: "Changed Bootstrap Request"
      });
      expect(changed.ok).toBe(false);
      expect(changed.error?.code).toBe("OPERATION_ID_CONFLICT");

    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("keeps bootstrap independent from browser pairing", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect("codex-cli", "0.147.0");
    try {
      const created = await callTool(client, "repository_bootstrap", {
        owner: "jande",
        operation_id: "op-bootstrap-agent-direct",
        project_name: "Agent Created Project",
        repository_id: "repo-agent-direct",
        repository_name: "Agent Direct",
        path: "/tmp/agent-direct",
        workspace_path: "/tmp/agent-direct",
        worktree_path: "/tmp/agent-direct"
      });
      expect(created.ok).toBe(true);
      expect(created.data).toMatchObject({
        created_project: true,
        repository: { repository_id: "repo-agent-direct" },
        session: { owner: "jande" }
      });
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("rolls back bootstrap project creation when the repository path conflicts", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect("codex-cli", "0.147.0");
    const conflictingPath = fixture.store.getRepository("repo-1")?.path;
    if (conflictingPath === undefined) {
      throw new Error("fixture repository missing");
    }
    try {
      const rejected = await callTool(client, "repository_bootstrap", {
        owner: "jande",
        operation_id: "op-bootstrap-path-conflict",
        project_name: "Rolled Back Project",
        repository_id: "repo-path-conflict",
        repository_name: "Path Conflict",
        path: conflictingPath,
        workspace_path: "/tmp/project-one",
        worktree_path: "/tmp/project-one"
      });
      expect(rejected.ok).toBe(false);
      expect(rejected.error?.code).toBe("REPOSITORY_PATH_CONFLICT");
      expect(fixture.store.getRepository("repo-path-conflict")).toBeUndefined();
      expect(fixture.store.listProjects().some((project) => project.name === "Rolled Back Project"))
        .toBe(false);
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("creates a task and replays the first response for a duplicated operation", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect();
    try {
      const session = await callTool(client, "session_context", sessionContextArgs);
      const sessionId = (session.data as { session_id: string }).session_id;
      const createArgs = {
        session_id: sessionId,
        operation_id: "op-create-1",
        expected_version: 0,
        repository_id: "repo-1",
        title: "Ship the MCP layer",
        goal: "Expose the task workflow over MCP",
        acceptance_criteria: ["MCP integration tests pass"],
        next_action: "register the tools",
        priority: "P1",
        scopes: [{ scope_type: "module_path", scope_value: "src/mcp" }]
      };

      const first = await callTool(client, "task_create", createArgs);
      expect(first.ok).toBe(true);
      expect(first.data).toMatchObject({ status: "backlog", version: 0 });
      expect(first.meta).toMatchObject({ task_version: 0 });

      const retry = await callTool(client, "task_create", createArgs);
      expect(retry.data).toEqual(first.data);

      const recovered = await callTool(client, "operation_result_get", {
        session_id: sessionId,
        operation_id: createArgs.operation_id
      });
      expect(recovered.data).toMatchObject({
        operation_result: {
          source_session_id: sessionId,
          tool_name: "task_create",
          request_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          result: first.data
        }
      });
      const changedRetry = await callTool(client, "task_create", {
        ...createArgs,
        title: "Changed retry"
      });
      expect(changedRetry.ok).toBe(false);
      expect(changedRetry.error?.code).toBe("OPERATION_ID_CONFLICT");
      const crossToolRetry = await callTool(client, "task_attach", {
        session_id: sessionId,
        operation_id: createArgs.operation_id,
        task_id: (first.data as { task_id: string }).task_id,
        expected_version: 0,
        role: "implementer"
      });
      expect(crossToolRetry.ok).toBe(false);
      expect(crossToolRetry.error?.code).toBe("OPERATION_ID_CONFLICT");

      const listed = await callTool(client, "task_list", {});
      const tasks = (listed.data as { tasks: Record<string, unknown>[] }).tasks;
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        goal: "Expose the task workflow over MCP",
        acceptance_criteria: ["MCP integration tests pass"]
      });
      const fetched = await callTool(client, "task_get", {
        task_id: (first.data as { task_id: string }).task_id
      });
      expect(fetched.data).toMatchObject({
        task: {
          goal: "Expose the task workflow over MCP",
          acceptance_criteria: ["MCP integration tests pass"],
          checkpoint: { next_action: "register the tools", current_state: "backlog" },
          scopes: [expect.objectContaining({
            scope_type: "module_path",
            scope_value: "src/mcp"
          })]
        }
      });
      expect(fetched.next).toBe(
        "Attach with task_attach and start the task with task_start when ready."
      );
      const recovery = await callTool(client, "task_recovery_get", {
        session_id: sessionId,
        task_id: (first.data as { task_id: string }).task_id
      });
      expect(recovery.data).toMatchObject({
        recovery: {
          task: { task_id: (first.data as { task_id: string }).task_id, version: 0 },
          evidence_state: "missing",
          active_lease: null,
          next_action: "register the tools"
        }
      });
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("returns a stable TASK_NOT_FOUND for an unknown task", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect();
    try {
      const body = await callTool(client, "task_get", { task_id: "missing-task" });
      expect(body.ok).toBe(false);
      expect(body.error).toMatchObject({
        code: "TASK_NOT_FOUND",
        retryable: false,
        evidence: expect.any(Array),
        recovery_actions: expect.any(Array)
      });
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("rejects task_create when required creation fields are missing", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect();
    try {
      const session = await callTool(client, "session_context", sessionContextArgs);
      const sessionId = (session.data as { session_id: string }).session_id;
      const rejected = await client.callTool({
        name: "task_create",
        arguments: {
          session_id: sessionId,
          operation_id: "op-create-missing-goal",
          expected_version: 0,
          repository_id: "repo-1",
          title: "Missing goal",
          priority: "P1"
        }
      });
      expect(rejected.isError).toBe(true);
      const listed = await callTool(client, "task_list", {});
      expect((listed.data as { tasks: unknown[] }).tasks).toHaveLength(0);
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("adopts a legacy task with scopes and dependencies over MCP", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect();
    try {
      const session = await callTool(client, "session_context", {
        ...sessionContextArgs,
        owner: "legacy-owner"
      });
      const sessionId = (session.data as { session_id: string }).session_id;
      const dependency = await callTool(client, "task_create", {
        session_id: sessionId,
        operation_id: "op-create-dep",
        expected_version: 0,
        repository_id: "repo-1",
        title: "Blocking task",
        goal: "Unblock the legacy adopt",
        acceptance_criteria: ["dependency done"],
        next_action: "hold the dependency",
        priority: "P2"
      });
      const dependencyId = (dependency.data as { task_id: string }).task_id;

      const adopted = await callTool(client, "task_adopt", {
        session_id: sessionId,
        operation_id: "op-adopt-1",
        expected_version: 0,
        legacy_import_key: "legacy-key-1",
        source_session_label: "Legacy session",
        project_id: "project-1",
        repository_id: "repo-1",
        worktree_path: "/tmp/project-one/worktrees/legacy",
        normalized_title: "legacy task",
        title: "Legacy task restored",
        owner: "legacy-owner",
        goal: "Finish the legacy migration",
        acceptance_criteria: ["legacy suite passes"],
        priority: "P1",
        status: "paused",
        checkpoint: {
          completed_items: ["legacy work"],
          current_state: "adopted mid-flight",
          human_context: [],
          confirmed_decisions: [],
          pending_decisions: [],
          blockers: [],
          verification: [],
          next_action: "continue legacy work",
          source: {
            source_type: "legacy_adoption",
            source_session_label: "Legacy session",
            adoption_method: "mcp",
            adopted_at: "2026-08-17T10:00:00.000Z"
          }
        },
        snapshot: { head_commit: "0123456789abcdef0123456789abcdef01234567" },
        scopes: [{ scope_type: "module_path", scope_value: "src/legacy" }],
        dependencies: [dependencyId]
      });
      expect(adopted.ok).toBe(true);
      expect(adopted.data).toMatchObject({ status: "paused", version: 0 });

      const fetched = await callTool(client, "task_get", {
        task_id: (adopted.data as { task_id: string }).task_id
      });
      expect(fetched.data).toMatchObject({
        task: {
          title: "Legacy task restored",
          owner: "legacy-owner",
          goal: "Finish the legacy migration",
          acceptance_criteria: ["legacy suite passes"],
          checkpoint: { next_action: "continue legacy work" },
          scopes: expect.arrayContaining([
            expect.objectContaining({
              scope_type: "module_path",
              scope_value: "src/legacy"
            })
          ])
        }
      });
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("rejects task_conflicts with both or neither of task_id and proposed", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect();
    try {
      const both = await client.callTool({
        name: "task_conflicts",
        arguments: {
          task_id: "some-task",
          proposed: {
            repository_id: "repo-1",
            worktree_path: "/tmp/project-one/worktrees/feature-a"
          }
        }
      });
      expect(both.isError).toBe(true);

      const neither = await client.callTool({
        name: "task_conflicts",
        arguments: {}
      });
      expect(neither.isError).toBe(true);
    } finally {
      await client.close();
      await fixture.close();
    }
  });
});


describe("write tool session binding", () => {
  it("publishes an overview refresh after repository registration", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect("codex-cli", "0.147.0");
    try {
      const context = await callTool(client, "session_context", sessionContextArgs);
      const sessionId = (context.data as { session_id: string }).session_id;
      const before = fixture.overviewChangedCount();

      await callTool(client, "repository_register", {
        session_id: sessionId,
        operation_id: "op-register-overview-refresh",
        project_name: "Project One",
        repository_id: "repo-overview-refresh",
        repository_name: "Overview Refresh",
        path: "/tmp/overview-refresh"
      });

      expect(fixture.overviewChangedCount()).toBe(before + 1);
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("registers a repository under a user-named project and binds it", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect("codex-cli", "0.147.0");
    try {
      const bootstrap = await callTool(client, "session_context", {
        ...sessionContextArgs,
        owner: "jande"
      });
      const sessionId = (bootstrap.data as { session_id: string }).session_id;
      const registrationArgs = {
        session_id: sessionId,
        operation_id: "op-register-agent-repository",
        project_name: "Project One",
        repository_id: "repo-agent-registered",
        repository_name: "Agent Registered",
        path: "/tmp/agent-registered"
      };
      const registered = await callTool(client, "repository_register", registrationArgs);
      const reg = registered.data as {
        project: { project_id: string; name: string };
        created_project: boolean;
      };
      // matched the existing project by name, no new project created
      expect(reg.project.project_id).toBe("project-1");
      expect(reg.created_project).toBe(false);

      const retried = await callTool(client, "repository_register", registrationArgs);
      expect(retried.data).toEqual(registered.data);
      expect(fixture.store.transaction((tx) => tx.getOperationResult(
        sessionId,
        registrationArgs.operation_id
      ))).toMatchObject({
        tool_name: "repository_register",
        request_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
      });
      const changedReplay = await callTool(client, "repository_register", {
        ...registrationArgs,
        repository_name: "Changed Replay"
      });
      expect(changedReplay.ok).toBe(false);
      expect(changedReplay.error?.code).toBe("OPERATION_ID_CONFLICT");

      const repositoryClient = await fixture.connect("codex-cli", "0.147.0");
      try {
        const bound = await callTool(repositoryClient, "session_context", {
          workspace_path: "/tmp/agent-registered",
          repository_id: "repo-agent-registered",
          worktree_path: "/tmp/agent-registered",
          owner: "jande"
        });
        expect((bound.data as { repository_id: string }).repository_id)
          .toBe("repo-agent-registered");
      } finally {
        await repositoryClient.close();
      }

      const duplicate = await callTool(client, "repository_register", {
        session_id: sessionId,
        operation_id: "op-register-agent-repository-conflict",
        project_name: "Project One",
        repository_id: "repo-agent-registered",
        repository_name: "再次登记",
        path: "/tmp/other"
      });
      expect(duplicate.ok).toBe(false);
      expect(duplicate.error?.code).toBe("REPOSITORY_EXISTS");

      const fresh = await callTool(client, "repository_register", {
        session_id: sessionId,
        operation_id: "op-register-fresh-repository",
        project_name: "全新项目",
        repository_id: "repo-fresh",
        repository_name: "Fresh",
        path: "/tmp/fresh"
      });
      const freshData = fresh.data as {
        project: { project_id: string; name: string; created_by: string | null };
        created_project: boolean;
      };
      expect(freshData.created_project).toBe(true);
      expect(freshData.project.name).toBe("全新项目");
      expect(freshData.project.created_by).toBe("jande");
      expect(fixture.store.listProjects()).toEqual(expect.arrayContaining([
        expect.objectContaining({ project_id: freshData.project.project_id, created_by: "jande" })
      ]));

      const projectConflict = await callTool(client, "repository_register", {
        session_id: sessionId,
        operation_id: "op-register-project-conflict",
        project_id: "project-other",
        project_name: "Project One",
        repository_id: "repo-project-conflict",
        repository_name: "Wrong Project",
        path: "/tmp/project-conflict"
      });
      expect(projectConflict.ok).toBe(false);
      expect(projectConflict.error?.code).toBe("PROJECT_CONFLICT");
      expect(fixture.store.getRepository("repo-project-conflict")).toBeUndefined();
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("records the declared owner and warns on a worktree outside the registered path", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect("codex-cli", "0.147.0");
    try {
      const mismatched = await callTool(client, "session_context", {
        ...sessionContextArgs,
        owner: "zhangsan",
        worktree_path: "/somewhere/else/entirely"
      });
      const data = mismatched.data as { session_id: string; warnings?: string[] };
      expect(data.warnings?.[0]).toContain("not under the registered path");

      const session = fixture.store.transaction((tx) => tx.getSession(data.session_id));
      expect(session?.owner).toBe("zhangsan");

      const registeredPath = fixture.store.getRepository("repo-1")?.path;
      if (registeredPath === undefined) {
        throw new Error("fixture repository missing");
      }
      const matched = await callTool(client, "session_rebind", {
        session_id: data.session_id,
        operation_id: "op-rebind-matched-worktree",
        repository_id: "repo-1",
        owner: "zhangsan",
        expected_worktree_path: "/somewhere/else/entirely",
        workspace_path: `${registeredPath}/worktrees/feature-a`,
        worktree_path: `${registeredPath}/worktrees/feature-a`
      });
      expect((matched.data as { warnings?: string[] }).warnings).toBeUndefined();
      expect(matched.data).toMatchObject({
        session_id: data.session_id,
        previous_worktree_path: "/somewhere/else/entirely",
        worktree_path: `${registeredPath}/worktrees/feature-a`,
        rebound: true
      });
      expect(fixture.store.transaction((tx) => tx.getOperationResult(
        data.session_id,
        "op-rebind-matched-worktree"
      ))).toMatchObject({
        tool_name: "session_rebind",
        request_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
      });
      const changedReplay = await callTool(client, "session_rebind", {
        session_id: data.session_id,
        operation_id: "op-rebind-matched-worktree",
        repository_id: "repo-1",
        owner: "zhangsan",
        expected_worktree_path: `${registeredPath}/worktrees/feature-a`,
        workspace_path: `${registeredPath}/worktrees/feature-b`,
        worktree_path: `${registeredPath}/worktrees/feature-b`
      });
      expect(changedReplay.ok).toBe(false);
      expect(changedReplay.error?.code).toBe("OPERATION_ID_CONFLICT");
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("rebinds a moved repository path without changing repository_id", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect("codex-cli", "0.147.0");
    try {
      const context = await callTool(client, "session_context", {
        ...sessionContextArgs,
        owner: "jande"
      });
      const sessionId = (context.data as { session_id: string }).session_id;
      const rebound = await callTool(client, "repository_rebind", {
        session_id: sessionId,
        operation_id: "op-rebind-moved-repository",
        owner: "jande",
        repository_id: "repo-1",
        path: "/tmp/project-one-moved",
        repository_name: "Project One moved"
      });
      expect(rebound.ok).toBe(true);
      expect(rebound.data).toMatchObject({
        rebound: true,
        repository: {
          repository_id: "repo-1",
          path: "/tmp/project-one-moved",
          label: "Project One moved"
        }
      });
      expect(fixture.store.getRepository("repo-1")?.path).toBe("/tmp/project-one-moved");
      expect(fixture.store.transaction((tx) => tx.getOperationResult(
        sessionId,
        "op-rebind-moved-repository"
      ))).toMatchObject({
        tool_name: "repository_rebind",
        request_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
      });
      const changedReplay = await callTool(client, "repository_rebind", {
        session_id: sessionId,
        operation_id: "op-rebind-moved-repository",
        owner: "jande",
        repository_id: "repo-1",
        path: "/tmp/project-one-moved-again"
      });
      expect(changedReplay.ok).toBe(false);
      expect(changedReplay.error?.code).toBe("OPERATION_ID_CONFLICT");
      const conflict = await callTool(client, "repository_rebind", {
        session_id: sessionId,
        operation_id: "op-rebind-wrong-owner",
        owner: "other-owner",
        repository_id: "repo-1",
        path: "/tmp/project-one-other"
      });
      expect(conflict.ok).toBe(false);
      expect(conflict.error?.code).toBe("OWNER_MISMATCH");
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("rejects a write tool call that claims another session's id", async () => {
    const fixture = await createFixture();
    const owner = await fixture.connect("codex-cli", "0.147.0");
    const intruder = await fixture.connect("codex-cli", "0.147.0");

    const ownerSession = await callTool(owner, "session_context", sessionContextArgs);
    const ownerSessionId = (ownerSession.data as { session_id: string }).session_id;
    await callTool(owner, "task_create", {
      session_id: ownerSessionId,
      operation_id: "op-owner-create",
      expected_version: 0,
      repository_id: "repo-1",
      title: "Binding guard task",
      goal: "verify impersonation is rejected",
      acceptance_criteria: ["intruder cannot write"],
      next_action: "attempt writes",
      priority: "P2"
    });

    const intruderSession = await callTool(intruder, "session_context", sessionContextArgs);
    const intruderSessionId = (intruderSession.data as { session_id: string }).session_id;
    expect(intruderSessionId).not.toBe(ownerSessionId);

    const list = await callTool(intruder, "task_list", { repository_id: "repo-1" });
    const tasks = (list.data as { tasks: { task_id: string }[] }).tasks;
    const taskId = tasks[0]?.task_id;
    if (taskId === undefined) {
      throw new Error("created task not listed");
    }

    const checkpointAttempt = await callTool(intruder, "task_checkpoint", {
      session_id: ownerSessionId,
      operation_id: "op-intrude-1",
      task_id: taskId,
      expected_version: 0,
      checkpoint: {
        completed_items: [],
        current_state: "forged",
        human_context: [],
        confirmed_decisions: [],
        pending_decisions: [],
        blockers: [],
        verification: [],
        next_action: "nope"
      }
    });
    expect(checkpointAttempt.error?.code).toBe("SESSION_MISMATCH");

    await fixture.close();
  });

  it("exposes dependency validation list, receive, checkpoint, and complete tools", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect();
    try {
      const session = await callTool(client, "session_context", {
        ...sessionContextArgs,
        owner: "owner-downstream"
      });
      const downstreamSession = (session.data as { session_id: string }).session_id;
      fixture.store.transaction((tx) => {
        tx.insertTask({
          task_id: "task-upstream",
          repository_id: "repo-1",
          owner: "owner-upstream",
          title: "Upstream",
          status: "done",
          priority: "P1",
          goal: "Provide dependency",
          acceptance_criteria: ["done"],
          created_at: startedAt,
          updated_at: startedAt
        });
        tx.insertTask({
          task_id: "task-downstream",
          repository_id: "repo-1",
          owner: "owner-downstream",
          title: "Downstream",
          status: "pending_acceptance",
          priority: "P1",
          goal: "Validate dependency",
          acceptance_criteria: ["validated"],
          created_at: startedAt,
          updated_at: startedAt
        });
        tx.insertTaskDependency({
          task_id: "task-downstream",
          depends_on_task_id: "task-upstream",
          created_at: startedAt
        });
        tx.insertDependencyValidation({
          validation_id: "validation-1",
          upstream_task_id: "task-upstream",
          downstream_task_id: "task-downstream",
          cycle: 1,
          status: "pending",
          requested_by_actor: "human",
          requested_by_owner: "owner-upstream",
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
            downstream_repository_id: "repo-1",
            cycle: 1,
            target_revision: "seed-revision",
            target_head_commit: "seed-revision",
            scope: {
              worktree_path: "/tmp/project-one/worktrees/feature-a",
              changed_files: ["src/example.ts"],
              module_paths: ["src"]
            },
            command: "npm test",
            commands: ["npm test"],
            timeout_strategy: { kind: "rolling_lease", lease_ttl_ms: 1_800_000, max_attempts: 2 },
            human_context: [{ secret: "MCP_SECRET_MUST_NOT_ESCAPE" }],
            blockers: ["MCP_SECRET_MUST_NOT_ESCAPE"]
          }
        });
      });

      const listed = await callTool(client, "dependency_validation_list", {
        session_id: downstreamSession,
        owner: "owner-downstream",
        repository_id: "repo-1"
      });
      expect(listed.ok).toBe(true);
      const listedValidations = (listed.data as { validations: Array<Record<string, unknown>> }).validations;
      expect(listedValidations).toHaveLength(1);
      expect(listedValidations[0]).toMatchObject({
        validation_spec: expect.objectContaining({
          schema_version: "dependency-validation.v1",
          upstream_task_version: 0,
          target_revision: "seed-revision",
          command: "npm test",
          timeout_strategy: expect.objectContaining({ kind: "rolling_lease" })
        })
      });
      expect(JSON.stringify(listedValidations[0])).not.toContain("MCP_SECRET_MUST_NOT_ESCAPE");

      const received = await callTool(client, "dependency_validation_receive", {
        session_id: downstreamSession,
        operation_id: "mcp-receive-1",
        validation_id: "validation-1",
        owner: "owner-downstream"
      });
      expect(received.data).toMatchObject({ status: "claimed", validation_id: "validation-1" });
      const runId = (received.data as { run_id: string }).run_id;
      const duplicateReceive = await callTool(client, "dependency_validation_receive", {
        session_id: downstreamSession,
        operation_id: "mcp-receive-1",
        validation_id: "validation-1",
        owner: "owner-downstream"
      });
      expect(duplicateReceive).toEqual(received);

      const wrongSessionClient = await fixture.connect();
      try {
        const wrongSession = await callTool(wrongSessionClient, "session_context", {
          ...sessionContextArgs,
          owner: "owner-downstream"
        });
        const wrongSessionResult = await callTool(wrongSessionClient, "dependency_validation_checkpoint", {
          session_id: downstreamSession,
          operation_id: "mcp-wrong-session",
          validation_id: "validation-1",
          run_id: runId,
          owner: "owner-downstream",
          progress: { completed: [] }
        });
        expect(wrongSessionResult.ok).toBe(false);
        expect(wrongSessionResult.error?.code).toBe("SESSION_MISMATCH");
      } finally {
        await wrongSessionClient.close();
      }

      const checkpoint = await callTool(client, "dependency_validation_checkpoint", {
        session_id: downstreamSession,
        operation_id: "mcp-checkpoint-1",
        validation_id: "validation-1",
        run_id: runId,
        owner: "owner-downstream",
        progress: { completed: ["unit"] }
      });
      expect(checkpoint.ok).toBe(true);

      const missingReason = await callTool(client, "dependency_validation_complete", {
        session_id: downstreamSession,
        operation_id: "mcp-rejected-no-reason",
        validation_id: "validation-1",
        run_id: runId,
        owner: "owner-downstream",
        status: "rejected",
        verification: [{
          command: "npm test",
          outcome: "failed",
          summary: "failed",
          revision: "agent-revision",
          target_revision: "seed-revision",
          worktree_path: "/tmp/project-one/worktrees/feature-a"
        }]
      });
      expect(missingReason.ok).toBe(false);
      expect(missingReason.error?.code).toBe("DEPENDENCY_VALIDATION_REQUIRED");

      const completed = await callTool(client, "dependency_validation_complete", {
        session_id: downstreamSession,
        operation_id: "mcp-complete-1",
        validation_id: "validation-1",
        run_id: runId,
        owner: "owner-downstream",
        status: "passed",
        verification: [{
          command: "npm test",
          outcome: "passed",
          summary: "ok",
          revision: "agent-revision",
          target_revision: "seed-revision",
          worktree_path: "/tmp/project-one/worktrees/feature-a"
        }]
      });
      expect(completed.data).toMatchObject({ run: { status: "passed" }, request: { status: "passed" } });
      expect(completed.data).toMatchObject({
        run: {
          verification: [{
            command: "npm test",
            revision: "agent-revision",
            target_revision: "seed-revision",
            worktree_path: "/tmp/project-one/worktrees/feature-a"
          }]
        }
      });
      expect(JSON.stringify(completed.data)).not.toContain("MCP_SECRET_MUST_NOT_ESCAPE");

      const retried = await callTool(client, "dependency_validation_complete", {
        session_id: downstreamSession,
        operation_id: "mcp-complete-1",
        validation_id: "validation-1",
        run_id: runId,
        owner: "owner-downstream",
        status: "passed",
        verification: [{
          command: "npm test",
          outcome: "passed",
          summary: "ok",
          revision: "agent-revision",
          target_revision: "seed-revision",
          worktree_path: "/tmp/project-one/worktrees/feature-a"
        }]
      });
      expect(retried).toEqual(completed);
      const alteredReplay = await callTool(client, "dependency_validation_complete", {
        session_id: downstreamSession,
        operation_id: "mcp-complete-1",
        validation_id: "validation-1",
        run_id: runId,
        owner: "owner-downstream",
        status: "error",
        verification: [],
        reason: "altered retry payload"
      });
      expect(alteredReplay.ok).toBe(false);
      expect(alteredReplay.error?.code).toBe("OPERATION_ID_CONFLICT");

      const wrongOwner = await callTool(client, "dependency_validation_list", {
        session_id: downstreamSession,
        owner: "other-owner",
        repository_id: "repo-1"
      });
      expect(wrongOwner.ok).toBe(false);
      expect(wrongOwner.error?.code).toBe("OWNER_MISMATCH");
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("returns structured lease errors for an expired dependency validation run", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect();
    try {
      const context = await callTool(client, "session_context", { ...sessionContextArgs, owner: "owner-downstream" });
      const sessionId = (context.data as { session_id: string }).session_id;
      fixture.store.transaction((tx) => {
        tx.insertTask({ task_id: "expired-upstream", repository_id: "repo-1", owner: "owner-upstream", title: "Expired upstream", status: "done", priority: "P1", goal: "g", acceptance_criteria: ["a"], created_at: startedAt, updated_at: startedAt });
        tx.insertTask({ task_id: "expired-downstream", repository_id: "repo-1", owner: "owner-downstream", title: "Expired downstream", status: "pending_acceptance", priority: "P1", goal: "g", acceptance_criteria: ["a"], created_at: startedAt, updated_at: startedAt });
        tx.insertTaskDependency({ task_id: "expired-downstream", depends_on_task_id: "expired-upstream", created_at: startedAt });
        tx.insertDependencyValidation({
          validation_id: "expired-validation",
          upstream_task_id: "expired-upstream",
          downstream_task_id: "expired-downstream",
          cycle: 1,
          status: "pending",
          requested_by_actor: "human",
          requested_by_owner: "owner-upstream",
          requested_at: startedAt,
          request_read_at: null,
          responded_by_owner: null,
          response_reason: null,
          responded_at: null,
          response_read_at: null,
          validation_spec: {
            schema_version: "dependency-validation.v1",
            upstream_task_id: "expired-upstream",
            upstream_task_version: 0,
            upstream_repository_id: "repo-1",
            downstream_task_id: "expired-downstream",
            downstream_repository_id: "repo-1",
            cycle: 1,
            target_revision: "seed-revision",
            target_head_commit: "seed-revision",
            scope: { worktree_path: "/tmp/project-one/worktrees/feature-a", changed_files: [], module_paths: [] },
            command: "npm test",
            commands: ["npm test"],
            timeout_strategy: { kind: "rolling_lease", lease_ttl_ms: 1_800_000, max_attempts: 2 }
          }
        });
      });
      const received = await callTool(client, "dependency_validation_receive", { session_id: sessionId, operation_id: "expired-receive", validation_id: "expired-validation", owner: "owner-downstream" });
      const runId = (received.data as { run_id: string }).run_id;
      fixture.store.transaction((tx) => {
        const run = tx.getDependencyValidationRun(runId)!;
        tx.updateDependencyValidationRun({ ...run, expires_at: "2020-01-01T00:00:00.000Z" }, run.status);
      });
      const raw = await client.callTool({ name: "dependency_validation_checkpoint", arguments: { session_id: sessionId, operation_id: "expired-checkpoint", validation_id: "expired-validation", run_id: runId, owner: "owner-downstream", progress: {} } });
      expect(raw.isError).toBe(true);
      const body = raw.structuredContent as StructuredBody;
      expect(body.error).toMatchObject({ code: "TASK_LEASE_CONFLICT", retryable: true, recovery_actions: expect.any(Array) });
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("returns a structured stale-cycle error when receiving an old validation request", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect();
    try {
      const context = await callTool(client, "session_context", { ...sessionContextArgs, owner: "owner-downstream" });
      const sessionId = (context.data as { session_id: string }).session_id;
      fixture.store.transaction((tx) => {
        tx.insertTask({ task_id: "stale-upstream", repository_id: "repo-1", owner: "owner-upstream", title: "Stale upstream", status: "done", priority: "P1", goal: "g", acceptance_criteria: ["a"], created_at: startedAt, updated_at: startedAt });
        tx.insertTask({ task_id: "stale-downstream", repository_id: "repo-1", owner: "owner-downstream", title: "Stale downstream", status: "pending_acceptance", priority: "P1", goal: "g", acceptance_criteria: ["a"], created_at: startedAt, updated_at: startedAt });
        tx.insertTaskDependency({ task_id: "stale-downstream", depends_on_task_id: "stale-upstream", created_at: startedAt });
        for (const [validation_id, cycle] of [["stale-validation-old", 1], ["stale-validation-new", 2]] as const) {
          tx.insertDependencyValidation({
            validation_id,
            upstream_task_id: "stale-upstream",
            downstream_task_id: "stale-downstream",
            cycle,
            status: "pending",
            requested_by_actor: "human",
            requested_by_owner: "owner-upstream",
            requested_at: startedAt,
            request_read_at: null,
            responded_by_owner: null,
            response_reason: null,
            responded_at: null,
            response_read_at: null,
            validation_spec: {
              schema_version: "dependency-validation.v1",
              upstream_task_id: "stale-upstream",
              upstream_task_version: 0,
              upstream_repository_id: "repo-1",
              downstream_task_id: "stale-downstream",
              downstream_repository_id: "repo-1",
              cycle,
              target_revision: `seed-revision-${cycle}`,
              target_head_commit: `seed-revision-${cycle}`,
              scope: { worktree_path: "/tmp/project-one/worktrees/feature-a", changed_files: [], module_paths: [] },
              command: "npm test",
              commands: ["npm test"],
              timeout_strategy: { kind: "rolling_lease", lease_ttl_ms: 1_800_000, max_attempts: 2 }
            }
          });
        }
      });
      const listed = await callTool(client, "dependency_validation_list", {
        session_id: sessionId,
        owner: "owner-downstream",
        repository_id: "repo-1"
      });
      const listedCycles = (listed.data as { validations: Array<{ validation_id: string; cycle: number }> }).validations;
      expect(listedCycles).toHaveLength(1);
      expect(listedCycles[0]).toMatchObject({ validation_id: "stale-validation-new", cycle: 2 });
      const raw = await client.callTool({ name: "dependency_validation_receive", arguments: { session_id: sessionId, operation_id: "stale-receive", validation_id: "stale-validation-old", owner: "owner-downstream" } });
      expect(raw.isError).toBe(true);
      const body = raw.structuredContent as StructuredBody;
      expect(body.error).toMatchObject({ code: "TASK_VERSION_CONFLICT", retryable: false, recovery_actions: expect.any(Array) });
    } finally {
      await client.close();
      await fixture.close();
    }
  });
});

describe("archived projects over MCP", () => {
  const archivedAt = "2026-10-16T02:00:00.000Z";

  function archiveProjectOne(fixture: McpFixture): void {
    const outcome = fixture.store.transaction((tx) => (
      tx.archiveProject("project-1", "jande", archivedAt)
    ));
    expect(outcome.status).toBe("archived");
  }

  it("rejects task_create and session_rebind from a session bound before the archive", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect();
    try {
      const bound = await callTool(client, "session_context", { ...sessionContextArgs, owner: "jande" });
      expect(bound.ok).toBe(true);
      const sessionId = (bound.data as { session_id: string }).session_id;
      archiveProjectOne(fixture);

      const created = await callTool(client, "task_create", {
        session_id: sessionId,
        operation_id: "op-create-archived",
        expected_version: 0,
        owner: "jande",
        repository_id: "repo-1",
        title: "Should not land",
        goal: "Archived projects are read-only",
        acceptance_criteria: ["rejected"],
        next_action: "none",
        priority: "P2"
      });
      expect(created.ok).toBe(false);
      expect(created.error?.code).toBe("PROJECT_ARCHIVED");
      expect(created.error?.recovery_actions.join(" ")).toContain("Restore");
      expect(fixture.store.listTasks({ repositoryId: "repo-1" })).toEqual([]);

      const rebound = await callTool(client, "session_rebind", {
        session_id: sessionId,
        operation_id: "op-rebind-archived",
        repository_id: "repo-1",
        owner: "jande",
        expected_worktree_path: sessionContextArgs.worktree_path,
        workspace_path: "/tmp/project-one/worktrees/feature-b",
        worktree_path: "/tmp/project-one/worktrees/feature-b"
      });
      expect(rebound.ok).toBe(false);
      expect(rebound.error?.code).toBe("PROJECT_ARCHIVED");
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("returns PROJECT_ARCHIVED instead of not-registered from session_context", async () => {
    const fixture = await createFixture();
    archiveProjectOne(fixture);
    const client = await fixture.connect();
    try {
      const bound = await callTool(client, "session_context", { ...sessionContextArgs, owner: "jande" });
      expect(bound.ok).toBe(false);
      expect(bound.error?.code).toBe("PROJECT_ARCHIVED");
      expect(bound.error?.evidence).toContain("project-1");
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it("rejects registering or bootstrapping a new repository into an archived project", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect();
    try {
      const bound = await callTool(client, "session_context", { ...sessionContextArgs, owner: "jande" });
      const sessionId = (bound.data as { session_id: string }).session_id;
      archiveProjectOne(fixture);

      const byName = await callTool(client, "repository_register", {
        session_id: sessionId,
        operation_id: "op-register-archived-name",
        project_name: "Project One",
        repository_id: "repo-into-archived",
        repository_name: "Into Archived",
        path: "/tmp/into-archived"
      });
      expect(byName.ok).toBe(false);
      expect(byName.error?.code).toBe("PROJECT_ARCHIVED");

      const byId = await callTool(client, "repository_register", {
        session_id: sessionId,
        operation_id: "op-register-archived-id",
        project_id: "project-1",
        project_name: "Project One",
        repository_id: "repo-into-archived",
        repository_name: "Into Archived",
        path: "/tmp/into-archived"
      });
      expect(byId.error?.code).toBe("PROJECT_ARCHIVED");

      const bootstrapClient = await fixture.connect();
      try {
        const bootstrapped = await callTool(bootstrapClient, "repository_bootstrap", {
          owner: "jande",
          operation_id: "op-bootstrap-archived",
          project_name: "Project One",
          repository_id: "repo-bootstrap-archived",
          repository_name: "Bootstrap Archived",
          path: "/tmp/bootstrap-archived",
          workspace_path: "/tmp/bootstrap-archived",
          worktree_path: "/tmp/bootstrap-archived"
        });
        expect(bootstrapped.ok).toBe(false);
        expect(bootstrapped.error?.code).toBe("PROJECT_ARCHIVED");
      } finally {
        await bootstrapClient.close();
      }

      expect(fixture.store.getRepository("repo-into-archived")).toBeUndefined();
      expect(fixture.store.getRepository("repo-bootstrap-archived")).toBeUndefined();
      // Registration never restores the project implicitly.
      expect(fixture.store.getProject("project-1")?.archived_at).toBe(archivedAt);
    } finally {
      await client.close();
      await fixture.close();
    }
  });
});
