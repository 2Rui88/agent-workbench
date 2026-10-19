/// <reference types="node" />

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeConfig } from "../../../src/config/runtime-config.js";
import { TaskService } from "../../../src/core/task-service.js";
import { SqliteDatabase } from "../../../src/storage/database.js";
import type { ProgressStore } from "../../../src/storage/progress-store.js";

const baseTime = Date.parse("2026-08-17T10:00:00.000Z");
const directories: string[] = [];

function isoAt(offsetMs: number): string {
  return new Date(baseTime + offsetMs).toISOString();
}

function seed(store: ProgressStore, requestedAt = isoAt(0)): void {
  store.transaction((tx) => {
    tx.upsertProject({
      project_id: "project-1",
      name: "Recovery project",
      created_at: isoAt(0),
      updated_at: isoAt(0)
    });
    tx.upsertRepository({
      repository_id: "repo-1",
      project_id: "project-1",
      path: "/tmp/recovery-repo",
      label: "Recovery repo",
      created_at: isoAt(0),
      updated_at: isoAt(0)
    });
    for (const session of [
      {
        session_id: "session-old",
        owner: "downstream-owner",
        worktree_path: "/tmp/recovery-repo/worktrees/old"
      },
      {
        session_id: "session-new",
        owner: "downstream-owner",
        worktree_path: "/tmp/recovery-repo/worktrees/new"
      }
    ]) {
      tx.insertSession({
        session_id: session.session_id,
        repository_id: "repo-1",
        label: session.session_id,
        owner: session.owner,
        worktree_path: session.worktree_path,
        started_at: isoAt(0),
        last_activity_at: isoAt(0)
      });
    }
    tx.insertTask({
      task_id: "upstream-task",
      repository_id: "repo-1",
      owner: "upstream-owner",
      title: "Upstream",
      status: "pending_acceptance",
      priority: "P1",
      goal: "produce a validation",
      acceptance_criteria: ["downstream validation"],
      created_at: isoAt(0),
      updated_at: isoAt(0)
    });
    tx.insertTask({
      task_id: "downstream-task",
      repository_id: "repo-1",
      owner: "downstream-owner",
      title: "Downstream",
      status: "pending_acceptance",
      priority: "P1",
      goal: "run validation",
      acceptance_criteria: ["evidence"],
      created_at: isoAt(0),
      updated_at: isoAt(0)
    });
    tx.insertTaskDependency({
      task_id: "downstream-task",
      depends_on_task_id: "upstream-task",
      created_at: isoAt(0)
    });
    tx.insertDependencyValidation({
      validation_id: "validation-recovery",
      upstream_task_id: "upstream-task",
      downstream_task_id: "downstream-task",
      cycle: 1,
      status: "pending",
      requested_by_actor: "agent",
      requested_by_owner: "upstream-owner",
      requested_at: requestedAt,
      request_read_at: null,
      responded_by_owner: null,
      response_reason: null,
      responded_at: null,
      response_read_at: null,
      validation_spec: {
        schema_version: "dependency-validation.v1",
        upstream_task_id: "upstream-task",
        upstream_task_version: 0,
        upstream_repository_id: "repo-1",
        downstream_task_id: "downstream-task",
        downstream_repository_id: "repo-1",
        cycle: 1,
        target_revision: "target-revision",
        target_head_commit: "target-revision",
        scope: {
          worktree_path: "/tmp/recovery-repo/worktrees/old",
          changed_files: [],
          module_paths: []
        },
        command: "npm test",
        commands: ["npm test"],
        timeout_strategy: { kind: "rolling_lease", lease_ttl_ms: 1_000, max_attempts: 2 }
      }
    });
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLite dependency validation recovery", () => {
  it("persists expiry errors and returns a committed capped result", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-validation-recovery-"));
    directories.push(dataDir);
    const config = createRuntimeConfig(dataDir);
    const database = SqliteDatabase.open(config);
    const store = database.createProgressStore();
    seed(store);
    let now = isoAt(0);
    const service = new TaskService({
      store,
      probe: { inspect: async () => ({
        repository_id: "repo-1",
        repository_path: "/tmp/recovery-repo",
        worktree_path: "/tmp/recovery-repo/worktrees/old",
        branch: "main",
        head_commit: "target-revision",
        captured_at: now,
        changed_files: []
      }) },
      now: () => now,
      leaseTtlMs: 1_000
    });

    const first = await service.receiveDependencyValidation({
      session_id: "session-old",
      operation_id: "recover-receive-1",
      validation_id: "validation-recovery",
      owner: "downstream-owner"
    });
    now = isoAt(2_000);
    const second = await service.receiveDependencyValidation({
      session_id: "session-new",
      operation_id: "recover-receive-2",
      validation_id: "validation-recovery",
      owner: "downstream-owner"
    });
    expect(second).toMatchObject({ status: "claimed", attempt: 2 });

    now = isoAt(4_000);
    const capped = await service.receiveDependencyValidation({
      session_id: "session-new",
      operation_id: "recover-receive-3",
      validation_id: "validation-recovery",
      owner: "downstream-owner"
    });
    expect(capped).toMatchObject({
      status: "capped",
      capped: true,
      attempt: 2,
      recovery_actions: expect.any(Array),
      run: { run_id: second.run_id, status: "error", error_reason: "lease expired" }
    });

    const view = store.getDependencyValidation("validation-recovery");
    expect(view).toMatchObject({ status: "pending", latest_run: { status: "error", attempt: 2 } });
    expect(view?.runs.map((run) => ({ attempt: run.attempt, status: run.status }))).toEqual([
      { attempt: 2, status: "error" },
      { attempt: 1, status: "error" }
    ]);
    expect(first.attempt).toBe(1);
    database.close();

    const reopened = SqliteDatabase.open(config);
    try {
      const reopenedView = reopened.createProgressStore().getDependencyValidation("validation-recovery");
      expect(reopenedView?.runs.map((run) => ({ attempt: run.attempt, status: run.status }))).toEqual([
        { attempt: 2, status: "error" },
        { attempt: 1, status: "error" }
      ]);
      expect(reopenedView?.status).toBe("pending");
    } finally {
      reopened.close();
    }
  });

  it("preserves terminal validation history when a downstream edge changes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-validation-history-"));
    directories.push(dataDir);
    const config = createRuntimeConfig(dataDir);
    const database = SqliteDatabase.open(config);
    const store = database.createProgressStore();
    seed(store);

    // Seed a completed response, then exercise the real service path that
    // removes the dependency edge.  SQLite's CHECK constraint requires
    // responded fields to remain populated for passed/rejected rows.
    store.transaction((tx) => {
      tx.updateDependencyValidationResponse("validation-recovery", "pending", {
        status: "passed",
        responded_by_owner: "downstream-owner",
        response_reason: "validated against target",
        responded_at: isoAt(1_000),
        response_read_at: null
      });
    });
    const service = new TaskService({
      store,
      probe: { inspect: async () => ({
        repository_id: "repo-1",
        repository_path: "/tmp/recovery-repo",
        worktree_path: "/tmp/recovery-repo/worktrees/new",
        branch: "main",
        head_commit: "target-revision",
        captured_at: isoAt(2_000),
        changed_files: []
      }) },
      now: () => isoAt(2_000)
    });

    await expect(service.updateTaskDependencies({
      session_id: "session-new",
      operation_id: "history-edge-remove",
      task_id: "downstream-task",
      expected_version: 0,
      dependencies: []
    })).resolves.toMatchObject({ task_id: "downstream-task", version: 1 });

    const row = store.getDependencyValidation("validation-recovery");
    expect(row).toMatchObject({
      status: "passed",
      responded_by_owner: "downstream-owner",
      response_reason: "validated against target"
    });
    database.close();

    const reopened = SqliteDatabase.open(config);
    try {
      expect(reopened.createProgressStore().getDependencyValidation("validation-recovery"))
        .toMatchObject({ status: "passed", response_reason: "validated against target" });
    } finally {
      reopened.close();
    }
  });

  it("keeps edge generation above persisted history after a wall-clock rollback", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-validation-generation-"));
    directories.push(dataDir);
    const config = createRuntimeConfig(dataDir);
    const database = SqliteDatabase.open(config);
    const store = database.createProgressStore();
    seed(store);

    store.transaction((tx) => {
      tx.updateDependencyValidationResponse("validation-recovery", "pending", {
        status: "passed",
        responded_by_owner: "downstream-owner",
        response_reason: "validated against target",
        responded_at: isoAt(1_000),
        response_read_at: null
      });
    });
    let now = isoAt(2_000);
    const service = new TaskService({
      store,
      probe: { inspect: async () => ({
        repository_id: "repo-1",
        repository_path: "/tmp/recovery-repo",
        worktree_path: "/tmp/recovery-repo/worktrees/new",
        branch: "main",
        head_commit: "target-revision",
        captured_at: now,
        changed_files: []
      }) },
      now: () => now
    });

    await service.updateTaskDependencies({
      session_id: "session-new",
      operation_id: "generation-edge-remove",
      task_id: "downstream-task",
      expected_version: 0,
      dependencies: []
    });
    now = isoAt(-60_000);
    await service.humanUpdateTask("downstream-task", "human", { priority: "P0" });
    await service.updateTaskDependencies({
      session_id: "session-new",
      operation_id: "generation-edge-readd",
      task_id: "downstream-task",
      expected_version: 2,
      dependencies: ["upstream-task"]
    });

    expect(store.getDependencyValidationGate("upstream-task")).toMatchObject({
      ready_for_acceptance: false
    });
    database.close();
  });

  it("does not reuse a late validation after rollback during edge re-add", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-validation-late-generation-"));
    directories.push(dataDir);
    const config = createRuntimeConfig(dataDir);
    const database = SqliteDatabase.open(config);
    const store = database.createProgressStore();
    seed(store, isoAt(1_000));
    store.transaction((tx) => {
      tx.updateDependencyValidationResponse("validation-recovery", "pending", {
        status: "passed",
        responded_by_owner: "downstream-owner",
        response_reason: "validated against target",
        responded_at: isoAt(1_100),
        response_read_at: null
      });
    });
    const service = new TaskService({
      store,
      probe: { inspect: async () => ({
        repository_id: "repo-1",
        repository_path: "/tmp/recovery-repo",
        worktree_path: "/tmp/recovery-repo/worktrees/new",
        branch: "main",
        head_commit: "target-revision",
        captured_at: isoAt(-100),
        changed_files: []
      }) },
      now: () => isoAt(-100)
    });

    await service.updateTaskDependencies({
      session_id: "session-new",
      operation_id: "late-generation-edge-remove",
      task_id: "downstream-task",
      expected_version: 0,
      dependencies: []
    });
    await service.updateTaskDependencies({
      session_id: "session-new",
      operation_id: "late-generation-edge-readd",
      task_id: "downstream-task",
      expected_version: 1,
      dependencies: ["upstream-task"]
    });

    expect(store.getDependencyValidationGate("upstream-task")).toMatchObject({
      ready_for_acceptance: false
    });
    database.close();
  });
});
