/// <reference types="node" />

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeConfig } from "../../../src/config/runtime-config.js";
import { SqliteDatabase, StorageError } from "../../../src/storage/database.js";
import * as sqliteStoreModule from "../../../src/storage/sqlite-progress-store.js";
import type {
  ActiveTaskLease,
  CheckpointRecord,
  DependencyRepairRequestRecord,
  JsonValue,
  OperationResult,
  ProgressStore,
  ProgressTransaction,
  TaskEventRecord
} from "../../../src/storage/progress-store.js";
import type {
  CheckpointPayload,
  TaskRecord
} from "../../../src/shared/task-contracts.js";

const temporaryDirectories: string[] = [];

function createStore() {
  const dataDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-"));
  temporaryDirectories.push(dataDir);
  const config = createRuntimeConfig(dataDir);
  const database = SqliteDatabase.open(config);
  seedRepository(config.databasePath);
  return { config, database, store: database.createProgressStore() };
}

function seedRepository(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("BEGIN IMMEDIATE");
  database.prepare(`
    INSERT OR IGNORE INTO projects(project_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run("project-1", "Project One", "2026-08-17T00:00:00.000Z", "2026-08-17T00:00:00.000Z");
  database.prepare(`
    INSERT OR IGNORE INTO repositories(
      repository_id, project_id, path, label, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    "repo-1",
    "project-1",
    "/tmp/project-one",
    "Project One",
    "2026-08-17T00:00:00.000Z",
    "2026-08-17T00:00:00.000Z"
  );
  database.prepare(`
    INSERT OR IGNORE INTO sessions(
      session_id, repository_id, label, started_at
    ) VALUES (?, ?, ?, ?)
  `).run("session-1", "repo-1", "CLI session", "2026-08-17T00:00:00.000Z");
  database.prepare(`
    INSERT OR IGNORE INTO sessions(
      session_id, repository_id, label, started_at
    ) VALUES (?, ?, ?, ?)
  `).run("session-2", "repo-1", "Second CLI session", "2026-08-17T00:01:00.000Z");
  database.exec("COMMIT");
  database.close();
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task_id: "task-1",
    repository_id: "repo-1",
    session_id: "session-1",
    title: "Persist task progress",
    status: "in_progress",
    priority: "P1",
    created_at: "2026-08-17T00:00:00.000Z",
    updated_at: "2026-08-17T00:00:00.000Z",
    ...overrides
  };
}

function lease(overrides: Partial<ActiveTaskLease> = {}): ActiveTaskLease {
  return {
    task_id: "task-1",
    session_id: "session-1",
    acquired_at: "2026-08-17T00:00:00.000Z",
    heartbeat_at: "2026-08-17T00:00:00.000Z",
    expires_at: "2026-08-17T00:30:00.000Z",
    generation: 1,
    ...overrides
  };
}

type RuntimeSqliteDatabaseConstructor = new (
  path: string,
  database: DatabaseSync,
  sqliteBusyTimeoutMs: number
) => SqliteDatabase;

function probeForgedDatabase(
  DatabaseConstructor: RuntimeSqliteDatabaseConstructor,
  databasePath: string,
  taskId: string
): {
  escapedWriteVisible: boolean;
  ranOutsideTransaction: boolean;
  thrown: unknown;
} {
  const rawDatabase = new DatabaseSync(databasePath);
  const nonTransactionalDatabase = {
    exec(sql: string) {
      if (/^\s*(?:BEGIN(?:\s+IMMEDIATE)?|COMMIT|ROLLBACK)\b/i.test(sql)) {
        return;
      }
      rawDatabase.exec(sql);
    },
    prepare: rawDatabase.prepare.bind(rawDatabase)
  } as unknown as DatabaseSync;
  let ranOutsideTransaction = false;
  let thrown: unknown;

  try {
    const forgedDatabase = new DatabaseConstructor(
      "forged.sqlite",
      nonTransactionalDatabase,
      5_000
    );
    forgedDatabase.createProgressStore().transaction((tx) => {
      ranOutsideTransaction = !rawDatabase.isTransaction;
      tx.insertTask(task({ task_id: taskId }));
    });
  } catch (error) {
    thrown = error;
  }

  const escapedWriteVisible = rawDatabase.prepare(`
    SELECT COUNT(*) AS count
    FROM tasks
    WHERE task_id = ?
  `).get(taskId)?.count === 1;
  rawDatabase.close();
  return { escapedWriteVisible, ranOutsideTransaction, thrown };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteProgressStore", () => {
  it("requires an internal capability for direct SqliteDatabase construction", () => {
    const { config, database } = createStore();
    const DatabaseConstructor = SqliteDatabase as unknown as RuntimeSqliteDatabaseConstructor;

    try {
      const probe = probeForgedDatabase(
        DatabaseConstructor,
        config.databasePath,
        "forged-direct-task"
      );

      expect(probe.ranOutsideTransaction).toBe(false);
      expect(probe.escapedWriteVisible).toBe(false);
      expect(probe.thrown).toBeInstanceOf(StorageError);
      expect(probe.thrown).toMatchObject({ code: "DATABASE_CAPABILITY_REQUIRED" });
    } finally {
      database.close();
    }
  });

  it("requires an internal capability when reusing an instance constructor", () => {
    const { config, database } = createStore();
    const DatabaseConstructor = database.constructor as RuntimeSqliteDatabaseConstructor;

    try {
      const probe = probeForgedDatabase(
        DatabaseConstructor,
        config.databasePath,
        "forged-instance-task"
      );

      expect(probe.ranOutsideTransaction).toBe(false);
      expect(probe.escapedWriteVisible).toBe(false);
      expect(probe.thrown).toBeInstanceOf(StorageError);
      expect(probe.thrown).toMatchObject({ code: "DATABASE_CAPABILITY_REQUIRED" });
    } finally {
      database.close();
    }
  });

  it("rolls back every write when transaction work throws", () => {
    const { database, store } = createStore();

    expect(() => store.transaction((tx) => {
      tx.insertTask(task());
      throw new Error("stop transaction");
    })).toThrowError("stop transaction");

    expect(store.getTaskDetail("task-1")).toBeUndefined();
    database.close();
  });

  it("invalidates a transaction object after its callback returns", () => {
    const { config, database, store } = createStore();
    let escapedTransaction!: ProgressTransaction;

    store.transaction((tx) => {
      escapedTransaction = tx;
    });

    expect(() => escapedTransaction.getTask("task-1")).toThrowError(
      expect.objectContaining({ code: "TRANSACTION_INACTIVE" })
    );
    const escapedRuntime = escapedTransaction as unknown as Record<string, unknown>;
    expect(Reflect.ownKeys(escapedTransaction)).not.toEqual(expect.arrayContaining([
      "active",
      "database"
    ]));
    const transactionPrototypeKeys = Reflect.ownKeys(
      Object.getPrototypeOf(escapedTransaction) as object
    );
    expect(transactionPrototypeKeys).not.toContain("assertActive");
    expect(transactionPrototypeKeys).not.toContain("deactivate");
    escapedRuntime.active = true;
    expect(() => escapedTransaction.getTask("task-1")).toThrowError(
      expect.objectContaining({ code: "TRANSACTION_INACTIVE" })
    );
    const rawDatabase = new DatabaseSync(config.databasePath);
    const TransactionConstructor = escapedTransaction.constructor as new (
      ...parameters: unknown[]
    ) => ProgressTransaction;
    expect(() => new TransactionConstructor(rawDatabase)).toThrowError(
      expect.objectContaining({ code: "TRANSACTION_CAPABILITY_REQUIRED" })
    );
    rawDatabase.close();
    database.close();
  });

  it("does not export a store factory that accepts a non-transactional runner", () => {
    const { config, database, store } = createStore();
    const rawDatabase = new DatabaseSync(config.databasePath);
    const unsafeFactory = (
      sqliteStoreModule as unknown as Record<string, unknown>
    ).createSqliteProgressStore;
    let ranOutsideTransaction = false;

    try {
      if (typeof unsafeFactory === "function") {
        const createUnsafeStore = unsafeFactory as (
          database: DatabaseSync,
          runner: <T>(work: () => T) => T
        ) => ProgressStore;
        const unsafeStore = createUnsafeStore(rawDatabase, (work) => work());
        unsafeStore.transaction((tx) => {
          ranOutsideTransaction = !rawDatabase.isTransaction;
          tx.insertTask(task());
        });
      }

      expect(ranOutsideTransaction).toBe(false);
      expect(unsafeFactory).toBeUndefined();
      const StoreConstructor = store.constructor as new (
        ...parameters: unknown[]
      ) => ProgressStore;
      expect(() => new StoreConstructor(
        rawDatabase,
        <T>(work: () => T) => work()
      )).toThrowError(expect.objectContaining({
        code: "STORE_CAPABILITY_REQUIRED"
      }));
    } finally {
      rawDatabase.close();
      database.close();
    }
  });

  it("rejects thenable transaction results and rolls back synchronous writes", () => {
    const { database, store } = createStore();

    expect(() => store.transaction((tx) => {
      tx.insertTask(task());
      return Promise.resolve("async result");
    })).toThrowError(expect.objectContaining({ code: "ASYNC_TRANSACTION_UNSUPPORTED" }));
    expect(store.getTaskDetail("task-1")).toBeUndefined();

    database.close();
  });

  it("consumes an async callback rejection without an unhandledRejection", async () => {
    const { database, store } = createStore();
    const unhandledRejections: unknown[] = [];
    const captureUnhandled = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", captureUnhandled);

    try {
      expect(() => store.transaction(async (tx) => {
        tx.insertTask(task());
        throw new Error("async callback failed");
      })).toThrowError(expect.objectContaining({
        code: "ASYNC_TRANSACTION_UNSUPPORTED"
      }));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toEqual([]);
      expect(store.getTaskDetail("task-1")).toBeUndefined();
    } finally {
      process.off("unhandledRejection", captureUnhandled);
      database.close();
    }
  });

  it("rejects a second lease for either the same task or the same session", () => {
    const { database, store } = createStore();
    store.transaction((tx) => {
      tx.insertTask(task());
      tx.insertTask(task({ task_id: "task-2", session_id: "session-2" }));
      tx.putLease(lease());
    });

    expect(() => store.transaction((tx) => {
      tx.putLease(lease({ session_id: "session-2" }));
    })).toThrowError(/UNIQUE/);
    expect(() => store.transaction((tx) => {
      tx.putLease(lease({ task_id: "task-2" }));
    })).toThrowError(/UNIQUE/);

    database.close();
  });

  it("returns the original result for a duplicate session operation key", () => {
    const { database, store } = createStore();
    const original: OperationResult = {
      session_id: "session-1",
      operation_id: "operation-1",
      tool_name: "task_checkpoint",
      request_hash: `sha256:${"a".repeat(64)}`,
      result: { task_id: "task-1", accepted: true },
      created_at: "2026-08-17T00:00:00.000Z"
    };

    store.transaction((tx) => tx.putOperationResult(original));
    const found = store.transaction((tx) => tx.getOperationResult(
      "session-1",
      "operation-1"
    ));

    expect(found).toEqual(original);
    expect(() => store.transaction((tx) => tx.putOperationResult({
      ...original,
      result: { task_id: "task-2", accepted: false }
    }))).toThrowError(/UNIQUE/);
    expect(store.transaction((tx) => tx.getOperationResult(
      "session-1",
      "operation-1"
    ))).toEqual(original);
    database.close();
  });

  it("round-trips recovery columns and dependency repair requests", () => {
    const { database, store } = createStore();
    const timestamp = "2026-08-17T00:00:00.000Z";
    const repair: DependencyRepairRequestRecord = {
      repair_id: "repair-1",
      validation_id: "validation-1",
      source_run_id: "run-1",
      ctx_id: null,
      upstream_task_id: "task-1",
      downstream_task_id: "task-2",
      cycle: 1,
      status: "pending",
      rejection_reason: "Contract output no longer matches the downstream parser",
      claimed_session_id: null,
      claimed_worktree_path: null,
      claimed_at: null,
      resolved_at: null,
      superseded_at: null,
      created_at: timestamp,
      updated_at: timestamp
    };

    store.transaction((tx) => {
      tx.insertTask(task({ owner: "owner-upstream" }));
      tx.insertTask(task({
        task_id: "task-2",
        session_id: "session-2",
        title: "Validate upstream dependency",
        owner: "owner-downstream"
      }));
      tx.putLease(lease({ generation: 3 }));
      tx.insertRepoSnapshot({
        snapshot_id: "snapshot-1",
        task_id: "task-1",
        repository_id: "repo-1",
        repository_path: "/tmp/project-one",
        head_commit: "abc123",
        content_digest: `sha256:${"b".repeat(64)}`,
        captured_at: timestamp
      });
      tx.insertTaskDependency({
        task_id: "task-2",
        depends_on_task_id: "task-1",
        created_at: timestamp
      });
      tx.insertDependencyValidation({
        validation_id: repair.validation_id,
        upstream_task_id: "task-1",
        downstream_task_id: "task-2",
        cycle: 1,
        status: "rejected",
        requested_by_actor: "agent",
        requested_by_owner: "owner-upstream",
        requested_at: timestamp,
        request_read_at: timestamp,
        responded_by_owner: "owner-downstream",
        response_reason: repair.rejection_reason,
        responded_at: timestamp,
        response_read_at: null,
        validation_spec: { acceptance_criteria: ["contract remains compatible"] }
      });
      tx.insertDependencyValidationRun({
        run_id: repair.source_run_id,
        validation_id: repair.validation_id,
        attempt: 1,
        status: "rejected",
        owner: "owner-downstream",
        session_id: "session-2",
        worktree_path: "/tmp/project-one",
        heartbeat_at: timestamp,
        expires_at: "2026-08-17T00:30:00.000Z",
        started_at: timestamp,
        completed_at: timestamp,
        verification: [],
        failure_reason: repair.rejection_reason,
        error_reason: null,
        operation_id: "validation-operation-1",
        created_at: timestamp,
        updated_at: timestamp
      });
      tx.insertDependencyRepairRequest(repair);
    });

    expect(store.transaction((tx) => tx.getLeaseByTask("task-1")))
      .toMatchObject({ generation: 3 });
    expect(store.transaction((tx) => tx.getLatestRepoSnapshot("task-1")))
      .toMatchObject({ content_digest: `sha256:${"b".repeat(64)}` });
    expect(store.transaction((tx) => tx.getDependencyRepairByValidation("validation-1")))
      .toEqual(repair);
    expect(store.transaction((tx) => tx.listDependencyRepairsForUpstream("task-1")))
      .toEqual([repair]);
    expect(store.getDependencyRepairRequest("repair-1", "owner-upstream"))
      .toEqual(repair);
    expect(store.listDependencyRepairRequests("owner-upstream", "repo-1"))
      .toEqual([repair]);

    const claimed: DependencyRepairRequestRecord = {
      ...repair,
      status: "claimed",
      claimed_session_id: "session-1",
      claimed_worktree_path: "/tmp/project-one",
      claimed_at: "2026-08-17T00:05:00.000Z",
      updated_at: "2026-08-17T00:05:00.000Z"
    };
    store.transaction((tx) => tx.updateDependencyRepairRequest(claimed, "pending"));
    expect(store.transaction((tx) => tx.getDependencyRepairRequest("repair-1")))
      .toEqual(claimed);
    expect(() => store.transaction((tx) => {
      tx.updateDependencyRepairRequest({ ...claimed, status: "resolved" }, "pending");
    })).toThrowError(expect.objectContaining({ code: "VERSION_CONFLICT" }));

    database.close();
  });

  it("persists tasks after the database is closed and reopened", () => {
    const { config, database, store } = createStore();
    store.transaction((tx) => tx.insertTask(task()));
    database.close();

    const reopened = SqliteDatabase.open(config);
    const reopenedStore = reopened.createProgressStore();
    expect(reopenedStore.getTaskDetail("task-1")).toMatchObject({
      task_id: "task-1",
      title: "Persist task progress",
      version: 0
    });
    reopened.close();
  });

  it("increments task version and rejects a stale expected version", () => {
    const { database, store } = createStore();
    const original = task();
    const updated = task({
      title: "Persist task progress safely",
      updated_at: "2026-08-17T00:01:00.000Z"
    });
    store.transaction((tx) => tx.insertTask(original));

    store.transaction((tx) => tx.updateTask(updated, 0));
    expect(store.getTaskDetail("task-1")).toMatchObject({
      title: "Persist task progress safely",
      version: 1
    });

    expect(() => store.transaction((tx) => tx.updateTask({
      ...updated,
      title: "Stale overwrite"
    }, 0))).toThrowError(expect.objectContaining({ code: "VERSION_CONFLICT" }));
    expect(store.getTaskDetail("task-1")).toMatchObject({
      title: "Persist task progress safely",
      version: 1
    });
    database.close();
  });

  it("validates JSON values before writing them", () => {
    const { database, store } = createStore();
    store.transaction((tx) => tx.insertTask(task()));

    expect(() => store.transaction((tx) => tx.putOperationResult({
      session_id: "session-1",
      operation_id: "operation-invalid",
      result: { unsupported: BigInt(1) } as unknown as JsonValue,
      created_at: "2026-08-17T00:00:00.000Z"
    }))).toThrowError();

    database.close();
  });

  it("validates task, checkpoint, and task event JSON at the application boundary", () => {
    const { database, store } = createStore();
    const invalidCheckpoint = {
      completed_items: [],
      current_state: "working",
      confirmed_decisions: [],
      pending_decisions: [],
      blockers: [],
      verification: []
    } as unknown as CheckpointPayload;

    expect(() => store.transaction((tx) => tx.insertTask(task({
      checkpoint: invalidCheckpoint
    })))).toThrowError();
    expect(store.getTaskDetail("task-1")).toBeUndefined();

    store.transaction((tx) => tx.insertTask(task()));
    const invalidCheckpointRecord: CheckpointRecord = {
      checkpoint_id: "checkpoint-1",
      task_id: "task-1",
      session_id: "session-1",
      payload: invalidCheckpoint,
      created_at: "2026-08-17T00:01:00.000Z"
    };
    expect(() => store.transaction((tx) => {
      tx.insertCheckpoint(invalidCheckpointRecord);
    })).toThrowError();

    const invalidEvent: TaskEventRecord = {
      event_id: "event-1",
      task_id: "task-1",
      session_id: "session-1",
      event_type: "checkpointed",
      payload: { invalid: BigInt(1) } as unknown as JsonValue,
      created_at: "2026-08-17T00:01:00.000Z"
    };
    expect(() => store.transaction((tx) => {
      tx.appendTaskEvent(invalidEvent);
    })).toThrowError();

    database.close();
  });

  it("returns STORAGE_BUSY after finite retries while another writer holds the lock", () => {
    const { config, database, store } = createStore();
    const lockingDatabase = new DatabaseSync(config.databasePath);
    lockingDatabase.exec("BEGIN IMMEDIATE");

    const startedAt = Date.now();
    let thrown: unknown;
    try {
      store.transaction((tx) => tx.insertTask(task()));
    } catch (error) {
      thrown = error;
    } finally {
      lockingDatabase.exec("ROLLBACK");
      lockingDatabase.close();
    }

    expect(thrown).toBeInstanceOf(StorageError);
    expect(thrown).toMatchObject({ code: "STORAGE_BUSY" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(database.getDiagnostics()).toMatchObject({ busyTimeoutMs: 5_000 });
    database.close();
  });
});
