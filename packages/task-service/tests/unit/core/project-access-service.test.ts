/// <reference types="node" />

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeConfig } from "../../../src/config/runtime-config.js";
import { ProjectAccessService } from "../../../src/core/project-access-service.js";
import { PlatformDomainError } from "../../../src/core/task-service.js";
import { SqliteDatabase } from "../../../src/storage/database.js";

const temporaryDirectories: string[] = [];
const timestamp = "2026-09-02T11:00:00.000Z";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createAccess() {
  const dataDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-access-"));
  temporaryDirectories.push(dataDir);
  const database = SqliteDatabase.open(createRuntimeConfig(dataDir));
  const store = database.createProgressStore();
  store.transaction((tx) => {
    tx.upsertProject({
      project_id: "project-collab",
      name: "Collaboration",
      created_by: "creator",
      created_at: timestamp,
      updated_at: timestamp
    });
    tx.upsertRepository({
      repository_id: "repo-collab",
      project_id: "project-collab",
      path: "/tmp/project-collab",
      label: "Collaboration",
      created_at: timestamp,
      updated_at: timestamp
    });
    tx.insertTask({
      task_id: "task-creator",
      repository_id: "repo-collab",
      title: "Creator task",
      status: "backlog",
      priority: "P1",
      owner: "creator",
      created_at: timestamp,
      updated_at: timestamp
    });
    tx.insertTask({
      task_id: "task-member",
      repository_id: "repo-collab",
      title: "Member task",
      status: "backlog",
      priority: "P1",
      owner: "member",
      created_at: timestamp,
      updated_at: timestamp
    });
  });
  return {
    database,
    store,
    access: new ProjectAccessService(store, {
      now: () => timestamp,
      shareTtlMs: 60 * 60 * 1_000
    })
  };
}

describe("ProjectAccessService", () => {
  it("allows the creator and active members to view a project", () => {
    const fixture = createAccess();
    try {
      expect(fixture.access.isProjectViewer("project-collab", "creator")).toBe(true);
      expect(fixture.access.isProjectViewer("project-collab", "member")).toBe(false);
      const share = fixture.access.createShare("project-collab", "creator");
      fixture.access.acceptShare(share.token, "member");
      expect(fixture.access.isProjectViewer("project-collab", "member")).toBe(true);
      expect(fixture.access.listMembers("project-collab", "member")).toEqual([
        expect.objectContaining({ owner: "member", granted_by: "creator" })
      ]);
    } finally {
      fixture.database.close();
    }
  });

  it("rejects invalid, expired, reused, and revoked access", () => {
    const fixture = createAccess();
    try {
      expect(() => fixture.access.acceptShare("missing", "member"))
        .toThrowError(PlatformDomainError);
      const share = fixture.access.createShare("project-collab", "creator");
      fixture.access.acceptShare(share.token, "member");
      expect(() => fixture.access.acceptShare(share.token, "another-member"))
        .toThrowError("invalid, expired, revoked, or already used");
      expect(fixture.access.removeMember("project-collab", "member", "creator")).toBe(true);
      expect(fixture.access.isProjectViewer("project-collab", "member")).toBe(false);
      expect(() => fixture.access.createShare("project-collab", "member"))
        .toThrowError("Only the project creator");
    } finally {
      fixture.database.close();
    }
  });

  it("only permits task mutations for the authenticated task owner", () => {
    const fixture = createAccess();
    try {
      expect(() => fixture.access.assertTaskMutation("task-creator", "creator"))
        .not.toThrow();
      expect(() => fixture.access.assertTaskMutation("task-creator", "member"))
        .toThrowError("Only the task owner");
      expect(() => fixture.access.assertTaskMutation("task-member", "member"))
        .toThrowError("not a member of this project");
    } finally {
      fixture.database.close();
    }
  });
});

function createArchiveFixture(createdBy: string | null) {
  const dataDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-archive-access-"));
  temporaryDirectories.push(dataDir);
  const database = SqliteDatabase.open(createRuntimeConfig(dataDir));
  const store = database.createProgressStore();
  store.transaction((tx) => {
    tx.upsertProject({
      project_id: "project-archive",
      name: "Archive",
      created_by: createdBy,
      created_at: timestamp,
      updated_at: timestamp
    });
    tx.upsertRepository({
      repository_id: "repo-archive",
      project_id: "project-archive",
      path: "/tmp/project-archive",
      label: "Archive",
      created_at: timestamp,
      updated_at: timestamp
    });
    tx.insertTask({
      task_id: "task-finished",
      repository_id: "repo-archive",
      title: "Finished",
      status: "done",
      priority: "P1",
      owner: "creator",
      created_at: timestamp,
      updated_at: timestamp
    });
  });
  return {
    database,
    store,
    access: new ProjectAccessService(store, {
      now: () => timestamp,
      shareTtlMs: 60 * 60 * 1_000
    })
  };
}

function insertTask(
  store: ReturnType<typeof createArchiveFixture>["store"],
  taskId: string,
  owner: string,
  status: "backlog" | "in_progress" | "pending_acceptance" | "done"
): void {
  store.transaction((tx) => tx.insertTask({
    task_id: taskId,
    repository_id: "repo-archive",
    title: taskId,
    status,
    priority: "P1",
    owner,
    created_at: timestamp,
    updated_at: timestamp
  }));
}

describe("ProjectAccessService project archive", () => {
  it("lets the creator archive a project whose tasks are all terminal", () => {
    const fixture = createArchiveFixture("creator");
    try {
      const archived = fixture.access.archiveProject("project-archive", "creator");
      expect(archived).toMatchObject({
        project_id: "project-archive",
        archived_at: timestamp,
        archived_by: "creator"
      });
      expect(fixture.store.listProjects("creator")).toEqual([]);
      expect(fixture.store.listProjects("creator", { include_archived: true }))
        .toEqual([expect.objectContaining({ project_id: "project-archive" })]);
      expect(fixture.access.archiveProject("project-archive", "creator"))
        .toMatchObject({ archived_at: timestamp, archived_by: "creator" });
    } finally {
      fixture.database.close();
    }
  });

  it("rejects archive and restore by a member who is not the creator", () => {
    const fixture = createArchiveFixture("creator");
    try {
      const share = fixture.access.createShare("project-archive", "creator");
      fixture.access.acceptShare(share.token, "member");
      expect(() => fixture.access.archiveProject("project-archive", "member"))
        .toThrowError(expect.objectContaining({ code: "PROJECT_CREATOR_REQUIRED" }));
      fixture.access.archiveProject("project-archive", "creator");
      expect(() => fixture.access.unarchiveProject("project-archive", "member"))
        .toThrowError(expect.objectContaining({ code: "PROJECT_CREATOR_REQUIRED" }));
      expect(fixture.store.getProject("project-archive")?.archived_at).toBe(timestamp);
    } finally {
      fixture.database.close();
    }
  });

  it("rejects archiving while a member's task is open and reports counts, ids and owners", () => {
    const fixture = createArchiveFixture("creator");
    try {
      insertTask(fixture.store, "task-member-active", "member", "in_progress");
      insertTask(fixture.store, "task-member-review", "member", "pending_acceptance");
      insertTask(fixture.store, "task-creator-todo", "creator", "backlog");
      let thrown: unknown;
      try {
        fixture.access.archiveProject("project-archive", "creator");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PlatformDomainError);
      const error = thrown as PlatformDomainError;
      expect(error.code).toBe("PROJECT_HAS_OPEN_TASKS");
      expect(error.details).toEqual({
        open_task_counts: { backlog: 1, in_progress: 1, pending_acceptance: 1 },
        open_tasks: expect.arrayContaining([
          { task_id: "task-member-active", owner: "member", status: "in_progress", repository_id: "repo-archive" },
          { task_id: "task-member-review", owner: "member", status: "pending_acceptance", repository_id: "repo-archive" },
          { task_id: "task-creator-todo", owner: "creator", status: "backlog", repository_id: "repo-archive" }
        ])
      });
      expect(error.evidence).toEqual(expect.arrayContaining([
        "in_progress: 1",
        "task task-member-active (owner member, in_progress)"
      ]));
      expect(fixture.store.getProject("project-archive")?.archived_at).toBeNull();
    } finally {
      fixture.database.close();
    }
  });

  it("lets a visible identity archive and restore a legacy project without a creator", () => {
    const fixture = createArchiveFixture(null);
    try {
      // "creator" owns a task in the project, so the project is visible to it.
      const archived = fixture.access.archiveProject("project-archive", "creator");
      expect(archived).toMatchObject({ created_by: null, archived_by: "creator" });
      const restored = fixture.access.unarchiveProject("project-archive", "creator");
      expect(restored).toMatchObject({ archived_at: null, archived_by: null });
    } finally {
      fixture.database.close();
    }
  });

  it("rejects a legacy project archive from an identity that cannot see the project", () => {
    const fixture = createArchiveFixture(null);
    try {
      expect(() => fixture.access.archiveProject("project-archive", "stranger"))
        .toThrowError(expect.objectContaining({ code: "PROJECT_ACCESS_REQUIRED" }));
      fixture.access.archiveProject("project-archive", "creator");
      expect(() => fixture.access.unarchiveProject("project-archive", "stranger"))
        .toThrowError(expect.objectContaining({ code: "PROJECT_ACCESS_REQUIRED" }));
    } finally {
      fixture.database.close();
    }
  });

  it("rejects creating or accepting a share for an archived project", () => {
    const fixture = createArchiveFixture("creator");
    try {
      const pending = fixture.access.createShare("project-archive", "creator");
      fixture.access.archiveProject("project-archive", "creator");
      expect(() => fixture.access.createShare("project-archive", "creator"))
        .toThrowError(expect.objectContaining({ code: "PROJECT_ARCHIVED" }));
      expect(() => fixture.access.acceptShare(pending.token, "member"))
        .toThrowError(expect.objectContaining({ code: "PROJECT_ARCHIVED" }));
      expect(fixture.access.isProjectViewer("project-archive", "member")).toBe(false);
    } finally {
      fixture.database.close();
    }
  });

  it("keeps member removal, share revocation and member listing available after archive", () => {
    const fixture = createArchiveFixture("creator");
    try {
      const joined = fixture.access.createShare("project-archive", "creator");
      fixture.access.acceptShare(joined.token, "member");
      const pending = fixture.access.createShare("project-archive", "creator");
      fixture.access.archiveProject("project-archive", "creator");
      expect(fixture.access.listMembers("project-archive", "member"))
        .toEqual([expect.objectContaining({ owner: "member" })]);
      expect(fixture.access.revokeShare("project-archive", pending.share_id, "creator"))
        .toBe(true);
      expect(fixture.access.removeMember("project-archive", "member", "creator")).toBe(true);
    } finally {
      fixture.database.close();
    }
  });

  it("restores an archived project so writes are accepted again", () => {
    const fixture = createArchiveFixture("creator");
    try {
      fixture.access.archiveProject("project-archive", "creator");
      expect(fixture.access.unarchiveProject("project-archive", "creator"))
        .toMatchObject({ archived_at: null, archived_by: null });
      expect(fixture.access.unarchiveProject("project-archive", "creator"))
        .toMatchObject({ archived_at: null });
      expect(() => fixture.access.createShare("project-archive", "creator")).not.toThrow();
      expect(fixture.store.listProjects("creator"))
        .toEqual([expect.objectContaining({ project_id: "project-archive" })]);
    } finally {
      fixture.database.close();
    }
  });
});
