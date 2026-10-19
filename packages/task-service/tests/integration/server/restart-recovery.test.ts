/// <reference types="node" />

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeConfig } from "../../../src/config/runtime-config.js";
import { SessionService } from "../../../src/core/session-service.js";
import { SqliteDatabase } from "../../../src/storage/database.js";
import type { ProgressStore } from "../../../src/storage/progress-store.js";

const startedAt = "2026-08-17T10:00:00.000Z";
const leaseExpiresAt = "2026-08-17T10:30:00.000Z";

const temporaryDirectories: string[] = [];

function temporaryDataDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-restart-"));
  temporaryDirectories.push(dataDir);
  return dataDir;
}

function inspectDatabase<T>(databasePath: string, work: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return work(database);
  } finally {
    database.close();
  }
}

function seedWorkflowState(store: ProgressStore): void {
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
      transport_session_id: "transport-1",
      client_name: "codex_cli",
      client_version: "0.147.0",
      protocol_version: "2025-06-18",
      worktree_path: "/tmp/project-one/worktrees/feature",
      last_activity_at: startedAt
    });
    const checkpoint = {
      completed_items: ["drafted the persistence layer"],
      current_state: "in_progress",
      human_context: [],
      confirmed_decisions: [],
      pending_decisions: [],
      blockers: [],
      verification: [],
      next_action: "checkpoint before restart"
    };
    for (const task of [
      {
        task_id: "task-1",
        repository_id: "repo-1",
        session_id: "session-1",
        owner: "upstream-owner",
        title: "Restart recovery task",
        status: "in_progress" as const,
        priority: "P1" as const,
        goal: "Prove restarts preserve workflow state",
        acceptance_criteria: ["task survives a reopen"],
        checkpoint,
        created_at: startedAt,
        updated_at: startedAt
      },
      {
        task_id: "task-2",
        repository_id: "repo-1",
        owner: "owner-1",
        title: "Blocking dependency task",
        status: "backlog" as const,
        priority: "P2" as const,
        created_at: startedAt,
        updated_at: startedAt
      }
    ]) {
      tx.insertTask(task);
    }
    tx.putLease({
      task_id: "task-1",
      session_id: "session-1",
      acquired_at: startedAt,
      heartbeat_at: startedAt,
      expires_at: leaseExpiresAt
    });
    tx.insertCheckpoint({
      checkpoint_id: "checkpoint-1",
      task_id: "task-1",
      session_id: "session-1",
      payload: checkpoint,
      created_at: startedAt
    });
    tx.putOperationResult({
      session_id: "session-1",
      operation_id: "operation-before-restart",
      tool_name: "task_checkpoint",
      request_hash: `sha256:${"d".repeat(64)}`,
      result: { task_id: "task-1", status: "in_progress", version: 1 },
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
    tx.insertTaskDependency({
      task_id: "task-2",
      depends_on_task_id: "task-1",
      created_at: startedAt
    });
    tx.insertDependencyValidation({
      validation_id: "validation-restart",
      upstream_task_id: "task-1",
      downstream_task_id: "task-2",
      cycle: 3,
      status: "pending",
      requested_by_actor: "agent",
      requested_by_owner: "owner-1",
      requested_at: startedAt,
      request_read_at: null,
      responded_by_owner: null,
      response_reason: null,
      responded_at: null,
      response_read_at: null,
      validation_spec: {
        schema_version: "dependency-validation.v1",
        upstream_task_id: "task-1",
        upstream_task_version: 0,
        upstream_repository_id: "repo-1",
        downstream_task_id: "task-2",
        downstream_repository_id: "repo-1",
        cycle: 3,
        target_revision: "a1b2c3d4",
        target_head_commit: "a1b2c3d4",
        scope: {
          worktree_path: "/tmp/project-one/worktrees/feature",
          changed_files: ["src/persistence.ts"],
          module_paths: ["src/storage"]
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
      run_id: "run-restart-error",
      validation_id: "validation-restart",
      attempt: 1,
      status: "error",
      owner: "owner-1",
      session_id: "session-1",
      worktree_path: "/tmp/project-one/worktrees/feature",
      heartbeat_at: startedAt,
      expires_at: startedAt,
      started_at: startedAt,
      completed_at: startedAt,
      verification: [],
      progress: { step: "bootstrap" },
      failure_reason: null,
      error_reason: "provider unavailable",
      operation_id: "run-op-1",
      created_at: startedAt,
      updated_at: startedAt
    });
    tx.insertDependencyValidationRun({
      run_id: "run-restart-active",
      validation_id: "validation-restart",
      attempt: 2,
      status: "running",
      owner: "owner-1",
      session_id: "session-1",
      worktree_path: "/tmp/project-one/worktrees/feature",
      heartbeat_at: "2026-08-17T10:20:00.000Z",
      expires_at: leaseExpiresAt,
      started_at: "2026-08-17T10:10:00.000Z",
      completed_at: null,
      verification: [{
        command: "npm test",
        outcome: "not_run",
        summary: "running",
        revision: "agent-revision-2",
        target_revision: "a1b2c3d4",
        worktree_path: "/tmp/project-one/worktrees/feature"
      }],
      progress: { step: "integration", completed: 1 },
      failure_reason: null,
      error_reason: null,
      operation_id: "run-op-2",
      created_at: "2026-08-17T10:10:00.000Z",
      updated_at: "2026-08-17T10:20:00.000Z"
    });
    tx.insertDependencyRepairRequest({
      repair_id: "repair-restart",
      validation_id: "validation-restart",
      source_run_id: "run-restart-active",
      ctx_id: null,
      upstream_task_id: "task-1",
      downstream_task_id: "task-2",
      cycle: 3,
      status: "pending",
      rejection_reason: "contract mismatch",
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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("restart recovery", () => {
  it("preserves tasks, checkpoints, snapshots, events, and dependencies across a reopen", () => {
    const dataDir = temporaryDataDir();
    const config = createRuntimeConfig(dataDir);

    const first = SqliteDatabase.open(config);
    seedWorkflowState(first.createProgressStore());
    first.close();

    const reopened = SqliteDatabase.open(config);
    const store = reopened.createProgressStore();
    try {
      const detail = store.getTaskDetail("task-1");
      expect(store.transaction((tx) => tx.getOperationResult(
        "session-1",
        "operation-before-restart"
      ))).toMatchObject({
        tool_name: "task_checkpoint",
        request_hash: `sha256:${"d".repeat(64)}`,
        result: { task_id: "task-1", status: "in_progress", version: 1 }
      });
      expect(detail).toMatchObject({
        task_id: "task-1",
        title: "Restart recovery task",
        status: "in_progress",
        priority: "P1",
        version: 0,
        session_id: "session-1",
        checkpoint: { next_action: "checkpoint before restart" }
      });
      expect(store.listTasks({ repositoryId: "repo-1" })).toHaveLength(2);

      const validation = store.getDependencyValidation("validation-restart");
      expect(validation).toMatchObject({
        validation_id: "validation-restart",
        cycle: 3,
        status: "pending",
        latest_run: {
          run_id: "run-restart-active",
          attempt: 2,
          status: "running",
          heartbeat_at: "2026-08-17T10:20:00.000Z",
          expires_at: leaseExpiresAt,
          progress: { step: "integration", completed: 1 }
        }
      });
      expect(validation?.runs).toEqual([
        expect.objectContaining({ run_id: "run-restart-active", attempt: 2 }),
        expect.objectContaining({
          run_id: "run-restart-error",
          attempt: 1,
          status: "error"
        })
      ]);
      expect(
        store.transaction((tx) => tx.listDependencyValidationRuns("validation-restart"))
      ).toEqual([
        expect.objectContaining({
          run_id: "run-restart-active",
          attempt: 2,
          status: "running"
        }),
        expect.objectContaining({
          run_id: "run-restart-error",
          attempt: 1,
          status: "error",
          error_reason: "provider unavailable"
        })
      ]);
      expect(store.listDependencyRepairRequests("upstream-owner", "repo-1"))
        .toEqual([expect.objectContaining({
          repair_id: "repair-restart",
          validation_id: "validation-restart",
          status: "pending",
          rejection_reason: "contract mismatch"
        })]);

      expect(inspectDatabase(config.databasePath, (database) => ({
        checkpoints: database.prepare(
          "SELECT checkpoint_id, task_id FROM checkpoints"
        ).all(),
        snapshots: database.prepare(
          "SELECT snapshot_id, head_commit FROM repo_snapshots"
        ).all(),
        events: database.prepare(
          "SELECT event_id, event_type FROM task_events"
        ).all(),
        dependencies: database.prepare(
          "SELECT task_id, depends_on_task_id FROM task_dependencies"
        ).all(),
        validation: database.prepare(
          "SELECT validation_id, cycle, status FROM dependency_validations"
        ).all(),
        validationRuns: database.prepare(
          "SELECT run_id, attempt, status, progress_json FROM dependency_validation_runs"
          + " ORDER BY attempt"
        ).all(),
        repairs: database.prepare(
          "SELECT repair_id, validation_id, status FROM dependency_repair_requests"
        ).all()
      }))).toEqual({
        checkpoints: [{ checkpoint_id: "checkpoint-1", task_id: "task-1" }],
        snapshots: [{ snapshot_id: "snapshot-1", head_commit: "a1b2c3d4" }],
        events: [{ event_id: "event-1", event_type: "task_started" }],
        dependencies: [
          { task_id: "task-2", depends_on_task_id: "task-1" }
        ],
        validation: [
          { validation_id: "validation-restart", cycle: 3, status: "pending" }
        ],
        validationRuns: [
          {
            run_id: "run-restart-error",
            attempt: 1,
            status: "error",
            progress_json: JSON.stringify({ step: "bootstrap" })
          },
          {
            run_id: "run-restart-active",
            attempt: 2,
            status: "running",
            progress_json: JSON.stringify({ step: "integration", completed: 1 })
          }
        ],
        repairs: [{
          repair_id: "repair-restart",
          validation_id: "validation-restart",
          status: "pending"
        }]
      });
    } finally {
      reopened.close();
    }

    // Reopening an already migrated database must not re-run migrations, so
    // no pre-migration backup directory may appear.
    expect(existsSync(join(dataDir, "backups"))).toBe(false);
  });

  it("keeps the original lease untouched instead of transferring or dropping it", () => {
    const dataDir = temporaryDataDir();
    const config = createRuntimeConfig(dataDir);

    const first = SqliteDatabase.open(config);
    seedWorkflowState(first.createProgressStore());
    first.close();

    const reopened = SqliteDatabase.open(config);
    try {
      const lease = reopened.createProgressStore().transaction((tx) => (
        tx.getLeaseByTask("task-1")
      ));
      expect(lease).toEqual({
        task_id: "task-1",
        session_id: "session-1",
        acquired_at: startedAt,
        heartbeat_at: startedAt,
        expires_at: leaseExpiresAt,
        generation: 1
      });

      expect(inspectDatabase(config.databasePath, (database) => ({
        leaseRows: database.prepare(
          "SELECT task_id, session_id, acquired_at, heartbeat_at, expires_at"
          + " FROM active_task_leases ORDER BY task_id"
        ).all(),
        sessionState: database.prepare(
          "SELECT stale_at, ended_at FROM sessions WHERE session_id = 'session-1'"
        ).all(),
        taskSession: database.prepare(
          "SELECT status, session_id FROM tasks WHERE task_id = 'task-1'"
        ).all()
      }))).toEqual({
        leaseRows: [{
          task_id: "task-1",
          session_id: "session-1",
          acquired_at: startedAt,
          heartbeat_at: startedAt,
          expires_at: leaseExpiresAt
        }],
        // The reopen neither marks the session stale nor manufactures any
        // lease-transfer audit trail; the lease awaits recovery, not migration.
        sessionState: [{ stale_at: null, ended_at: null }],
        taskSession: [{ status: "in_progress", session_id: "session-1" }]
      });
    } finally {
      reopened.close();
    }
  });

  it("marks an inactive session stale after restart without disturbing its lease", () => {
    const dataDir = temporaryDataDir();
    const config = createRuntimeConfig(dataDir);

    const first = SqliteDatabase.open(config);
    seedWorkflowState(first.createProgressStore());
    first.close();

    const reopened = SqliteDatabase.open(config);
    try {
      const marked = new SessionService(
        reopened.createProgressStore(),
        config
      ).markStale("2026-08-17T12:00:00.000Z");
      expect(marked.map((session) => session.session_id)).toEqual(["session-1"]);
      expect(marked[0]?.stale_at).toBe("2026-08-17T12:00:00.000Z");

      const leaseAfterMarking = inspectDatabase(config.databasePath, (database) => (
        database.prepare(
          "SELECT task_id, session_id, expires_at FROM active_task_leases"
        ).all()
      ));
      expect(leaseAfterMarking).toEqual([{
        task_id: "task-1",
        session_id: "session-1",
        expires_at: leaseExpiresAt
      }]);
    } finally {
      reopened.close();
    }
  });
});
