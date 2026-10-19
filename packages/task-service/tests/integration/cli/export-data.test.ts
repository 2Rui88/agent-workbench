/// <reference types="node" />

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeConfig } from "../../../src/config/runtime-config.js";
import { SqliteDatabase } from "../../../src/storage/database.js";
import * as migrationModule from "../../../src/storage/migrations.js";

const startedAt = "2026-08-17T10:00:00.000Z";

const temporaryDirectories: string[] = [];

function temporaryDataDir(prefix: string): string {
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(dataDir);
  return dataDir;
}

function seedWorkflowState(dataDir: string): void {
  const config = createRuntimeConfig(dataDir);
  const database = SqliteDatabase.open(config);
  try {
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
      tx.insertSession({
        session_id: "session-1",
        repository_id: "repo-1",
        label: "codex-cli 0.147.0",
        started_at: startedAt,
        transport_session_id: "transport-1"
      });
      const checkpoint = {
        completed_items: ["drafted the export tool"],
        current_state: "in_progress",
        human_context: [],
        confirmed_decisions: [],
        pending_decisions: [],
        blockers: [],
        verification: [],
        next_action: "export the audit trail"
      };
      tx.insertTask({
        task_id: "task-1",
        repository_id: "repo-1",
        session_id: "session-1",
        title: "Export task",
        status: "in_progress",
        priority: "P1",
        goal: "Prove exports carry the audit trail",
        acceptance_criteria: ["export contains every table"],
        checkpoint,
        created_at: startedAt,
        updated_at: startedAt
      });
      tx.insertTask({
        task_id: "task-2",
        repository_id: "repo-1",
        title: "Dependency task",
        status: "backlog",
        priority: "P2",
        created_at: startedAt,
        updated_at: startedAt
      });
      tx.putLease({
        task_id: "task-1",
        session_id: "session-1",
        acquired_at: startedAt,
        heartbeat_at: startedAt,
        expires_at: "2026-08-17T10:30:00.000Z"
      });
      tx.insertCheckpoint({
        checkpoint_id: "checkpoint-1",
        task_id: "task-1",
        session_id: "session-1",
        payload: checkpoint,
        created_at: startedAt
      });
      tx.insertRepoSnapshot({
        snapshot_id: "snapshot-1",
        task_id: "task-1",
        checkpoint_id: "checkpoint-1",
        repository_id: "repo-1",
        repository_path: "/tmp/project-one",
        head_commit: "a1b2c3d4",
        captured_at: startedAt
      });
      tx.appendTaskEvent({
        event_id: "event-1",
        task_id: "task-1",
        session_id: "session-1",
        event_type: "task_started",
        payload: { actor: "agent" },
        created_at: startedAt
      });
      tx.insertHumanDecision({
        decision_id: "decision-1",
        task_id: "task-1",
        session_id: "session-1",
        question: "Ship the export?",
        status: "pending",
        created_at: startedAt
      });
      tx.insertTaskDependency({
        task_id: "task-1",
        depends_on_task_id: "task-2",
        created_at: startedAt
      });
      tx.putOperationResult({
        session_id: "session-1",
        operation_id: "op-secret-1",
        result: {
          authorization: "Bearer secret-operation-token",
          note: "sensitive operation response content"
        },
        created_at: startedAt
      });
      tx.insertDependencyValidation({
        validation_id: "validation-1",
        upstream_task_id: "task-2",
        downstream_task_id: "task-1",
        cycle: 1,
        status: "rejected",
        requested_by_actor: "agent",
        requested_by_owner: "owner-upstream",
        requested_at: startedAt,
        request_read_at: startedAt,
        responded_by_owner: "owner-downstream",
        response_reason: "Downstream contract check failed",
        responded_at: startedAt,
        response_read_at: null,
        validation_spec: { acceptance_criteria: ["contract check passes"] }
      });
      tx.insertDependencyValidationRun({
        run_id: "run-1",
        validation_id: "validation-1",
        attempt: 1,
        status: "rejected",
        owner: "owner-downstream",
        session_id: "session-1",
        worktree_path: "/tmp/project-one",
        heartbeat_at: startedAt,
        expires_at: "2026-08-17T10:30:00.000Z",
        started_at: startedAt,
        completed_at: startedAt,
        verification: [],
        failure_reason: "Downstream contract check failed",
        error_reason: null,
        operation_id: "validation-op-1",
        created_at: startedAt,
        updated_at: startedAt
      });
      tx.insertDependencyRepairRequest({
        repair_id: "repair-1",
        validation_id: "validation-1",
        source_run_id: "run-1",
        ctx_id: null,
        upstream_task_id: "task-2",
        downstream_task_id: "task-1",
        cycle: 1,
        status: "pending",
        rejection_reason: "Downstream contract check failed",
        claimed_session_id: null,
        claimed_worktree_path: null,
        claimed_at: null,
        resolved_at: null,
        superseded_at: null,
        created_at: startedAt,
        updated_at: startedAt
      });
    });
  } finally {
    database.close();
  }
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runExportCli(dataDir: string, outputPath: string): Promise<CliResult> {
  const child: ChildProcess = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      join(process.cwd(), "src/cli/export-data.ts"),
      "--output",
      outputPath
    ],
    {
      env: { ...process.env, TASK_MCP_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("data:export cli", () => {
  it("exports every audit table with the schema version and no operation responses", async () => {
    const dataDir = temporaryDataDir("cli-session-task-mcp-export-");
    seedWorkflowState(dataDir);
    const outputDir = temporaryDataDir("cli-session-task-mcp-export-out-");
    const outputPath = join(outputDir, "export.json");

    const result = await runExportCli(dataDir, outputPath);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const exportText = readFileSync(outputPath, "utf8");
    const payload = JSON.parse(exportText) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "checkpoints",
      "decisions",
      "dependencies",
      "events",
      "projects",
      "repair_requests",
      "repositories",
      "schema_version",
      "session_events",
      "snapshots",
      "tasks"
    ]);
    expect(payload.schema_version).toBe(migrationModule.migrationMetadata.length);
    expect(payload.projects).toEqual([
      expect.objectContaining({ project_id: "project-1", name: "Project One" })
    ]);
    expect(payload.repositories).toEqual([
      expect.objectContaining({
        repository_id: "repo-1",
        path: "/tmp/project-one"
      })
    ]);
    expect(payload.tasks).toHaveLength(2);
    expect(payload.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        task_id: "task-1",
        title: "Export task",
        status: "in_progress",
        version: 0,
        checkpoint: expect.objectContaining({ next_action: "export the audit trail" })
      })
    ]));
    expect(payload.checkpoints).toEqual([
      expect.objectContaining({ checkpoint_id: "checkpoint-1", task_id: "task-1" })
    ]);
    expect(payload.snapshots).toEqual([
      expect.objectContaining({ snapshot_id: "snapshot-1", head_commit: "a1b2c3d4" })
    ]);
    expect(payload.events).toEqual([
      expect.objectContaining({ event_id: "event-1", event_type: "task_started" })
    ]);
    expect(payload.session_events).toEqual([]);
    expect(payload.decisions).toEqual([
      expect.objectContaining({ decision_id: "decision-1", status: "pending" })
    ]);
    expect(payload.dependencies).toEqual([
      {
        task_id: "task-1",
        depends_on_task_id: "task-2",
        created_at: startedAt,
        ctx_id: "repo-1:task-2:repo-1:task-1:1",
        generation: 1
      }
    ]);
    expect(payload.repair_requests).toEqual([
      expect.objectContaining({
        repair_id: "repair-1",
        status: "pending",
        rejection_reason: "Downstream contract check failed"
      })
    ]);

    // Operation responses stay out of the export: neither the table name nor
    // the sensitive payload markers may appear anywhere in the file.
    expect(exportText).not.toContain("operation_results");
    expect(exportText).not.toContain("op-secret-1");
    expect(exportText).not.toContain("secret-operation-token");

    // The atomic temp-file plus rename dance must leave no residue behind.
    expect(readdirSync(outputDir)).toEqual(["export.json"]);
  }, 30_000);

  it("refuses to overwrite an existing output file with a non-zero exit", async () => {
    const dataDir = temporaryDataDir("cli-session-task-mcp-export-");
    seedWorkflowState(dataDir);
    const outputDir = temporaryDataDir("cli-session-task-mcp-export-out-");
    const outputPath = join(outputDir, "export.json");

    const first = await runExportCli(dataDir, outputPath);
    expect(first.code).toBe(0);
    const original = readFileSync(outputPath, "utf8");

    const second = await runExportCli(dataDir, outputPath);
    expect(second.code).not.toBe(0);
    expect(second.stderr).toMatch(/exist|overwrite|refus/i);
    expect(readFileSync(outputPath, "utf8")).toBe(original);
    expect(readdirSync(outputDir)).toEqual(["export.json"]);
  }, 30_000);

  it("fails clearly when no platform database exists yet", async () => {
    const dataDir = temporaryDataDir("cli-session-task-mcp-export-empty-");
    const outputDir = temporaryDataDir("cli-session-task-mcp-export-out-");
    const outputPath = join(outputDir, "export.json");

    const result = await runExportCli(dataDir, outputPath);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/database/i);
    expect(existsSync(outputPath)).toBe(false);
  }, 30_000);
});
