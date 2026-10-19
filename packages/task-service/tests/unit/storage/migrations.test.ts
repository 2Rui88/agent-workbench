/// <reference types="node" />

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeConfig } from "../../../src/config/runtime-config.js";
import { SessionService } from "../../../src/core/session-service.js";
import { SqliteDatabase, StorageError } from "../../../src/storage/database.js";
import * as migrationModule from "../../../src/storage/migrations.js";
import type { TaskRecord } from "../../../src/shared/task-contracts.js";
import type {
  DependencyValidationRecord,
  DependencyValidationRunRecord,
  RepositoryRecord,
  SessionRecord
} from "../../../src/storage/progress-store.js";

const temporaryDirectories: string[] = [];

function temporaryDataDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-"));
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

function writeTestFixture(databasePath: string, work: (database: DatabaseSync) => void): void {
  mkdirSync(join(databasePath, ".."), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("BEGIN IMMEDIATE");
  try {
    work(database);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function listTables(database: DatabaseSync): string[] {
  return database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => String(row.name));
}

function columnNames(databasePath: string, tableName: string): string[] {
  return inspectDatabase(databasePath, (database) => database.prepare(
    `PRAGMA table_info(${tableName})`
  ).all().map((row) => String(row.name)));
}

function runtimeKeys(value: object): PropertyKey[] {
  return [
    ...Reflect.ownKeys(value),
    ...Reflect.ownKeys(Object.getPrototypeOf(value) as object)
  ];
}

async function waitForBackupCount(dataDir: string, expectedCount: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const backupsDir = join(dataDir, "backups");
    const backupCount = existsSync(backupsDir)
      ? readdirSync(backupsDir).length
      : 0;
    if (backupCount >= expectedCount) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expectedCount} migration backups`);
}

function waitForChild(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

function spawnDatabaseOpen(
  config: ReturnType<typeof createRuntimeConfig>
): ChildProcess {
  const databaseModuleUrl = pathToFileURL(join(
    process.cwd(),
    "src/storage/database.ts"
  )).href;
  const childScript = `
    const { SqliteDatabase } = await import(${JSON.stringify(databaseModuleUrl)});
    const database = SqliteDatabase.open(${JSON.stringify(config)});
    database.close();
  `;
  return spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", childScript],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runtime config", () => {
  it("uses the specified loopback port and macOS application data path by default", () => {
    expect(createRuntimeConfig()).toEqual({
      host: "127.0.0.1",
      port: 47_321,
      dataDir: join(
        homedir(),
        "Library",
        "Application Support",
        "cli-session-task-mcp"
      ),
      databasePath: join(
        homedir(),
        "Library",
        "Application Support",
        "cli-session-task-mcp",
        "task-progress.sqlite"
      ),
      staleAfterMs: 1_800_000,
      sqliteBusyTimeoutMs: 5_000,
      hostChallengeTtlMs: 120_000,
      hostEvidenceWindowMs: 900_000
    });
  });

  it("overrides the port from TASK_MCP_PORT for isolated runs", () => {
    process.env.TASK_MCP_PORT = "47399";
    try {
      // main.ts calls with no arguments, so the environment wins.
      expect(createRuntimeConfig()).toMatchObject({ port: 47_399 });
    } finally {
      delete process.env.TASK_MCP_PORT;
    }
  });

  it("ignores an invalid TASK_MCP_PORT", () => {
    process.env.TASK_MCP_PORT = "not-a-port";
    try {
      expect(createRuntimeConfig()).toMatchObject({ port: 47_321 });
    } finally {
      delete process.env.TASK_MCP_PORT;
    }
  });
});

describe("SQLite migrations", () => {
  it("upgrades a populated v11 database without replaying historical migrations", () => {
    const config = createRuntimeConfig(temporaryDataDir());
    SqliteDatabase.open(config).close();
    writeTestFixture(config.databasePath, (legacy) => {
      legacy.exec(`
        ALTER TABLE sessions DROP COLUMN successor_session_id;
        ALTER TABLE sessions DROP COLUMN successor_ctx_id;
        ALTER TABLE task_dependencies DROP COLUMN policy;
        ALTER TABLE dependency_validations DROP COLUMN ctx_id;
        INSERT INTO projects(project_id, name, created_at, updated_at)
          VALUES ('upgrade-project', 'Upgrade', '2026-09-05', '2026-09-05');
        INSERT INTO repositories(repository_id, project_id, path, label, created_at, updated_at)
          VALUES ('upgrade-repo', 'upgrade-project', '/tmp/upgrade', 'Upgrade', '2026-09-05', '2026-09-05');
        INSERT INTO sessions(session_id, repository_id, label, started_at, owner)
          VALUES ('upgrade-session', 'upgrade-repo', 'Retained', '2026-09-05T00:00:00.000Z', 'jande');
        PRAGMA user_version = 11;
      `);
    });
    const upgraded = SqliteDatabase.open(config);
    try {
      expect(upgraded.createProgressStore().transaction((tx) => tx.getSession("upgrade-session")))
        .toMatchObject({ owner: "jande", label: "Retained" });
      expect(columnNames(config.databasePath, "task_dependencies")).toContain("policy");
      expect(columnNames(config.databasePath, "dependency_validations")).toContain("ctx_id");
      expect(upgraded.getDiagnostics().schemaVersion).toBeGreaterThan(11);
    } finally {
      upgraded.close();
    }
    const reopened = SqliteDatabase.open(config);
    expect(reopened.createProgressStore().transaction((tx) => tx.getSession("upgrade-session")))
      .toMatchObject({ owner: "jande" });
    reopened.close();
  });

  it("creates every required table with foreign keys and WAL", () => {
    const config = createRuntimeConfig(temporaryDataDir());
    const database = SqliteDatabase.open(config);

    expect(database.getDiagnostics()).toMatchObject({
      busyTimeoutMs: 5_000,
      foreignKeys: true,
      journalMode: "wal",
      schemaVersion: migrationModule.migrationMetadata.length
    });
    expect(inspectDatabase(config.databasePath, listTables)).toEqual(expect.arrayContaining([
      "projects",
      "repositories",
      "tasks",
      "task_scopes",
      "sessions",
      "task_session_links",
      "active_task_leases",
      "checkpoints",
      "repo_snapshots",
      "task_events",
      "human_decisions",
      "task_dependencies",
      "dependency_validations",
      "dependency_validation_runs",
      "dependency_repair_requests",
      "operation_results",
      "legacy_task_imports"
    ]));
    expect(columnNames(config.databasePath, "active_task_leases")).toContain(
      "generation"
    );
    expect(columnNames(config.databasePath, "repo_snapshots")).toContain(
      "content_digest"
    );
    expect(columnNames(config.databasePath, "operation_results")).toEqual(
      expect.arrayContaining(["tool_name", "request_hash"])
    );
    expect(columnNames(config.databasePath, "dependency_validation_runs")).toEqual(
      expect.arrayContaining([
        "run_id", "validation_id", "attempt", "status", "owner", "session_id",
        "heartbeat_at", "expires_at", "verification_json", "operation_id"
      ])
    );
    expect(migrationModule.migrationMetadata.at(-1)).toEqual({
      version: 16,
      name: "add_project_archive"
    });
    database.close();
  });

  it("upgrades a populated v12 database to v13 without losing workflow state", () => {
    const config = createRuntimeConfig(temporaryDataDir());
    const timestamp = "2026-08-17T00:00:00.000Z";
    const database = SqliteDatabase.open(config);
    database.createProgressStore().transaction((tx) => {
      tx.upsertProject({
        project_id: "retained-project",
        name: "Retained",
        created_at: timestamp,
        updated_at: timestamp
      });
      tx.upsertRepository({
        repository_id: "retained-repo",
        project_id: "retained-project",
        path: "/tmp/retained",
        label: "Retained",
        created_at: timestamp,
        updated_at: timestamp
      });
      tx.insertSession({
        session_id: "retained-upstream-session",
        repository_id: "retained-repo",
        label: "Upstream",
        owner: "owner-upstream",
        started_at: timestamp
      });
      tx.insertSession({
        session_id: "retained-downstream-session",
        repository_id: "retained-repo",
        label: "Downstream",
        owner: "owner-downstream",
        started_at: timestamp
      });
      tx.insertSession({
        session_id: "legacy-predecessor-session",
        repository_id: "retained-repo",
        label: "Legacy predecessor",
        owner: "owner-upstream",
        started_at: timestamp,
        stale_at: timestamp,
        transport_session_id: "legacy-predecessor-transport",
        client_name: "codex-cli",
        client_version: "0.147.0",
        client_family: "codex",
        protocol_version: "2025-06-18",
        workspace_path: "/tmp/retained",
        worktree_path: "/tmp/retained/worktrees/predecessor",
        last_activity_at: timestamp
      });
      tx.insertSession({
        session_id: "legacy-successor-session",
        repository_id: "retained-repo",
        label: "Legacy successor",
        owner: "owner-upstream",
        started_at: timestamp,
        transport_session_id: "legacy-successor-transport",
        client_name: "codex-cli",
        client_version: "0.147.0",
        client_family: "codex",
        protocol_version: "2025-06-18",
        workspace_path: "/tmp/retained",
        worktree_path: "/tmp/retained/worktrees/successor",
        last_activity_at: timestamp,
        successor_session_id: "legacy-predecessor-session",
        successor_ctx_id: "legacy-handoff-context"
      });
      tx.insertTask({
        task_id: "retained-upstream",
        repository_id: "retained-repo",
        session_id: "retained-upstream-session",
        owner: "owner-upstream",
        title: "Upstream",
        status: "in_progress",
        priority: "P1",
        created_at: timestamp,
        updated_at: timestamp
      });
      tx.insertTask({
        task_id: "retained-downstream",
        repository_id: "retained-repo",
        session_id: "retained-downstream-session",
        owner: "owner-downstream",
        title: "Downstream",
        status: "in_progress",
        priority: "P1",
        created_at: timestamp,
        updated_at: timestamp
      });
      tx.insertCheckpoint({
        checkpoint_id: "retained-checkpoint",
        task_id: "retained-upstream",
        session_id: "retained-upstream-session",
        payload: {
          completed_items: ["seeded v12 fixture"],
          current_state: "in_progress",
          human_context: [],
          confirmed_decisions: [],
          pending_decisions: [],
          blockers: [],
          verification: [],
          next_action: "migrate"
        },
        created_at: timestamp
      });
      tx.putOperationResult({
        session_id: "retained-upstream-session",
        operation_id: "retained-operation",
        result: { retained: true },
        created_at: timestamp
      });
      tx.insertTaskDependency({
        task_id: "retained-downstream",
        depends_on_task_id: "retained-upstream",
        created_at: timestamp
      });
      tx.insertDependencyValidation({
        validation_id: "retained-validation",
        upstream_task_id: "retained-upstream",
        downstream_task_id: "retained-downstream",
        cycle: 1,
        status: "pending",
        requested_by_actor: "agent",
        requested_by_owner: "owner-upstream",
        requested_at: timestamp,
        request_read_at: null,
        responded_by_owner: null,
        response_reason: null,
        responded_at: null,
        response_read_at: null,
        validation_spec: { acceptance_criteria: ["retained"] }
      });
      tx.insertDependencyValidationRun({
        run_id: "retained-run",
        validation_id: "retained-validation",
        attempt: 1,
        status: "running",
        owner: "owner-downstream",
        session_id: "retained-downstream-session",
        worktree_path: "/tmp/retained",
        heartbeat_at: timestamp,
        expires_at: "2026-08-17T00:30:00.000Z",
        started_at: timestamp,
        completed_at: null,
        verification: [],
        failure_reason: null,
        error_reason: null,
        operation_id: "retained-run-operation",
        created_at: timestamp,
        updated_at: timestamp
      });
    });
    database.close();

    writeTestFixture(config.databasePath, (legacy) => {
      legacy.exec(`
        DROP TABLE dependency_repair_requests;
        ALTER TABLE active_task_leases DROP COLUMN generation;
        ALTER TABLE repo_snapshots DROP COLUMN content_digest;
        ALTER TABLE operation_results DROP COLUMN tool_name;
        ALTER TABLE operation_results DROP COLUMN request_hash;
        PRAGMA user_version = 12;
      `);
    });

    const upgraded = SqliteDatabase.open(config);
    const store = upgraded.createProgressStore();
    expect(upgraded.getDiagnostics().schemaVersion).toBe(16);
    expect(store.getTaskDetail("retained-upstream")).toMatchObject({
      title: "Upstream"
    });
    expect(store.transaction((tx) => tx.getOperationResult(
      "retained-upstream-session",
      "retained-operation"
    ))).toMatchObject({ result: { retained: true } });
    expect(store.transaction((tx) => tx.getDependencyValidationRun("retained-run")))
      .toMatchObject({ status: "running" });
    expect(store.transaction((tx) => tx.getDependencyContext?.(
      "retained-repo:retained-upstream:retained-repo:retained-downstream:1"
    ))).toMatchObject({ current_cycle: 0 });
    expect(store.transaction((tx) => tx.getSession("legacy-predecessor-session")))
      .toMatchObject({
        successor_session_id: "legacy-successor-session",
        successor_ctx_id: "legacy-handoff-context",
        stale_at: timestamp
      });
    expect(store.transaction((tx) => tx.getSession("legacy-successor-session")))
      .not.toHaveProperty("successor_session_id");
    const sessionService = new SessionService(store, config);
    expect(() => sessionService.sessionContext({
      transport_session_id: "legacy-successor-transport",
      client_name: "codex-cli",
      client_version: "0.147.0",
      protocol_version: "2025-06-18",
      workspace_path: "/tmp/retained",
      repository_id: "retained-repo",
      worktree_path: "/tmp/retained/worktrees/successor",
      owner: "owner-upstream"
    }, "2026-08-17T00:01:00.000Z")).not.toThrow();
    expect(() => sessionService.sessionContext({
      transport_session_id: "legacy-predecessor-transport",
      client_name: "codex-cli",
      client_version: "0.147.0",
      protocol_version: "2025-06-18",
      workspace_path: "/tmp/retained",
      repository_id: "retained-repo",
      worktree_path: "/tmp/retained/worktrees/predecessor",
      owner: "owner-upstream"
    }, "2026-08-17T00:01:00.000Z")).toThrow(expect.objectContaining({
      code: "SESSION_SUPERSEDED"
    }));
    expect(inspectDatabase(config.databasePath, (raw) => (
      raw.prepare("PRAGMA foreign_key_check").all()
    ))).toEqual([]);
    upgraded.close();
  });

  it("does not expose raw SQL or transaction entry points", () => {
    const database = SqliteDatabase.open(createRuntimeConfig(temporaryDataDir()));
    const store = database.createProgressStore();

    expect(runtimeKeys(database)).not.toEqual(expect.arrayContaining([
      "database",
      "sqliteBusyTimeoutMs",
      "closed",
      "runTransaction",
      "prepare",
      "exec",
      "transaction"
    ]));
    expect(runtimeKeys(store as object)).not.toEqual(expect.arrayContaining([
      "database",
      "runTransaction"
    ]));
    expect((database as unknown as Record<string, unknown>).database).toBeUndefined();
    expect((store as unknown as Record<string, unknown>).database).toBeUndefined();

    database.close();
  });

  it("does not expose executable migrations that can capture the opening connection", () => {
    const config = createRuntimeConfig(temporaryDataDir());
    const moduleExports = migrationModule as unknown as Record<string, unknown>;
    const executableMigrations = moduleExports.migrations as Array<{
      up(database: DatabaseSync): void;
    }> | undefined;
    const firstMigration = executableMigrations?.[0];
    const originalUp = firstMigration?.up;
    let capturedDatabase: DatabaseSync | undefined;
    let database: SqliteDatabase | undefined;
    let ranOutsideTransaction = false;

    try {
      if (firstMigration !== undefined && originalUp !== undefined) {
        firstMigration.up = (rawDatabase) => {
          capturedDatabase = rawDatabase;
          originalUp(rawDatabase);
        };
      }

      database = SqliteDatabase.open(config);
      if (capturedDatabase !== undefined) {
        ranOutsideTransaction = !capturedDatabase.isTransaction;
        capturedDatabase.exec(`
          CREATE TABLE migration_escape(value TEXT NOT NULL) STRICT
        `);
        capturedDatabase.prepare(
          "INSERT INTO migration_escape(value) VALUES (?)"
        ).run("escaped");
      }

      const escapedWriteVisible = inspectDatabase(config.databasePath, (rawDatabase) => (
        listTables(rawDatabase).includes("migration_escape")
      ));
      expect(ranOutsideTransaction).toBe(false);
      expect(escapedWriteVisible).toBe(false);
      expect(capturedDatabase).toBeUndefined();
      expect(moduleExports.migrations).toBeUndefined();

      const metadata = moduleExports.migrationMetadata;
      expect(Array.isArray(metadata)).toBe(true);
      expect(Object.isFrozen(metadata)).toBe(true);
      for (const entry of metadata as object[]) {
        expect(Object.isFrozen(entry)).toBe(true);
        expect(Object.values(entry).some((value) => typeof value === "function"))
          .toBe(false);
      }
    } finally {
      if (firstMigration !== undefined && originalUp !== undefined) {
        firstMigration.up = originalUp;
      }
      database?.close();
    }
  });

  it("reopens an already migrated database without applying version one twice", () => {
    const config = createRuntimeConfig(temporaryDataDir());

    SqliteDatabase.open(config).close();
    const reopened = SqliteDatabase.open(config);

    expect(reopened.getDiagnostics()).toMatchObject({
      schemaVersion: migrationModule.migrationMetadata.length
    });
    expect(inspectDatabase(config.databasePath, listTables)).toContain("tasks");
    reopened.close();
  });

  it("adds a nullable project creator column for existing databases", () => {
    const config = createRuntimeConfig(temporaryDataDir());

    const database = SqliteDatabase.open(config);
    database.close();

    expect(columnNames(config.databasePath, "projects")).toContain("created_by");
    expect(inspectDatabase(config.databasePath, (connection) => (
      connection.prepare("SELECT created_by FROM projects LIMIT 1").get()
    ))).toBeUndefined();
  });

  it("upgrades a v15 database with nullable project archive columns", () => {
    const config = createRuntimeConfig(temporaryDataDir());
    SqliteDatabase.open(config).close();
    writeTestFixture(config.databasePath, (legacy) => {
      legacy.exec(`
        ALTER TABLE projects DROP COLUMN archived_at;
        ALTER TABLE projects DROP COLUMN archived_by;
        INSERT INTO projects(project_id, name, created_at, updated_at)
          VALUES ('v15-project', 'V15', '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z');
        PRAGMA user_version = 15;
      `);
    });
    const upgraded = SqliteDatabase.open(config);
    try {
      expect(upgraded.getDiagnostics().schemaVersion).toBe(16);
      expect(columnNames(config.databasePath, "projects")).toEqual(
        expect.arrayContaining(["archived_at", "archived_by"])
      );
      expect(upgraded.createProgressStore().getProject("v15-project")).toMatchObject({
        project_id: "v15-project",
        archived_at: null,
        archived_by: null
      });
    } finally {
      upgraded.close();
    }
    const reopened = SqliteDatabase.open(config);
    expect(reopened.getDiagnostics().schemaVersion).toBe(16);
    reopened.close();
  });

  it("upgrades a version-six database with session context and validation storage", () => {
    const config = createRuntimeConfig(temporaryDataDir());
    SqliteDatabase.open(config).close();
    writeTestFixture(config.databasePath, (database) => {
      const timestamp = "2026-08-17T00:00:00.000Z";
      database.prepare(`
        INSERT INTO projects(project_id, name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run("project-1", "Project One", timestamp, timestamp);
      database.prepare(`
        INSERT INTO repositories(
          repository_id, project_id, path, label, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run("repo-1", "project-1", "/tmp/project-one", "Project One", timestamp, timestamp);
      database.prepare(`
        INSERT INTO sessions(session_id, repository_id, label, started_at)
        VALUES (?, ?, ?, ?)
      `).run("session-1", "repo-1", "Existing session", timestamp);
      database.exec("DROP TABLE session_events");
      database.exec("DROP TABLE dependency_validations");
      database.exec("PRAGMA user_version = 6");
    });

    const upgraded = SqliteDatabase.open(config);

    expect(upgraded.getDiagnostics()).toMatchObject({
      schemaVersion: migrationModule.migrationMetadata.length
    });
    expect(inspectDatabase(config.databasePath, listTables)).toContain("session_events");
    expect(inspectDatabase(config.databasePath, listTables)).toContain(
      "dependency_validations"
    );
    expect(inspectDatabase(config.databasePath, (database) => (
      database.prepare("SELECT label FROM sessions WHERE session_id = ?")
        .get("session-1")
    ))).toMatchObject({ label: "Existing session" });
    upgraded.close();
  });

  it("upgrades a legacy v8 database to v12 and reopens idempotently", () => {
    const config = createRuntimeConfig(temporaryDataDir());
    SqliteDatabase.open(config).close();
    const legacy = new DatabaseSync(config.databasePath);
    legacy.exec("DROP INDEX dependency_validation_runs_active_idx");
    legacy.exec("DROP TABLE dependency_validation_runs");
    legacy.exec("ALTER TABLE dependency_validations DROP COLUMN validation_spec_json");
    legacy.exec("PRAGMA user_version = 8");
    legacy.close();

    const upgraded = SqliteDatabase.open(config);
    expect(upgraded.getDiagnostics().schemaVersion).toBe(16);
    expect(inspectDatabase(config.databasePath, listTables)).toContain(
      "dependency_validation_runs"
    );
    expect(columnNames(config.databasePath, "dependency_validations")).toContain(
      "validation_spec_json"
    );
    upgraded.close();

    const reopened = SqliteDatabase.open(config);
    expect(reopened.getDiagnostics().schemaVersion).toBe(16);
    reopened.close();
  });

  it("persists validation progress and latest_run across SQLite reopen", () => {
    const config = createRuntimeConfig(temporaryDataDir());
    const timestamp = "2026-08-17T00:00:00.000Z";
    const project = { project_id: "project-1", name: "Project One", created_at: timestamp, updated_at: timestamp };
    const repository: RepositoryRecord = {
      repository_id: "repo-1", project_id: "project-1", path: "/tmp/project-one",
      label: "Project One", created_at: timestamp, updated_at: timestamp
    };
    const upstreamSession: SessionRecord = {
      session_id: "session-upstream", repository_id: "repo-1", label: "Upstream",
      started_at: timestamp, owner: "owner-upstream", worktree_path: "/tmp/wt-upstream"
    };
    const downstreamSession: SessionRecord = {
      session_id: "session-downstream", repository_id: "repo-1", label: "Downstream",
      started_at: timestamp, owner: "owner-downstream", worktree_path: "/tmp/wt-downstream"
    };
    const upstream: TaskRecord = {
      task_id: "task-upstream", repository_id: "repo-1", session_id: upstreamSession.session_id,
      owner: "owner-upstream", title: "Upstream", status: "done", priority: "P1",
      created_at: timestamp, updated_at: timestamp
    };
    const downstream: TaskRecord = {
      task_id: "task-downstream", repository_id: "repo-1", session_id: downstreamSession.session_id,
      owner: "owner-downstream", title: "Downstream", status: "in_progress", priority: "P1",
      created_at: timestamp, updated_at: timestamp
    };
    const validation: DependencyValidationRecord = {
      validation_id: "validation-roundtrip", upstream_task_id: upstream.task_id,
      downstream_task_id: downstream.task_id, cycle: 1, status: "pending",
      requested_by_actor: "agent", requested_by_owner: "owner-upstream", requested_at: timestamp,
      request_read_at: null, responded_by_owner: null, response_reason: null,
      responded_at: null, response_read_at: null,
      validation_spec: { acceptance_criteria: ["all checks pass"] }
    };
    const run: DependencyValidationRunRecord = {
      run_id: "run-roundtrip", validation_id: validation.validation_id, attempt: 1,
      status: "running", owner: "owner-downstream", session_id: downstreamSession.session_id,
      worktree_path: downstreamSession.worktree_path!, heartbeat_at: timestamp,
      expires_at: "2026-08-17T00:10:00.000Z", started_at: timestamp, completed_at: null,
      verification: [], progress: { phase: "checks", completed_checks: ["npm test"] },
      failure_reason: null, error_reason: null, operation_id: "op-roundtrip",
      created_at: timestamp, updated_at: timestamp
    };

    const database = SqliteDatabase.open(config);
    const store = database.createProgressStore();
    store.transaction((tx) => {
      tx.upsertProject(project);
      tx.upsertRepository(repository);
      tx.insertSession(upstreamSession);
      tx.insertSession(downstreamSession);
      tx.insertTask(upstream);
      tx.insertTask(downstream);
      tx.insertTaskDependency({ task_id: downstream.task_id, depends_on_task_id: upstream.task_id, created_at: timestamp });
      tx.insertDependencyValidation(validation);
      tx.insertDependencyValidationRun(run);
    });
    database.close();

    const reopened = SqliteDatabase.open(config);
    const reopenedStore = reopened.createProgressStore();
    const view = reopenedStore.getDependencyValidation(validation.validation_id)!;
    expect(view.latest_run).toMatchObject({
      run_id: run.run_id,
      status: "running",
      progress: { phase: "checks", completed_checks: ["npm test"] }
    });
    expect(reopenedStore.transaction((tx) => tx.listDependencyValidationRuns(validation.validation_id)[0])).toMatchObject({
      progress: run.progress
    });
    reopened.close();
  });

  it("backs up an existing database and rolls back a failed migration", () => {
    const dataDir = temporaryDataDir();
    const config = createRuntimeConfig(dataDir);
    writeTestFixture(config.databasePath, (database) => {
      database.exec("CREATE TABLE migration_sentinel(value TEXT NOT NULL)");
      database.prepare("INSERT INTO migration_sentinel(value) VALUES (?)").run("preserved");
      database.exec("CREATE TABLE repositories(value TEXT NOT NULL)");
    });

    expect(() => SqliteDatabase.open(config)).toThrowError(/repositories already exists/);

    inspectDatabase(config.databasePath, (database) => {
      expect(database.prepare("SELECT value FROM migration_sentinel").get())
        .toMatchObject({ value: "preserved" });
      expect(listTables(database)).not.toContain("projects");
      expect(database.prepare("PRAGMA user_version").get()).toMatchObject({
        user_version: 0
      });
    });
    const backupsDir = join(dataDir, "backups");
    const backups = readdirSync(backupsDir);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^task-progress-\d{8}-\d{6}\.sqlite$/);
    expect(existsSync(join(backupsDir, backups[0]!))).toBe(true);
  });

  it("rejects a database with a newer unknown schema version", () => {
    const config = createRuntimeConfig(temporaryDataDir());
    writeTestFixture(config.databasePath, (database) => {
      database.exec("PRAGMA user_version = 999");
    });

    let thrown: unknown;
    try {
      SqliteDatabase.open(config);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StorageError);
    expect(thrown).toMatchObject({ code: "SCHEMA_VERSION_UNSUPPORTED" });
  });

  it("rejects invalid JSON in every JSON-backed table at the database boundary", () => {
    const config = createRuntimeConfig(temporaryDataDir());
    SqliteDatabase.open(config).close();

    writeTestFixture(config.databasePath, (database) => {
      const timestamp = "2026-08-17T00:00:00.000Z";
      database.prepare(`
        INSERT INTO projects(project_id, name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run("project-1", "Project One", timestamp, timestamp);
      database.prepare(`
        INSERT INTO repositories(
          repository_id, project_id, path, label, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run("repo-1", "project-1", "/tmp/project-one", "Project One", timestamp, timestamp);
      database.prepare(`
        INSERT INTO sessions(session_id, repository_id, label, started_at)
        VALUES (?, ?, ?, ?)
      `).run("session-1", "repo-1", "CLI session", timestamp);
      database.prepare(`
        INSERT INTO tasks(
          task_id, repository_id, session_id, title, status, priority,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "task-1",
        "repo-1",
        "session-1",
        "Task",
        "in_progress",
        "P1",
        timestamp,
        timestamp
      );

      expect(() => database.prepare(`
        UPDATE tasks SET checkpoint_json = ? WHERE task_id = ?
      `).run("{invalid", "task-1")).toThrowError(/CHECK constraint failed/);
      expect(() => database.prepare(`
        INSERT INTO checkpoints(
          checkpoint_id, task_id, session_id, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run("checkpoint-1", "task-1", "session-1", "{invalid", timestamp))
        .toThrowError(/CHECK constraint failed/);
      expect(() => database.prepare(`
        INSERT INTO task_events(
          event_id, task_id, session_id, event_type, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run("event-1", "task-1", "session-1", "updated", "{invalid", timestamp))
        .toThrowError(/CHECK constraint failed/);
      expect(() => database.prepare(`
        INSERT INTO session_events(
          event_id, session_id, event_type, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run("session-event-1", "session-1", "rebound", "{invalid", timestamp))
        .toThrowError(/CHECK constraint failed/);
      expect(() => database.prepare(`
        INSERT INTO operation_results(session_id, operation_id, result_json, created_at)
        VALUES (?, ?, ?, ?)
      `).run("session-1", "operation-1", "{invalid", timestamp))
        .toThrowError(/CHECK constraint failed/);
    });
  });

  it("rechecks schema version after waiting for the migration write lock", async () => {
    const dataDir = temporaryDataDir();
    const config = createRuntimeConfig(dataDir);
    writeTestFixture(config.databasePath, () => undefined);
    const firstMigrator = new DatabaseSync(config.databasePath);
    firstMigrator.exec("PRAGMA journal_mode = WAL");
    firstMigrator.exec("BEGIN IMMEDIATE");
    const firstCompetingMigrator = spawnDatabaseOpen(config);
    const firstChildResult = waitForChild(firstCompetingMigrator);
    let secondCompetingMigrator: ChildProcess | undefined;

    try {
      await waitForBackupCount(dataDir, 1);
      secondCompetingMigrator = spawnDatabaseOpen(config);
      const secondChildResult = waitForChild(secondCompetingMigrator);
      await waitForBackupCount(dataDir, 2);
      firstMigrator.exec("COMMIT");
      const outcomes = await Promise.all([
        firstChildResult,
        secondChildResult
      ]);
      expect(outcomes).toEqual([
        { code: 0, stderr: "" },
        { code: 0, stderr: "" }
      ]);
    } finally {
      if (firstMigrator.isTransaction) {
        firstMigrator.exec("ROLLBACK");
      }
      firstMigrator.close();
      firstCompetingMigrator.kill();
      secondCompetingMigrator?.kill();
    }

    const reopened = SqliteDatabase.open(config);
    expect(reopened.getDiagnostics()).toMatchObject({
      schemaVersion: migrationModule.migrationMetadata.length
    });
    reopened.close();
  });
});
