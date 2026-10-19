import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRuntimeConfig } from "../../../src/config/runtime-config.js";
import { SessionService } from "../../../src/core/session-service.js";
import { PlatformDomainError } from "../../../src/core/task-service.js";
import { SqliteDatabase } from "../../../src/storage/database.js";

const dataDirs: string[] = [];

function openStore(): { store: ReturnType<SqliteDatabase["createProgressStore"]>; database: SqliteDatabase } {
  const dataDir = mkdtempSync(join(tmpdir(), "cstm-session-resume-"));
  dataDirs.push(dataDir);
  const config = createRuntimeConfig(dataDir);
  const database = SqliteDatabase.open(config);
  const store = database.createProgressStore();
  store.transaction((tx) => {
    tx.upsertProject({
      project_id: "project-1",
      name: "Project One",
      created_at: "2026-09-24T06:00:00.000Z",
      updated_at: "2026-09-24T06:00:00.000Z"
    });
    tx.upsertRepository({
      repository_id: "repo-1",
      project_id: "project-1",
      path: "/tmp/workspace-a",
      label: "Project One",
      created_at: "2026-09-24T06:00:00.000Z",
      updated_at: "2026-09-24T06:00:00.000Z"
    });
  });
  return { store, database };
}

const baseInput = {
  client_name: "zcode",
  client_version: "0.16.9",
  protocol_version: "2025-11-25",
  workspace_path: "/tmp/workspace-a",
  repository_id: "repo-1",
  worktree_path: "/tmp/workspace-a",
  owner: "jande"
};

afterAll(() => {
  for (const dir of dataDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("SessionService resume tokens", () => {
  it("issues a resume token on bind and stores only its hash", () => {
    const { store, database } = openStore();
    const service = new SessionService(store, createRuntimeConfig(dataDirs.at(-1)!));

    const bound = service.sessionContext(
      { ...baseInput, transport_session_id: "transport-a" },
      "2026-09-24T07:00:00.000Z"
    );

    expect(typeof bound.resume_token).toBe("string");
    expect(bound.resume_token!.length).toBeGreaterThanOrEqual(32);
    const stored = store.transaction((tx) => tx.getSession(bound.session_id));
    expect(stored?.resume_token_hash).toBeDefined();
    expect(stored?.resume_token_hash).not.toBe(bound.resume_token);
    database.close();
  });

  it("re-attaches a pseudo-dead session to a new transport with lease continuity", () => {
    const { store, database } = openStore();
    const active = new Set<string>(["transport-a"]);
    const service = new SessionService(
      store,
      createRuntimeConfig(dataDirs.at(-1)!),
      undefined,
      (transportId) => active.has(transportId)
    );

    const bound = service.sessionContext(
      { ...baseInput, transport_session_id: "transport-a" },
      "2026-09-24T07:00:00.000Z"
    );
    store.transaction((tx) => {
      tx.insertTask({
        task_id: "task-1",
        repository_id: "repo-1",
        owner: "jande",
        title: "Resume continuity task",
        status: "in_progress",
        priority: "P2",
        created_at: "2026-09-24T07:00:00.000Z",
        updated_at: "2026-09-24T07:00:00.000Z"
      });
      tx.putLease({
        task_id: "task-1",
        session_id: bound.session_id,
        acquired_at: "2026-09-24T07:00:01.000Z",
        heartbeat_at: "2026-09-24T07:00:01.000Z",
        expires_at: "2026-09-24T07:30:01.000Z"
      });
    });
    store.transaction((tx) => tx.setSessionStaleAt(bound.session_id, "2026-09-24T07:40:00.000Z"));

    // The old transport dies (server restart) and the client reconnects.
    active.clear();

    const resumed = service.sessionContext(
      {
        ...baseInput,
        transport_session_id: "transport-b",
        resume_session_id: bound.session_id,
        resume_token: bound.resume_token!
      },
      "2026-09-24T07:41:00.000Z"
    );

    expect(resumed.session_id).toBe(bound.session_id);
    expect(resumed.resume_token).toBeDefined();
    expect(resumed.resume_token).not.toBe(bound.resume_token);

    const stored = store.transaction((tx) => tx.getSession(bound.session_id));
    expect(stored?.transport_session_id).toBe("transport-b");
    expect(stored?.stale_at).toBeUndefined();
    const lease = store.transaction((tx) => tx.getLeaseByTask("task-1"));
    expect(lease?.session_id).toBe(bound.session_id);
    const events = store.listSessionEvents(bound.session_id);
    expect(events.some((event) => event.event_type === "session_rebound")).toBe(true);

    // The rotated token is the only valid one for a further resume.
    active.delete("transport-b");
    expect(() =>
      service.sessionContext(
        {
          ...baseInput,
          transport_session_id: "transport-c",
          resume_session_id: bound.session_id,
          resume_token: bound.resume_token!
        },
        "2026-09-24T07:42:00.000Z"
      )
    ).toThrow(PlatformDomainError);
    database.close();
  });

  it("rejects resume while the previous transport is still active", () => {
    const { store, database } = openStore();
    const service = new SessionService(
      store,
      createRuntimeConfig(dataDirs.at(-1)!),
      undefined,
      () => true
    );
    const bound = service.sessionContext(
      { ...baseInput, transport_session_id: "transport-a" },
      "2026-09-24T07:00:00.000Z"
    );

    expect(() =>
      service.sessionContext(
        {
          ...baseInput,
          transport_session_id: "transport-b",
          resume_session_id: bound.session_id,
          resume_token: bound.resume_token!
        },
        "2026-09-24T07:01:00.000Z"
      )
    ).toThrow(PlatformDomainError);
    database.close();
  });

  it("rejects a wrong resume token and repository mismatch", () => {
    const { store, database } = openStore();
    const service = new SessionService(
      store,
      createRuntimeConfig(dataDirs.at(-1)!),
      undefined,
      () => false
    );
    const bound = service.sessionContext(
      { ...baseInput, transport_session_id: "transport-a" },
      "2026-09-24T07:00:00.000Z"
    );

    expect(() =>
      service.sessionContext(
        {
          ...baseInput,
          transport_session_id: "transport-b",
          resume_session_id: bound.session_id,
          resume_token: "not-the-issued-token"
        },
        "2026-09-24T07:01:00.000Z"
      )
    ).toThrow(PlatformDomainError);

    expect(() =>
      service.sessionContext(
        {
          ...baseInput,
          repository_id: "repo-other",
          transport_session_id: "transport-b",
          resume_session_id: bound.session_id,
          resume_token: bound.resume_token!
        },
        "2026-09-24T07:01:00.000Z"
      )
    ).toThrow(PlatformDomainError);
    database.close();
  });

  it("rejects resume for a session superseded by an explicit successor", () => {
    const { store, database } = openStore();
    const service = new SessionService(
      store,
      createRuntimeConfig(dataDirs.at(-1)!),
      undefined,
      () => false
    );
    const bound = service.sessionContext(
      { ...baseInput, transport_session_id: "transport-a" },
      "2026-09-24T07:00:00.000Z"
    );
    store.transaction((tx) => {
      tx.setSessionSuccessor(bound.session_id, "successor-1", undefined, "2026-09-24T07:00:30.000Z");
    });

    expect(() =>
      service.sessionContext(
        {
          ...baseInput,
          transport_session_id: "transport-b",
          resume_session_id: bound.session_id,
          resume_token: bound.resume_token!
        },
        "2026-09-24T07:01:00.000Z"
      )
    ).toThrow(PlatformDomainError);
    database.close();
  });

  it("fails closed when no transport liveness provider is configured", () => {
    const { store, database } = openStore();
    const service = new SessionService(store, createRuntimeConfig(dataDirs.at(-1)!));
    const bound = service.sessionContext(
      { ...baseInput, transport_session_id: "transport-a" },
      "2026-09-24T07:00:00.000Z"
    );

    expect(() =>
      service.sessionContext(
        {
          ...baseInput,
          transport_session_id: "transport-b",
          resume_session_id: bound.session_id,
          resume_token: bound.resume_token!
        },
        "2026-09-24T07:01:00.000Z"
      )
    ).toThrow(PlatformDomainError);
    database.close();
  });
});
