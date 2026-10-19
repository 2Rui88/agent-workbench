/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeConfig } from "../../../src/config/runtime-config.js";
import {
  TaskService,
  type AdoptTaskInput,
  type CreateTaskInput,
  type StartTaskInput,
  type SwitchTaskInput
} from "../../../src/core/task-service.js";
import type {
  RepoProbeInput,
  RepoSnapshotDraft
} from "../../../src/repo/repo-probe.js";
import { SqliteDatabase } from "../../../src/storage/database.js";
import type { ProgressStore } from "../../../src/storage/progress-store.js";

function valueOf(entry: PromiseSettledResult<unknown>): unknown {
  return entry.status === "fulfilled" ? entry.value : undefined;
}

function rejectionOf(entry: PromiseSettledResult<unknown>): unknown {
  return entry.status === "rejected" ? entry.reason : undefined;
}

const temporaryDirectories: string[] = [];
const BASE_TIME_MS = Date.parse("2026-08-17T10:00:00.000Z");

function isoAt(offsetSeconds: number): string {
  return new Date(BASE_TIME_MS + offsetSeconds * 1_000).toISOString();
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
}

function createGitRepository(path: string): string {
  mkdirSync(path);
  git(path, ["init", "-b", "main"]);
  git(path, ["config", "user.email", "races@example.com"]);
  git(path, ["config", "user.name", "Race Test"]);
  writeFileSync(join(path, "base.txt"), "base\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "base"]);
  return realpathSync(path);
}

interface RaceFixture {
  store: ProgressStore;
  database: SqliteDatabase;
  databasePath: string;
  service: TaskService;
  probe: DeferredProbe;
  rootPath: string;
  worktreeA: string;
  worktreeB: string;
}

/**
 * A probe double whose inspections stay pending until flushed, so tests can
 * pin callers at the async probe boundary and then release them together.
 */
class DeferredProbe {
  readonly #pending: {
    input: RepoProbeInput;
    resolve: (draft: RepoSnapshotDraft) => void;
    reject: (error: Error) => void;
  }[] = [];
  #store: RaceFixture | undefined;
  #flushedOnce = false;

  bind(fixture: RaceFixture): void {
    this.#store = fixture;
  }

  async inspect(input: RepoProbeInput): Promise<RepoSnapshotDraft> {
    return new Promise<RepoSnapshotDraft>((resolve, reject) => {
      this.#pending.push({ input, resolve, reject });
      if (this.#flushedOnce) {
        this.flushOne();
      }
    });
  }

  pendingCount(): number {
    return this.#pending.length;
  }

  /** Resolve the queued inspections; later calls resolve immediately. */
  flushAll(): void {
    this.#flushedOnce = true;
    while (this.#pending.length > 0) {
      this.flushOne();
    }
  }

  private flushOne(): void {
    const entry = this.#pending.shift();
    if (entry === undefined) {
      return;
    }
    const store = this.#store;
    if (store === undefined) {
      entry.reject(new Error("DeferredProbe was not bound to a fixture"));
      return;
    }
    entry.resolve({
      repository_id: "repo-1",
      repository_path: store.rootPath,
      worktree_path: entry.input.worktree_path,
      head_commit: git(entry.input.worktree_path, ["rev-parse", "HEAD"]).trimEnd(),
      branch: git(entry.input.worktree_path, ["branch", "--show-current"]).trimEnd(),
      changed_files: [],
      captured_at: isoAt(0)
    });
  }
}

function createFixture(): RaceFixture {
  const dataDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-"));
  const workDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-repo-"));
  temporaryDirectories.push(dataDir, workDir);

  const rootPath = createGitRepository(join(workDir, "main-repo"));
  git(rootPath, ["worktree", "add", "-b", "feature-a", join(workDir, "wt-a")]);
  git(rootPath, ["worktree", "add", "-b", "feature-b", join(workDir, "wt-b")]);
  const worktreeA = realpathSync(join(workDir, "wt-a"));
  const worktreeB = realpathSync(join(workDir, "wt-b"));

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
      path: rootPath,
      label: "Project One",
      created_at: isoAt(0),
      updated_at: isoAt(0)
    });
    tx.insertSession({
      session_id: "session-a",
      repository_id: "repo-1",
      label: "Session A",
      started_at: isoAt(0),
      worktree_path: worktreeA,
      last_activity_at: isoAt(0)
    });
    tx.insertSession({
      session_id: "session-b",
      repository_id: "repo-1",
      label: "Session B",
      started_at: isoAt(0),
      worktree_path: worktreeB,
      last_activity_at: isoAt(0)
    });
  });

  let clockTick = 0;
  const probe = new DeferredProbe();
  const fixture: RaceFixture = {
    store,
    database,
    databasePath: config.databasePath,
    probe,
    rootPath,
    worktreeA,
    worktreeB,
    service: new TaskService({
      store,
      probe,
      now: () => isoAt(clockTick++)
    })
  };
  probe.bind(fixture);
  return fixture;
}

function createInput(sessionId: string, suffix: string): CreateTaskInput {
  return {
    session_id: sessionId,
    operation_id: `op-create-${suffix}`,
    expected_version: 0,
    repository_id: "repo-1",
    title: `Task ${suffix}`,
    goal: `Finish task ${suffix}`,
    acceptance_criteria: ["tests pass"],
    next_action: "begin work",
    priority: "P1"
  };
}

function startInput(sessionId: string, suffix: string, taskId: string): StartTaskInput {
  return {
    session_id: sessionId,
    operation_id: `op-start-${suffix}`,
    task_id: taskId,
    expected_version: 0
  };
}

function adoptInput(sessionId: string, suffix: string, worktreePath: string): AdoptTaskInput {
  return {
    session_id: sessionId,
    operation_id: `op-adopt-${suffix}`,
    expected_version: 0,
    legacy_import_key: `legacy-${suffix}`,
    source_session_label: `Legacy ${suffix}`,
    project_id: "project-1",
    repository_id: "repo-1",
    worktree_path: worktreePath,
    normalized_title: `Legacy task ${suffix}`,
    goal: `Finish legacy task ${suffix}`,
    acceptance_criteria: ["legacy tests pass"],
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
        source_session_label: `Legacy ${suffix}`,
        adoption_method: "mcp",
        adopted_at: isoAt(0)
      }
    },
    snapshot: { head_commit: "0123456789abcdef0123456789abcdef01234567" }
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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("task races over real SQLite", () => {
  it("rolls back the session binding when a cross-worktree switch fails mid-transaction", async () => {
    const fixture = createFixture();
    const current = await fixture.service.createTask(createInput("session-a", "rollback-current"));
    const start = fixture.service.startTask(startInput(
      "session-a",
      "rollback-current",
      current.task_id
    ));
    expect(fixture.probe.pendingCount()).toBe(1);
    fixture.probe.flushAll();
    await start;
    const target = await fixture.service.createTask({
      ...createInput("session-a", "rollback-target"),
      scopes: [{ scope_type: "worktree_path", scope_value: fixture.worktreeA }]
    });
    const rawDatabase = new DatabaseSync(fixture.databasePath);
    rawDatabase.exec(`
      CREATE TRIGGER fail_switch_target_start
      BEFORE INSERT ON task_events
      WHEN NEW.event_type = 'task_started'
      BEGIN
        SELECT RAISE(ABORT, 'forced target start failure');
      END
    `);
    rawDatabase.close();
    const input: SwitchTaskInput = {
      session_id: "session-a",
      operation_id: "op-switch-rollback",
      task_id: current.task_id,
      expected_version: 1,
      checkpoint: {
        completed_items: [],
        current_state: "ready to switch",
        human_context: [],
        confirmed_decisions: [],
        pending_decisions: [],
        blockers: [],
        verification: [],
        next_action: "work in target"
      },
      target_task_id: target.task_id,
      target_expected_version: 0,
      target_worktree_path: fixture.worktreeB
    };

    await expect(fixture.service.switchTask(input)).rejects.toBeDefined();

    expect(fixture.store.transaction((tx) => tx.getSession("session-a"))).toMatchObject({
      worktree_path: fixture.worktreeA
    });
    expect(fixture.store.getTaskDetail(current.task_id)).toMatchObject({
      status: "in_progress",
      version: 1
    });
    expect(fixture.store.getTaskDetail(target.task_id)).toMatchObject({
      status: "backlog",
      version: 0
    });
    expect(fixture.store.getTaskDetail(target.task_id)?.scopes
      .filter((scope) => scope.scope_type === "worktree_path"))
      .toEqual([
        expect.objectContaining({ scope_value: fixture.worktreeA })
      ]);
    expect(fixture.store.transaction((tx) => tx.getLeaseByTask(current.task_id)))
      .toMatchObject({ session_id: "session-a" });
    expect(fixture.store.transaction((tx) => tx.getLeaseByTask(target.task_id)))
      .toBeUndefined();
    expect(fixture.store.listSessionEvents("session-a")).toEqual([]);
    fixture.database.close();
  });

  it("leaves exactly one lease when two sessions race to start the same task", async () => {
    const { database, service, probe } = createFixture();
    const created = await service.createTask(createInput("session-a", "1"));
    const taskId = created.task_id;

    const race = Promise.allSettled([
      service.startTask(startInput("session-a", "a", taskId)),
      service.startTask(startInput("session-b", "b", taskId))
    ]);
    expect(probe.pendingCount()).toBe(2);
    probe.flushAll();
    const settled = await race;

    const fulfilled = settled.filter((entry) => entry.status === "fulfilled");
    const rejected = settled.filter((entry) => entry.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(valueOf(fulfilled[0]!)).toMatchObject({
      status: "in_progress",
      version: 1
    });
    expect(rejectionOf(rejected[0]!)).toMatchObject({
      code: "TASK_VERSION_CONFLICT",
      current_version: "1",
      retryable: false,
      evidence: expect.any(Array),
      recovery_actions: expect.any(Array)
    });

    const leases = rows(
      database.path,
      "SELECT task_id, session_id FROM active_task_leases"
    );
    expect(leases).toEqual([{ task_id: taskId, session_id: expect.any(String) }]);
    const startedEvents = rows(
      database.path,
      "SELECT COUNT(*) AS count FROM task_events WHERE event_type = 'task_started'"
    );
    expect(startedEvents[0]).toMatchObject({ count: 1 });
    database.close();
  });

  it("keeps a single lease when one session races to start two tasks", async () => {
    const { database, service, probe } = createFixture();
    const first = (await service.createTask(createInput("session-a", "1"))).task_id;
    const second = (await service.createTask(createInput("session-a", "2"))).task_id;

    const race = Promise.allSettled([
      service.startTask(startInput("session-a", "a", first)),
      service.startTask(startInput("session-a", "b", second))
    ]);
    expect(probe.pendingCount()).toBe(2);
    probe.flushAll();
    const settled = await race;

    const fulfilled = settled.filter((entry) => entry.status === "fulfilled");
    const rejected = settled.filter((entry) => entry.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejectionOf(rejected[0]!)).toMatchObject({
      code: "TASK_LEASE_CONFLICT",
      retryable: false,
      evidence: expect.any(Array),
      recovery_actions: expect.any(Array)
    });

    const leases = rows(database.path, "SELECT task_id FROM active_task_leases");
    expect(leases).toHaveLength(1);
    database.close();
  });

  it("keeps tasks, events, and leases consistent when task_adopt races task_start on one worktree", async () => {
    const { database, service, probe, worktreeA } = createFixture();
    const nativeTaskId = (await service.createTask({
      ...createInput("session-a", "1"),
      scopes: [{ scope_type: "worktree_path", scope_value: worktreeA }]
    })).task_id;

    const startPromise = service.startTask(startInput("session-a", "a", nativeTaskId));
    expect(probe.pendingCount()).toBe(1);
    const adopted = await service.adoptTask(adoptInput("session-b", "1", worktreeA));
    expect(adopted).toMatchObject({ status: "in_progress", version: 0 });
    probe.flushAll();
    const startOutcome = await startPromise.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason })
    );

    expect(startOutcome).toMatchObject({
      status: "rejected",
      reason: { code: "WORKTREE_CONFLICT" }
    });

    const leases = rows(database.path, "SELECT task_id FROM active_task_leases");
    expect(leases).toEqual([{ task_id: adopted.task_id }]);
    const taskRows = rows(
      database.path,
      "SELECT task_id, status, version FROM tasks ORDER BY created_at"
    );
    expect(taskRows).toEqual([
      { task_id: nativeTaskId, status: "backlog", version: 0 },
      { task_id: adopted.task_id, status: "in_progress", version: 0 }
    ]);
    const startedEvents = rows(
      database.path,
      "SELECT COUNT(*) AS count FROM task_events WHERE event_type = 'task_started'"
    );
    expect(startedEvents[0]).toMatchObject({ count: 0 });
    database.close();
  });

  it("lets an adopt and a start on different worktrees race into two distinct leases", async () => {
    const { database, service, probe, worktreeA, worktreeB } = createFixture();
    const nativeTaskId = (await service.createTask({
      ...createInput("session-b", "1"),
      scopes: [{ scope_type: "worktree_path", scope_value: worktreeB }]
    })).task_id;

    const startPromise = service.startTask(startInput("session-b", "a", nativeTaskId));
    expect(probe.pendingCount()).toBe(1);
    const adopted = await service.adoptTask(adoptInput("session-a", "1", worktreeA));
    probe.flushAll();
    await expect(startPromise).resolves.toMatchObject({
      status: "in_progress",
      version: 1
    });

    const leases = rows(
      database.path,
      "SELECT task_id FROM active_task_leases ORDER BY task_id"
    );
    expect(leases).toHaveLength(2);
    const leasedTaskIds = leases.map((entry) => String(entry.task_id));
    expect(leasedTaskIds).toContain(nativeTaskId);
    expect(leasedTaskIds).toContain(adopted.task_id);
    database.close();
  });

  it("rejects an adopt that would pause a running native task in the same worktree", async () => {
    const { database, service, probe, worktreeA } = createFixture();
    const nativeTaskId = (await service.createTask({
      ...createInput("session-a", "1"),
      scopes: [{ scope_type: "worktree_path", scope_value: worktreeA }]
    })).task_id;
    const pendingStart = service.startTask(startInput("session-a", "a", nativeTaskId));
    expect(probe.pendingCount()).toBe(1);
    probe.flushAll();
    await expect(pendingStart).resolves.toMatchObject({
      status: "in_progress",
      version: 1
    });

    await expect(service.adoptTask(adoptInput("session-b", "1", worktreeA)))
      .rejects.toMatchObject({
        code: "WORKTREE_CONFLICT",
        retryable: false,
        evidence: expect.any(Array),
        recovery_actions: expect.any(Array)
      });

    expect(rows(database.path, `
      SELECT status, version FROM tasks WHERE task_id = ?
    `, [nativeTaskId])).toMatchObject([{ status: "in_progress", version: 1 }]);
    expect(rows(database.path, "SELECT task_id FROM active_task_leases"))
      .toEqual([{ task_id: nativeTaskId }]);
    expect(rows(database.path, "SELECT COUNT(*) AS count FROM legacy_task_imports"))
      .toMatchObject([{ count: 0 }]);
    expect(rows(database.path, "SELECT COUNT(*) AS count FROM tasks"))
      .toMatchObject([{ count: 1 }]);
    expect(rows(database.path, `
      SELECT COUNT(*) AS count FROM task_events
      WHERE event_type = 'legacy_worktree_conflict'
    `)).toMatchObject([{ count: 0 }]);
    database.close();
  });

  it("returns the recorded response for a duplicated operation without double effects", async () => {
    const { database, service, probe } = createFixture();
    const taskId = (await service.createTask(createInput("session-a", "1"))).task_id;
    const input = startInput("session-a", "a", taskId);

    const pending = service.startTask(input);
    expect(probe.pendingCount()).toBe(1);
    probe.flushAll();
    const first = await pending;
    const retry = await service.startTask(input);

    expect(retry).toEqual(first);
    const events = rows(
      database.path,
      "SELECT COUNT(*) AS count FROM task_events WHERE event_type = 'task_started'"
    );
    expect(events[0]).toMatchObject({ count: 1 });
    const version = rows(database.path, "SELECT version FROM tasks WHERE task_id = ?", [
      taskId
    ]);
    expect(version[0]).toMatchObject({ version: 1 });
    database.close();
  });
});

describe("goal persistence across state transitions (real sqlite regression)", () => {
  it("keeps goal and acceptance_criteria after the first transition", async () => {
    const { database, service, probe } = createFixture();
    const created = await service.createTask(createInput("session-a", "goal"));
    const startPromise = service.startTask(startInput("session-a", "goal", created.task_id));
    expect(probe.pendingCount()).toBe(1);
    probe.flushAll();
    await startPromise;

    const persisted = rows(
      database.path,
      "SELECT goal, acceptance_criteria_json FROM tasks WHERE task_id = ?",
      [created.task_id]
    );
    expect(persisted).toEqual([
      { goal: "Finish task goal", acceptance_criteria_json: "[\"tests pass\"]" }
    ]);
    database.close();
  });
});
