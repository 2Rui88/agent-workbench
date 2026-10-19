/// <reference types="node" />

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeConfig } from "../../../src/config/runtime-config.js";
import {
  TaskService,
  type AdoptTaskInput
} from "../../../src/core/task-service.js";
import { RepoProbe } from "../../../src/repo/repo-probe.js";
import { SqliteDatabase } from "../../../src/storage/database.js";
import type { ProgressStore } from "../../../src/storage/progress-store.js";

const temporaryDirectories: string[] = [];
const BASE_TIME_MS = Date.parse("2026-08-17T10:00:00.000Z");
const SHARED_WORKTREE = "/repos/project-one/worktrees/shared";

function isoAt(offsetSeconds: number): string {
  return new Date(BASE_TIME_MS + offsetSeconds * 1_000).toISOString();
}

function createService(): {
  store: ProgressStore;
  database: SqliteDatabase;
  service: TaskService;
} {
  const dataDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-"));
  temporaryDirectories.push(dataDir);
  const config = createRuntimeConfig(dataDir);
  const database = SqliteDatabase.open(config);
  const store = database.createProgressStore();
  store.transaction((tx) => {
    tx.upsertProject({
      project_id: "project-1",
      name: "Project One",
      created_at: isoAt(0),
      updated_at: isoAt(0)
    });
    tx.upsertRepository({
      repository_id: "repo-1",
      project_id: "project-1",
      path: "/repos/project-one",
      label: "Project One",
      created_at: isoAt(0),
      updated_at: isoAt(0)
    });
    tx.insertSession({
      session_id: "session-1",
      repository_id: "repo-1",
      label: "Session One",
      owner: "session-owner",
      started_at: isoAt(0),
      worktree_path: SHARED_WORKTREE,
      last_activity_at: isoAt(0)
    });
    tx.insertSession({
      session_id: "session-2",
      repository_id: "repo-1",
      label: "Session Two",
      started_at: isoAt(0),
      worktree_path: SHARED_WORKTREE,
      last_activity_at: isoAt(0)
    });
    tx.insertSession({
      session_id: "session-3",
      repository_id: "repo-1",
      label: "Session Three",
      started_at: isoAt(0),
      worktree_path: "/repos/project-one/worktrees/other",
      last_activity_at: isoAt(0)
    });
  });
  let clockTick = 0;
  return {
    store,
    database,
    service: new TaskService({
      store,
      probe: new RepoProbe(),
      now: () => isoAt(clockTick++)
    })
  };
}

function adoptInput(overrides: Partial<AdoptTaskInput> = {}): AdoptTaskInput {
  return {
    session_id: "session-1",
    operation_id: "op-adopt-1",
    expected_version: 0,
    legacy_import_key: "legacy-key-1",
    source_session_label: "Legacy session",
    project_id: "project-1",
    repository_id: "repo-1",
    worktree_path: SHARED_WORKTREE,
    normalized_title: "legacy task",
    goal: "Finish the legacy migration",
    acceptance_criteria: ["legacy suite passes"],
    priority: "P1",
    status: "in_progress",
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
        adopted_at: isoAt(0)
      }
    },
    snapshot: { head_commit: "0123456789abcdef0123456789abcdef01234567" },
    ...overrides
  };
}

function rows(databasePath: string, sql: string, parameters: readonly string[] = []) {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  try {
    return database.prepare(sql).all(...parameters);
  } finally {
    database.close();
  }
}

function listLeasesForSharedWorktree(databasePath: string): unknown[] {
  return rows(databasePath, `
    SELECT active_task_leases.task_id
    FROM active_task_leases
    JOIN task_scopes ON task_scopes.task_id = active_task_leases.task_id
    WHERE task_scopes.scope_type = 'worktree_path'
      AND task_scopes.scope_value = ?
  `, [SHARED_WORKTREE]);
}

function listTasksForSharedWorktree(databasePath: string): { status: string }[] {
  return rows(databasePath, `
    SELECT tasks.status
    FROM tasks
    JOIN task_scopes ON task_scopes.task_id = tasks.task_id
    WHERE task_scopes.scope_type = 'worktree_path'
      AND task_scopes.scope_value = ?
  `, [SHARED_WORKTREE]).map((row) => ({ status: String(row.status) }));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("legacy adoption over real SQLite", () => {
  it("adopts an active legacy task atomically with checkpoint, snapshot, event, and lease", async () => {
    const { database, service } = createService();
    const activeLegacyInput = adoptInput();

    const adopted = await service.adoptTask(activeLegacyInput);

    expect(adopted).toMatchObject({ status: "in_progress", version: 0 });
    const taskRow = rows(database.path, `
      SELECT status, version, session_id, owner, goal, acceptance_criteria_json
      FROM tasks WHERE task_id = ?
    `, [adopted.task_id])[0];
    expect(taskRow).toMatchObject({
      status: "in_progress",
      version: 0,
      session_id: "session-1",
      owner: "session-owner",
      goal: "Finish the legacy migration"
    });
    expect(JSON.parse(String(taskRow?.acceptance_criteria_json)))
      .toEqual(["legacy suite passes"]);
    expect(rows(database.path, `
      SELECT payload_json FROM checkpoints WHERE task_id = ?
    `, [adopted.task_id])).toHaveLength(1);
    expect(rows(database.path, `
      SELECT head_commit FROM repo_snapshots WHERE task_id = ?
    `, [adopted.task_id])).toMatchObject([
      { head_commit: "0123456789abcdef0123456789abcdef01234567" }
    ]);
    expect(rows(database.path, `
      SELECT event_type FROM task_events WHERE task_id = ? ORDER BY created_at
    `, [adopted.task_id])).toEqual([{ event_type: "legacy_task_adopted" }]);
    expect(rows(database.path, `
      SELECT legacy_import_key, task_id FROM legacy_task_imports
    `)).toEqual([{ legacy_import_key: "legacy-key-1", task_id: adopted.task_id }]);
    expect(rows(database.path, `
      SELECT session_id FROM active_task_leases WHERE task_id = ?
    `, [adopted.task_id])).toEqual([{ session_id: "session-1" }]);
    expect(rows(database.path, `
      SELECT session_id FROM task_session_links WHERE task_id = ?
    `, [adopted.task_id])).toEqual([{ session_id: "session-1" }]);
    database.close();
  });

  it("returns the existing task for a repeated legacy key even under a new operation id", async () => {
    const { database, service } = createService();
    const activeLegacyInput = adoptInput();
    const first = await service.adoptTask(activeLegacyInput);

    const retried = await service.adoptTask({
      ...activeLegacyInput,
      operation_id: "retry"
    });

    expect(retried).toMatchObject({ task_id: first.task_id, status: "in_progress" });
    expect(rows(database.path, "SELECT COUNT(*) AS count FROM tasks"))
      .toMatchObject([{ count: 1 }]);
    expect(rows(database.path, "SELECT COUNT(*) AS count FROM legacy_task_imports"))
      .toMatchObject([{ count: 1 }]);
    expect(rows(database.path, "SELECT COUNT(*) AS count FROM checkpoints"))
      .toMatchObject([{ count: 1 }]);
    database.close();
  });

  it("rejects adopting legacy work into an archived project", async () => {
    const { database, store, service } = createService();
    expect(store.transaction((tx) => (
      tx.archiveProject("project-1", "session-owner", isoAt(1))
    )).status).toBe("archived");

    await expect(service.adoptTask(adoptInput())).rejects.toMatchObject({
      code: "PROJECT_ARCHIVED",
      recovery_actions: expect.any(Array)
    });
    expect(rows(database.path, "SELECT COUNT(*) AS count FROM tasks"))
      .toMatchObject([{ count: 0 }]);
    database.close();
  });

  it("rejects a repeated legacy key whose identity fields changed", async () => {
    const { database, service } = createService();
    await service.adoptTask(adoptInput());

    await expect(service.adoptTask(adoptInput({
      operation_id: "op-adopt-2",
      normalized_title: "a different legacy task"
    }))).rejects.toMatchObject({
      code: "TASK_ALREADY_ADOPTED",
      retryable: false,
      evidence: expect.any(Array),
      recovery_actions: expect.any(Array)
    });

    expect(rows(database.path, "SELECT COUNT(*) AS count FROM tasks"))
      .toMatchObject([{ count: 1 }]);
    database.close();
  });

  it("rejects adopting a legacy task for another owner", async () => {
    const { database, service } = createService();

    await expect(service.adoptTask(adoptInput({
      operation_id: "op-adopt-owner-mismatch",
      legacy_import_key: "legacy-key-owner-mismatch",
      owner: "owner-other"
    }))).rejects.toMatchObject({
      code: "OWNER_MISMATCH",
      evidence: ["session-owner", "owner-other"]
    });

    expect(rows(database.path, "SELECT COUNT(*) AS count FROM tasks"))
      .toMatchObject([{ count: 0 }]);
    database.close();
  });

  it("refuses importing a pending_acceptance legacy task without passing verification", async () => {
    const { database, service } = createService();
    const unevidenced = adoptInput({
      operation_id: "op-adopt-pending",
      legacy_import_key: "legacy-key-pending",
      status: "pending_acceptance"
    });

    await expect(service.adoptTask(unevidenced))
      .rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect(rows(database.path, "SELECT COUNT(*) AS count FROM tasks"))
      .toMatchObject([{ count: 0 }]);
    expect(rows(database.path, "SELECT COUNT(*) AS count FROM legacy_task_imports"))
      .toMatchObject([{ count: 0 }]);
    database.close();
  });

  it("adopts a pending_acceptance legacy task when every verification entry passed", async () => {
    const { database, service } = createService();
    const adopted = await service.adoptTask(adoptInput({
      operation_id: "op-adopt-pending-ok",
      legacy_import_key: "legacy-key-pending-ok",
      status: "pending_acceptance",
      checkpoint: {
        completed_items: ["legacy work"],
        current_state: "awaiting acceptance before migration",
        human_context: [],
        confirmed_decisions: [],
        pending_decisions: [],
        blockers: [],
        verification: [{
          command: "npm test",
          outcome: "passed",
          summary: "legacy suite green"
        }],
        next_action: "human acceptance",
        source: {
          source_type: "legacy_adoption",
          source_session_label: "Legacy session",
          adoption_method: "mcp",
          adopted_at: isoAt(0)
        }
      }
    }));

    expect(adopted).toMatchObject({ status: "pending_acceptance", version: 0 });
    expect(rows(database.path, "SELECT COUNT(*) AS count FROM active_task_leases"))
      .toMatchObject([{ count: 0 }]);
    database.close();
  });

  it("pauses both legacy imports that claim the same writable worktree and releases leases", async () => {
    const { database, service } = createService();
    const first = await service.adoptTask(adoptInput());
    expect(rows(database.path, "SELECT COUNT(*) AS count FROM active_task_leases"))
      .toMatchObject([{ count: 1 }]);

    const second = await service.adoptTask(adoptInput({
      session_id: "session-2",
      operation_id: "op-adopt-2",
      legacy_import_key: "legacy-key-2",
      source_session_label: "Second legacy session"
    }));

    expect(await listLeasesForSharedWorktree(database.path)).toHaveLength(0);
    expect((await listTasksForSharedWorktree(database.path))
      .every((task) => task.status === "paused")).toBe(true);
    expect(first).toMatchObject({ status: "in_progress", version: 0 });
    expect(rows(database.path, `
      SELECT status, version FROM tasks WHERE task_id = ?
    `, [first.task_id])).toMatchObject([{ status: "paused", version: 1 }]);
    expect(rows(database.path, `
      SELECT status FROM tasks WHERE task_id = ?
    `, [second.task_id])).toMatchObject([{ status: "paused" }]);
    const conflictEvents = rows(database.path, `
      SELECT COUNT(*) AS count FROM task_events
      WHERE event_type = 'legacy_worktree_conflict'
    `);
    expect(conflictEvents).toMatchObject([{ count: 2 }]);
    database.close();
  });

  it("adopts a paused legacy task without creating a lease", async () => {
    const { database, service } = createService();
    const adopted = await service.adoptTask(adoptInput({
      operation_id: "op-adopt-paused",
      legacy_import_key: "legacy-key-paused",
      status: "paused"
    }));

    expect(adopted).toMatchObject({ status: "paused", version: 0 });
    expect(rows(database.path, "SELECT COUNT(*) AS count FROM active_task_leases"))
      .toMatchObject([{ count: 0 }]);
    expect(rows(database.path, `
      SELECT session_id FROM tasks WHERE task_id = ?
    `, [adopted.task_id])).toMatchObject([{ session_id: null }]);
    database.close();
  });
});
