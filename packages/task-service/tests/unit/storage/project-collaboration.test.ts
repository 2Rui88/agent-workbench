/// <reference types="node" />

import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeConfig } from "../../../src/config/runtime-config.js";
import { SqliteDatabase } from "../../../src/storage/database.js";
import type { ProjectMemberRecord, ProjectShareRecord } from "../../../src/storage/progress-store.js";

const temporaryDirectories: string[] = [];
const timestamp = "2026-09-02T11:00:00.000Z";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("project collaboration storage", () => {
  it("keeps member/share tables and indexes after later migrations", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-collab-"));
    temporaryDirectories.push(dataDir);
    const config = createRuntimeConfig(dataDir);
    const database = SqliteDatabase.open(config);
    database.close();

    const connection = new DatabaseSync(config.databasePath, { readOnly: true });
    try {
      expect(connection.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 16 });
      expect(connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all())
        .toEqual(expect.arrayContaining([
          { name: "project_members" },
          { name: "project_shares" }
        ]));
      expect(connection.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all())
        .toEqual(expect.arrayContaining([
          { name: "project_members_owner_active_idx" }
        ]));
    } finally {
      connection.close();
    }
  });

  it("persists, revokes, and consumes collaboration records atomically", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-collab-"));
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
      const member: ProjectMemberRecord = {
        project_id: "project-collab",
        owner: "member",
        role: "member",
        granted_by: "creator",
        created_at: timestamp,
        revoked_at: null
      };
      tx.upsertProjectMember(member);
      tx.upsertProjectMember({ ...member, granted_by: "creator-2", revoked_at: timestamp });
      const share: ProjectShareRecord = {
        share_id: "share-1",
        project_id: "project-collab",
        token_hash: "hash-1",
        created_by: "creator",
        expires_at: "2099-01-01T00:00:00.000Z",
        consumed_at: null,
        revoked_at: null,
        created_at: timestamp
      };
      tx.createProjectShare(share);
      expect(tx.getProjectShareByTokenHash("hash-1")).toMatchObject(share);
      expect(tx.consumeProjectShare("share-1", "hash-1", "2026-09-02T11:01:00.000Z"))
        .toBe(true);
      expect(tx.consumeProjectShare("share-1", "hash-1", "2026-09-02T11:02:00.000Z"))
        .toBe(false);
    });

    expect(store.getProjectMember("project-collab", "member")).toMatchObject({
      owner: "member",
      revoked_at: timestamp
    });
    expect(store.listProjectMembers("project-collab")).toEqual([]);
    expect(store.listProjectMembers("project-collab", true)).toEqual([
      expect.objectContaining({ owner: "member", revoked_at: timestamp })
    ]);
    database.close();
  });

  it("does not consume expired or revoked shares", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cli-session-task-mcp-collab-"));
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
      for (const share of [
        {
          share_id: "share-expired",
          token_hash: "hash-expired",
          expires_at: "2026-09-01T00:00:00.000Z",
          revoked_at: null
        },
        {
          share_id: "share-revoked",
          token_hash: "hash-revoked",
          expires_at: "2099-01-01T00:00:00.000Z",
          revoked_at: timestamp
        }
      ]) {
        tx.createProjectShare({
          ...share,
          project_id: "project-collab",
          created_by: "creator",
          consumed_at: null,
          created_at: timestamp
        });
      }
      expect(tx.consumeProjectShare("share-expired", "hash-expired", timestamp)).toBe(false);
      expect(tx.consumeProjectShare("share-revoked", "hash-revoked", timestamp)).toBe(false);
    });
    database.close();
  });
});
