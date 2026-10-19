/// <reference types="node" />

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeConfig } from "../../../src/config/runtime-config.js";
import { SqliteDatabase } from "../../../src/storage/database.js";
import type { ProgressStore } from "../../../src/storage/progress-store.js";
import type { TaskStatus } from "../../../src/shared/task-contracts.js";

const temporaryDirectories: string[] = [];
const timestamp = "2026-10-16T02:00:00.000Z";
const archivedAt = "2026-10-16T03:00:00.000Z";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openStore(): { database: SqliteDatabase; store: ProgressStore } {
  const dataDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-archive-"));
  temporaryDirectories.push(dataDir);
  const database = SqliteDatabase.open(createRuntimeConfig(dataDir));
  return { database, store: database.createProgressStore() };
}

function seedProject(
  store: ProgressStore,
  projectId: string,
  createdBy: string | null,
  tasks: readonly { task_id: string; status: TaskStatus; owner: string }[] = []
): void {
  store.transaction((tx) => {
    tx.upsertProject({
      project_id: projectId,
      name: `Name ${projectId}`,
      created_by: createdBy,
      created_at: timestamp,
      updated_at: timestamp
    });
    tx.upsertRepository({
      repository_id: `repo-${projectId}`,
      project_id: projectId,
      path: `/tmp/${projectId}`,
      label: `Repo ${projectId}`,
      created_at: timestamp,
      updated_at: timestamp
    });
    for (const task of tasks) {
      tx.insertTask({
        task_id: task.task_id,
        repository_id: `repo-${projectId}`,
        title: task.task_id,
        status: task.status,
        priority: "P1",
        owner: task.owner,
        created_at: timestamp,
        updated_at: timestamp
      });
    }
  });
}

describe("project archive storage", () => {
  it("exposes null archive fields for a project that was never archived", () => {
    const { database, store } = openStore();
    try {
      seedProject(store, "project-a", "creator");
      expect(store.getProject("project-a")).toMatchObject({
        archived_at: null,
        archived_by: null
      });
      expect(store.listProjects("creator")).toEqual([
        expect.objectContaining({
          project_id: "project-a",
          archived_at: null,
          archived_by: null
        })
      ]);
    } finally {
      database.close();
    }
  });

  it("archives a project whose tasks are all terminal and keeps every record", () => {
    const { database, store } = openStore();
    try {
      seedProject(store, "project-a", "creator", [
        { task_id: "task-done", status: "done", owner: "creator" },
        { task_id: "task-cancelled", status: "cancelled", owner: "member" }
      ]);
      const outcome = store.transaction((tx) => (
        tx.archiveProject("project-a", "creator", archivedAt)
      ));
      expect(outcome).toMatchObject({
        status: "archived",
        changed: true,
        project: { project_id: "project-a", archived_at: archivedAt, archived_by: "creator" }
      });
      expect(store.getProject("project-a")).toMatchObject({
        archived_at: archivedAt,
        archived_by: "creator"
      });
      expect(store.transaction((tx) => tx.getProject("project-a"))).toMatchObject({
        archived_at: archivedAt,
        archived_by: "creator"
      });
      expect(store.getTaskDetail("task-done")).toBeDefined();
      expect(store.getTaskDetail("task-cancelled")).toBeDefined();
      expect(store.getRepository("repo-project-a")).toBeDefined();
    } finally {
      database.close();
    }
  });

  it("is idempotent and keeps the original archive stamp on a repeated archive", () => {
    const { database, store } = openStore();
    try {
      seedProject(store, "project-a", "creator");
      store.transaction((tx) => tx.archiveProject("project-a", "creator", archivedAt));
      const repeated = store.transaction((tx) => (
        tx.archiveProject("project-a", "someone-else", "2026-10-16T04:00:00.000Z")
      ));
      expect(repeated).toMatchObject({
        status: "archived",
        changed: false,
        project: { archived_at: archivedAt, archived_by: "creator" }
      });
    } finally {
      database.close();
    }
  });

  it("refuses to archive while any owner's task is not terminal", () => {
    const { database, store } = openStore();
    try {
      seedProject(store, "project-a", "creator", [
        { task_id: "task-done", status: "done", owner: "creator" },
        { task_id: "task-member-active", status: "in_progress", owner: "member" },
        { task_id: "task-member-review", status: "pending_acceptance", owner: "member" },
        { task_id: "task-creator-backlog", status: "backlog", owner: "creator" }
      ]);
      const outcome = store.transaction((tx) => (
        tx.archiveProject("project-a", "creator", archivedAt)
      ));
      expect(outcome.status).toBe("open_tasks");
      if (outcome.status !== "open_tasks") {
        return;
      }
      expect(outcome.open_tasks).toEqual(expect.arrayContaining([
        { task_id: "task-member-active", owner: "member", status: "in_progress", repository_id: "repo-project-a" },
        { task_id: "task-member-review", owner: "member", status: "pending_acceptance", repository_id: "repo-project-a" },
        { task_id: "task-creator-backlog", owner: "creator", status: "backlog", repository_id: "repo-project-a" }
      ]));
      expect(outcome.open_tasks).toHaveLength(3);
      expect(store.getProject("project-a")).toMatchObject({ archived_at: null });
    } finally {
      database.close();
    }
  });

  it("reports not_found for an unknown project", () => {
    const { database, store } = openStore();
    try {
      expect(store.transaction((tx) => tx.archiveProject("missing", "creator", archivedAt)))
        .toEqual({ status: "not_found" });
      expect(store.transaction((tx) => tx.unarchiveProject("missing", archivedAt)))
        .toEqual({ status: "not_found" });
    } finally {
      database.close();
    }
  });

  it("unarchives idempotently and clears the archive stamp", () => {
    const { database, store } = openStore();
    try {
      seedProject(store, "project-a", "creator");
      store.transaction((tx) => tx.archiveProject("project-a", "creator", archivedAt));
      const first = store.transaction((tx) => (
        tx.unarchiveProject("project-a", "2026-10-16T05:00:00.000Z")
      ));
      expect(first).toMatchObject({
        status: "unarchived",
        changed: true,
        project: { archived_at: null, archived_by: null }
      });
      const second = store.transaction((tx) => (
        tx.unarchiveProject("project-a", "2026-10-16T06:00:00.000Z")
      ));
      expect(second).toMatchObject({ status: "unarchived", changed: false });
      expect(store.listProjects("creator").map((project) => project.project_id))
        .toEqual(["project-a"]);
    } finally {
      database.close();
    }
  });

  it("keeps the archive stamp when the project row is upserted again", () => {
    const { database, store } = openStore();
    try {
      seedProject(store, "project-a", "creator");
      store.transaction((tx) => tx.archiveProject("project-a", "creator", archivedAt));
      store.transaction((tx) => tx.upsertProject({
        project_id: "project-a",
        name: "Renamed",
        created_by: "creator",
        created_at: timestamp,
        updated_at: archivedAt
      }));
      expect(store.getProject("project-a")).toMatchObject({ archived_at: archivedAt });
    } finally {
      database.close();
    }
  });

  it("excludes archived projects by default for every owner-visibility branch", () => {
    const { database, store } = openStore();
    try {
      // Visible to "viewer" via each OR branch of the owner clause:
      // creator, owned task, owned session, active membership.
      seedProject(store, "by-creator", "viewer");
      seedProject(store, "by-task", "other", [
        { task_id: "viewer-task", status: "done", owner: "viewer" }
      ]);
      seedProject(store, "by-session", "other");
      seedProject(store, "by-member", "other");
      seedProject(store, "still-active", "viewer");
      store.transaction((tx) => {
        tx.insertSession({
          session_id: "viewer-session",
          repository_id: "repo-by-session",
          label: "Viewer session",
          started_at: timestamp,
          owner: "viewer"
        });
        tx.upsertProjectMember({
          project_id: "by-member",
          owner: "viewer",
          role: "member",
          granted_by: "other",
          created_at: timestamp,
          revoked_at: null
        });
        for (const projectId of ["by-creator", "by-task", "by-session", "by-member"]) {
          tx.archiveProject(projectId, "other", archivedAt);
        }
      });

      expect(store.listProjects("viewer").map((project) => project.project_id))
        .toEqual(["still-active"]);
      expect(store.listProjects().map((project) => project.project_id))
        .toEqual(["still-active"]);
      expect(store.listProjects("viewer", { include_archived: true })
        .map((project) => project.project_id)
        .sort())
        .toEqual(["by-creator", "by-member", "by-session", "by-task", "still-active"]);
      expect(store.listProjects(undefined, { include_archived: true })).toHaveLength(5);
      expect(store.listProjects("viewer", { include_archived: true })
        .find((project) => project.project_id === "by-member"))
        .toMatchObject({ archived_at: archivedAt, archived_by: "other" });
      expect(store.listProjects("stranger", { include_archived: true })).toEqual([]);
    } finally {
      database.close();
    }
  });
});
