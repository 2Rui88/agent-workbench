/// <reference types="node" />

import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify as verifySignature
} from "node:crypto";
import { z } from "zod";
import type { RuntimeConfig } from "../config/runtime-config.js";
import type {
  HostEvidenceChallengeRecord,
  HostEvidenceRecord,
  HostKeyRecord,
  ProgressStore,
  ProgressTransaction
} from "../storage/progress-store.js";
import { canonicalJsonBytes } from "../shared/canonical-json.js";
import { normalizeWorktreePath } from "../shared/worktree-path.js";
import { PlatformDomainError } from "./task-service.js";

export { normalizeWorktreePath };

export const hostEvidencePayloadSchema = z.object({
  v: z.literal(1),
  kind: z.literal("host_worktree_evidence.v1"),
  challenge_id: z.string().min(1),
  nonce_b64: z.string().min(1),
  repository_id: z.string().min(1),
  worktree_path: z.string().min(1),
  head_commit: z.string().regex(/^[0-9a-f]{40}$/),
  branch: z.string().min(1).optional(),
  changed_files: z.array(z.string().min(1)),
  content_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  captured_at: z.iso.datetime(),
  host_key_id: z.string().min(1)
});

export type HostEvidencePayload = z.infer<typeof hostEvidencePayloadSchema>;

export interface RegisterHostKeyInput {
  owner: string;
  label: string;
  public_key_b64: string;
  client_family?: string;
  /**
   * Rotation proof: Ed25519 signature by the previous host key over the
   * SHA-256 digest of the new public key's SPKI DER bytes.
   */
  rotation_signature_b64?: string;
}

export interface RegisterHostKeyResult {
  host_key_id: string;
  outcome: "registered" | "existing" | "rotated";
}

export interface CreateChallengeInput {
  session_id: string;
  operation: "checkpoint" | "submit";
  task_id?: string;
}

export interface CreateChallengeResult {
  challenge_id: string;
  nonce_b64: string;
  operation: "checkpoint" | "submit";
  session_id: string;
  repository_id: string;
  task_id?: string;
  lease_generation?: number;
  expected_worktree_path: string;
  created_at: string;
  expires_at: string;
}

export interface SubmitEvidenceInput {
  payload: unknown;
  signature_b64: string;
}

export interface SubmitEvidenceResult {
  evidence_id: string;
  repository_id: string;
  worktree_path: string;
  head_commit: string;
  content_digest: string;
  captured_at: string;
  expires_at: string;
}

export interface HostEvidenceServiceDeps {
  store: ProgressStore;
  config: Pick<RuntimeConfig, "hostChallengeTtlMs" | "hostEvidenceWindowMs">;
  now?: () => string;
}

function decodeEd25519PublicKey(publicKeyB64: string): Buffer {
  let der: Buffer;
  try {
    der = Buffer.from(publicKeyB64, "base64");
  } catch {
    throw new PlatformDomainError(
      "HOST_KEY_REJECTED",
      "Host public key is not valid base64"
    );
  }
  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error(`expected ed25519, got ${String(key.asymmetricKeyType)}`);
    }
    return der;
  } catch {
    throw new PlatformDomainError(
      "HOST_KEY_REJECTED",
      "Host public key must be a base64 SPKI Ed25519 key"
    );
  }
}

function verifyEd25519(
  publicKeyB64: string,
  data: Buffer,
  signature: Buffer
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyB64, "base64"),
      format: "der",
      type: "spki"
    });
    return verifySignature(null, data, key, signature);
  } catch {
    return false;
  }
}

/**
 * Host-trusted worktree evidence chain: a developer machine signs a one-time
 * server challenge over its local worktree fingerprint with a registered
 * Ed25519 host key. The server verifies the signature and stores the evidence
 * as host_verified, which TaskService consumes when its own probe cannot
 * reach the worktree. Writes run in a single store transaction; every time
 * check uses the server clock, never the developer machine's.
 */
export class HostEvidenceService {
  readonly #store: ProgressStore;
  readonly #config: HostEvidenceServiceDeps["config"];
  readonly #now: () => string;

  constructor(deps: HostEvidenceServiceDeps) {
    this.#store = deps.store;
    this.#config = deps.config;
    this.#now = deps.now ?? (() => new Date().toISOString());
  }

  /**
   * Register (or idempotently re-register) a host key bound to an owner.
   * Rotation swaps the previous active key for a new one when the previous
   * key signs the SHA-256 digest of the new SPKI public key.
   */
  registerHostKey(input: RegisterHostKeyInput): RegisterHostKeyResult {
    const newKeyDer = decodeEd25519PublicKey(input.public_key_b64);
    return this.#store.transaction((tx) => {
      const existing = this.#store.findHostKeyByPublicKey(input.public_key_b64);
      if (existing !== undefined) {
        if (existing.owner !== input.owner) {
          throw new PlatformDomainError(
            "HOST_KEY_REJECTED",
            `Host key ${existing.host_key_id} belongs to owner ${existing.owner}`
          );
        }
        if (existing.status === "revoked") {
          throw new PlatformDomainError(
            "HOST_KEY_REJECTED",
            `Host key ${existing.host_key_id} is revoked and cannot be reused`
          );
        }
        return { host_key_id: existing.host_key_id, outcome: "existing" };
      }

      const nowIso = this.#now();
      if (input.rotation_signature_b64 !== undefined) {
        return this.#rotateHostKey(tx, input, newKeyDer, nowIso);
      }
      const hostKeyId = randomUUID();
      tx.insertHostKey({
        host_key_id: hostKeyId,
        owner: input.owner,
        label: input.label,
        public_key_b64: input.public_key_b64,
        ...(input.client_family === undefined
          ? {}
          : { client_family: input.client_family }),
        status: "active",
        created_at: nowIso
      });
      return { host_key_id: hostKeyId, outcome: "registered" };
    });
  }

  #rotateHostKey(
    tx: ProgressTransaction,
    input: RegisterHostKeyInput,
    newKeyDer: Buffer,
    nowIso: string
  ): RegisterHostKeyResult {
    let signature: Buffer;
    try {
      signature = Buffer.from(input.rotation_signature_b64!, "base64");
    } catch {
      throw new PlatformDomainError(
        "HOST_KEY_REJECTED",
        "Rotation signature is not valid base64"
      );
    }
    const digest = createHash("sha256").update(newKeyDer).digest();
    const matched = this.#store.listHostKeys(input.owner)
      .filter((key) => key.status === "active")
      .find((key) => verifyEd25519(key.public_key_b64, digest, signature));
    if (matched === undefined) {
      throw new PlatformDomainError(
        "HOST_KEY_REJECTED",
        `No active host key for owner ${input.owner} verifies the rotation signature`
      );
    }
    const hostKeyId = randomUUID();
    tx.insertHostKey({
      host_key_id: hostKeyId,
      owner: input.owner,
      label: input.label,
      public_key_b64: input.public_key_b64,
      ...(input.client_family === undefined
        ? {}
        : { client_family: input.client_family }),
      status: "active",
      created_at: nowIso
    });
    tx.updateHostKey({
      ...matched,
      status: "revoked",
      rotated_to: hostKeyId,
      revoked_at: nowIso
    });
    return { host_key_id: hostKeyId, outcome: "rotated" };
  }

  /**
   * Issue a one-time challenge bound to the session's repository, worktree,
   * and (for submit) the current task lease generation.
   */
  createChallenge(input: CreateChallengeInput): CreateChallengeResult {
    const session = this.#store.transaction((tx) => tx.getSession(input.session_id));
    if (session === undefined) {
      throw new PlatformDomainError(
        "SESSION_NOT_FOUND",
        `Session ${input.session_id} does not exist`
      );
    }
    if (session.worktree_path === undefined) {
      throw new PlatformDomainError(
        "REPOSITORY_NOT_ALLOWED",
        `Session ${input.session_id} has no worktree bound for evidence collection`
      );
    }
    if (session.owner === undefined) {
      throw new PlatformDomainError(
        "OWNER_MISMATCH",
        `Session ${input.session_id} has no owner bound for host key checks`
      );
    }
    let leaseGeneration: number | undefined;
    if (input.task_id !== undefined) {
      const lease = this.#store.transaction((tx) => tx.getLeaseByTask(input.task_id!));
      if (input.operation === "submit") {
        if (lease === undefined) {
          throw new PlatformDomainError(
            "LEASE_NOT_FOUND",
            `Task ${input.task_id} holds no lease; submit evidence requires the session lease`
          );
        }
        if (lease.session_id !== input.session_id) {
          throw new PlatformDomainError(
            "TASK_LEASE_CONFLICT",
            `Task ${input.task_id} is leased by another session`
          );
        }
        leaseGeneration = lease.generation ?? 1;
      } else if (lease !== undefined && lease.session_id === input.session_id) {
        leaseGeneration = lease.generation ?? 1;
      }
    }
    const nowIso = this.#now();
    const challenge: HostEvidenceChallengeRecord = {
      challenge_id: randomUUID(),
      nonce_b64: randomBytes(32).toString("base64"),
      operation: input.operation,
      session_id: input.session_id,
      repository_id: session.repository_id,
      ...(input.task_id === undefined ? {} : { task_id: input.task_id }),
      ...(leaseGeneration === undefined
        ? {}
        : { lease_generation: leaseGeneration }),
      expected_worktree_path: normalizeWorktreePath(session.worktree_path),
      created_at: nowIso,
      expires_at: new Date(
        Date.parse(nowIso) + this.#config.hostChallengeTtlMs
      ).toISOString()
    };
    this.#store.transaction((tx) => tx.insertHostEvidenceChallenge(challenge));
    const { nonce_b64, ...view } = challenge;
    return { nonce_b64, ...view };
  }

  /**
   * Verify a signed evidence payload against its challenge in one atomic
   * pass: existence, expiry, binding, host key status and ownership, lease
   * generation, Ed25519 signature, and the capture-time window. A retry of
   * the exact same submission replays the stored evidence idempotently.
   */
  submitEvidence(input: SubmitEvidenceInput): SubmitEvidenceResult {
    const parsed = hostEvidencePayloadSchema.safeParse(input.payload);
    if (!parsed.success) {
      throw new PlatformDomainError(
        "INVALID_INPUT",
        "Host evidence payload does not match host_worktree_evidence.v1",
        { evidence: parsed.error.issues.map((issue) => issue.path.join(".")) }
      );
    }
    const payload = parsed.data;
    let signature: Buffer;
    try {
      signature = Buffer.from(input.signature_b64, "base64");
    } catch {
      throw new PlatformDomainError(
        "HOST_KEY_REJECTED",
        "Evidence signature is not valid base64"
      );
    }
    return this.#store.transaction((tx) => {
      const challenge = this.#store.getHostEvidenceChallenge(payload.challenge_id);
      if (challenge === undefined) {
        throw new PlatformDomainError(
          "INVALID_INPUT",
          `Challenge ${payload.challenge_id} does not exist`
        );
      }
      const nowIso = this.#now();
      if (challenge.consumed_at !== undefined) {
        const stored = this.#store.getHostEvidenceByChallenge(challenge.challenge_id);
        if (stored !== undefined
          && stored.content_digest === payload.content_digest
          && stored.head_commit === payload.head_commit
          && stored.worktree_path === payload.worktree_path) {
          return this.#resultFromEvidence(stored);
        }
        throw new PlatformDomainError(
          "CHALLENGE_REPLAY",
          `Challenge ${payload.challenge_id} was already consumed`
        );
      }
      if (Date.parse(nowIso) >= Date.parse(challenge.expires_at)) {
        throw new PlatformDomainError(
          "CHALLENGE_EXPIRED",
          `Challenge ${payload.challenge_id} expired at ${challenge.expires_at}`,
          { retryable: true, evidence: [challenge.expires_at] }
        );
      }
      this.#assertChallengeBinding(challenge, payload);
      const session = tx.getSession(challenge.session_id);
      if (session === undefined) {
        throw new PlatformDomainError(
          "SESSION_NOT_FOUND",
          `Session ${challenge.session_id} no longer exists`
        );
      }
      const hostKey = this.#store.getHostKey(payload.host_key_id);
      if (hostKey === undefined || hostKey.status !== "active") {
        throw new PlatformDomainError(
          "HOST_KEY_REJECTED",
          `Host key ${payload.host_key_id} is not registered and active`
        );
      }
      if (hostKey.owner !== session.owner) {
        throw new PlatformDomainError(
          "HOST_KEY_REJECTED",
          `Host key ${payload.host_key_id} belongs to ${hostKey.owner}, `
            + `not session owner ${session.owner ?? "unknown"}`
        );
      }
      if (challenge.host_key_id !== undefined
        && challenge.host_key_id !== payload.host_key_id) {
        throw new PlatformDomainError(
          "HOST_EVIDENCE_MISMATCH",
          `Challenge was bound to host key ${challenge.host_key_id}`
        );
      }
      this.#assertLeaseStillBound(tx, challenge);
      if (!verifyEd25519(
        hostKey.public_key_b64,
        canonicalJsonBytes(payload),
        signature
      )) {
        throw new PlatformDomainError(
          "HOST_KEY_REJECTED",
          "Host evidence signature verification failed"
        );
      }
      if (Date.parse(payload.captured_at) < Date.parse(challenge.created_at)
        || Date.parse(payload.captured_at) > Date.parse(challenge.expires_at)) {
        throw new PlatformDomainError(
          "HOST_EVIDENCE_MISMATCH",
          `captured_at ${payload.captured_at} falls outside the challenge window `
            + `[${challenge.created_at}, ${challenge.expires_at}]`
        );
      }
      if (!tx.consumeHostEvidenceChallenge(challenge.challenge_id, nowIso)) {
        throw new PlatformDomainError(
          "CHALLENGE_REPLAY",
          `Challenge ${payload.challenge_id} was consumed concurrently`
        );
      }
      const evidence: HostEvidenceRecord = {
        evidence_id: randomUUID(),
        host_key_id: hostKey.host_key_id,
        challenge_id: challenge.challenge_id,
        session_id: challenge.session_id,
        ...(challenge.task_id === undefined ? {} : { task_id: challenge.task_id }),
        repository_id: challenge.repository_id,
        worktree_path: payload.worktree_path,
        head_commit: payload.head_commit,
        ...(payload.branch === undefined ? {} : { branch: payload.branch }),
        changed_files: [...payload.changed_files],
        content_digest: payload.content_digest,
        signature_b64: input.signature_b64,
        payload_json: JSON.stringify(payload),
        captured_at: payload.captured_at,
        verified_at: nowIso,
        expires_at: new Date(
          Date.parse(nowIso) + this.#config.hostEvidenceWindowMs
        ).toISOString()
      };
      tx.insertHostEvidence(evidence);
      tx.touchHostKeyUsed(hostKey.host_key_id, nowIso);
      return this.#resultFromEvidence(evidence);
    });
  }

  #assertChallengeBinding(
    challenge: HostEvidenceChallengeRecord,
    payload: HostEvidencePayload
  ): void {
    const mismatches: string[] = [];
    if (payload.nonce_b64 !== challenge.nonce_b64) {
      mismatches.push("nonce_b64");
    }
    if (payload.repository_id !== challenge.repository_id) {
      mismatches.push("repository_id");
    }
    if (normalizeWorktreePath(payload.worktree_path) !== challenge.expected_worktree_path) {
      mismatches.push("worktree_path");
    }
    if (mismatches.length > 0) {
      throw new PlatformDomainError(
        "HOST_EVIDENCE_MISMATCH",
        `Evidence payload does not match the challenge binding: ${mismatches.join(", ")}`
      );
    }
  }

  #assertLeaseStillBound(
    tx: ProgressTransaction,
    challenge: HostEvidenceChallengeRecord
  ): void {
    if (challenge.lease_generation === undefined || challenge.task_id === undefined) {
      return;
    }
    const lease = tx.getLeaseByTask(challenge.task_id);
    if (lease === undefined
      || lease.session_id !== challenge.session_id
      || (lease.generation ?? 1) !== challenge.lease_generation) {
      throw new PlatformDomainError(
        "HOST_EVIDENCE_MISMATCH",
        `Task ${challenge.task_id} lease changed since the challenge was issued `
          + `(expected session ${challenge.session_id} generation `
          + `${String(challenge.lease_generation)})`
      );
    }
  }

  #resultFromEvidence(evidence: HostEvidenceRecord): SubmitEvidenceResult {
    return {
      evidence_id: evidence.evidence_id,
      repository_id: evidence.repository_id,
      worktree_path: evidence.worktree_path,
      head_commit: evidence.head_commit,
      content_digest: evidence.content_digest,
      captured_at: evidence.captured_at,
      expires_at: evidence.expires_at
    };
  }
}

export type { HostKeyRecord };
