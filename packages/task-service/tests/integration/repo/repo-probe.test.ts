/// <reference types="node" />

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeConfig } from "../../../src/config/runtime-config.js";
import {
  evaluateConflicts,
  type ConflictSide
} from "../../../src/core/conflict-policy.js";
import {
  RepoProbe,
  RepoProbeError,
  type RepoSnapshotDraft
} from "../../../src/repo/repo-probe.js";
import { SqliteDatabase } from "../../../src/storage/database.js";
import {
  StorageError,
  type ProgressStore,
  type RepositoryRecord
} from "../../../src/storage/progress-store.js";
import type { TaskRecord } from "../../../src/shared/task-contracts.js";

const temporaryDirectories: string[] = [];
const registeredAt = "2026-08-17T00:00:00.000Z";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
}

function gitStatusRaw(worktreePath: string): string {
  return execFileSync(
    "git",
    ["-C", worktreePath, "status", "--porcelain=v2", "-z"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
  );
}

function createGitRepository(path: string): void {
  mkdirSync(path);
  git(path, ["init", "-b", "main"]);
  git(path, ["config", "user.email", "probe@example.com"]);
  git(path, ["config", "user.name", "Probe Test"]);
  writeFileSync(join(path, "base.txt"), "base\n");
  writeFileSync(join(path, "unstaged.txt"), "original\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "base"]);
}

interface ProbeFixture {
  store: ProgressStore;
  database: SqliteDatabase;
  databasePath: string;
  repository: RepositoryRecord;
  rootPath: string;
  workDir: string;
  overlapWorktree: string;
  moduleWorktree: string;
}

function createFixture(): ProbeFixture {
  const dataDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-"));
  const workDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-repo-"));
  temporaryDirectories.push(dataDir, workDir);

  const root = join(workDir, "main-repo");
  createGitRepository(root);
  const rootPath = realpathSync(root);
  writeFileSync(join(rootPath, "staged.txt"), "staged\n");
  git(rootPath, ["add", "staged.txt"]);
  writeFileSync(join(rootPath, "unstaged.txt"), "modified\n");
  writeFileSync(join(rootPath, "untracked.txt"), "untracked\n");

  git(rootPath, ["worktree", "add", "-b", "feature-overlap", join(workDir, "wt-overlap")]);
  git(rootPath, ["worktree", "add", "-b", "feature-module", join(workDir, "wt-module")]);
  const overlapWorktree = realpathSync(join(workDir, "wt-overlap"));
  const moduleWorktree = realpathSync(join(workDir, "wt-module"));
  writeFileSync(join(overlapWorktree, "staged.txt"), "conflicting\n");
  writeFileSync(join(moduleWorktree, "feature.txt"), "feature\n");

  const config = createRuntimeConfig(dataDir);
  const database = SqliteDatabase.open(config);
  const store = database.createProgressStore();
  store.transaction((tx) => {
    tx.upsertProject({
      project_id: "project-1",
      name: "Project One",
      created_at: registeredAt,
      updated_at: registeredAt
    });
    tx.upsertRepository({
      repository_id: "repo-1",
      project_id: "project-1",
      path: rootPath,
      label: "Repo One",
      created_at: registeredAt,
      updated_at: registeredAt
    });
  });
  const repository = store.getRepository("repo-1");
  if (repository === undefined) {
    database.close();
    throw new Error("Fixture failed to register the repository");
  }
  return {
    store,
    database,
    databasePath: config.databasePath,
    repository,
    rootPath,
    workDir,
    overlapWorktree,
    moduleWorktree
  };
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task_id: "task-1",
    repository_id: "repo-1",
    title: "Persist task progress",
    status: "in_progress",
    priority: "P1",
    created_at: registeredAt,
    updated_at: registeredAt,
    ...overrides
  };
}

function withModulePaths(
  snapshot: RepoSnapshotDraft,
  modulePaths: readonly string[]
): ConflictSide {
  return { ...snapshot, module_paths: modulePaths };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("RepoProbe", () => {
  it("collects staged, unstaged, and untracked files without mutating the repository", async () => {
    const fixture = createFixture();
    const statusBefore = gitStatusRaw(fixture.rootPath);
    const probe = new RepoProbe();

    const snapshot = await probe.inspect({
      repository: fixture.repository,
      worktree_path: fixture.rootPath
    });
    const statusAfter = gitStatusRaw(fixture.rootPath);

    expect(statusAfter).toBe(statusBefore);
    expect(snapshot.repository_id).toBe("repo-1");
    expect(snapshot.repository_path).toBe(fixture.rootPath);
    expect(snapshot.worktree_path).toBe(fixture.rootPath);
    expect(snapshot.head_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.content_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(snapshot.branch).toBe("main");
    expect(snapshot.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(snapshot.changed_files).toEqual(expect.arrayContaining([
      "staged.txt",
      "unstaged.txt",
      "untracked.txt"
    ]));
    fixture.database.close();
  });

  it("binds the digest to tracked, staged, deleted, renamed, and untracked content", async () => {
    const fixture = createFixture();
    const probe = new RepoProbe();
    const inspect = () => probe.inspect({
      repository: fixture.repository,
      worktree_path: fixture.rootPath
    });

    const initial = await inspect();
    const stable = await inspect();
    expect(stable.content_digest).toBe(initial.content_digest);

    const untrackedPath = join(fixture.rootPath, "untracked.txt");
    utimesSync(untrackedPath, new Date("2026-09-22T00:00:00Z"), new Date("2026-09-22T00:00:00Z"));
    expect((await inspect()).content_digest).toBe(initial.content_digest);

    writeFileSync(untrackedPath, "untracked changed\n");
    const untrackedChanged = await inspect();
    expect(untrackedChanged.content_digest).not.toBe(initial.content_digest);

    writeFileSync(join(fixture.rootPath, "staged.txt"), "staged changed\n");
    git(fixture.rootPath, ["add", "staged.txt"]);
    const stagedChanged = await inspect();
    expect(stagedChanged.content_digest).not.toBe(untrackedChanged.content_digest);

    rmSync(join(fixture.rootPath, "base.txt"));
    const deleted = await inspect();
    expect(deleted.content_digest).not.toBe(stagedChanged.content_digest);

    renameSync(
      join(fixture.rootPath, "unstaged.txt"),
      join(fixture.rootPath, "renamed.txt")
    );
    const renamed = await inspect();
    expect(renamed.content_digest).not.toBe(deleted.content_digest);
    fixture.database.close();
  });

  it("probes linked worktrees located outside the repository root", async () => {
    const fixture = createFixture();
    const statusBefore = gitStatusRaw(fixture.overlapWorktree);
    const probe = new RepoProbe();

    const snapshot = await probe.inspect({
      repository: fixture.repository,
      worktree_path: fixture.overlapWorktree
    });

    expect(gitStatusRaw(fixture.overlapWorktree)).toBe(statusBefore);
    expect(snapshot.worktree_path).toBe(fixture.overlapWorktree);
    expect(snapshot.branch).toBe("feature-overlap");
    expect(snapshot.changed_files).toEqual(["staged.txt"]);
    fixture.database.close();
  });

  it("rejects symlink escapes and unregistered worktree paths", async () => {
    const fixture = createFixture();
    const unregisteredPath = join(fixture.workDir, "unregistered");
    createGitRepository(unregisteredPath);
    const unregisteredRoot = realpathSync(unregisteredPath);
    const escapeLink = join(fixture.workDir, "escape-link");
    symlinkSync(unregisteredRoot, escapeLink);
    mkdirSync(join(fixture.rootPath, "nested"));
    const probe = new RepoProbe();

    await expect(probe.inspect({
      repository: fixture.repository,
      worktree_path: escapeLink
    })).rejects.toMatchObject({
      name: "RepoProbeError",
      code: "REPOSITORY_NOT_ALLOWED"
    });
    await expect(probe.inspect({
      repository: fixture.repository,
      worktree_path: unregisteredRoot
    })).rejects.toMatchObject({
      name: "RepoProbeError",
      code: "REPOSITORY_NOT_ALLOWED"
    });
    await expect(probe.inspect({
      repository: { ...fixture.repository, path: join(fixture.rootPath, "nested") },
      worktree_path: fixture.rootPath
    })).rejects.toMatchObject({
      name: "RepoProbeError",
      code: "REPOSITORY_NOT_ALLOWED"
    });
    fixture.database.close();
  });

  it("grades conflicts between probed worktree snapshots", async () => {
    const fixture = createFixture();
    const probe = new RepoProbe();
    const left = await probe.inspect({
      repository: fixture.repository,
      worktree_path: fixture.rootPath
    });
    const overlapSide = await probe.inspect({
      repository: fixture.repository,
      worktree_path: fixture.overlapWorktree
    });
    const moduleSide = await probe.inspect({
      repository: fixture.repository,
      worktree_path: fixture.moduleWorktree
    });

    expect(evaluateConflicts({ left, right: left }).level).toBe("hard");
    expect(evaluateConflicts({ left, right: left }).code).toBe("WORKTREE_CONFLICT");
    expect(evaluateConflicts({ left, right: overlapSide }).level).toBe("hard");
    expect(evaluateConflicts({ left, right: overlapSide }).code).toBe("FILE_CONFLICT");
    expect(evaluateConflicts({
      left: withModulePaths(left, ["src/core"]),
      right: withModulePaths(moduleSide, ["src/core/session"])
    })).toMatchObject({ level: "warning", code: "MODULE_OVERLAP" });
    fixture.database.close();
  });

  it("treats probe failures as hard conflicts that forbid starting or switching", async () => {
    const fixture = createFixture();
    const probe = new RepoProbe();
    const left = await probe.inspect({
      repository: fixture.repository,
      worktree_path: fixture.rootPath
    });

    let probeError: RepoProbeError | undefined;
    try {
      await probe.inspect({
        repository: fixture.repository,
        worktree_path: join(fixture.workDir, "missing-worktree")
      });
    } catch (error) {
      probeError = error as RepoProbeError;
    }

    expect(probeError).toBeInstanceOf(RepoProbeError);
    expect(probeError?.code).toBe("REPOSITORY_NOT_ALLOWED");
    expect(evaluateConflicts({
      left: { ...left, probe_error: `${probeError?.name}: ${probeError?.message}` },
      right: left
    })).toMatchObject({ level: "hard", code: "REPO_PROBE_FAILED" });
    fixture.database.close();
  });
});

describe("repository and scope storage", () => {
  it("upserts repositories idempotently and keeps the original creation time", () => {
    const fixture = createFixture();
    const later = "2026-08-17T12:00:00.000Z";

    fixture.store.transaction((tx) => {
      tx.upsertRepository({
        repository_id: "repo-1",
        project_id: "project-1",
        path: fixture.rootPath,
        label: "Repo One Renamed",
        created_at: later,
        updated_at: later
      });
    });

    expect(fixture.store.getRepository("repo-1")).toMatchObject({
      repository_id: "repo-1",
      project_id: "project-1",
      path: fixture.rootPath,
      label: "Repo One Renamed",
      created_at: registeredAt,
      updated_at: later
    });
    expect(fixture.store.getRepository("repo-missing")).toBeUndefined();
    fixture.database.close();
  });

  it("rejects registering a different repository id on an existing path", () => {
    const fixture = createFixture();
    const later = "2026-08-17T12:00:00.000Z";

    let thrown: unknown;
    try {
      fixture.store.transaction((tx) => {
        tx.upsertRepository({
          repository_id: "repo-2",
          project_id: "project-1",
          path: fixture.rootPath,
          label: "Repo Two",
          created_at: later,
          updated_at: later
        });
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as StorageError).code).toBe("CONSTRAINT_VIOLATION");
    fixture.database.close();
  });

  it("lists scopes of non-terminal tasks for a repository", () => {
    const fixture = createFixture();
    fixture.store.transaction((tx) => {
      tx.insertTask(task({ task_id: "task-active", status: "in_progress" }));
      tx.insertTask(task({ task_id: "task-done", status: "done" }));
      tx.insertTask(task({ task_id: "task-cancelled", status: "cancelled" }));
      tx.insertTask(task({ task_id: "task-backlog", status: "backlog" }));
    });
    const seeder = new DatabaseSync(fixture.databasePath);
    seeder.exec("BEGIN IMMEDIATE");
    const insertScope = seeder.prepare(`
      INSERT INTO task_scopes(task_scope_id, task_id, scope_type, scope_value)
      VALUES (?, ?, ?, ?)
    `);
    insertScope.run("scope-1", "task-active", "module", "src/core");
    insertScope.run("scope-2", "task-done", "module", "src/done");
    insertScope.run("scope-3", "task-cancelled", "module", "src/cancelled");
    insertScope.run("scope-4", "task-backlog", "module", "src/backlog");
    insertScope.run("scope-5", "task-backlog", "file", "README.md");
    seeder.exec("COMMIT");
    seeder.close();

    expect(fixture.store.listActiveTaskScopes("repo-1")).toEqual([
      { task_id: "task-active", scope_type: "module", scope_value: "src/core" },
      { task_id: "task-backlog", scope_type: "file", scope_value: "README.md" },
      { task_id: "task-backlog", scope_type: "module", scope_value: "src/backlog" }
    ]);
    expect(fixture.store.listActiveTaskScopes("repo-missing")).toEqual([]);
    fixture.database.close();
  });
});
