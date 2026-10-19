/// <reference types="node" />

import {
  generateKeyPairSync,
  createHash,
  createPrivateKey,
  sign as signWith
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeConfig } from "../../../src/config/runtime-config.js";
import {
  HostEvidenceService,
  type CreateChallengeResult,
  type SubmitEvidenceResult
} from "../../../src/core/host-evidence-service.js";
import {
  PlatformDomainError,
  TaskService
} from "../../../src/core/task-service.js";
import type { RepoProbeInput, RepoSnapshotDraft } from "../../../src/repo/repo-probe.js";
import { canonicalJsonBytes } from "../../../src/shared/canonical-json.js";
import { SqliteDatabase } from "../../../src/storage/database.js";
import type { ProgressStore } from "../../../src/storage/progress-store.js";

const WORKTREE = "/remote/wt/feature-a";
const BASE_TIME_MS = Date.parse("2026-09-22T10:00:00.000Z");
const CHALLENGE_TTL_MS = 120_000;
const EVIDENCE_WINDOW_MS = 900_000;

const temporaryDirectories: string[] = [];

function temporaryDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "host-evidence-"));
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Probe that behaves like a server which cannot reach the remote worktree. */
class UnreachableProbe {
  async inspect(input: RepoProbeInput): Promise<RepoSnapshotDraft> {
    void input;
    throw new PlatformDomainError(
      "REPOSITORY_NOT_ALLOWED",
      `Path ${WORKTREE} is not reachable from this server`
    );
  }
}

interface KeyPair {
  publicKeyB64: string;
  privateKey: ReturnType<typeof createPrivateKey>;
}

function makeKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  return {
    publicKeyB64: Buffer.from(der).toString("base64"),
    privateKey
  };
}

function signPayload(payload: unknown, privateKey: KeyPair["privateKey"]): string {
  return signWith(null, canonicalJsonBytes(payload), privateKey).toString("base64");
}

interface Fixture {
  store: ProgressStore;
  database: SqliteDatabase;
  service: HostEvidenceService;
  taskService: TaskService;
  clockMs: { value: number };
  keyPair: KeyPair;
  hostKeyId: string;
}

function createFixture(): Fixture {
  const database = SqliteDatabase.open(createRuntimeConfig(temporaryDataDir()));
  const store = database.createProgressStore();
  let clockMs = BASE_TIME_MS;
  const now = (): string => new Date(clockMs).toISOString();
  store.transaction((tx) => {
    tx.upsertProject({
      project_id: "project-1",
      name: "Project One",
      created_at: now(),
      updated_at: now()
    });
    tx.upsertRepository({
      repository_id: "repo-1",
      project_id: "project-1",
      path: "/repos/project-one",
      label: "Project One",
      created_at: now(),
      updated_at: now()
    });
    tx.insertSession({
      session_id: "session-a",
      repository_id: "repo-1",
      label: "Session A",
      started_at: now(),
      owner: "jande",
      worktree_path: WORKTREE,
      last_activity_at: now()
    });
  });
  const service = new HostEvidenceService({
    store,
    config: { hostChallengeTtlMs: CHALLENGE_TTL_MS, hostEvidenceWindowMs: EVIDENCE_WINDOW_MS },
    now
  });
  const taskService = new TaskService({
    store,
    probe: new UnreachableProbe(),
    now
  });
  const keyPair = makeKeyPair();
  const { host_key_id: hostKeyId } = service.registerHostKey({
    owner: "jande",
    label: "dev-host",
    public_key_b64: keyPair.publicKeyB64
  });
  return {
    store,
    database,
    service,
    taskService,
    clockMs: {
      get value() {
        return clockMs;
      },
      set value(next: number) {
        clockMs = next;
      }
    },
    keyPair,
    hostKeyId
  };
}

function evidencePayload(
  challenge: CreateChallengeResult,
  hostKeyId: string,
  digest: string,
  capturedAt: string
): Record<string, unknown> {
  return {
    v: 1,
    kind: "host_worktree_evidence.v1",
    challenge_id: challenge.challenge_id,
    nonce_b64: challenge.nonce_b64,
    repository_id: challenge.repository_id,
    worktree_path: challenge.expected_worktree_path,
    head_commit: "a".repeat(40),
    branch: "feature-a",
    changed_files: ["src/feature.ts"],
    content_digest: digest,
    captured_at: capturedAt,
    host_key_id: hostKeyId
  };
}

function digestOf(char: string): string {
  return `sha256:${char.repeat(64)}`;
}

function collectEvidence(
  fixture: Fixture,
  options: { operation?: "checkpoint" | "submit"; taskId?: string; digest?: string } = {}
): { challenge: CreateChallengeResult; result: SubmitEvidenceResult } {
  const challenge = fixture.service.createChallenge({
    session_id: "session-a",
    operation: options.operation ?? "checkpoint",
    ...(options.taskId === undefined ? {} : { task_id: options.taskId })
  });
  const payload = evidencePayload(
    challenge,
    fixture.hostKeyId,
    options.digest ?? digestOf("a"),
    new Date(fixture.clockMs.value).toISOString()
  );
  const result = fixture.service.submitEvidence({
    payload,
    signature_b64: signPayload(payload, fixture.keyPair.privateKey)
  });
  return { challenge, result };
}

describe("HostEvidenceService registration", () => {
  it("registers idempotently and rejects owner hijacking", () => {
    const fixture = createFixture();
    const again = fixture.service.registerHostKey({
      owner: "jande",
      label: "dev-host",
      public_key_b64: fixture.keyPair.publicKeyB64
    });
    expect(again).toMatchObject({ outcome: "existing", host_key_id: fixture.hostKeyId });

    expect(() => fixture.service.registerHostKey({
      owner: "someone-else",
      label: "stolen",
      public_key_b64: fixture.keyPair.publicKeyB64
    })).toThrowError(PlatformDomainError);
    fixture.database.close();
  });

  it("rotates to a new key when the previous key signs the new public key", () => {
    const fixture = createFixture();
    const next = makeKeyPair();
    const nextDer = Buffer.from(next.publicKeyB64, "base64");
    const rotationSignature = signWith(
      null,
      createHash("sha256").update(nextDer).digest(),
      fixture.keyPair.privateKey
    ).toString("base64");

    const rotated = fixture.service.registerHostKey({
      owner: "jande",
      label: "dev-host-2",
      public_key_b64: next.publicKeyB64,
      rotation_signature_b64: rotationSignature
    });
    expect(rotated.outcome).toBe("rotated");
    const previous = fixture.store.getHostKey(fixture.hostKeyId);
    expect(previous).toMatchObject({ status: "revoked", rotated_to: rotated.host_key_id });
    fixture.database.close();
  });

  it("rejects rotation without a verifying signature", () => {
    const fixture = createFixture();
    const rogue = makeKeyPair();
    const rogueSignature = signWith(
      null,
      createHash("sha256").update(Buffer.from(rogue.publicKeyB64, "base64")).digest(),
      rogue.privateKey
    ).toString("base64");
    expect(() => fixture.service.registerHostKey({
      owner: "jande",
      label: "rogue",
      public_key_b64: rogue.publicKeyB64,
      rotation_signature_b64: rogueSignature
    })).toThrowError(PlatformDomainError);
    fixture.database.close();
  });
});

describe("HostEvidenceService challenge and submit", () => {
  it("stores host_verified evidence for a correct signature", () => {
    const fixture = createFixture();
    const { result } = collectEvidence(fixture);
    expect(result).toMatchObject({
      repository_id: "repo-1",
      worktree_path: WORKTREE,
      content_digest: digestOf("a")
    });
    const stored = fixture.store.getHostEvidence(result.evidence_id);
    expect(stored).toMatchObject({ host_key_id: fixture.hostKeyId });
    fixture.database.close();
  });

  it("rejects a tampered signature", () => {
    const fixture = createFixture();
    const challenge = fixture.service.createChallenge({
      session_id: "session-a",
      operation: "checkpoint"
    });
    const payload = evidencePayload(
      challenge,
      fixture.hostKeyId,
      digestOf("a"),
      new Date(fixture.clockMs.value).toISOString()
    );
    expect(() => fixture.service.submitEvidence({
      payload,
      signature_b64: Buffer.from("not-a-signature").toString("base64")
    })).toThrowError(
      expect.objectContaining({ code: "HOST_KEY_REJECTED" }) as Partial<PlatformDomainError>
    );
    fixture.database.close();
  });

  it("rejects binding mismatches with HOST_EVIDENCE_MISMATCH", () => {
    const fixture = createFixture();
    const challenge = fixture.service.createChallenge({
      session_id: "session-a",
      operation: "checkpoint"
    });
    const base = evidencePayload(
      challenge,
      fixture.hostKeyId,
      digestOf("a"),
      new Date(fixture.clockMs.value).toISOString()
    );
    const wrongPath = { ...base, worktree_path: "/remote/wt/other" };
    expect(() => fixture.service.submitEvidence({
      payload: wrongPath,
      signature_b64: signPayload(wrongPath, fixture.keyPair.privateKey)
    })).toThrowError(
      expect.objectContaining({ code: "HOST_EVIDENCE_MISMATCH" }) as Partial<PlatformDomainError>
    );
    const wrongRepository = { ...base, repository_id: "repo-other" };
    expect(() => fixture.service.submitEvidence({
      payload: wrongRepository,
      signature_b64: signPayload(wrongRepository, fixture.keyPair.privateKey)
    })).toThrowError(
      expect.objectContaining({ code: "HOST_EVIDENCE_MISMATCH" }) as Partial<PlatformDomainError>
    );
    fixture.database.close();
  });

  it("expires unconsumed challenges and replays idempotently", () => {
    const fixture = createFixture();
    const { result } = collectEvidence(fixture);

    // Same payload retried after consumption replays the stored evidence.
    const challenge2 = fixture.store.getHostEvidenceChallenge(
      fixture.store.getHostEvidence(result.evidence_id)!.challenge_id
    );
    void challenge2;
    const stored = fixture.store.getHostEvidence(result.evidence_id);
    const payload = JSON.parse(stored!.payload_json);
    const replay = fixture.service.submitEvidence({
      payload,
      signature_b64: stored!.signature_b64
    });
    expect(replay.evidence_id).toBe(result.evidence_id);

    // A fresh challenge left unused expires after the TTL.
    const unused = fixture.service.createChallenge({
      session_id: "session-a",
      operation: "checkpoint"
    });
    fixture.clockMs.value = BASE_TIME_MS + CHALLENGE_TTL_MS + 1_000;
    const stalePayload = evidencePayload(
      unused,
      fixture.hostKeyId,
      digestOf("a"),
      new Date(BASE_TIME_MS).toISOString()
    );
    expect(() => fixture.service.submitEvidence({
      payload: stalePayload,
      signature_b64: signPayload(stalePayload, fixture.keyPair.privateKey)
    })).toThrowError(
      expect.objectContaining({ code: "CHALLENGE_EXPIRED" }) as Partial<PlatformDomainError>
    );
    fixture.database.close();
  });

  it("rejects a challenge consumed by different evidence as replay", () => {
    const fixture = createFixture();
    const challenge = fixture.service.createChallenge({
      session_id: "session-a",
      operation: "checkpoint"
    });
    const payload = evidencePayload(
      challenge,
      fixture.hostKeyId,
      digestOf("a"),
      new Date(fixture.clockMs.value).toISOString()
    );
    fixture.service.submitEvidence({
      payload,
      signature_b64: signPayload(payload, fixture.keyPair.privateKey)
    });
    const differentDigest = { ...payload, content_digest: digestOf("b") };
    expect(() => fixture.service.submitEvidence({
      payload: differentDigest,
      signature_b64: signPayload(differentDigest, fixture.keyPair.privateKey)
    })).toThrowError(
      expect.objectContaining({ code: "CHALLENGE_REPLAY" }) as Partial<PlatformDomainError>
    );
    fixture.database.close();
  });

  it("requires the submit operation to hold the task lease", () => {
    const fixture = createFixture();
    fixture.store.transaction((tx) => {
      tx.insertTask({
        task_id: "task-1",
        repository_id: "repo-1",
        title: "Feature A",
        status: "backlog",
        priority: "P1",
        created_at: new Date(fixture.clockMs.value).toISOString(),
        updated_at: new Date(fixture.clockMs.value).toISOString()
      });
    });
    expect(() => fixture.service.createChallenge({
      session_id: "session-a",
      operation: "submit",
      task_id: "task-1"
    })).toThrowError(
      expect.objectContaining({ code: "LEASE_NOT_FOUND" }) as Partial<PlatformDomainError>
    );
    fixture.database.close();
  });
});

describe("TaskService host-verified worktree evidence", () => {
  async function createBacklogTask(fixture: Fixture): Promise<string> {
    void fixture;
    const result = await fixture.taskService.createTask({
      session_id: "session-a",
      operation_id: "op-create",
      expected_version: 0,
      repository_id: "repo-1",
      title: "Feature A",
      goal: "Ship the feature",
      acceptance_criteria: ["npm test passes"],
      next_action: "start implementation",
      priority: "P1"
    });
    return result.task_id;
  }

  it("runs checkpoint and submit on a remote worktree using host evidence", async () => {
    const fixture = createFixture();
    const taskId = await createBacklogTask(fixture);
    const verification = [{ command: "npm test", outcome: "passed" as const, summary: "green" }];

    // No evidence yet: fail closed.
    await expect(fixture.taskService.startTask({
      session_id: "session-a",
      operation_id: "op-start-fail",
      task_id: taskId,
      expected_version: 0
    })).rejects.toMatchObject({ code: "REMOTE_WORKTREE_EVIDENCE_REQUIRED" });

    collectEvidence(fixture);
    const started = await fixture.taskService.startTask({
      session_id: "session-a",
      operation_id: "op-start",
      task_id: taskId,
      expected_version: 0
    });
    expect(started.status).toBe("in_progress");

    await fixture.taskService.checkpointTask({
      session_id: "session-a",
      operation_id: "op-checkpoint",
      task_id: taskId,
      expected_version: 1,
      checkpoint: {
        completed_items: ["implemented"],
        current_state: "ready",
        human_context: [],
        confirmed_decisions: [],
        pending_decisions: [],
        blockers: [],
        verification,
        next_action: "submit"
      }
    });
    const detail = fixture.store.getTaskDetail(taskId);
    expect(detail?.checkpoint?.verification[0]?.code_fingerprint)
      .toMatchObject({ provenance: "host_verified", content_digest: digestOf("a") });
    expect(fixture.store.transaction((tx) => tx.getLatestRepoSnapshot(taskId)))
      .toMatchObject({ provenance: "host_verified", worktree_path: WORKTREE });

    collectEvidence(fixture, { operation: "submit", taskId, digest: digestOf("a") });
    const submitted = await fixture.taskService.submitTask({
      session_id: "session-a",
      operation_id: "op-submit",
      task_id: taskId,
      expected_version: 2,
      verification
    });
    expect(submitted.status).toBe("pending_acceptance");
    fixture.database.close();
  });

  it("rejects submit when the code changed between checkpoint and evidence", async () => {
    const fixture = createFixture();
    const taskId = await createBacklogTask(fixture);
    const verification = [{ command: "npm test", outcome: "passed" as const, summary: "green" }];

    collectEvidence(fixture);
    await fixture.taskService.startTask({
      session_id: "session-a",
      operation_id: "op-start",
      task_id: taskId,
      expected_version: 0
    });
    await fixture.taskService.checkpointTask({
      session_id: "session-a",
      operation_id: "op-checkpoint",
      task_id: taskId,
      expected_version: 1,
      checkpoint: {
        completed_items: ["implemented"],
        current_state: "ready",
        human_context: [],
        confirmed_decisions: [],
        pending_decisions: [],
        blockers: [],
        verification,
        next_action: "submit"
      }
    });

    // The worktree moved on after checkpoint: fresh evidence carries digest b.
    collectEvidence(fixture, { operation: "submit", taskId, digest: digestOf("b") });
    await expect(fixture.taskService.submitTask({
      session_id: "session-a",
      operation_id: "op-submit",
      task_id: taskId,
      expected_version: 2,
      verification
    })).rejects.toMatchObject({ code: "CHECKPOINT_REQUIRED" });
    fixture.database.close();
  });

  it("fails closed again once the evidence window lapses", async () => {
    const fixture = createFixture();
    const taskId = await createBacklogTask(fixture);

    collectEvidence(fixture);
    await fixture.taskService.startTask({
      session_id: "session-a",
      operation_id: "op-start",
      task_id: taskId,
      expected_version: 0
    });

    fixture.clockMs.value = BASE_TIME_MS + EVIDENCE_WINDOW_MS + 1_000;
    await expect(fixture.taskService.checkpointTask({
      session_id: "session-a",
      operation_id: "op-checkpoint",
      task_id: taskId,
      expected_version: 1,
      checkpoint: {
        completed_items: [],
        current_state: "working",
        human_context: [],
        confirmed_decisions: [],
        pending_decisions: [],
        blockers: [],
        verification: [],
        next_action: "continue"
      }
    })).rejects.toMatchObject({ code: "REMOTE_WORKTREE_EVIDENCE_REQUIRED" });
    fixture.database.close();
  });

  it("recovery treats host-verified submissions as fresh without a live probe", async () => {
    const fixture = createFixture();
    const taskId = await createBacklogTask(fixture);
    const verification = [{ command: "npm test", outcome: "passed" as const, summary: "green" }];

    collectEvidence(fixture);
    await fixture.taskService.startTask({
      session_id: "session-a",
      operation_id: "op-start",
      task_id: taskId,
      expected_version: 0
    });
    await fixture.taskService.checkpointTask({
      session_id: "session-a",
      operation_id: "op-checkpoint",
      task_id: taskId,
      expected_version: 1,
      checkpoint: {
        completed_items: ["implemented"],
        current_state: "ready",
        human_context: [],
        confirmed_decisions: [],
        pending_decisions: [],
        blockers: [],
        verification,
        next_action: "submit"
      }
    });
    collectEvidence(fixture, { operation: "submit", taskId, digest: digestOf("a") });
    await fixture.taskService.submitTask({
      session_id: "session-a",
      operation_id: "op-submit",
      task_id: taskId,
      expected_version: 2,
      verification
    });

    // Long after the evidence window the frozen submission stays acceptable.
    fixture.clockMs.value = BASE_TIME_MS + EVIDENCE_WINDOW_MS * 10;
    const recovery = await fixture.taskService.getTaskRecovery({
      session_id: "session-a",
      task_id: taskId
    });
    expect(recovery.evidence_state).toBe("fresh");
    fixture.database.close();
  });
});
