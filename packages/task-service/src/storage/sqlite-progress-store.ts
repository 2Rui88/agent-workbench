/// <reference types="node" />

import { existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { DatabaseSync as NativeDatabaseSync } from "node:sqlite";
import type { RuntimeConfig } from "../config/runtime-config.js";
import {
  checkpointPayloadSchema,
  taskStatusSchema,
  repoSnapshotSchema,
  sessionRecordSchema,
  taskRecordSchema,
  type TaskRecord
} from "../shared/task-contracts.js";
import {
  dependencyValidationEvidenceSchema,
  dependencyValidationSpecSchema,
  assertDependencyValidationSpecIdentity,
  sanitizeDependencyValidationEvidence,
  sanitizeDependencyValidationProgress,
  sanitizeDependencyValidationSpec,
  sanitizeDependencyValidationText,
  type DependencyValidationSpec
} from "../shared/dependency-validation-contracts.js";
import {
  migrationMetadata,
  type MigrationMetadata
} from "./migrations.js";
import type {
  BoardAuthStore,
  BoardPairingChallengeRecord,
  BoardSessionRecord,
  PlatformStore
} from "./board-auth-store.js";
import type {
  ActiveTaskLease,
  ActiveTaskScope,
  CheckpointRecord,
  DependencyContextEventRecord,
  DependencyContextRecord,
  DependencyContextStatus,
  DependencyRepairRequestRecord,
  DependencyRepairStatus,
  DependencyValidationActivity,
  DependencyValidationGate,
  DependencyValidationListFilter,
  DependencyValidationPerspective,
  DependencyValidationRecord,
  DependencyValidationRunRecord,
  DependencyValidationRunStatus,
  DependencyValidationRunView,
  DependencyValidationView,
  HostEvidenceChallengeRecord,
  HostEvidenceRecord,
  HostKeyRecord,
  HumanDecisionRecord,
  JsonValue,
  LegacyTaskImport,
  OperationResult,
  ProgressStore,
  ProgressTransaction,
  ProjectRecord,
  ArchiveProjectOutcome,
  ListProjectsOptions,
  ProjectOpenTask,
  UnarchiveProjectOutcome,
  ProjectMemberRecord,
  ProjectShareRecord,
  ProjectWithRepositories,
  RepoSnapshotView,
  RepoSnapshotRecord,
  RepositoryRecord,
  NotificationListFilter,
  NotificationRecord,
  PersonSummary,
  SessionRecord,
  SessionEventRecord,
  SnapshotConflictView,
  TaskDependencyRecord,
  TaskDependencyView,
  TaskEventView,
  TaskDetail,
  TaskEventRecord,
  TaskListFilter,
  TaskScopeRecord,
  TaskSessionLinkRecord,
  TaskSummary
} from "./progress-store.js";
import { StorageError } from "./progress-store.js";

type SqliteRow = Record<string, unknown>;
interface Migration extends MigrationMetadata {
  readonly up: (database: DatabaseSync) => void;
}

const jsonValueSchema: z.ZodType<JsonValue> = z.json();

const leaseSchema = z.object({
  task_id: z.string().min(1),
  session_id: z.string().min(1),
  acquired_at: z.iso.datetime(),
  heartbeat_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  generation: z.number().int().positive().default(1)
});

const dependencyRepairRequestSchema = z.object({
  repair_id: z.string().min(1),
  validation_id: z.string().min(1),
  source_run_id: z.string().min(1),
  ctx_id: z.string().min(1).nullable(),
  upstream_task_id: z.string().min(1),
  downstream_task_id: z.string().min(1),
  cycle: z.number().int().positive(),
  status: z.enum(["pending", "claimed", "resolved", "superseded", "cancelled"]),
  rejection_reason: z.string().trim().min(1).max(4_000),
  claimed_session_id: z.string().min(1).nullable(),
  claimed_worktree_path: z.string().min(1).nullable(),
  claimed_at: z.iso.datetime().nullable(),
  resolved_at: z.iso.datetime().nullable(),
  superseded_at: z.iso.datetime().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime()
});

const hostKeySchema = z.object({
  host_key_id: z.string().min(1),
  owner: z.string().min(1),
  label: z.string().min(1),
  public_key_b64: z.string().min(1),
  client_family: z.string().min(1).optional(),
  status: z.enum(["active", "revoked"]),
  rotated_to: z.string().min(1).optional(),
  created_at: z.iso.datetime(),
  revoked_at: z.iso.datetime().optional(),
  last_used_at: z.iso.datetime().optional()
});

const hostEvidenceChallengeSchema = z.object({
  challenge_id: z.string().min(1),
  nonce_b64: z.string().min(1),
  operation: z.enum(["checkpoint", "submit"]),
  session_id: z.string().min(1),
  repository_id: z.string().min(1),
  task_id: z.string().min(1).optional(),
  lease_generation: z.number().int().positive().optional(),
  expected_worktree_path: z.string().min(1),
  host_key_id: z.string().min(1).optional(),
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  consumed_at: z.iso.datetime().optional()
});

const hostEvidenceSchema = z.object({
  evidence_id: z.string().min(1),
  host_key_id: z.string().min(1),
  challenge_id: z.string().min(1),
  session_id: z.string().min(1),
  task_id: z.string().min(1).optional(),
  repository_id: z.string().min(1),
  worktree_path: z.string().min(1),
  head_commit: z.string().min(1),
  branch: z.string().min(1).optional(),
  changed_files: z.array(z.string().min(1)),
  content_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  signature_b64: z.string().min(1),
  payload_json: z.string().min(1),
  captured_at: z.iso.datetime(),
  verified_at: z.iso.datetime(),
  expires_at: z.iso.datetime()
});

const legacyTaskImportSchema = z.object({
  legacy_import_key: z.string().min(1),
  source_session_label: z.string().min(1),
  project_id: z.string().min(1),
  repository_id: z.string().min(1),
  worktree_path: z.string().min(1),
  normalized_title: z.string().min(1),
  task_id: z.string().min(1),
  created_at: z.iso.datetime()
});

const projectRecordSchema = z.object({
  project_id: z.string().min(1),
  name: z.string().min(1),
  created_by: z.string().min(1).nullable().optional(),
  archived_at: z.iso.datetime().nullable().optional(),
  archived_by: z.string().min(1).nullable().optional(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime()
});

const projectMemberSchema = z.object({
  project_id: z.string().min(1),
  owner: z.string().min(1),
  role: z.literal("member"),
  granted_by: z.string().min(1),
  created_at: z.iso.datetime(),
  revoked_at: z.iso.datetime().nullable()
});

const projectShareSchema = z.object({
  share_id: z.string().min(1),
  project_id: z.string().min(1),
  token_hash: z.string().min(1),
  created_by: z.string().min(1),
  expires_at: z.iso.datetime(),
  consumed_at: z.iso.datetime().nullable(),
  revoked_at: z.iso.datetime().nullable(),
  created_at: z.iso.datetime()
});

const repositoryRecordSchema = z.object({
  repository_id: z.string().min(1),
  project_id: z.string().min(1),
  path: z.string().min(1),
  label: z.string().min(1),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime()
});

const activeTaskScopeSchema = z.object({
  task_id: z.string().min(1),
  scope_type: z.string().min(1),
  scope_value: z.string().min(1)
});

const taskSessionLinkSchema = z.object({
  task_id: z.string().min(1),
  session_id: z.string().min(1),
  linked_at: z.iso.datetime()
});

const humanDecisionSchema = z.object({
  decision_id: z.string().min(1),
  task_id: z.string().min(1),
  session_id: z.string().min(1).optional(),
  question: z.string().min(1),
  decision: z.string().optional(),
  status: z.string().min(1),
  created_at: z.iso.datetime(),
  decided_at: z.iso.datetime().optional()
});

const taskDependencySchema = z.object({
  task_id: z.string().min(1),
  depends_on_task_id: z.string().min(1),
  created_at: z.iso.datetime(),
  policy: z.enum(["informational", "validation_gate", "acceptance_gate", "hard_block"]).default("acceptance_gate"),
  ctx_id: z.string().min(1).optional(),
  generation: z.number().int().positive().default(1)
});

const dependencyContextSchema = z.object({
  ctx_id: z.string().min(1),
  upstream_task_id: z.string().min(1),
  upstream_repository_id: z.string().min(1),
  downstream_task_id: z.string().min(1),
  downstream_repository_id: z.string().min(1),
  policy: z.enum(["informational", "validation_gate", "acceptance_gate", "hard_block"]),
  generation: z.number().int().positive(),
  status: z.enum(["active", "cancelled", "superseded", "closed"]),
  current_cycle: z.number().int().min(0),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime()
});

const dependencyContextEventSchema = z.object({
  event_id: z.string().min(1),
  ctx_id: z.string().min(1),
  sequence: z.number().int().positive(),
  event_type: z.string().min(1),
  payload: jsonValueSchema,
  created_at: z.iso.datetime()
});

const dependencyValidationSchema = z.object({
  ctx_id: z.string().min(1).optional(),
  validation_id: z.string().min(1),
  upstream_task_id: z.string().min(1),
  downstream_task_id: z.string().min(1),
  cycle: z.number().int().positive(),
  status: z.enum(["pending", "passed", "rejected", "superseded"]),
  requested_by_actor: z.enum(["agent", "human"]),
  requested_by_owner: z.string().nullable(),
  requested_at: z.iso.datetime(),
  request_read_at: z.iso.datetime().nullable(),
  responded_by_owner: z.string().nullable(),
  response_reason: z.string().nullable(),
  responded_at: z.iso.datetime().nullable(),
  response_read_at: z.iso.datetime().nullable(),
  validation_spec: jsonValueSchema
});

const dependencyValidationRunSchema = z.object({
  run_id: z.string().min(1),
  validation_id: z.string().min(1),
  attempt: z.number().int().positive(),
  status: z.enum(["queued", "claimed", "running", "passed", "rejected", "error", "cancelled"]),
  owner: z.string().min(1),
  session_id: z.string().min(1),
  worktree_path: z.string().min(1),
  heartbeat_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  started_at: z.iso.datetime().nullable(),
  completed_at: z.iso.datetime().nullable(),
  verification: z.array(jsonValueSchema),
  progress: jsonValueSchema.default({}),
  failure_reason: z.string().nullable(),
  error_reason: z.string().nullable(),
  operation_id: z.string().min(1),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime()
});

const sessionEventSchema = z.object({
  event_id: z.string().min(1),
  session_id: z.string().min(1),
  event_type: z.string().min(1),
  payload: jsonValueSchema,
  created_at: z.iso.datetime()
});

const boardPairingChallengeSchema = z.object({
  challenge_id: z.string().min(1),
  code_hash: z.string().min(1),
  browser_secret_hash: z.string().min(1),
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  approved_session_id: z.string().min(1).optional(),
  approved_owner: z.string().min(1).optional(),
  approved_at: z.iso.datetime().optional(),
  consumed_at: z.iso.datetime().optional()
});

const boardSessionSchema = z.object({
  board_session_id: z.string().min(1),
  token_hash: z.string().min(1),
  owner: z.string().min(1),
  source_session_id: z.string().min(1),
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  last_seen_at: z.iso.datetime(),
  revoked_at: z.iso.datetime().optional()
});

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boardPairingFromRow(row: SqliteRow): BoardPairingChallengeRecord {
  return boardPairingChallengeSchema.parse({
    challenge_id: row.challenge_id,
    code_hash: row.code_hash,
    browser_secret_hash: row.browser_secret_hash,
    created_at: row.created_at,
    expires_at: row.expires_at,
    ...(optionalString(row.approved_session_id) === undefined
      ? {}
      : { approved_session_id: row.approved_session_id }),
    ...(optionalString(row.approved_owner) === undefined
      ? {}
      : { approved_owner: row.approved_owner }),
    ...(optionalString(row.approved_at) === undefined
      ? {}
      : { approved_at: row.approved_at }),
    ...(optionalString(row.consumed_at) === undefined
      ? {}
      : { consumed_at: row.consumed_at })
  });
}

function boardSessionFromRow(row: SqliteRow): BoardSessionRecord {
  return boardSessionSchema.parse({
    board_session_id: row.board_session_id,
    token_hash: row.token_hash,
    owner: row.owner,
    source_session_id: row.source_session_id,
    created_at: row.created_at,
    expires_at: row.expires_at,
    last_seen_at: row.last_seen_at,
    ...(optionalString(row.revoked_at) === undefined ? {} : { revoked_at: row.revoked_at })
  });
}

function parseJson(text: unknown): JsonValue {
  if (typeof text !== "string") {
    throw new TypeError("Expected a JSON string from SQLite");
  }
  return jsonValueSchema.parse(JSON.parse(text));
}

function serializeJson(value: unknown): string {
  return JSON.stringify(jsonValueSchema.parse(value));
}

function taskFromRow(row: SqliteRow): TaskRecord {
  const candidate: Record<string, unknown> = {
    task_id: row.task_id,
    repository_id: row.repository_id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
  if (typeof row.session_id === "string") {
    candidate.session_id = row.session_id;
  }
  if (typeof row.owner === "string") {
    candidate.owner = row.owner;
  }
  if (typeof row.goal === "string") {
    candidate.goal = row.goal;
  }
  if (typeof row.acceptance_criteria_json === "string") {
    candidate.acceptance_criteria = JSON.parse(row.acceptance_criteria_json) as string[];
  }
  if (typeof row.checkpoint_json === "string") {
    candidate.checkpoint = checkpointPayloadSchema.parse(JSON.parse(row.checkpoint_json));
  }
  return taskRecordSchema.parse(candidate);
}

function taskSummaryFromRow(row: SqliteRow): TaskSummary {
  const task = taskFromRow(row);
  if (typeof row.version !== "number") {
    throw new TypeError("Expected numeric task version from SQLite");
  }
  return { ...task, version: row.version };
}

function repoSnapshotRecordFromRow(row: SqliteRow): RepoSnapshotRecord {
  const changedFiles = row.changed_files_json === null || row.changed_files_json === undefined
    ? undefined
    : JSON.parse(String(row.changed_files_json));
  return {
    snapshot_id: String(row.snapshot_id),
    task_id: String(row.task_id),
    ...(row.checkpoint_id === null || row.checkpoint_id === undefined
      ? {}
      : { checkpoint_id: String(row.checkpoint_id) }),
    repository_id: String(row.repository_id),
    repository_path: String(row.repository_path),
    head_commit: String(row.head_commit),
    captured_at: String(row.captured_at),
    ...(row.worktree_path === null || row.worktree_path === undefined
      ? {}
      : { worktree_path: String(row.worktree_path) }),
    ...(row.branch === null || row.branch === undefined
      ? {}
      : { branch: String(row.branch) }),
    ...(changedFiles === undefined ? {} : { changed_files: changedFiles as string[] }),
    ...(row.content_digest === null || row.content_digest === undefined
      ? {}
      : { content_digest: String(row.content_digest) }),
    ...(row.provenance === null || row.provenance === undefined
      ? {}
      : { provenance: String(row.provenance) as "server_verified" | "host_verified" }),
    ...(row.host_evidence_id === null || row.host_evidence_id === undefined
      ? {}
      : { host_evidence_id: String(row.host_evidence_id) })
  };
}

function hostKeyFromRow(row: SqliteRow): HostKeyRecord {
  const parsed = hostKeySchema.parse({
    host_key_id: String(row.host_key_id),
    owner: String(row.owner),
    label: String(row.label),
    public_key_b64: String(row.public_key_b64),
    client_family: row.client_family === null || row.client_family === undefined
      ? undefined
      : String(row.client_family),
    status: String(row.status) === "revoked" ? "revoked" : "active",
    rotated_to: row.rotated_to === null || row.rotated_to === undefined
      ? undefined
      : String(row.rotated_to),
    created_at: String(row.created_at),
    revoked_at: row.revoked_at === null || row.revoked_at === undefined
      ? undefined
      : String(row.revoked_at),
    last_used_at: row.last_used_at === null || row.last_used_at === undefined
      ? undefined
      : String(row.last_used_at)
  });
  return {
    host_key_id: parsed.host_key_id,
    owner: parsed.owner,
    label: parsed.label,
    public_key_b64: parsed.public_key_b64,
    status: parsed.status,
    created_at: parsed.created_at,
    ...(parsed.client_family === undefined ? {} : { client_family: parsed.client_family }),
    ...(parsed.rotated_to === undefined ? {} : { rotated_to: parsed.rotated_to }),
    ...(parsed.revoked_at === undefined ? {} : { revoked_at: parsed.revoked_at }),
    ...(parsed.last_used_at === undefined ? {} : { last_used_at: parsed.last_used_at })
  };
}

function hostEvidenceChallengeFromRow(row: SqliteRow): HostEvidenceChallengeRecord {
  const parsed = hostEvidenceChallengeSchema.parse({
    challenge_id: String(row.challenge_id),
    nonce_b64: String(row.nonce_b64),
    operation: String(row.operation) === "submit" ? "submit" : "checkpoint",
    session_id: String(row.session_id),
    repository_id: String(row.repository_id),
    task_id: row.task_id === null || row.task_id === undefined
      ? undefined
      : String(row.task_id),
    lease_generation: row.lease_generation === null || row.lease_generation === undefined
      ? undefined
      : Number(row.lease_generation),
    expected_worktree_path: String(row.expected_worktree_path),
    host_key_id: row.host_key_id === null || row.host_key_id === undefined
      ? undefined
      : String(row.host_key_id),
    created_at: String(row.created_at),
    expires_at: String(row.expires_at),
    consumed_at: row.consumed_at === null || row.consumed_at === undefined
      ? undefined
      : String(row.consumed_at)
  });
  return {
    challenge_id: parsed.challenge_id,
    nonce_b64: parsed.nonce_b64,
    operation: parsed.operation,
    session_id: parsed.session_id,
    repository_id: parsed.repository_id,
    expected_worktree_path: parsed.expected_worktree_path,
    created_at: parsed.created_at,
    expires_at: parsed.expires_at,
    ...(parsed.task_id === undefined ? {} : { task_id: parsed.task_id }),
    ...(parsed.lease_generation === undefined
      ? {}
      : { lease_generation: parsed.lease_generation }),
    ...(parsed.host_key_id === undefined ? {} : { host_key_id: parsed.host_key_id }),
    ...(parsed.consumed_at === undefined ? {} : { consumed_at: parsed.consumed_at })
  };
}

function hostEvidenceFromRow(row: SqliteRow): HostEvidenceRecord {
  const parsed = hostEvidenceSchema.parse({
    evidence_id: String(row.evidence_id),
    host_key_id: String(row.host_key_id),
    challenge_id: String(row.challenge_id),
    session_id: String(row.session_id),
    task_id: row.task_id === null || row.task_id === undefined
      ? undefined
      : String(row.task_id),
    repository_id: String(row.repository_id),
    worktree_path: String(row.worktree_path),
    head_commit: String(row.head_commit),
    branch: row.branch === null || row.branch === undefined
      ? undefined
      : String(row.branch),
    changed_files: JSON.parse(String(row.changed_files_json)) as string[],
    content_digest: String(row.content_digest),
    signature_b64: String(row.signature_b64),
    payload_json: String(row.payload_json),
    captured_at: String(row.captured_at),
    verified_at: String(row.verified_at),
    expires_at: String(row.expires_at)
  });
  return {
    evidence_id: parsed.evidence_id,
    host_key_id: parsed.host_key_id,
    challenge_id: parsed.challenge_id,
    session_id: parsed.session_id,
    repository_id: parsed.repository_id,
    worktree_path: parsed.worktree_path,
    head_commit: parsed.head_commit,
    changed_files: parsed.changed_files,
    content_digest: parsed.content_digest,
    signature_b64: parsed.signature_b64,
    payload_json: parsed.payload_json,
    captured_at: parsed.captured_at,
    verified_at: parsed.verified_at,
    expires_at: parsed.expires_at,
    ...(parsed.task_id === undefined ? {} : { task_id: parsed.task_id }),
    ...(parsed.branch === undefined ? {} : { branch: parsed.branch })
  };
}

function leaseFromRow(row: SqliteRow): ActiveTaskLease {
  return leaseSchema.parse(row);
}

function dependencyRepairRequestFromRow(row: SqliteRow): DependencyRepairRequestRecord {
  return dependencyRepairRequestSchema.parse({
    ...row,
    cycle: Number(row.cycle),
    rejection_reason: sanitizeDependencyValidationText(row.rejection_reason) ?? "[redacted]"
  });
}

const sessionColumns = `
  session_id, repository_id, label, started_at, ended_at,
  transport_session_id, client_name, client_version, client_family,
  protocol_version, capabilities_json, workspace_path, worktree_path,
  last_activity_at, stale_at, owner, successor_session_id, successor_ctx_id,
  resume_token_hash
`;

function sessionFromRow(row: SqliteRow): SessionRecord {
  const candidate: Record<string, unknown> = {
    session_id: row.session_id,
    repository_id: row.repository_id,
    label: row.label,
    started_at: row.started_at
  };
  for (const column of [
    "ended_at",
    "owner",
    "transport_session_id",
    "client_name",
    "client_version",
    "client_family",
    "protocol_version",
    "workspace_path",
    "worktree_path",
    "last_activity_at",
    "stale_at", "successor_session_id", "successor_ctx_id", "resume_token_hash"
  ]) {
    if (typeof row[column] === "string") {
      candidate[column] = row[column];
    }
  }
  if (typeof row.capabilities_json === "string") {
    candidate.capabilities = JSON.parse(row.capabilities_json);
  }
  return sessionRecordSchema.parse(candidate);
}

function sessionEventFromRow(row: SqliteRow): SessionEventRecord {
  return sessionEventSchema.parse({
    event_id: row.event_id,
    session_id: row.session_id,
    event_type: row.event_type,
    payload: parseJson(row.payload_json),
    created_at: row.created_at
  });
}

function dependencyValidationFromRow(row: SqliteRow): DependencyValidationRecord {
  const upstreamTaskId = String(row.upstream_task_id);
  const downstreamTaskId = String(row.downstream_task_id);
  const cycle = Number(row.cycle);
  const rawSpec = row.validation_spec_json === undefined
    ? {}
    : parseJson(String(row.validation_spec_json));
  try {
    // Reject an explicit identity mismatch before the sanitizer applies
    // legacy fallbacks.  A malformed row must not be exposed as a different
    // task/repository/cycle contract to Board or Agent callers.
    assertDependencyValidationSpecIdentity(rawSpec, {
      upstream_task_id: upstreamTaskId,
      upstream_repository_id: optionalString(row.upstream_repository_id),
      downstream_task_id: downstreamTaskId,
      downstream_repository_id: optionalString(row.downstream_repository_id),
      cycle
    });
  } catch (error) {
    throw new StorageError(
      "CONSTRAINT_VIOLATION",
      error instanceof Error ? error.message : "validation_spec identity mismatch"
    );
  }
  return dependencyValidationSchema.parse({
    ctx_id: row.ctx_id === null || row.ctx_id === undefined ? String(row.validation_id) : String(row.ctx_id),
    validation_id: row.validation_id,
    upstream_task_id: upstreamTaskId,
    downstream_task_id: downstreamTaskId,
    cycle,
    status: row.status,
    requested_by_actor: row.requested_by_actor,
    requested_by_owner: row.requested_by_owner,
    requested_at: row.requested_at,
    request_read_at: row.request_read_at,
    responded_by_owner: row.responded_by_owner,
    response_reason: row.response_reason === null || row.response_reason === undefined
      ? null
      : sanitizeDependencyValidationText(row.response_reason) ?? "[redacted]",
    responded_at: row.responded_at,
    response_read_at: row.response_read_at,
    // Keep the storage-facing record JSON-compatible for migrations and
    // exports; public views below always pass it through the strict contract
    // sanitizer with task-derived fallbacks.
    validation_spec: sanitizeDependencyValidationSpec(rawSpec, {
      preserve_persisted_fields: true,
      upstream_task_id: upstreamTaskId,
      upstream_repository_id: optionalString(row.upstream_repository_id),
      downstream_task_id: downstreamTaskId,
      downstream_repository_id: optionalString(row.downstream_repository_id),
      cycle
    })
  }) as DependencyValidationRecord;
}

function dependencyValidationRunFromRow(row: SqliteRow, prefix = ""): DependencyValidationRunRecord {
  const parsed = dependencyValidationRunSchema.parse({
    run_id: row[`${prefix}run_id`],
    validation_id: row[`${prefix}validation_id`],
    attempt: Number(row[`${prefix}attempt`]),
    status: row[`${prefix}status`] as DependencyValidationRunStatus,
    owner: row[`${prefix}owner`],
    session_id: row[`${prefix}session_id`],
    worktree_path: row[`${prefix}worktree_path`],
    heartbeat_at: row[`${prefix}heartbeat_at`],
    expires_at: row[`${prefix}expires_at`],
    started_at: row[`${prefix}started_at`] ?? null,
    completed_at: row[`${prefix}completed_at`] ?? null,
    verification: sanitizeDependencyValidationEvidence(
      parseJson(String(row[`${prefix}verification_json`]))
    ),
    progress: row[`${prefix}progress_json`] === undefined || row[`${prefix}progress_json`] === null
      ? {}
      : sanitizeDependencyValidationProgress(
        parseJson(String(row[`${prefix}progress_json`]))
      ),
    failure_reason: row[`${prefix}failure_reason`] === null || row[`${prefix}failure_reason`] === undefined
      ? null
      : sanitizeDependencyValidationText(row[`${prefix}failure_reason`]) ?? "[redacted]",
    error_reason: row[`${prefix}error_reason`] === null || row[`${prefix}error_reason`] === undefined
      ? null
      : sanitizeDependencyValidationText(row[`${prefix}error_reason`]) ?? "[redacted]",
    operation_id: row[`${prefix}operation_id`],
    created_at: row[`${prefix}created_at`],
    updated_at: row[`${prefix}updated_at`]
  });
  return {
    ...parsed,
    verification: sanitizeDependencyValidationEvidence(parsed.verification),
    progress: sanitizeDependencyValidationProgress(parsed.progress)
  };
}

function dependencyValidationRunViewFromRow(
  row: SqliteRow,
  validationSpec: DependencyValidationSpec
): DependencyValidationRunView {
  return {
    ...dependencyValidationRunFromRow(row),
    validation_spec: validationSpec
  };
}

function dependencyValidationViewFromRow(
  row: SqliteRow,
  runs: readonly DependencyValidationRunView[] = [],
  upstreamTaskVersion?: number
): DependencyValidationView {
  const rawSpec = row.validation_spec_json === undefined
    ? {}
    : parseJson(String(row.validation_spec_json));
  const validationSpec = sanitizeDependencyValidationSpec(rawSpec, {
    preserve_persisted_fields: true,
    upstream_task_id: optionalString(row.upstream_task_id),
    ...(upstreamTaskVersion === undefined ? {} : { upstream_task_version: upstreamTaskVersion }),
    upstream_repository_id: optionalString(row.upstream_repository_id),
    downstream_task_id: optionalString(row.downstream_task_id),
    downstream_repository_id: optionalString(row.downstream_repository_id),
    cycle: typeof row.cycle === "number" ? row.cycle : Number(row.cycle ?? 1),
    worktree_path: optionalString(row.latest_worktree_path)
  });
  const safeRuns = runs.length > 0
    ? runs
    : row.latest_run_id === null || row.latest_run_id === undefined
      ? []
      : [dependencyValidationRunViewFromRow({
        run_id: row.latest_run_id,
        validation_id: row.latest_validation_id,
        attempt: row.latest_attempt,
        status: row.latest_status,
        owner: row.latest_owner,
        session_id: row.latest_session_id,
        worktree_path: row.latest_worktree_path,
        heartbeat_at: row.latest_heartbeat_at,
        expires_at: row.latest_expires_at,
        started_at: row.latest_started_at,
        completed_at: row.latest_completed_at,
        verification_json: row.latest_verification_json,
        progress_json: row.latest_progress_json,
        failure_reason: row.latest_failure_reason,
        error_reason: row.latest_error_reason,
        operation_id: row.latest_operation_id,
        created_at: row.latest_created_at,
        updated_at: row.latest_updated_at
      }, validationSpec)];
  return {
    ...dependencyValidationFromRow(row),
    validation_spec: validationSpec,
    upstream_owner: row.upstream_owner === null ? null : String(row.upstream_owner),
    upstream_repository_id: String(row.upstream_repository_id),
    upstream_title: String(row.upstream_title),
    downstream_owner: row.downstream_owner === null ? null : String(row.downstream_owner),
    downstream_repository_id: String(row.downstream_repository_id),
    downstream_title: String(row.downstream_title),
    latest_run: safeRuns[0] ?? null,
    runs: safeRuns
  };
}

function optionalRow(row: SqliteRow | undefined): SqliteRow | undefined {
  return row;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null)
    || typeof value === "function"
  ) && "then" in value && typeof value.then === "function";
}

export interface DatabaseDiagnostics {
  busyTimeoutMs: number;
  foreignKeys: boolean;
  integrityCheck: string;
  journalMode: string;
  schemaVersion: number;
}

function readIntegerPragma(database: DatabaseSync, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get();
  const value = row?.[pragma];
  if (typeof value !== "number") {
    throw new StorageError("MIGRATION_INVALID", `PRAGMA ${pragma} was not numeric`);
  }
  return value;
}

function isBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const sqliteError = error as Error & { errcode?: number };
  return sqliteError.errcode === 5 || /database is (?:locked|busy)/i.test(error.message);
}

function pause(milliseconds: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

const initialSchemaSql = `
  CREATE TABLE projects (
    project_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE project_members (
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    owner TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role = 'member'),
    granted_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    PRIMARY KEY(project_id, owner)
  ) STRICT;

  CREATE INDEX project_members_owner_active_idx
    ON project_members(owner)
    WHERE revoked_at IS NULL;

  CREATE TABLE project_shares (
    share_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE repositories (
    repository_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    path TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT
  ) STRICT;

  CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    priority TEXT NOT NULL,
    checkpoint_json TEXT CHECK (
      checkpoint_json IS NULL OR json_valid(checkpoint_json)
    ),
    version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (status IN (
      'backlog', 'in_progress', 'waiting_human', 'blocked', 'paused',
      'verifying', 'pending_acceptance', 'done', 'cancelled'
    )),
    CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
    CHECK (version >= 0)
  ) STRICT;

  CREATE TABLE task_scopes (
    task_scope_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    scope_type TEXT NOT NULL,
    scope_value TEXT NOT NULL,
    UNIQUE(task_id, scope_type, scope_value)
  ) STRICT;

  CREATE TABLE task_session_links (
    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    linked_at TEXT NOT NULL,
    PRIMARY KEY(task_id, session_id)
  ) STRICT;

  CREATE TABLE active_task_leases (
    task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL UNIQUE REFERENCES sessions(session_id) ON DELETE CASCADE,
    acquired_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE checkpoints (
    checkpoint_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE repo_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    checkpoint_id TEXT REFERENCES checkpoints(checkpoint_id) ON DELETE SET NULL,
    repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
    repository_path TEXT NOT NULL,
    head_commit TEXT NOT NULL,
    captured_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE task_events (
    event_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE human_decisions (
    decision_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    question TEXT NOT NULL,
    decision TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    decided_at TEXT
  ) STRICT;

  CREATE TABLE task_dependencies (
    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    depends_on_task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    policy TEXT NOT NULL DEFAULT 'acceptance_gate',
    ctx_id TEXT,
    generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
    PRIMARY KEY(task_id, depends_on_task_id),
    CHECK (task_id <> depends_on_task_id)
  ) STRICT;

  CREATE TABLE dependency_contexts (
    ctx_id TEXT PRIMARY KEY,
    upstream_task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    upstream_repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
    downstream_task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    downstream_repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
    policy TEXT NOT NULL CHECK (policy IN ('informational','validation_gate','acceptance_gate','hard_block')),
    generation INTEGER NOT NULL CHECK (generation > 0),
    status TEXT NOT NULL CHECK (status IN ('active','cancelled','superseded','closed')),
    current_cycle INTEGER NOT NULL DEFAULT 0 CHECK (current_cycle >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(upstream_task_id, downstream_task_id, generation)
  ) STRICT;
  CREATE INDEX dependency_contexts_upstream_idx ON dependency_contexts(upstream_task_id, status);
  CREATE INDEX dependency_contexts_downstream_idx ON dependency_contexts(downstream_task_id, status);

  CREATE TABLE dependency_context_events (
    event_id TEXT PRIMARY KEY,
    ctx_id TEXT NOT NULL REFERENCES dependency_contexts(ctx_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL,
    UNIQUE(ctx_id, sequence)
  ) STRICT;
  CREATE INDEX dependency_context_events_ctx_idx ON dependency_context_events(ctx_id, sequence);

  CREATE TABLE operation_results (
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    created_at TEXT NOT NULL,
    UNIQUE(session_id, operation_id)
  ) STRICT;

  CREATE TABLE legacy_task_imports (
    legacy_import_key TEXT NOT NULL UNIQUE,
    source_session_label TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
    worktree_path TEXT NOT NULL,
    normalized_title TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX tasks_repository_status_idx
    ON tasks(repository_id, status, updated_at DESC);
  CREATE INDEX checkpoints_task_created_idx
    ON checkpoints(task_id, created_at DESC);
  CREATE INDEX task_events_task_created_idx
    ON task_events(task_id, created_at);
`;

const sessionExtensionSql = `
  ALTER TABLE sessions ADD COLUMN transport_session_id TEXT;
  ALTER TABLE sessions ADD COLUMN client_name TEXT;
  ALTER TABLE sessions ADD COLUMN client_version TEXT;
  ALTER TABLE sessions ADD COLUMN client_family TEXT;
  ALTER TABLE sessions ADD COLUMN protocol_version TEXT;
  ALTER TABLE sessions ADD COLUMN capabilities_json TEXT CHECK (
    capabilities_json IS NULL OR json_valid(capabilities_json)
  );
  ALTER TABLE sessions ADD COLUMN workspace_path TEXT;
  ALTER TABLE sessions ADD COLUMN worktree_path TEXT;
  ALTER TABLE sessions ADD COLUMN last_activity_at TEXT;
  ALTER TABLE sessions ADD COLUMN stale_at TEXT;
  CREATE UNIQUE INDEX sessions_transport_session_id_idx
    ON sessions(transport_session_id)
    WHERE transport_session_id IS NOT NULL;
  CREATE INDEX sessions_last_activity_idx
    ON sessions(last_activity_at);
`;

const taskGoalExtensionSql = `
  ALTER TABLE tasks ADD COLUMN goal TEXT;
  ALTER TABLE tasks ADD COLUMN acceptance_criteria_json TEXT CHECK (
    acceptance_criteria_json IS NULL OR json_valid(acceptance_criteria_json)
  );
`;

const taskDependencyPolicyExtensionSql = `
  ALTER TABLE task_dependencies ADD COLUMN policy TEXT NOT NULL DEFAULT 'acceptance_gate';
`;

const dependencyContextSql = `
  CREATE TABLE IF NOT EXISTS dependency_contexts (
    ctx_id TEXT PRIMARY KEY,
    upstream_task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    upstream_repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
    downstream_task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    downstream_repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
    policy TEXT NOT NULL CHECK (policy IN ('informational','validation_gate','acceptance_gate','hard_block')),
    generation INTEGER NOT NULL CHECK (generation > 0),
    status TEXT NOT NULL CHECK (status IN ('active','cancelled','superseded','closed')),
    current_cycle INTEGER NOT NULL DEFAULT 0 CHECK (current_cycle >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(upstream_task_id, downstream_task_id, generation)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS dependency_contexts_upstream_idx ON dependency_contexts(upstream_task_id, status);
  CREATE INDEX IF NOT EXISTS dependency_contexts_downstream_idx ON dependency_contexts(downstream_task_id, status);
  CREATE TABLE IF NOT EXISTS dependency_context_events (
    event_id TEXT PRIMARY KEY,
    ctx_id TEXT NOT NULL REFERENCES dependency_contexts(ctx_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL,
    UNIQUE(ctx_id, sequence)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS dependency_context_events_ctx_idx ON dependency_context_events(ctx_id, sequence);
`;

const taskMemoryAndRepairLoopSql = `
  CREATE TABLE IF NOT EXISTS dependency_repair_requests (
    repair_id TEXT PRIMARY KEY,
    validation_id TEXT NOT NULL UNIQUE
      REFERENCES dependency_validations(validation_id) ON DELETE CASCADE,
    source_run_id TEXT NOT NULL
      REFERENCES dependency_validation_runs(run_id) ON DELETE CASCADE,
    ctx_id TEXT,
    upstream_task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    downstream_task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    cycle INTEGER NOT NULL CHECK (cycle > 0),
    status TEXT NOT NULL CHECK (
      status IN ('pending','claimed','resolved','superseded','cancelled')
    ),
    rejection_reason TEXT NOT NULL CHECK (length(trim(rejection_reason)) > 0),
    claimed_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    claimed_worktree_path TEXT,
    claimed_at TEXT,
    resolved_at TEXT,
    superseded_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS dependency_repair_requests_upstream_idx
    ON dependency_repair_requests(upstream_task_id, status, cycle DESC);
  CREATE INDEX IF NOT EXISTS dependency_repair_requests_downstream_idx
    ON dependency_repair_requests(downstream_task_id, status);
`;

const snapshotConflictSql = `
  ALTER TABLE repo_snapshots ADD COLUMN worktree_path TEXT;
  ALTER TABLE repo_snapshots ADD COLUMN branch TEXT;
  ALTER TABLE repo_snapshots ADD COLUMN changed_files_json TEXT CHECK (
    changed_files_json IS NULL OR json_valid(changed_files_json)
  );
  CREATE INDEX repo_snapshots_task_captured_idx
    ON repo_snapshots(task_id, captured_at DESC);
`;

const ownerNotificationSql = `
  ALTER TABLE sessions ADD COLUMN owner TEXT;
  ALTER TABLE tasks ADD COLUMN owner TEXT;
  CREATE INDEX tasks_owner_idx ON tasks(owner);

  CREATE TABLE notifications (
    notification_id TEXT PRIMARY KEY,
    owner TEXT,
    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    upstream_task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    upstream_title TEXT NOT NULL,
    upstream_status TEXT NOT NULL CHECK (upstream_status IN ('done', 'cancelled')),
    read_at TEXT,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX notifications_owner_idx ON notifications(owner, read_at);
`;

const boardAuthSql = `
  CREATE TABLE board_pairing_challenges (
    challenge_id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    browser_secret_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    approved_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    approved_owner TEXT,
    approved_at TEXT,
    consumed_at TEXT,
    CHECK ((approved_at IS NULL) = (approved_owner IS NULL)),
    CHECK ((approved_at IS NULL) = (approved_session_id IS NULL))
  ) STRICT;
  CREATE INDEX board_pairing_expires_idx
    ON board_pairing_challenges(expires_at);

  CREATE TABLE board_sessions (
    board_session_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    owner TEXT NOT NULL,
    source_session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    revoked_at TEXT
  ) STRICT;
  CREATE INDEX board_sessions_token_idx ON board_sessions(token_hash);
  CREATE INDEX board_sessions_owner_idx ON board_sessions(owner, expires_at);
`;

const sessionContextEventSql = `
  CREATE TABLE session_events (
    event_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX session_events_session_created_idx
    ON session_events(session_id, created_at, event_id);
`;

const dependencyValidationSql = `
  CREATE TABLE dependency_validations (
    ctx_id TEXT,
    validation_id TEXT PRIMARY KEY,
    upstream_task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    downstream_task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    cycle INTEGER NOT NULL CHECK (cycle > 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'passed', 'rejected', 'superseded')),
    requested_by_actor TEXT NOT NULL CHECK (requested_by_actor IN ('agent', 'human')),
    requested_by_owner TEXT,
    requested_at TEXT NOT NULL,
    request_read_at TEXT,
    responded_by_owner TEXT,
    response_reason TEXT,
    responded_at TEXT,
    response_read_at TEXT,
    validation_spec_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(validation_spec_json)),
    UNIQUE(upstream_task_id, downstream_task_id, cycle),
    CHECK (upstream_task_id <> downstream_task_id),
    CHECK (
      (status IN ('pending', 'superseded')
        AND responded_by_owner IS NULL AND responded_at IS NULL)
      OR (status IN ('passed', 'rejected')
        AND responded_by_owner IS NOT NULL AND responded_at IS NOT NULL)
    ),
    CHECK (
      status <> 'rejected'
      OR (response_reason IS NOT NULL AND length(trim(response_reason)) > 0)
    )
  ) STRICT;
  CREATE INDEX dependency_validations_upstream_cycle_idx
    ON dependency_validations(upstream_task_id, cycle DESC);
  CREATE INDEX dependency_validations_downstream_status_idx
    ON dependency_validations(downstream_task_id, status, request_read_at);
`;

const dependencyValidationRunsSql = `
  CREATE TABLE IF NOT EXISTS dependency_validation_runs (
    run_id TEXT PRIMARY KEY,
    validation_id TEXT NOT NULL REFERENCES dependency_validations(validation_id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL CHECK (attempt > 0),
    status TEXT NOT NULL CHECK (status IN ('queued','claimed','running','passed','rejected','error','cancelled')),
    owner TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    worktree_path TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    verification_json TEXT NOT NULL CHECK (json_valid(verification_json)),
    progress_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress_json)),
    failure_reason TEXT,
    error_reason TEXT,
    operation_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(validation_id, attempt)
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS dependency_validation_runs_active_idx
    ON dependency_validation_runs(validation_id)
    WHERE status IN ('queued','claimed','running');
`;

const projectCollaborationSql = `
  CREATE TABLE IF NOT EXISTS project_members (
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    owner TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role = 'member'),
    granted_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    PRIMARY KEY(project_id, owner)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS project_members_owner_active_idx
    ON project_members(owner)
    WHERE revoked_at IS NULL;
  CREATE TABLE IF NOT EXISTS project_shares (
    share_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  ) STRICT;
`;

const hostVerifiedEvidenceSql = `
  CREATE TABLE IF NOT EXISTS host_keys (
    host_key_id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    label TEXT NOT NULL,
    public_key_b64 TEXT NOT NULL UNIQUE,
    client_family TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
    rotated_to TEXT REFERENCES host_keys(host_key_id),
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    last_used_at TEXT,
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
  ) STRICT;
  CREATE INDEX IF NOT EXISTS host_keys_owner_active_idx
    ON host_keys(owner)
    WHERE status = 'active';

  CREATE TABLE IF NOT EXISTS host_evidence_challenges (
    challenge_id TEXT PRIMARY KEY,
    nonce_b64 TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('checkpoint','submit')),
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(task_id) ON DELETE CASCADE,
    lease_generation INTEGER,
    expected_worktree_path TEXT NOT NULL,
    host_key_id TEXT REFERENCES host_keys(host_key_id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS host_evidence_challenges_expires_idx
    ON host_evidence_challenges(expires_at);

  CREATE TABLE IF NOT EXISTS host_evidence (
    evidence_id TEXT PRIMARY KEY,
    host_key_id TEXT NOT NULL REFERENCES host_keys(host_key_id),
    challenge_id TEXT NOT NULL UNIQUE REFERENCES host_evidence_challenges(challenge_id),
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(task_id) ON DELETE SET NULL,
    repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
    worktree_path TEXT NOT NULL,
    head_commit TEXT NOT NULL,
    branch TEXT,
    changed_files_json TEXT NOT NULL CHECK (json_valid(changed_files_json)),
    content_digest TEXT NOT NULL,
    signature_b64 TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    captured_at TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS host_evidence_lookup_idx
    ON host_evidence(repository_id, worktree_path, expires_at);
`;

const migrations: readonly Migration[] = Object.freeze([
  Object.freeze({
    version: migrationMetadata[0]!.version,
    name: migrationMetadata[0]!.name,
    up: (database: DatabaseSync) => {
      database.exec(initialSchemaSql);
    }
  }),
  Object.freeze({
    version: migrationMetadata[1]!.version,
    name: migrationMetadata[1]!.name,
    up: (database: DatabaseSync) => {
      database.exec(sessionExtensionSql);
    }
  }),
  Object.freeze({
    version: migrationMetadata[2]!.version,
    name: migrationMetadata[2]!.name,
    up: (database: DatabaseSync) => {
      database.exec(taskGoalExtensionSql);
    }
  }),
  Object.freeze({
    version: migrationMetadata[3]!.version,
    name: migrationMetadata[3]!.name,
    up: (database: DatabaseSync) => {
      database.exec(snapshotConflictSql);
    }
  }),
  Object.freeze({
    version: migrationMetadata[4]!.version,
    name: migrationMetadata[4]!.name,
    up: (database: DatabaseSync) => {
      database.exec(ownerNotificationSql);
    }
  }),
  Object.freeze({
    version: migrationMetadata[5]!.version,
    name: migrationMetadata[5]!.name,
    up: (database: DatabaseSync) => {
      database.exec(boardAuthSql);
    }
  }),
  Object.freeze({
    version: migrationMetadata[6]!.version,
    name: migrationMetadata[6]!.name,
    up: (database: DatabaseSync) => {
      database.exec(sessionContextEventSql);
    }
  }),
  Object.freeze({
    version: migrationMetadata[7]!.version,
    name: migrationMetadata[7]!.name,
    up: (database: DatabaseSync) => {
      database.exec(dependencyValidationSql);
    }
  }),
  Object.freeze({
    version: migrationMetadata[8]!.version,
    name: migrationMetadata[8]!.name,
    up: (database: DatabaseSync) => {
      const columns = database.prepare("PRAGMA table_info(dependency_validations)").all()
        .map((row) => String(row.name));
      if (!columns.includes("validation_spec_json")) {
        database.exec("ALTER TABLE dependency_validations ADD COLUMN validation_spec_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(validation_spec_json))");
      }
      database.exec(dependencyValidationRunsSql);
      const runColumns = database.prepare("PRAGMA table_info(dependency_validation_runs)").all()
        .map((row) => String(row.name));
      if (!runColumns.includes("progress_json")) {
        database.exec("ALTER TABLE dependency_validation_runs ADD COLUMN progress_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress_json))");
      }
    }
  }),
  Object.freeze({
    version: migrationMetadata[9]!.version,
    name: migrationMetadata[9]!.name,
    up: (database: DatabaseSync) => {
      const columns = database.prepare("PRAGMA table_info(projects)").all()
        .map((row) => String(row.name));
      if (!columns.includes("created_by")) {
        database.exec("ALTER TABLE projects ADD COLUMN created_by TEXT");
      }
    }
  }),
  Object.freeze({
    version: migrationMetadata[10]!.version,
    name: migrationMetadata[10]!.name,
    up: (database: DatabaseSync) => {
      database.exec(projectCollaborationSql);
    }
  }),
  Object.freeze({
    version: migrationMetadata[11]!.version,
    name: migrationMetadata[11]!.name,
    up: (database: DatabaseSync) => {
      const sessionColumns = database.prepare("PRAGMA table_info(sessions)").all()
        .map((row) => String(row.name));
      if (!sessionColumns.includes("successor_session_id")) {
        database.exec("ALTER TABLE sessions ADD COLUMN successor_session_id TEXT");
      }
      if (!sessionColumns.includes("successor_ctx_id")) {
        database.exec("ALTER TABLE sessions ADD COLUMN successor_ctx_id TEXT");
      }
      const dependencyColumns = database.prepare("PRAGMA table_info(task_dependencies)").all()
        .map((row) => String(row.name));
      if (!dependencyColumns.includes("policy")) {
        database.exec(taskDependencyPolicyExtensionSql);
      }
      if (!dependencyColumns.includes("ctx_id")) {
        database.exec("ALTER TABLE task_dependencies ADD COLUMN ctx_id TEXT");
      }
      if (!dependencyColumns.includes("generation")) {
        database.exec("ALTER TABLE task_dependencies ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0)");
      }
      const validationColumns = database.prepare("PRAGMA table_info(dependency_validations)").all()
        .map((row) => String(row.name));
      if (!validationColumns.includes("ctx_id")) {
        database.exec("ALTER TABLE dependency_validations ADD COLUMN ctx_id TEXT");
      }
      database.exec(dependencyContextSql);
      const legacyEdges = database.prepare(`
        SELECT dependency.task_id, dependency.depends_on_task_id,
          dependency.created_at, dependency.policy, dependency.generation,
          upstream.repository_id AS upstream_repository_id,
          downstream.repository_id AS downstream_repository_id
        FROM task_dependencies dependency
        JOIN tasks upstream ON upstream.task_id = dependency.depends_on_task_id
        JOIN tasks downstream ON downstream.task_id = dependency.task_id
        WHERE dependency.ctx_id IS NULL
      `).all();
      const updateEdge = database.prepare(`
        UPDATE task_dependencies SET ctx_id = ?
        WHERE task_id = ? AND depends_on_task_id = ?
      `);
      const insertContext = database.prepare(`
        INSERT OR IGNORE INTO dependency_contexts(
          ctx_id, upstream_task_id, upstream_repository_id,
          downstream_task_id, downstream_repository_id, policy,
          generation, status, current_cycle, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)
      `);
      const insertContextEvent = database.prepare(`
        INSERT OR IGNORE INTO dependency_context_events(
          event_id, ctx_id, sequence, event_type, payload_json, created_at
        ) VALUES (?, ?, 1, 'dependency_bound', ?, ?)
      `);
      for (const edge of legacyEdges) {
        const generation = Number(edge.generation ?? 1);
        const ctxId = `${String(edge.upstream_repository_id)}:${String(edge.depends_on_task_id)}:${String(edge.downstream_repository_id)}:${String(edge.task_id)}:${generation}`;
        const createdAt = String(edge.created_at);
        const policy = String(edge.policy ?? 'acceptance_gate');
        insertContext.run(
          ctxId,
          String(edge.depends_on_task_id),
          String(edge.upstream_repository_id),
          String(edge.task_id),
          String(edge.downstream_repository_id),
          policy,
          generation,
          createdAt,
          createdAt
        );
        insertContextEvent.run(
          randomUUID(),
          ctxId,
          JSON.stringify({
            ctx_id: ctxId,
            upstream_task_id: String(edge.depends_on_task_id),
            downstream_task_id: String(edge.task_id),
            upstream_repository_id: String(edge.upstream_repository_id),
            downstream_repository_id: String(edge.downstream_repository_id),
            policy,
            generation,
            cycle: 0
          }),
          createdAt
        );
        updateEdge.run(ctxId, String(edge.task_id), String(edge.depends_on_task_id));
      }
      database.exec(`
        UPDATE dependency_validations
        SET ctx_id = (
          SELECT dependency.ctx_id
          FROM task_dependencies dependency
          WHERE dependency.task_id = dependency_validations.downstream_task_id
            AND dependency.depends_on_task_id = dependency_validations.upstream_task_id
        )
        WHERE ctx_id IS NULL
      `);
    }
  }),
  Object.freeze({
    version: migrationMetadata[12]!.version,
    name: migrationMetadata[12]!.name,
    up: (database: DatabaseSync) => {
      const legacySuccessions = database.prepare(`
        SELECT session_id AS successor_session_id,
          successor_session_id AS predecessor_session_id,
          successor_ctx_id
        FROM sessions
        WHERE successor_session_id IS NOT NULL
      `).all();
      const predecessorIds = new Set<string>();
      for (const link of legacySuccessions) {
        const predecessorId = String(link.predecessor_session_id);
        const successorId = String(link.successor_session_id);
        if (predecessorId === successorId || predecessorIds.has(predecessorId)) {
          throw new StorageError(
            "MIGRATION_INVALID",
            `Schema 12 contains an ambiguous session succession for ${predecessorId}`
          );
        }
        predecessorIds.add(predecessorId);
      }
      if (legacySuccessions.length > 0) {
        database.exec(`
          CREATE TEMP TABLE legacy_session_successions_v13(
            predecessor_session_id TEXT PRIMARY KEY,
            successor_session_id TEXT NOT NULL,
            successor_ctx_id TEXT
          );
          INSERT INTO legacy_session_successions_v13(
            predecessor_session_id, successor_session_id, successor_ctx_id
          )
          SELECT successor_session_id, session_id, successor_ctx_id
          FROM sessions
          WHERE successor_session_id IS NOT NULL;
          UPDATE sessions
          SET successor_session_id = NULL, successor_ctx_id = NULL
          WHERE successor_session_id IS NOT NULL;
          UPDATE sessions
          SET successor_session_id = (
              SELECT legacy.successor_session_id
              FROM legacy_session_successions_v13 legacy
              WHERE legacy.predecessor_session_id = sessions.session_id
            ),
            successor_ctx_id = (
              SELECT legacy.successor_ctx_id
              FROM legacy_session_successions_v13 legacy
              WHERE legacy.predecessor_session_id = sessions.session_id
            )
          WHERE session_id IN (
            SELECT predecessor_session_id FROM legacy_session_successions_v13
          );
          DROP TABLE legacy_session_successions_v13;
        `);
      }
      const leaseColumns = database.prepare("PRAGMA table_info(active_task_leases)").all()
        .map((row) => String(row.name));
      if (!leaseColumns.includes("generation")) {
        database.exec("ALTER TABLE active_task_leases ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0)");
      }
      const snapshotColumns = database.prepare("PRAGMA table_info(repo_snapshots)").all()
        .map((row) => String(row.name));
      if (!snapshotColumns.includes("content_digest")) {
        database.exec("ALTER TABLE repo_snapshots ADD COLUMN content_digest TEXT");
      }
      const operationColumns = database.prepare("PRAGMA table_info(operation_results)").all()
        .map((row) => String(row.name));
      if (!operationColumns.includes("tool_name")) {
        database.exec("ALTER TABLE operation_results ADD COLUMN tool_name TEXT");
      }
      if (!operationColumns.includes("request_hash")) {
        database.exec("ALTER TABLE operation_results ADD COLUMN request_hash TEXT");
      }
      database.exec(taskMemoryAndRepairLoopSql);
    }
  }),
  Object.freeze({
    version: migrationMetadata[13]!.version,
    name: migrationMetadata[13]!.name,
    up: (database: DatabaseSync) => {
      database.exec(hostVerifiedEvidenceSql);
      const snapshotColumns = database.prepare("PRAGMA table_info(repo_snapshots)").all()
        .map((row) => String(row.name));
      if (!snapshotColumns.includes("provenance")) {
        database.exec("ALTER TABLE repo_snapshots ADD COLUMN provenance TEXT NOT NULL DEFAULT 'server_verified' CHECK (provenance IN ('server_verified','host_verified'))");
      }
      if (!snapshotColumns.includes("host_evidence_id")) {
        database.exec("ALTER TABLE repo_snapshots ADD COLUMN host_evidence_id TEXT REFERENCES host_evidence(evidence_id)");
      }
    }
  }),
  Object.freeze({
    version: migrationMetadata[14]!.version,
    name: migrationMetadata[14]!.name,
    up: (database: DatabaseSync) => {
      const sessionColumnNames = database.prepare("PRAGMA table_info(sessions)").all()
        .map((row) => String(row.name));
      if (!sessionColumnNames.includes("resume_token_hash")) {
        database.exec("ALTER TABLE sessions ADD COLUMN resume_token_hash TEXT");
      }
    }
  }),
  Object.freeze({
    version: migrationMetadata[15]!.version,
    name: migrationMetadata[15]!.name,
    up: (database: DatabaseSync) => {
      const projectColumns = database.prepare("PRAGMA table_info(projects)").all()
        .map((row) => String(row.name));
      if (!projectColumns.includes("archived_at")) {
        database.exec("ALTER TABLE projects ADD COLUMN archived_at TEXT");
      }
      if (!projectColumns.includes("archived_by")) {
        database.exec("ALTER TABLE projects ADD COLUMN archived_by TEXT");
      }
    }
  })
]);

function orderedMigrations(): Migration[] {
  const ordered = [...migrations].sort((left, right) => (
    left.version - right.version
  ));
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index]?.version !== index + 1) {
      throw new StorageError(
        "MIGRATION_INVALID",
        "Migration versions must be unique and contiguous from version 1"
      );
    }
  }
  return ordered;
}

function backupDatabase(database: DatabaseSync, databasePath: string): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  // Pre-migration backups live under <dataDir>/backups as
  // task-progress-YYYYMMDD-HHmmss.sqlite; concurrent same-second migrations
  // append a numeric suffix instead of clobbering each other.
  const backupsDir = join(dirname(databasePath), "backups");
  mkdirSync(backupsDir, { recursive: true });
  const baseName = basename(databasePath, ".sqlite");
  for (let attempt = 1; ; attempt += 1) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const backupPath = join(backupsDir, `${baseName}-${timestamp}${suffix}.sqlite`);
    if (existsSync(backupPath)) {
      continue;
    }
    const quotedPath = backupPath.replaceAll("'", "''");
    try {
      database.exec(`VACUUM INTO '${quotedPath}'`);
      return backupPath;
    } catch (error) {
      // VACUUM INTO refuses to overwrite an existing target; a concurrent
      // migrator may have created it between the check and the write.
      if (!existsSync(backupPath) || attempt >= 100) {
        throw error;
      }
    }
  }
}

function applyPendingMigrations(
  database: DatabaseSync,
  availableMigrations: readonly Migration[]
): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const lockedVersion = readIntegerPragma(database, "user_version");
    const latestVersion = availableMigrations.at(-1)?.version ?? 0;
    if (lockedVersion > latestVersion) {
      throw new StorageError(
        "SCHEMA_VERSION_UNSUPPORTED",
        `Database schema version ${lockedVersion} is newer than supported version ${latestVersion}`
      );
    }
    for (const migration of availableMigrations) {
      if (migration.version > lockedVersion) {
        migration.up(database);
        database.exec(`PRAGMA user_version = ${migration.version}`);
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function readProjectRecord(database: DatabaseSync, projectId: string): ProjectRecord | undefined {
  const row = optionalRow(database.prepare(`
    SELECT project_id, name, created_by, archived_at, archived_by, created_at, updated_at
    FROM projects
    WHERE project_id = ?
  `).get(projectId));
  if (row === undefined) {
    return undefined;
  }
  const parsed = projectRecordSchema.parse(row);
  return {
    ...parsed,
    created_by: parsed.created_by ?? null,
    archived_at: parsed.archived_at ?? null,
    archived_by: parsed.archived_by ?? null
  };
}

const databaseCapability = Object.freeze({});
const storeCapability = Object.freeze({});

export class SqliteDatabase {
  readonly path: string;
  readonly #database: DatabaseSync;
  readonly #sqliteBusyTimeoutMs: number;
  #closed = false;

  private constructor(
    capability: object,
    path: string,
    database: DatabaseSync,
    sqliteBusyTimeoutMs: number
  ) {
    if (capability !== databaseCapability) {
      throw new StorageError(
        "DATABASE_CAPABILITY_REQUIRED",
        "SQLite databases can only be created by SqliteDatabase.open"
      );
    }
    this.path = path;
    this.#database = database;
    this.#sqliteBusyTimeoutMs = sqliteBusyTimeoutMs;
  }

  static open(config: RuntimeConfig): SqliteDatabase {
    mkdirSync(config.dataDir, { recursive: true });
    const existedBeforeOpen = existsSync(config.databasePath);
    const database = new NativeDatabaseSync(config.databasePath);

    try {
      database.exec("PRAGMA foreign_keys = ON");
      database.exec("PRAGMA journal_mode = WAL");
      database.exec(`PRAGMA busy_timeout = ${config.sqliteBusyTimeoutMs}`);

      const availableMigrations = orderedMigrations();
      const latestVersion = availableMigrations.at(-1)?.version ?? 0;
      const currentVersion = readIntegerPragma(database, "user_version");
      if (currentVersion > latestVersion) {
        throw new StorageError(
          "SCHEMA_VERSION_UNSUPPORTED",
          `Database schema version ${currentVersion} is newer than supported version ${latestVersion}`
        );
      }

      if (existedBeforeOpen && currentVersion < latestVersion) {
        backupDatabase(database, config.databasePath);
      }
      if (currentVersion < latestVersion) {
        applyPendingMigrations(database, availableMigrations);
      }

      const integrity = database.prepare("PRAGMA integrity_check").get();
      if (integrity?.integrity_check !== "ok") {
        throw new StorageError(
          "DATABASE_INTEGRITY_FAILED",
          `SQLite integrity check failed: ${String(integrity?.integrity_check)}`
        );
      }
      return new SqliteDatabase(
        databaseCapability,
        config.databasePath,
        database,
        config.sqliteBusyTimeoutMs
      );
    } catch (error) {
      database.close();
      throw error;
    }
  }

  createProgressStore(): PlatformStore {
    return new SqliteProgressStore(
      storeCapability,
      this.#database,
      <T>(work: () => T) => this.#runTransaction(work)
    );
  }

  getDiagnostics(): DatabaseDiagnostics {
    const busyTimeout = this.#database.prepare("PRAGMA busy_timeout").get()?.timeout;
    const foreignKeys = readIntegerPragma(this.#database, "foreign_keys");
    const journalMode = this.#database.prepare("PRAGMA journal_mode").get()?.journal_mode;
    const integrityCheck = this.#database.prepare("PRAGMA integrity_check").get()
      ?.integrity_check;
    return {
      busyTimeoutMs: Number(busyTimeout),
      foreignKeys: foreignKeys === 1,
      integrityCheck: String(integrityCheck),
      journalMode: String(journalMode),
      schemaVersion: readIntegerPragma(this.#database, "user_version")
    };
  }

  #runTransaction<T>(work: () => T): T {
    const maximumAttempts = 3;
    const retryBusyTimeoutMs = Math.min(100, this.#sqliteBusyTimeoutMs);
    this.#database.exec(`PRAGMA busy_timeout = ${retryBusyTimeoutMs}`);
    try {
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        try {
          this.#database.exec("BEGIN IMMEDIATE");
        } catch (error) {
          if (!isBusyError(error) || attempt === maximumAttempts) {
            if (isBusyError(error)) {
              throw new StorageError(
                "STORAGE_BUSY",
                `SQLite remained busy after ${maximumAttempts} attempts`,
                { cause: error }
              );
            }
            throw error;
          }
          pause(10 * (2 ** (attempt - 1)));
          continue;
        }

        try {
          const result = work();
          this.#database.exec("COMMIT");
          return result;
        } catch (error) {
          this.#database.exec("ROLLBACK");
          throw error;
        }
      }
      throw new StorageError("STORAGE_BUSY", "SQLite transaction retry loop exhausted");
    } finally {
      this.#database.exec(`PRAGMA busy_timeout = ${this.#sqliteBusyTimeoutMs}`);
    }
  }

  close(): void {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }
}

const transactionCapability = Object.freeze({});

interface TransactionState {
  active: boolean;
}

function createProgressTransaction(database: DatabaseSync): {
  deactivate: () => void;
  transaction: SqliteProgressTransaction;
} {
  const state: TransactionState = { active: true };
  const transaction = new SqliteProgressTransaction(
    transactionCapability,
    database,
    state
  );
  return {
    deactivate: () => {
      state.active = false;
    },
    transaction
  };
}

class SqliteProgressTransaction implements ProgressTransaction {
  readonly #database: DatabaseSync;
  readonly #state: TransactionState;

  constructor(
    capability: object,
    database: DatabaseSync,
    state: TransactionState
  ) {
    if (capability !== transactionCapability) {
      throw new StorageError(
        "TRANSACTION_CAPABILITY_REQUIRED",
        "Progress transactions can only be created by the active store transaction"
      );
    }
    this.#database = database;
    this.#state = state;
  }

  #assertActive(): void {
    if (!this.#state.active) {
      throw new StorageError(
        "TRANSACTION_INACTIVE",
        "Progress transaction is no longer active"
      );
    }
  }

  getTask(taskId: string): TaskRecord | undefined {
    this.#assertActive();
    const row = optionalRow(this.#database.prepare(`
      SELECT task_id, repository_id, session_id, title, status, priority,
        checkpoint_json, goal, acceptance_criteria_json, owner, created_at, updated_at
      FROM tasks
      WHERE task_id = ?
    `).get(taskId));
    return row === undefined ? undefined : taskFromRow(row);
  }

  getTaskVersion(taskId: string): number | undefined {
    this.#assertActive();
    const row = optionalRow(this.#database.prepare(
      "SELECT version FROM tasks WHERE task_id = ?"
    ).get(taskId));
    return row === undefined ? undefined : Number(row.version);
  }

  getProject(projectId: string): ProjectRecord | undefined {
    this.#assertActive();
    return readProjectRecord(this.#database, projectId);
  }

  archiveProject(
    projectId: string,
    archivedBy: string,
    archivedAt: string
  ): ArchiveProjectOutcome {
    this.#assertActive();
    const existing = readProjectRecord(this.#database, projectId);
    if (existing === undefined) {
      return { status: "not_found" };
    }
    if (existing.archived_at !== null) {
      return { status: "archived", changed: false, project: existing };
    }
    // The open-task check and the archive write share this BEGIN IMMEDIATE
    // transaction, so no task can be created between them.
    const openTasks: ProjectOpenTask[] = this.#database.prepare(`
      SELECT tasks.task_id AS task_id, tasks.owner AS owner,
        tasks.status AS status, tasks.repository_id AS repository_id
      FROM tasks
      JOIN repositories ON repositories.repository_id = tasks.repository_id
      WHERE repositories.project_id = ?
        AND tasks.status NOT IN ('done', 'cancelled')
      ORDER BY tasks.status, tasks.task_id
    `).all(projectId).map((row) => ({
      task_id: String(row.task_id),
      owner: row.owner === null ? null : String(row.owner),
      status: taskStatusSchema.parse(row.status),
      repository_id: String(row.repository_id)
    }));
    if (openTasks.length > 0) {
      return { status: "open_tasks", open_tasks: openTasks };
    }
    this.#database.prepare(`
      UPDATE projects
      SET archived_at = ?, archived_by = ?, updated_at = ?
      WHERE project_id = ? AND archived_at IS NULL
    `).run(archivedAt, archivedBy, archivedAt, projectId);
    return {
      status: "archived",
      changed: true,
      project: readProjectRecord(this.#database, projectId)!
    };
  }

  unarchiveProject(projectId: string, updatedAt: string): UnarchiveProjectOutcome {
    this.#assertActive();
    const existing = readProjectRecord(this.#database, projectId);
    if (existing === undefined) {
      return { status: "not_found" };
    }
    if (existing.archived_at === null) {
      return { status: "unarchived", changed: false, project: existing };
    }
    this.#database.prepare(`
      UPDATE projects
      SET archived_at = NULL, archived_by = NULL, updated_at = ?
      WHERE project_id = ?
    `).run(updatedAt, projectId);
    return {
      status: "unarchived",
      changed: true,
      project: readProjectRecord(this.#database, projectId)!
    };
  }

  insertTask(task: TaskRecord): void {
    this.#assertActive();
    const parsed = taskRecordSchema.parse(task);
    const checkpointJson = parsed.checkpoint === undefined
      ? null
      : JSON.stringify(checkpointPayloadSchema.parse(parsed.checkpoint));
    const acceptanceCriteriaJson = parsed.acceptance_criteria === undefined
      ? null
      : JSON.stringify(parsed.acceptance_criteria);
    this.#database.prepare(`
      INSERT INTO tasks(
        task_id, repository_id, session_id, title, status, priority,
        goal, acceptance_criteria_json, checkpoint_json, owner, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parsed.task_id,
      parsed.repository_id,
      parsed.session_id ?? null,
      parsed.title,
      parsed.status,
      parsed.priority,
      parsed.goal ?? null,
      acceptanceCriteriaJson,
      checkpointJson,
      parsed.owner ?? null,
      parsed.created_at,
      parsed.updated_at
    );
  }

  updateTask(task: TaskRecord, expectedVersion: number): void {
    this.#assertActive();
    const parsed = taskRecordSchema.parse(task);
    const existing = optionalRow(this.#database.prepare(
      "SELECT updated_at FROM tasks WHERE task_id = ?"
    ).get(parsed.task_id));
    const existingUpdatedAt = existing?.updated_at === undefined
      ? undefined
      : String(existing.updated_at);
    const persistedUpdatedAt = existingUpdatedAt !== undefined
      && Date.parse(existingUpdatedAt) > Date.parse(parsed.updated_at)
      ? existingUpdatedAt
      : parsed.updated_at;
    const checkpointJson = parsed.checkpoint === undefined
      ? null
      : JSON.stringify(checkpointPayloadSchema.parse(parsed.checkpoint));
    const acceptanceCriteriaJson = parsed.acceptance_criteria === undefined
      ? null
      : JSON.stringify(parsed.acceptance_criteria);
    const result = this.#database.prepare(`
      UPDATE tasks
      SET repository_id = ?, session_id = ?, title = ?, status = ?, priority = ?,
        goal = ?, acceptance_criteria_json = ?, checkpoint_json = ?, owner = ?,
        updated_at = ?, version = version + 1
      WHERE task_id = ? AND version = ?
    `).run(
      parsed.repository_id,
      parsed.session_id ?? null,
      parsed.title,
      parsed.status,
      parsed.priority,
      parsed.goal ?? null,
      acceptanceCriteriaJson,
      checkpointJson,
      parsed.owner ?? null,
      persistedUpdatedAt,
      parsed.task_id,
      expectedVersion
    );
    if (Number(result.changes) === 0) {
      throw new StorageError(
        "VERSION_CONFLICT",
        `Task ${parsed.task_id} is not at expected version ${expectedVersion}`
      );
    }
  }

  upsertProject(project: ProjectRecord): void {
    this.#assertActive();
    const parsed = projectRecordSchema.parse(project);
    this.#database.prepare(`
      INSERT INTO projects(project_id, name, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        name = excluded.name,
        updated_at = excluded.updated_at
    `).run(
      parsed.project_id,
      parsed.name,
      parsed.created_by ?? null,
      parsed.created_at,
      parsed.updated_at
    );
  }

  getProjectMember(projectId: string, owner: string): ProjectMemberRecord | undefined {
    this.#assertActive();
    const row = optionalRow(this.#database.prepare(`
      SELECT project_id, owner, role, granted_by, created_at, revoked_at
      FROM project_members
      WHERE project_id = ? AND owner = ?
    `).get(projectId, owner));
    return row === undefined ? undefined : projectMemberSchema.parse(row);
  }

  listProjectMembers(projectId: string, includeRevoked = false): ProjectMemberRecord[] {
    this.#assertActive();
    const revokedClause = includeRevoked ? "" : "AND revoked_at IS NULL";
    return this.#database.prepare(`
      SELECT project_id, owner, role, granted_by, created_at, revoked_at
      FROM project_members
      WHERE project_id = ? ${revokedClause}
      ORDER BY created_at, owner
    `).all(projectId).map((row) => projectMemberSchema.parse(row));
  }

  upsertProjectMember(member: ProjectMemberRecord): void {
    this.#assertActive();
    const parsed = projectMemberSchema.parse(member);
    this.#database.prepare(`
      INSERT INTO project_members(
        project_id, owner, role, granted_by, created_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, owner) DO UPDATE SET
        role = excluded.role,
        granted_by = excluded.granted_by,
        created_at = excluded.created_at,
        revoked_at = excluded.revoked_at
    `).run(
      parsed.project_id,
      parsed.owner,
      parsed.role,
      parsed.granted_by,
      parsed.created_at,
      parsed.revoked_at
    );
  }

  revokeProjectMember(projectId: string, owner: string, revokedAt: string): boolean {
    this.#assertActive();
    const result = this.#database.prepare(`
      UPDATE project_members
      SET revoked_at = ?
      WHERE project_id = ? AND owner = ? AND revoked_at IS NULL
    `).run(revokedAt, projectId, owner);
    return Number(result.changes) === 1;
  }

  createProjectShare(share: ProjectShareRecord): void {
    this.#assertActive();
    const parsed = projectShareSchema.parse(share);
    this.#database.prepare(`
      INSERT INTO project_shares(
        share_id, project_id, token_hash, created_by, expires_at,
        consumed_at, revoked_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parsed.share_id,
      parsed.project_id,
      parsed.token_hash,
      parsed.created_by,
      parsed.expires_at,
      parsed.consumed_at,
      parsed.revoked_at,
      parsed.created_at
    );
  }

  getProjectShareByTokenHash(tokenHash: string): ProjectShareRecord | undefined {
    this.#assertActive();
    const row = optionalRow(this.#database.prepare(`
      SELECT share_id, project_id, token_hash, created_by, expires_at,
        consumed_at, revoked_at, created_at
      FROM project_shares
      WHERE token_hash = ?
    `).get(tokenHash));
    return row === undefined ? undefined : projectShareSchema.parse(row);
  }

  consumeProjectShare(shareId: string, tokenHash: string, consumedAt: string): boolean {
    this.#assertActive();
    const result = this.#database.prepare(`
      UPDATE project_shares
      SET consumed_at = ?
      WHERE share_id = ?
        AND token_hash = ?
        AND consumed_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > ?
    `).run(consumedAt, shareId, tokenHash, consumedAt);
    return Number(result.changes) === 1;
  }

  revokeProjectShare(shareId: string, projectId: string, revokedAt: string): boolean {
    this.#assertActive();
    const result = this.#database.prepare(`
      UPDATE project_shares
      SET revoked_at = ?
      WHERE share_id = ? AND project_id = ? AND revoked_at IS NULL
    `).run(revokedAt, shareId, projectId);
    return Number(result.changes) === 1;
  }

  upsertRepository(repository: RepositoryRecord): void {
    this.#assertActive();
    const parsed = repositoryRecordSchema.parse(repository);
    const pathOwner = optionalRow(this.#database.prepare(`
      SELECT repository_id
      FROM repositories
      WHERE path = ? AND repository_id <> ?
    `).get(parsed.path, parsed.repository_id));
    if (pathOwner !== undefined) {
      throw new StorageError(
        "CONSTRAINT_VIOLATION",
        `Repository path ${parsed.path} is already registered as ${String(pathOwner.repository_id)}`
      );
    }
    this.#database.prepare(`
      INSERT INTO repositories(
        repository_id, project_id, path, label, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(repository_id) DO UPDATE SET
        project_id = excluded.project_id,
        path = excluded.path,
        label = excluded.label,
        updated_at = excluded.updated_at
    `).run(
      parsed.repository_id,
      parsed.project_id,
      parsed.path,
      parsed.label,
      parsed.created_at,
      parsed.updated_at
    );
  }

  getSessionByTransportId(transportSessionId: string): SessionRecord | undefined {
    this.#assertActive();
    const row = optionalRow(this.#database.prepare(`
      SELECT ${sessionColumns}
      FROM sessions
      WHERE transport_session_id = ?
    `).get(transportSessionId));
    return row === undefined ? undefined : sessionFromRow(row);
  }

  getSession(sessionId: string): SessionRecord | undefined {
    this.#assertActive();
    const row = optionalRow(this.#database.prepare(`
      SELECT ${sessionColumns}
      FROM sessions
      WHERE session_id = ?
    `).get(sessionId));
    return row === undefined ? undefined : sessionFromRow(row);
  }

  getSessionBySuccessorId(successorSessionId: string): SessionRecord | undefined {
    this.#assertActive();
    const row = optionalRow(this.#database.prepare(`
      SELECT ${sessionColumns}
      FROM sessions
      WHERE successor_session_id = ?
      ORDER BY started_at DESC, session_id
      LIMIT 1
    `).get(successorSessionId));
    return row === undefined ? undefined : sessionFromRow(row);
  }

  insertSession(session: SessionRecord): void {
    this.#assertActive();
    const parsed = sessionRecordSchema.parse(session);
    if (this.getSession(parsed.session_id) !== undefined) {
      throw new StorageError(
        "CONSTRAINT_VIOLATION",
        "UNIQUE session constraint rejected the session id"
      );
    }
    if (
      parsed.transport_session_id !== undefined
      && this.getSessionByTransportId(parsed.transport_session_id) !== undefined
    ) {
      throw new StorageError(
        "CONSTRAINT_VIOLATION",
        "UNIQUE transport session constraint rejected the transport session id"
      );
    }
    this.#database.prepare(`
      INSERT INTO sessions(
        session_id, repository_id, label, started_at, ended_at,
        transport_session_id, client_name, client_version, client_family,
        protocol_version, capabilities_json, workspace_path, worktree_path,
        last_activity_at, stale_at, owner, successor_session_id, successor_ctx_id,
        resume_token_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parsed.session_id,
      parsed.repository_id,
      parsed.label,
      parsed.started_at,
      parsed.ended_at ?? null,
      parsed.transport_session_id ?? null,
      parsed.client_name ?? null,
      parsed.client_version ?? null,
      parsed.client_family ?? null,
      parsed.protocol_version ?? null,
      parsed.capabilities === undefined
        ? null
        : JSON.stringify(parsed.capabilities),
      parsed.workspace_path ?? null,
      parsed.worktree_path ?? null,
      parsed.last_activity_at ?? null,
      parsed.stale_at ?? null,
      parsed.owner ?? null,
      parsed.successor_session_id ?? null,
      parsed.successor_ctx_id ?? null,
      parsed.resume_token_hash ?? null
    );
  }

  updateSessionActivity(sessionId: string, lastActivityAt: string): void {
    this.#assertActive();
    this.#database.prepare(`
      UPDATE sessions
      SET last_activity_at = ?, stale_at = NULL
      WHERE session_id = ?
    `).run(lastActivityAt, sessionId);
  }

  updateSessionTransport(
    sessionId: string,
    transportSessionId: string,
    lastActivityAt: string
  ): void {
    this.#assertActive();
    const result = this.#database.prepare(`
      UPDATE sessions
      SET transport_session_id = ?, last_activity_at = ?, stale_at = NULL
      WHERE session_id = ?
    `).run(transportSessionId, lastActivityAt, sessionId);
    if (Number(result.changes) === 0) {
      throw new StorageError(
        "CONSTRAINT_VIOLATION",
        `Session ${sessionId} disappeared while rebinding its transport`
      );
    }
  }

  setSessionResumeTokenHash(sessionId: string, resumeTokenHash: string): void {
    this.#assertActive();
    const result = this.#database.prepare(`
      UPDATE sessions
      SET resume_token_hash = ?
      WHERE session_id = ?
    `).run(resumeTokenHash, sessionId);
    if (Number(result.changes) === 0) {
      throw new StorageError(
        "CONSTRAINT_VIOLATION",
        `Session ${sessionId} disappeared while storing its resume token hash`
      );
    }
  }

  updateSessionContext(
    sessionId: string,
    workspacePath: string,
    worktreePath: string,
    lastActivityAt: string
  ): void {
    this.#assertActive();
    const result = this.#database.prepare(`
      UPDATE sessions
      SET workspace_path = ?, worktree_path = ?, last_activity_at = ?, stale_at = NULL
      WHERE session_id = ?
    `).run(workspacePath, worktreePath, lastActivityAt, sessionId);
    if (Number(result.changes) === 0) {
      throw new StorageError(
        "CONSTRAINT_VIOLATION",
        `Session ${sessionId} disappeared while updating its worktree context`
      );
    }
  }

  insertSessionEvent(event: SessionEventRecord): void {
    this.#assertActive();
    const parsed = sessionEventSchema.parse(event);
    this.#database.prepare(`
      INSERT INTO session_events(
        event_id, session_id, event_type, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      parsed.event_id,
      parsed.session_id,
      parsed.event_type,
      serializeJson(parsed.payload),
      parsed.created_at
    );
  }

  listSessionsInactiveBefore(cutoff: string): SessionRecord[] {
    this.#assertActive();
    return this.#database.prepare(`
      SELECT ${sessionColumns}
      FROM sessions
      WHERE last_activity_at IS NOT NULL AND last_activity_at <= ?
      ORDER BY session_id
    `).all(cutoff).map(sessionFromRow);
  }

  setSessionStaleAt(sessionId: string, staleAt: string): void {
    this.#assertActive();
    const result = this.#database.prepare(`
      UPDATE sessions
      SET stale_at = ?
      WHERE session_id = ?
    `).run(staleAt, sessionId);
    if (Number(result.changes) === 0) {
      throw new StorageError(
        "CONSTRAINT_VIOLATION",
        `Session ${sessionId} disappeared while marking it stale`
      );
    }
  }

  setSessionSuccessor(
    sessionId: string,
    successorSessionId: string,
    successorCtxId: string | undefined,
    staleAt: string
  ): void {
    this.#assertActive();
    const result = this.#database.prepare(`
      UPDATE sessions
      SET successor_session_id = ?, successor_ctx_id = ?, stale_at = ?
      WHERE session_id = ?
        AND successor_session_id IS NULL
    `).run(successorSessionId, successorCtxId ?? null, staleAt, sessionId);
    if (Number(result.changes) === 0) {
      throw new StorageError(
        "VERSION_CONFLICT",
        `Session ${sessionId} already has a successor or disappeared`
      );
    }
  }

  getLeaseByTask(taskId: string): ActiveTaskLease | undefined {
    this.#assertActive();
    const row = optionalRow(this.#database.prepare(`
      SELECT task_id, session_id, acquired_at, heartbeat_at, expires_at, generation
      FROM active_task_leases
      WHERE task_id = ?
    `).get(taskId));
    return row === undefined ? undefined : leaseFromRow(row);
  }

  getLeaseBySession(sessionId: string): ActiveTaskLease | undefined {
    this.#assertActive();
    const row = optionalRow(this.#database.prepare(`
      SELECT task_id, session_id, acquired_at, heartbeat_at, expires_at, generation
      FROM active_task_leases
      WHERE session_id = ?
    `).get(sessionId));
    return row === undefined ? undefined : leaseFromRow(row);
  }

  putLease(lease: ActiveTaskLease): void {
    this.#assertActive();
    const parsed = leaseSchema.parse(lease);
    if (
      this.getLeaseByTask(parsed.task_id) !== undefined
      || this.getLeaseBySession(parsed.session_id) !== undefined
    ) {
      throw new StorageError(
        "CONSTRAINT_VIOLATION",
        "UNIQUE active lease constraint rejected the task or session"
      );
    }
    this.#database.prepare(`
      INSERT INTO active_task_leases(
        task_id, session_id, acquired_at, heartbeat_at, expires_at, generation
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      parsed.task_id,
      parsed.session_id,
      parsed.acquired_at,
      parsed.heartbeat_at,
      parsed.expires_at,
      parsed.generation
    );
  }

  deleteLeaseByTask(taskId: string): void {
    this.#assertActive();
    this.#database.prepare("DELETE FROM active_task_leases WHERE task_id = ?").run(taskId);
  }

  insertCheckpoint(checkpoint: CheckpointRecord): void {
    this.#assertActive();
    const payload = checkpointPayloadSchema.parse(checkpoint.payload);
    this.#database.prepare(`
      INSERT INTO checkpoints(
        checkpoint_id, task_id, session_id, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      checkpoint.checkpoint_id,
      checkpoint.task_id,
      checkpoint.session_id ?? null,
      JSON.stringify(payload),
      checkpoint.created_at
    );
  }

  insertRepoSnapshot(snapshot: RepoSnapshotRecord): void {
    this.#assertActive();
    const parsed = repoSnapshotSchema.parse(snapshot);
    this.#database.prepare(`
      INSERT INTO repo_snapshots(
        snapshot_id, task_id, checkpoint_id, repository_id,
        repository_path, head_commit, captured_at,
        worktree_path, branch, changed_files_json, content_digest,
        provenance, host_evidence_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.snapshot_id,
      snapshot.task_id,
      snapshot.checkpoint_id ?? null,
      parsed.repository_id,
      parsed.repository_path,
      parsed.head_commit,
      parsed.captured_at,
      snapshot.worktree_path ?? null,
      snapshot.branch ?? null,
      snapshot.changed_files === undefined || snapshot.changed_files.length === 0
        ? null
        : JSON.stringify([...snapshot.changed_files]),
      snapshot.content_digest ?? null,
      snapshot.provenance ?? "server_verified",
      snapshot.host_evidence_id ?? null
    );
  }

  getLatestRepoSnapshot(taskId: string): RepoSnapshotRecord | undefined {
    this.#assertActive();
    const row = optionalRow(this.#database.prepare(`
      SELECT snapshot_id, task_id, checkpoint_id, repository_id,
        repository_path, head_commit, captured_at, worktree_path, branch,
        changed_files_json, content_digest, provenance, host_evidence_id
      FROM repo_snapshots
      WHERE task_id = ?
      ORDER BY captured_at DESC, snapshot_id DESC
      LIMIT 1
    `).get(taskId));
    return row === undefined ? undefined : repoSnapshotRecordFromRow(row);
  }

  insertHostKey(record: HostKeyRecord): void {
    this.#assertActive();
    const parsed = hostKeySchema.parse(record);
    this.#database.prepare(`
      INSERT INTO host_keys(
        host_key_id, owner, label, public_key_b64, client_family,
        status, rotated_to, created_at, revoked_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parsed.host_key_id,
      parsed.owner,
      parsed.label,
      parsed.public_key_b64,
      parsed.client_family ?? null,
      parsed.status,
      parsed.rotated_to ?? null,
      parsed.created_at,
      parsed.revoked_at ?? null,
      parsed.last_used_at ?? null
    );
  }

  updateHostKey(record: HostKeyRecord): void {
    this.#assertActive();
    const parsed = hostKeySchema.parse(record);
    this.#database.prepare(`
      UPDATE host_keys
      SET owner = ?, label = ?, client_family = ?, status = ?,
        rotated_to = ?, revoked_at = ?, last_used_at = ?
      WHERE host_key_id = ?
    `).run(
      parsed.owner,
      parsed.label,
      parsed.client_family ?? null,
      parsed.status,
      parsed.rotated_to ?? null,
      parsed.revoked_at ?? null,
      parsed.last_used_at ?? null,
      parsed.host_key_id
    );
  }

  touchHostKeyUsed(hostKeyId: string, usedAtIso: string): void {
    this.#assertActive();
    this.#database.prepare(`
      UPDATE host_keys SET last_used_at = ? WHERE host_key_id = ?
    `).run(usedAtIso, hostKeyId);
  }

  insertHostEvidenceChallenge(record: HostEvidenceChallengeRecord): void {
    this.#assertActive();
    const parsed = hostEvidenceChallengeSchema.parse(record);
    this.#database.prepare(`
      INSERT INTO host_evidence_challenges(
        challenge_id, nonce_b64, operation, session_id, repository_id,
        task_id, lease_generation, expected_worktree_path, host_key_id,
        created_at, expires_at, consumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parsed.challenge_id,
      parsed.nonce_b64,
      parsed.operation,
      parsed.session_id,
      parsed.repository_id,
      parsed.task_id ?? null,
      parsed.lease_generation ?? null,
      parsed.expected_worktree_path,
      parsed.host_key_id ?? null,
      parsed.created_at,
      parsed.expires_at,
      parsed.consumed_at ?? null
    );
  }

  consumeHostEvidenceChallenge(challengeId: string, consumedAtIso: string): boolean {
    this.#assertActive();
    const result = this.#database.prepare(`
      UPDATE host_evidence_challenges
      SET consumed_at = ?
      WHERE challenge_id = ? AND consumed_at IS NULL
    `).run(consumedAtIso, challengeId);
    return Number(result.changes) === 1;
  }

  insertHostEvidence(record: HostEvidenceRecord): void {
    this.#assertActive();
    const parsed = hostEvidenceSchema.parse(record);
    this.#database.prepare(`
      INSERT INTO host_evidence(
        evidence_id, host_key_id, challenge_id, session_id, task_id,
        repository_id, worktree_path, head_commit, branch,
        changed_files_json, content_digest, signature_b64, payload_json,
        captured_at, verified_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parsed.evidence_id,
      parsed.host_key_id,
      parsed.challenge_id,
      parsed.session_id,
      parsed.task_id ?? null,
      parsed.repository_id,
      parsed.worktree_path,
      parsed.head_commit,
      parsed.branch ?? null,
      JSON.stringify([...parsed.changed_files]),
      parsed.content_digest,
      parsed.signature_b64,
      parsed.payload_json,
      parsed.captured_at,
      parsed.verified_at,
      parsed.expires_at
    );
  }


  appendTaskEvent(event: TaskEventRecord): void {
    this.#assertActive();
    this.#database.prepare(`
      INSERT INTO task_events(
        event_id, task_id, session_id, event_type, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.event_id,
      event.task_id,
      event.session_id ?? null,
      event.event_type,
      serializeJson(event.payload),
      event.created_at
    );
  }

  findTaskAttemptEvent(taskId: string, attemptId: string): TaskEventRecord | undefined {
    this.#assertActive();
    const row = optionalRow(this.#database.prepare(`
      SELECT event_id, task_id, session_id, event_type, payload_json, created_at
      FROM task_events
      WHERE task_id = ?
        AND event_type = 'task_attempt_recorded'
        AND json_extract(payload_json, '$.attempt_id') = ?
      ORDER BY created_at, event_id
      LIMIT 1
    `).get(taskId, attemptId));
    if (row === undefined) {
      return undefined;
    }
    return {
      event_id: String(row.event_id),
      task_id: String(row.task_id),
      ...(row.session_id === null ? {} : { session_id: String(row.session_id) }),
      event_type: String(row.event_type),
      payload: parseJson(row.payload_json),
      created_at: String(row.created_at)
    };
  }

  listRecentTaskEvents(taskId: string, limit: number): TaskEventRecord[] {
    this.#assertActive();
    return this.#database.prepare(`
      SELECT event_id, task_id, session_id, event_type, payload_json, created_at
      FROM task_events
      WHERE task_id = ?
      ORDER BY created_at DESC, event_id DESC
      LIMIT ?
    `).all(taskId, limit).map((row) => ({
      event_id: String(row.event_id),
      task_id: String(row.task_id),
      ...(row.session_id === null || row.session_id === undefined
        ? {}
        : { session_id: String(row.session_id) }),
      event_type: String(row.event_type),
      payload: parseJson(row.payload_json),
      created_at: String(row.created_at)
    }));
  }

  getOperationResult(sessionId: string, operationId: string): OperationResult | undefined {
    this.#assertActive();
    const row = optionalRow(this.#database.prepare(`
      SELECT session_id, operation_id, tool_name, request_hash, result_json, created_at
      FROM operation_results
      WHERE session_id = ? AND operation_id = ?
    `).get(sessionId, operationId));
    if (row === undefined) {
      return undefined;
    }
    return {
      session_id: String(row.session_id),
      operation_id: String(row.operation_id),
      ...(row.tool_name === null || row.tool_name === undefined
        ? {}
        : { tool_name: String(row.tool_name) }),
      ...(row.request_hash === null || row.request_hash === undefined
        ? {}
        : { request_hash: String(row.request_hash) }),
      result: parseJson(row.result_json),
      created_at: String(row.created_at)
    };
  }

  putOperationResult(result: OperationResult): void {
    this.#assertActive();
    if (this.getOperationResult(result.session_id, result.operation_id) !== undefined) {
      throw new StorageError(
        "CONSTRAINT_VIOLATION",
        "UNIQUE operation result constraint rejected the session operation key"
      );
    }
    this.#database.prepare(`
      INSERT INTO operation_results(
        session_id, operation_id, tool_name, request_hash, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      result.session_id,
      result.operation_id,
      result.tool_name ?? null,
      result.request_hash ?? null,
      serializeJson(result.result),
      result.created_at
    );
  }

  findLegacyImport(legacyImportKey: string): LegacyTaskImport | undefined {
    this.#assertActive();
    const row = optionalRow(this.#database.prepare(`
      SELECT legacy_import_key, source_session_label, project_id, repository_id,
        worktree_path, normalized_title, task_id, created_at
      FROM legacy_task_imports
      WHERE legacy_import_key = ?
    `).get(legacyImportKey));
    return row === undefined ? undefined : legacyTaskImportSchema.parse(row);
  }

  insertLegacyImport(record: LegacyTaskImport): void {
    this.#assertActive();
    const parsed = legacyTaskImportSchema.parse(record);
    if (this.findLegacyImport(parsed.legacy_import_key) !== undefined) {
      throw new StorageError(
        "CONSTRAINT_VIOLATION",
        "UNIQUE legacy import constraint rejected the legacy import key"
      );
    }
    this.#database.prepare(`
      INSERT INTO legacy_task_imports(
        legacy_import_key, source_session_label, project_id, repository_id,
        worktree_path, normalized_title, task_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parsed.legacy_import_key,
      parsed.source_session_label,
      parsed.project_id,
      parsed.repository_id,
      parsed.worktree_path,
      parsed.normalized_title,
      parsed.task_id,
      parsed.created_at
    );
  }

  insertTaskScope(scope: TaskScopeRecord): void {
    this.#assertActive();
    this.#database.prepare(`
      INSERT INTO task_scopes(task_scope_id, task_id, scope_type, scope_value)
      VALUES (?, ?, ?, ?)
    `).run(scope.task_scope_id, scope.task_id, scope.scope_type, scope.scope_value);
  }

  replaceTaskWorktreeScope(scope: TaskScopeRecord): void {
    this.#assertActive();
    if (scope.scope_type !== "worktree_path") {
      throw new StorageError(
        "CONSTRAINT_VIOLATION",
        "replaceTaskWorktreeScope only accepts a worktree_path scope"
      );
    }
    this.#database.prepare(`
      DELETE FROM task_scopes
      WHERE task_id = ? AND scope_type = 'worktree_path'
    `).run(scope.task_id);
    this.insertTaskScope(scope);
  }

  upsertTaskSessionLink(link: TaskSessionLinkRecord): void {
    this.#assertActive();
    const parsed = taskSessionLinkSchema.parse(link);
    this.#database.prepare(`
      INSERT INTO task_session_links(task_id, session_id, linked_at)
      VALUES (?, ?, ?)
      ON CONFLICT(task_id, session_id) DO UPDATE SET
        linked_at = excluded.linked_at
    `).run(parsed.task_id, parsed.session_id, parsed.linked_at);
  }

  insertHumanDecision(decision: HumanDecisionRecord): void {
    this.#assertActive();
    const parsed = humanDecisionSchema.parse(decision);
    this.#database.prepare(`
      INSERT INTO human_decisions(
        decision_id, task_id, session_id, question, decision, status,
        created_at, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parsed.decision_id,
      parsed.task_id,
      parsed.session_id ?? null,
      parsed.question,
      parsed.decision ?? null,
      parsed.status,
      parsed.created_at,
      parsed.decided_at ?? null
    );
  }

  listPendingHumanDecisions(taskId: string): HumanDecisionRecord[] {
    this.#assertActive();
    return this.#database.prepare(`
      SELECT decision_id, task_id, session_id, question, decision, status,
        created_at, decided_at
      FROM human_decisions
      WHERE task_id = ? AND status = 'pending'
      ORDER BY created_at, decision_id
    `).all(taskId).map((row) => ({
      decision_id: String(row.decision_id),
      task_id: String(row.task_id),
      ...(row.session_id === null || row.session_id === undefined
        ? {}
        : { session_id: String(row.session_id) }),
      question: String(row.question),
      ...(row.decision === null || row.decision === undefined
        ? {}
        : { decision: String(row.decision) }),
      status: String(row.status),
      created_at: String(row.created_at),
      ...(row.decided_at === null || row.decided_at === undefined
        ? {}
        : { decided_at: String(row.decided_at) })
    }));
  }

  listDependentsOf(taskId: string): { task_id: string }[] {
    this.#assertActive();
    return this.#database.prepare(
      "SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ?"
    ).all(taskId).map((row) => ({ task_id: String(row.task_id) }));
  }

  nextDependencyValidationCycle(taskId: string): number {
    this.#assertActive();
    const row = this.#database.prepare(`
      SELECT COALESCE(MAX(cycle), 0) + 1 AS next_cycle
      FROM dependency_validations
      WHERE upstream_task_id = ?
    `).get(taskId);
    return Number(row?.next_cycle ?? 1);
  }

  insertDependencyValidation(validation: DependencyValidationRecord): void {
    this.#assertActive();
    const parsed = dependencyValidationSchema.parse(validation);
    const upstream = this.getTask(parsed.upstream_task_id);
    const downstream = this.getTask(parsed.downstream_task_id);
    const snapshot = this.getLatestRepoSnapshot(parsed.upstream_task_id);
    try {
      assertDependencyValidationSpecIdentity(parsed.validation_spec, {
        upstream_task_id: parsed.upstream_task_id,
        upstream_task_version: this.getTaskVersion(parsed.upstream_task_id) ?? 0,
        ...(upstream === undefined ? {} : { upstream_repository_id: upstream.repository_id }),
        downstream_task_id: parsed.downstream_task_id,
        ...(downstream === undefined ? {} : { downstream_repository_id: downstream.repository_id }),
        cycle: parsed.cycle
      });
    } catch (error) {
      throw new StorageError(
        "CONSTRAINT_VIOLATION",
        error instanceof Error ? error.message : "validation_spec identity mismatch"
      );
    }
    const safeSpec = sanitizeDependencyValidationSpec(parsed.validation_spec, {
      preserve_persisted_fields: true,
      upstream_task_id: parsed.upstream_task_id,
      upstream_task_version: this.getTaskVersion(parsed.upstream_task_id) ?? 0,
      ...(upstream === undefined ? {} : { upstream_repository_id: upstream.repository_id }),
      downstream_task_id: parsed.downstream_task_id,
      ...(downstream === undefined ? {} : { downstream_repository_id: downstream.repository_id }),
      cycle: parsed.cycle,
      ...(snapshot === undefined ? {} : {
        target_revision: snapshot.head_commit,
        target_head_commit: snapshot.head_commit,
        worktree_path: snapshot.worktree_path,
        changed_files: snapshot.changed_files
      })
    });
    this.#database.prepare(`
      INSERT INTO dependency_validations(
    ctx_id, validation_id, upstream_task_id, downstream_task_id, cycle, status,
        requested_by_actor, requested_by_owner, requested_at, request_read_at,
        responded_by_owner, response_reason, responded_at, response_read_at, validation_spec_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parsed.ctx_id ?? null,
      parsed.validation_id,
      parsed.upstream_task_id,
      parsed.downstream_task_id,
      parsed.cycle,
      parsed.status,
      parsed.requested_by_actor,
      parsed.requested_by_owner,
      parsed.requested_at,
      parsed.request_read_at,
      parsed.responded_by_owner,
      parsed.response_reason,
      parsed.responded_at,
      parsed.response_read_at,
      JSON.stringify(safeSpec)
    );
  }

  getDependencyValidation(validationId: string): DependencyValidationRecord | undefined {
    this.#assertActive();
    const row = this.#database.prepare(`
      SELECT * FROM dependency_validations WHERE validation_id = ?
    `).get(validationId);
    return row === undefined ? undefined : dependencyValidationFromRow(row);
  }

  listDependencyValidationsForUpstream(taskId: string): DependencyValidationRecord[] {
    this.#assertActive();
    return this.#database.prepare(`
      SELECT * FROM dependency_validations
      WHERE upstream_task_id = ?
      ORDER BY cycle DESC, downstream_task_id
    `).all(taskId).map(dependencyValidationFromRow);
  }

  getDependencyRepairRequest(repairId: string): DependencyRepairRequestRecord | undefined {
    this.#assertActive();
    const row = optionalRow(this.#database.prepare(`
      SELECT * FROM dependency_repair_requests WHERE repair_id = ?
    `).get(repairId));
    return row === undefined ? undefined : dependencyRepairRequestFromRow(row);
  }

  getDependencyRepairByValidation(
    validationId: string
  ): DependencyRepairRequestRecord | undefined {
    this.#assertActive();
    const row = optionalRow(this.#database.prepare(`
      SELECT * FROM dependency_repair_requests WHERE validation_id = ?
    `).get(validationId));
    return row === undefined ? undefined : dependencyRepairRequestFromRow(row);
  }

  listDependencyRepairsForUpstream(taskId: string): DependencyRepairRequestRecord[] {
    this.#assertActive();
    return this.#database.prepare(`
      SELECT * FROM dependency_repair_requests
      WHERE upstream_task_id = ?
      ORDER BY cycle DESC, created_at DESC, repair_id
    `).all(taskId).map(dependencyRepairRequestFromRow);
  }

  listDependencyRepairsForDownstream(taskId: string): DependencyRepairRequestRecord[] {
    this.#assertActive();
    return this.#database.prepare(`
      SELECT * FROM dependency_repair_requests
      WHERE downstream_task_id = ?
      ORDER BY cycle DESC, created_at DESC, repair_id
    `).all(taskId).map(dependencyRepairRequestFromRow);
  }

  insertDependencyRepairRequest(record: DependencyRepairRequestRecord): void {
    this.#assertActive();
    const parsed = dependencyRepairRequestSchema.parse({
      ...record,
      rejection_reason: sanitizeDependencyValidationText(record.rejection_reason) ?? "[redacted]"
    });
    this.#database.prepare(`
      INSERT INTO dependency_repair_requests(
        repair_id, validation_id, source_run_id, ctx_id,
        upstream_task_id, downstream_task_id, cycle, status, rejection_reason,
        claimed_session_id, claimed_worktree_path, claimed_at,
        resolved_at, superseded_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parsed.repair_id,
      parsed.validation_id,
      parsed.source_run_id,
      parsed.ctx_id,
      parsed.upstream_task_id,
      parsed.downstream_task_id,
      parsed.cycle,
      parsed.status,
      parsed.rejection_reason,
      parsed.claimed_session_id,
      parsed.claimed_worktree_path,
      parsed.claimed_at,
      parsed.resolved_at,
      parsed.superseded_at,
      parsed.created_at,
      parsed.updated_at
    );
  }

  updateDependencyRepairRequest(
    record: DependencyRepairRequestRecord,
    expectedStatus: DependencyRepairStatus
  ): void {
    this.#assertActive();
    const parsed = dependencyRepairRequestSchema.parse({
      ...record,
      rejection_reason: sanitizeDependencyValidationText(record.rejection_reason) ?? "[redacted]"
    });
    const result = this.#database.prepare(`
      UPDATE dependency_repair_requests
      SET validation_id = ?, source_run_id = ?, ctx_id = ?,
        upstream_task_id = ?, downstream_task_id = ?, cycle = ?, status = ?,
        rejection_reason = ?, claimed_session_id = ?, claimed_worktree_path = ?,
        claimed_at = ?, resolved_at = ?, superseded_at = ?, updated_at = ?
      WHERE repair_id = ? AND status = ?
    `).run(
      parsed.validation_id,
      parsed.source_run_id,
      parsed.ctx_id,
      parsed.upstream_task_id,
      parsed.downstream_task_id,
      parsed.cycle,
      parsed.status,
      parsed.rejection_reason,
      parsed.claimed_session_id,
      parsed.claimed_worktree_path,
      parsed.claimed_at,
      parsed.resolved_at,
      parsed.superseded_at,
      parsed.updated_at,
      parsed.repair_id,
      expectedStatus
    );
    if (Number(result.changes) !== 1) {
      throw new StorageError(
        "VERSION_CONFLICT",
        `Dependency repair request ${parsed.repair_id} is no longer ${expectedStatus}`
      );
    }
  }

  getDependencyValidationRun(runId: string): DependencyValidationRunRecord | undefined {
    this.#assertActive();
    const row = this.#database.prepare(
      "SELECT * FROM dependency_validation_runs WHERE run_id = ?"
    ).get(runId);
    return row === undefined ? undefined : dependencyValidationRunFromRow(row);
  }

  getActiveDependencyValidationRun(validationId: string): DependencyValidationRunRecord | undefined {
    this.#assertActive();
    const row = this.#database.prepare(`
      SELECT * FROM dependency_validation_runs
      WHERE validation_id = ? AND status IN ('queued','claimed','running')
      ORDER BY attempt DESC LIMIT 1
    `).get(validationId);
    return row === undefined ? undefined : dependencyValidationRunFromRow(row);
  }

  listDependencyValidationRuns(validationId: string): DependencyValidationRunRecord[] {
    this.#assertActive();
    return this.#database.prepare(`
      SELECT * FROM dependency_validation_runs
      WHERE validation_id = ? ORDER BY attempt DESC
    `).all(validationId).map((row) => dependencyValidationRunFromRow(row));
  }

  insertDependencyValidationRun(run: DependencyValidationRunRecord): void {
    this.#assertActive();
    const parsed = dependencyValidationRunSchema.parse({
      ...run,
      verification: sanitizeDependencyValidationEvidence(run.verification),
      progress: sanitizeDependencyValidationProgress(run.progress),
      failure_reason: run.failure_reason === null
        ? null
        : sanitizeDependencyValidationText(run.failure_reason) ?? "[redacted]",
      error_reason: run.error_reason === null
        ? null
        : sanitizeDependencyValidationText(run.error_reason) ?? "[redacted]"
    });
    this.#database.prepare(`
      INSERT INTO dependency_validation_runs(
        run_id, validation_id, attempt, status, owner, session_id, worktree_path,
        heartbeat_at, expires_at, started_at, completed_at, verification_json, progress_json,
        failure_reason, error_reason, operation_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parsed.run_id, parsed.validation_id, parsed.attempt, parsed.status, parsed.owner,
      parsed.session_id, parsed.worktree_path, parsed.heartbeat_at, parsed.expires_at,
      parsed.started_at, parsed.completed_at, JSON.stringify(parsed.verification), JSON.stringify(parsed.progress ?? {}),
      parsed.failure_reason, parsed.error_reason, parsed.operation_id,
      parsed.created_at, parsed.updated_at
    );
  }

  updateDependencyValidationRun(
    run: DependencyValidationRunRecord,
    expectedStatus?: DependencyValidationRunStatus
  ): void {
    this.#assertActive();
    const parsed = dependencyValidationRunSchema.parse({
      ...run,
      verification: sanitizeDependencyValidationEvidence(run.verification),
      progress: sanitizeDependencyValidationProgress(run.progress),
      failure_reason: run.failure_reason === null
        ? null
        : sanitizeDependencyValidationText(run.failure_reason) ?? "[redacted]",
      error_reason: run.error_reason === null
        ? null
        : sanitizeDependencyValidationText(run.error_reason) ?? "[redacted]"
    });
    const statusClause = expectedStatus === undefined ? "" : " AND status = ?";
    const params: any[] = [
      parsed.attempt, parsed.status, parsed.owner, parsed.session_id, parsed.worktree_path,
      parsed.heartbeat_at, parsed.expires_at, parsed.started_at, parsed.completed_at,
      JSON.stringify(parsed.verification), JSON.stringify(parsed.progress ?? {}), parsed.failure_reason, parsed.error_reason,
      parsed.operation_id, parsed.updated_at, parsed.run_id
    ];
    if (expectedStatus !== undefined) params.push(expectedStatus);
    const result = this.#database.prepare(`
      UPDATE dependency_validation_runs SET attempt = ?, status = ?, owner = ?, session_id = ?,
        worktree_path = ?, heartbeat_at = ?, expires_at = ?, started_at = ?, completed_at = ?,
        verification_json = ?, progress_json = ?, failure_reason = ?, error_reason = ?, operation_id = ?, updated_at = ?
      WHERE run_id = ?${statusClause}
    `).run(...params);
    if (Number(result.changes) !== 1) {
      throw new StorageError("VERSION_CONFLICT", `Dependency validation run ${parsed.run_id} update conflict`);
    }
  }

  renewDependencyValidationRunLease(
    runId: string,
    owner: string,
    sessionId: string,
    heartbeatAt: string,
    expiresAt: string,
    now: string
  ): void {
    this.#assertActive();
    const result = this.#database.prepare(`
      UPDATE dependency_validation_runs
      SET heartbeat_at = ?, expires_at = ?, updated_at = ?
      WHERE run_id = ? AND owner = ? AND session_id = ? AND expires_at > ?
    `).run(heartbeatAt, expiresAt, heartbeatAt, runId, owner, sessionId, now);
    if (Number(result.changes) !== 1) {
      throw new StorageError("VERSION_CONFLICT", `Dependency validation run ${runId} lease renewal rejected`);
    }
  }

  updateDependencyValidationResponse(
    validationId: string,
    expectedStatus: "pending",
    response: {
      status: "passed" | "rejected";
      responded_by_owner: string;
      response_reason: string | null;
      responded_at: string;
      response_read_at: string | null;
    }
  ): void {
    this.#assertActive();
    const result = this.#database.prepare(`
      UPDATE dependency_validations
      SET status = ?, responded_by_owner = ?, response_reason = ?, responded_at = ?,
        request_read_at = COALESCE(request_read_at, ?), response_read_at = ?
      WHERE validation_id = ? AND status = ?
    `).run(
      response.status,
      response.responded_by_owner,
      response.response_reason === null
        ? null
        : sanitizeDependencyValidationText(response.response_reason) ?? "[redacted]",
      response.responded_at,
      response.responded_at,
      response.response_read_at,
      validationId,
      expectedStatus
    );
    if (result.changes !== 1) {
      throw new StorageError(
        "VERSION_CONFLICT",
        `Dependency validation ${validationId} is no longer pending`
      );
    }
  }

  markDependencyValidationRequestRead(validationId: string, readAt: string): void {
    this.#assertActive();
    this.#database.prepare("UPDATE dependency_validations SET request_read_at = COALESCE(request_read_at, ?) WHERE validation_id = ?").run(readAt, validationId);
  }

  supersedePendingDependencyValidations(taskId: string, supersededAt: string): void {
    this.#assertActive();
    this.#database.prepare(`
      UPDATE dependency_validations
      SET status = 'superseded', response_reason = ?, response_read_at = ?
      WHERE upstream_task_id = ? AND status = 'pending'
    `).run("A newer validation cycle replaced this request", supersededAt, taskId);
    this.#database.prepare(`
      UPDATE dependency_validation_runs
      SET status = 'cancelled',
        completed_at = ?,
        error_reason = ?,
        updated_at = ?
      WHERE validation_id IN (
        SELECT validation_id FROM dependency_validations
        WHERE upstream_task_id = ? AND status = 'superseded'
      )
        AND status IN ('queued', 'claimed', 'running')
    `).run(
      supersededAt,
      "Validation cycle superseded",
      supersededAt,
      taskId
    );
  }

  supersedeDependencyValidationsForDownstream(taskId: string, supersededAt: string): void {
    this.#assertActive();
    // Terminal responses are immutable history.  SQLite enforces that a
    // superseded row has no responder fields, so only unresolved requests may
    // transition to superseded here; passed/rejected rows remain visible for
    // audit and are invalidated by the current dependency edge/cycle checks.
    this.#database.prepare(`
      UPDATE dependency_validations
      SET status = 'superseded'
      WHERE downstream_task_id = ?
        AND status = 'pending'
    `).run(taskId);
    this.#database.prepare(`
      UPDATE dependency_validation_runs
      SET status = 'cancelled',
        completed_at = ?,
        error_reason = ?,
        updated_at = ?
      WHERE validation_id IN (
        SELECT validation_id FROM dependency_validations
        WHERE downstream_task_id = ?
      )
        AND status IN ('queued', 'claimed', 'running')
    `).run(
      supersededAt,
      "Downstream task no longer accepts validation runs",
      supersededAt,
      taskId
    );
  }

  insertNotification(notification: NotificationRecord): void {
    this.#assertActive();
    this.#database.prepare(`
      INSERT INTO notifications(
        notification_id, owner, task_id, upstream_task_id,
        upstream_title, upstream_status, read_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      notification.notification_id,
      notification.owner,
      notification.task_id,
      notification.upstream_task_id,
      notification.upstream_title,
      notification.upstream_status,
      notification.read_at,
      notification.created_at
    );
  }

  replaceTaskDependencies(taskId: string, dependsOnTaskIds: readonly string[], created_at: string, policies?: Readonly<Record<string, TaskDependencyRecord["policy"]>>): void {
    this.#assertActive();
    const previous = this.#database.prepare(
      "SELECT ctx_id FROM task_dependencies WHERE task_id = ? AND ctx_id IS NOT NULL"
    ).all(taskId).map((row) => String(row.ctx_id));
    for (const ctxId of previous) {
      const context = this.getDependencyContext(ctxId);
      if (context !== undefined) {
        this.updateDependencyContext({ ...context, status: "superseded", updated_at: created_at }, context.updated_at);
        this.appendDependencyContextEvent({
          event_id: randomUUID(),
          ctx_id: ctxId,
          sequence: this.#nextDependencyContextSequence(ctxId),
          event_type: "dependency_superseded",
          payload: { status: "superseded" },
          created_at
        });
      }
    }
    this.#database.prepare("DELETE FROM task_dependencies WHERE task_id = ?").run(taskId);
    const insert = this.#database.prepare(`
      INSERT INTO task_dependencies(task_id, depends_on_task_id, created_at, policy, ctx_id, generation)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const dependsOn of dependsOnTaskIds) {
      const generation = this.#nextDependencyGeneration(taskId, dependsOn);
      const upstream = this.getTask(dependsOn);
      const downstream = this.getTask(taskId);
      const ctxId = upstream === undefined || downstream === undefined
        ? `${dependsOn}:${taskId}:${generation}`
        : `${upstream.repository_id}:${dependsOn}:${downstream.repository_id}:${taskId}:${generation}`;
      const policy = policies?.[dependsOn] ?? "acceptance_gate";
      insert.run(taskId, dependsOn, created_at, policy, ctxId, generation);
      if (upstream !== undefined && downstream !== undefined) {
        this.createDependencyContext({
          ctx_id: ctxId,
          upstream_task_id: dependsOn,
          upstream_repository_id: upstream.repository_id,
          downstream_task_id: taskId,
          downstream_repository_id: downstream.repository_id,
          policy,
          generation,
          status: "active",
          current_cycle: 0,
          created_at,
          updated_at: created_at
        });
      }
    }
  }

  insertTaskDependency(dependency: TaskDependencyRecord): void {
    this.#assertActive();
    const parsed = taskDependencySchema.parse(dependency);
    const upstream = this.getTask(parsed.depends_on_task_id);
    const downstream = this.getTask(parsed.task_id);
    const generation = parsed.generation ?? this.#nextDependencyGeneration(parsed.task_id, parsed.depends_on_task_id);
    const ctxId = parsed.ctx_id ?? (upstream === undefined || downstream === undefined
      ? `${parsed.depends_on_task_id}:${parsed.task_id}:${generation}`
      : `${upstream.repository_id}:${parsed.depends_on_task_id}:${downstream.repository_id}:${parsed.task_id}:${generation}`);
    this.#database.prepare(`
      INSERT INTO task_dependencies(task_id, depends_on_task_id, created_at, policy, ctx_id, generation)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(parsed.task_id, parsed.depends_on_task_id, parsed.created_at, parsed.policy, ctxId, generation);
    if (upstream !== undefined && downstream !== undefined) {
      this.createDependencyContext({
        ctx_id: ctxId,
        upstream_task_id: parsed.depends_on_task_id,
        upstream_repository_id: upstream.repository_id,
        downstream_task_id: parsed.task_id,
        downstream_repository_id: downstream.repository_id,
        policy: parsed.policy,
        generation,
        status: "active",
        current_cycle: 0,
        created_at: parsed.created_at,
        updated_at: parsed.created_at
      });
    }
  }

  listTaskDependencies(taskId: string): TaskDependencyRecord[] {
    this.#assertActive();
    return this.#database.prepare(`
      SELECT task_id, depends_on_task_id, created_at, policy, ctx_id, generation
      FROM task_dependencies
      WHERE task_id = ?
      ORDER BY depends_on_task_id
    `).all(taskId).map((row) => {
      const parsed = taskDependencySchema.parse(row);
      return {
        task_id: parsed.task_id,
        depends_on_task_id: parsed.depends_on_task_id,
        created_at: parsed.created_at,
        policy: parsed.policy,
        generation: parsed.generation,
        ...(parsed.ctx_id === undefined ? {} : { ctx_id: parsed.ctx_id })
      };
    });
  }

  createDependencyContext(context: DependencyContextRecord): void {
    this.#assertActive();
    const parsed = dependencyContextSchema.parse(context);
    this.#database.prepare(`
      INSERT INTO dependency_contexts(
        ctx_id, upstream_task_id, upstream_repository_id,
        downstream_task_id, downstream_repository_id, policy,
        generation, status, current_cycle, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parsed.ctx_id,
      parsed.upstream_task_id,
      parsed.upstream_repository_id,
      parsed.downstream_task_id,
      parsed.downstream_repository_id,
      parsed.policy,
      parsed.generation,
      parsed.status,
      parsed.current_cycle,
      parsed.created_at,
      parsed.updated_at
    );
    this.appendDependencyContextEvent({
      event_id: randomUUID(),
      ctx_id: parsed.ctx_id,
      sequence: 1,
      event_type: "dependency_bound",
      payload: {
        ctx_id: parsed.ctx_id,
        upstream_task_id: parsed.upstream_task_id,
        downstream_task_id: parsed.downstream_task_id,
        upstream_repository_id: parsed.upstream_repository_id,
        downstream_repository_id: parsed.downstream_repository_id,
        policy: parsed.policy,
        generation: parsed.generation,
        cycle: parsed.current_cycle
      },
      created_at: parsed.created_at
    });
  }

  getDependencyContext(ctxId: string): DependencyContextRecord | undefined {
    this.#assertActive();
    const row = this.#database.prepare(
      "SELECT * FROM dependency_contexts WHERE ctx_id = ?"
    ).get(ctxId);
    return row === undefined ? undefined : dependencyContextSchema.parse(row);
  }

  updateDependencyContext(context: DependencyContextRecord, expectedUpdatedAt?: string): void {
    this.#assertActive();
    const parsed = dependencyContextSchema.parse(context);
    const result = this.#database.prepare(`
      UPDATE dependency_contexts
      SET status = ?, policy = ?, current_cycle = ?, updated_at = ?
      WHERE ctx_id = ?
        AND (? IS NULL OR updated_at = ?)
    `).run(
      parsed.status,
      parsed.policy,
      parsed.current_cycle,
      parsed.updated_at,
      parsed.ctx_id,
      expectedUpdatedAt ?? null,
      expectedUpdatedAt ?? null
    );
    if (Number(result.changes) !== 1) {
      throw new StorageError("VERSION_CONFLICT", `Dependency context ${parsed.ctx_id} changed concurrently`);
    }
  }

  appendDependencyContextEvent(event: DependencyContextEventRecord): void {
    this.#assertActive();
    const parsed = dependencyContextEventSchema.parse(event);
    this.#database.prepare(`
      INSERT INTO dependency_context_events(
        event_id, ctx_id, sequence, event_type, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      parsed.event_id,
      parsed.ctx_id,
      parsed.sequence,
      parsed.event_type,
      JSON.stringify(parsed.payload),
      parsed.created_at
    );
  }

  listDependencyContextEvents(ctxId: string): DependencyContextEventRecord[] {
    this.#assertActive();
    return this.#database.prepare(`
      SELECT event_id, ctx_id, sequence, event_type, payload_json, created_at
      FROM dependency_context_events
      WHERE ctx_id = ?
      ORDER BY sequence
    `).all(ctxId).map((row) => dependencyContextEventSchema.parse({
      event_id: String(row.event_id),
      ctx_id: String(row.ctx_id),
      sequence: Number(row.sequence),
      event_type: String(row.event_type),
      payload: parseJson(row.payload_json),
      created_at: String(row.created_at)
    }));
  }

  #nextDependencyGeneration(taskId: string, dependsOnTaskId: string): number {
    const row = this.#database.prepare(`
      SELECT MAX(generation) AS generation
      FROM task_dependencies
      WHERE task_id = ? AND depends_on_task_id = ?
    `).get(taskId, dependsOnTaskId);
    const contextRow = this.#database.prepare(`
      SELECT MAX(generation) AS generation
      FROM dependency_contexts
      WHERE downstream_task_id = ? AND upstream_task_id = ?
    `).get(taskId, dependsOnTaskId);
    return Math.max(Number(row?.generation ?? 0), Number(contextRow?.generation ?? 0)) + 1;
  }

  #nextDependencyContextSequence(ctxId: string): number {
    const row = this.#database.prepare(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM dependency_context_events WHERE ctx_id = ?"
    ).get(ctxId);
    return Number(row?.next_sequence ?? 1);
  }

  listActiveScopesByWorktree(worktreePath: string): ActiveTaskScope[] {
    this.#assertActive();
    return this.#database.prepare(`
      SELECT task_scopes.task_id, task_scopes.scope_type, task_scopes.scope_value
      FROM task_scopes
      JOIN tasks ON tasks.task_id = task_scopes.task_id
      WHERE task_scopes.scope_type = 'worktree_path'
        AND rtrim(task_scopes.scope_value, '/') = rtrim(?, '/')
        AND tasks.status NOT IN ('done', 'cancelled')
      ORDER BY task_scopes.task_id, task_scopes.scope_type, task_scopes.scope_value
    `).all(worktreePath).map((row) => activeTaskScopeSchema.parse(row));
  }
}

type TransactionRunner = <T>(work: () => T) => T;

class SqliteProgressStore implements ProgressStore, BoardAuthStore {
  readonly #database: DatabaseSync;
  readonly #runTransaction: TransactionRunner;

  constructor(
    capability: object,
    database: DatabaseSync,
    runTransaction: TransactionRunner
  ) {
    if (capability !== storeCapability) {
      throw new StorageError(
        "STORE_CAPABILITY_REQUIRED",
        "SQLite progress stores can only be created by SqliteDatabase"
      );
    }
    this.#database = database;
    this.#runTransaction = runTransaction;
  }

  transaction<T>(work: (tx: ProgressTransaction) => T): T {
    return this.#runTransaction(() => {
      const { deactivate, transaction } = createProgressTransaction(this.#database);
      try {
        const result = work(transaction);
        if (isThenable(result)) {
          void Promise.resolve(result).catch(() => undefined);
          throw new StorageError(
            "ASYNC_TRANSACTION_UNSUPPORTED",
            "Progress transaction callbacks must complete synchronously"
          );
        }
        return result;
      } finally {
        deactivate();
      }
    });
  }

  listTasks(filter: TaskListFilter): TaskSummary[] {
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (filter.repositoryId !== undefined) {
      clauses.push("repository_id = ?");
      parameters.push(filter.repositoryId);
    }
    if (filter.owner !== undefined) {
      clauses.push("owner = ?");
      parameters.push(filter.owner);
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      clauses.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
      parameters.push(...filter.statuses);
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    return this.#database.prepare(`
      SELECT task_id, repository_id, session_id, title, status, priority,
        goal, acceptance_criteria_json, checkpoint_json, owner, version, created_at, updated_at
      FROM tasks
      ${where}
      ORDER BY updated_at DESC, task_id
    `).all(...parameters).map(taskSummaryFromRow);
  }

  getDependencyContext(ctxId: string): DependencyContextRecord | undefined {
    return this.transaction((tx) => tx.getDependencyContext?.(ctxId));
  }

  listDependencyContextEvents(ctxId: string): DependencyContextEventRecord[] {
    return this.transaction((tx) => tx.listDependencyContextEvents?.(ctxId) ?? []);
  }

  getTaskDetail(taskId: string): TaskDetail | undefined {
    const row = optionalRow(this.#database.prepare(`
      SELECT task_id, repository_id, session_id, title, status, priority,
        goal, acceptance_criteria_json, checkpoint_json, owner, version, created_at, updated_at
      FROM tasks
      WHERE task_id = ?
    `).get(taskId));
    if (row === undefined) {
      return undefined;
    }
    const scopes = this.#database.prepare(`
      SELECT task_scope_id, task_id, scope_type, scope_value
      FROM task_scopes
      WHERE task_id = ?
      ORDER BY scope_type, scope_value, task_scope_id
    `).all(taskId).map((scope) => ({
      task_scope_id: String(scope.task_scope_id),
      task_id: String(scope.task_id),
      scope_type: String(scope.scope_type),
      scope_value: String(scope.scope_value)
    }));
    return { ...taskSummaryFromRow(row), scopes };
  }

  getRepository(repositoryId: string): RepositoryRecord | undefined {
    const row = optionalRow(this.#database.prepare(`
      SELECT repository_id, project_id, path, label, created_at, updated_at
      FROM repositories
      WHERE repository_id = ?
    `).get(repositoryId));
    return row === undefined ? undefined : repositoryRecordSchema.parse(row);
  }

  getHostKey(hostKeyId: string): HostKeyRecord | undefined {
    const row = optionalRow(this.#database.prepare(`
      SELECT host_key_id, owner, label, public_key_b64, client_family,
        status, rotated_to, created_at, revoked_at, last_used_at
      FROM host_keys
      WHERE host_key_id = ?
    `).get(hostKeyId));
    return row === undefined ? undefined : hostKeyFromRow(row);
  }

  findHostKeyByPublicKey(publicKeyB64: string): HostKeyRecord | undefined {
    const row = optionalRow(this.#database.prepare(`
      SELECT host_key_id, owner, label, public_key_b64, client_family,
        status, rotated_to, created_at, revoked_at, last_used_at
      FROM host_keys
      WHERE public_key_b64 = ?
    `).get(publicKeyB64));
    return row === undefined ? undefined : hostKeyFromRow(row);
  }

  listHostKeys(owner?: string): HostKeyRecord[] {
    const rows = owner === undefined
      ? this.#database.prepare(`
          SELECT host_key_id, owner, label, public_key_b64, client_family,
            status, rotated_to, created_at, revoked_at, last_used_at
          FROM host_keys
          ORDER BY created_at DESC, host_key_id DESC
        `).all()
      : this.#database.prepare(`
          SELECT host_key_id, owner, label, public_key_b64, client_family,
            status, rotated_to, created_at, revoked_at, last_used_at
          FROM host_keys
          WHERE owner = ?
          ORDER BY created_at DESC, host_key_id DESC
        `).all(owner);
    return rows.map((row) => hostKeyFromRow(row as SqliteRow));
  }

  getHostEvidenceChallenge(challengeId: string): HostEvidenceChallengeRecord | undefined {
    const row = optionalRow(this.#database.prepare(`
      SELECT challenge_id, nonce_b64, operation, session_id, repository_id,
        task_id, lease_generation, expected_worktree_path, host_key_id,
        created_at, expires_at, consumed_at
      FROM host_evidence_challenges
      WHERE challenge_id = ?
    `).get(challengeId));
    return row === undefined ? undefined : hostEvidenceChallengeFromRow(row);
  }

  getHostEvidence(evidenceId: string): HostEvidenceRecord | undefined {
    const row = optionalRow(this.#database.prepare(`
      SELECT evidence_id, host_key_id, challenge_id, session_id, task_id,
        repository_id, worktree_path, head_commit, branch, changed_files_json,
        content_digest, signature_b64, payload_json, captured_at, verified_at,
        expires_at
      FROM host_evidence
      WHERE evidence_id = ?
    `).get(evidenceId));
    return row === undefined ? undefined : hostEvidenceFromRow(row);
  }

  getHostEvidenceByChallenge(challengeId: string): HostEvidenceRecord | undefined {
    const row = optionalRow(this.#database.prepare(`
      SELECT evidence_id, host_key_id, challenge_id, session_id, task_id,
        repository_id, worktree_path, head_commit, branch, changed_files_json,
        content_digest, signature_b64, payload_json, captured_at, verified_at,
        expires_at
      FROM host_evidence
      WHERE challenge_id = ?
    `).get(challengeId));
    return row === undefined ? undefined : hostEvidenceFromRow(row);
  }

  getLatestValidHostEvidence(
    repositoryId: string,
    worktreePath: string,
    nowIso: string
  ): HostEvidenceRecord | undefined {
    const row = optionalRow(this.#database.prepare(`
      SELECT evidence_id, host_key_id, challenge_id, session_id, task_id,
        repository_id, worktree_path, head_commit, branch, changed_files_json,
        content_digest, signature_b64, payload_json, captured_at, verified_at,
        expires_at
      FROM host_evidence
      WHERE repository_id = ? AND worktree_path = ? AND expires_at > ?
      ORDER BY verified_at DESC, rowid DESC
      LIMIT 1
    `).get(repositoryId, worktreePath, nowIso));
    return row === undefined ? undefined : hostEvidenceFromRow(row);
  }

  getProject(projectId: string): ProjectRecord | undefined {
    return readProjectRecord(this.#database, projectId);
  }

  getProjectMember(projectId: string, owner: string): ProjectMemberRecord | undefined {
    const row = optionalRow(this.#database.prepare(`
      SELECT project_id, owner, role, granted_by, created_at, revoked_at
      FROM project_members
      WHERE project_id = ? AND owner = ?
    `).get(projectId, owner));
    return row === undefined ? undefined : projectMemberSchema.parse(row);
  }

  listProjectMembers(projectId: string, includeRevoked = false): ProjectMemberRecord[] {
    const revokedClause = includeRevoked ? "" : "AND revoked_at IS NULL";
    return this.#database.prepare(`
      SELECT project_id, owner, role, granted_by, created_at, revoked_at
      FROM project_members
      WHERE project_id = ? ${revokedClause}
      ORDER BY created_at, owner
    `).all(projectId).map((row) => projectMemberSchema.parse(row));
  }

  listRepositories(owner?: string): RepositoryRecord[] {
    const where = owner === undefined
      ? ""
      : `WHERE EXISTS (
          SELECT 1 FROM tasks
          WHERE tasks.repository_id = repositories.repository_id AND tasks.owner = ?
        ) OR EXISTS (
          SELECT 1 FROM sessions
          WHERE sessions.repository_id = repositories.repository_id AND sessions.owner = ?
        )`;
    const parameters = owner === undefined ? [] : [owner, owner];
    return this.#database.prepare(`
      SELECT repository_id, project_id, path, label, created_at, updated_at
      FROM repositories
      ${where}
      ORDER BY repository_id
    `).all(...parameters).map((row) => repositoryRecordSchema.parse(row));
  }

  listDependentsOf(taskId: string): { task_id: string }[] {
    return this.#database.prepare(
      "SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ?"
    ).all(taskId).map((row) => ({ task_id: String(row.task_id) }));
  }

  listPeople(owner?: string): PersonSummary[] {
    const where = owner === undefined ? "" : "WHERE owner = ?";
    const parameters = owner === undefined ? [] : [owner];
    const rows = this.#database.prepare(`
      SELECT owner, repository_id, COUNT(*) AS task_count
      FROM tasks
      ${where}
      GROUP BY owner, repository_id
    `).all(...parameters);
    const byOwner = new Map<string | null, {
      repositories: string[];
      task_counts: Record<string, number>;
    }>();
    for (const row of rows) {
      const owner = row.owner === null ? null : String(row.owner);
      const repositoryId = String(row.repository_id);
      const entry = byOwner.get(owner) ?? { repositories: [], task_counts: {} };
      entry.repositories.push(repositoryId);
      entry.task_counts[repositoryId] = Number(row.task_count);
      byOwner.set(owner, entry);
    }
    return [...byOwner.entries()]
      .map(([owner, entry]) => ({
        owner,
        task_count: Object.values(entry.task_counts).reduce((sum, n) => sum + n, 0),
        repositories: entry.repositories,
        task_counts: entry.task_counts
      }))
      .sort((a, b) => b.task_count - a.task_count);
  }

  insertNotification(notification: NotificationRecord): void {
    this.#database.prepare(`
      INSERT INTO notifications(
        notification_id, owner, task_id, upstream_task_id,
        upstream_title, upstream_status, read_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      notification.notification_id,
      notification.owner,
      notification.task_id,
      notification.upstream_task_id,
      notification.upstream_title,
      notification.upstream_status,
      notification.read_at,
      notification.created_at
    );
  }

  listNotifications(
    owner: string,
    filter: NotificationListFilter = {}
  ): NotificationRecord[] {
    const conditions = ["n.owner = ?"];
    const parameters: string[] = [owner];
    if (filter.repositoryId !== undefined) {
      conditions.push("t.repository_id = ?");
      parameters.push(filter.repositoryId);
    }
    if (filter.unreadOnly === true) {
      conditions.push("n.read_at IS NULL");
    }
    parameters.push(String(filter.limit ?? 50));

    return this.#database.prepare(`
      SELECT n.notification_id, n.owner, n.task_id, n.upstream_task_id,
        n.upstream_title, n.upstream_status, n.read_at, n.created_at,
        t.repository_id AS repository_id, t.title AS task_title
      FROM notifications n
      JOIN tasks t ON t.task_id = n.task_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY n.created_at DESC
      LIMIT ?
    `).all(...parameters).map((row) => ({
      notification_id: String(row.notification_id),
      owner: row.owner === null ? null : String(row.owner),
      task_id: String(row.task_id),
      repository_id: String(row.repository_id),
      upstream_task_id: String(row.upstream_task_id),
      upstream_title: String(row.upstream_title),
      upstream_status: row.upstream_status as "done" | "cancelled",
      read_at: row.read_at === null ? null : String(row.read_at),
      created_at: String(row.created_at),
      task_title: row.task_title === null || row.task_title === undefined
        ? null
        : String(row.task_title)
    }));
  }

  markNotificationRead(notificationId: string, owner: string): void {
    this.#database.prepare(`
      UPDATE notifications SET read_at = ?
      WHERE notification_id = ? AND read_at IS NULL AND owner = ?
    `).run(new Date().toISOString(), notificationId, owner);
  }

  getDependencyRepairRequest(
    repairId: string,
    owner: string
  ): DependencyRepairRequestRecord | undefined {
    const row = optionalRow(this.#database.prepare(`
      SELECT repair.*
      FROM dependency_repair_requests repair
      JOIN tasks upstream ON upstream.task_id = repair.upstream_task_id
      WHERE repair.repair_id = ? AND upstream.owner = ?
    `).get(repairId, owner));
    return row === undefined ? undefined : dependencyRepairRequestFromRow(row);
  }

  listDependencyRepairRequests(
    owner: string,
    repositoryId?: string
  ): DependencyRepairRequestRecord[] {
    const repositoryClause = repositoryId === undefined
      ? ""
      : " AND upstream.repository_id = ?";
    const parameters = repositoryId === undefined ? [owner] : [owner, repositoryId];
    return this.#database.prepare(`
      SELECT repair.*
      FROM dependency_repair_requests repair
      JOIN tasks upstream ON upstream.task_id = repair.upstream_task_id
      WHERE upstream.owner = ?${repositoryClause}
      ORDER BY repair.updated_at DESC, repair.repair_id
    `).all(...parameters).map(dependencyRepairRequestFromRow);
  }

  getDependencyValidation(validationId: string): DependencyValidationView | undefined {
    const row = this.#database.prepare(`
      SELECT v.*,
        upstream.owner AS upstream_owner,
        upstream.repository_id AS upstream_repository_id,
        upstream.title AS upstream_title,
        downstream.owner AS downstream_owner,
        downstream.repository_id AS downstream_repository_id,
        downstream.title AS downstream_title,
        latest.run_id AS latest_run_id, latest.validation_id AS latest_validation_id,
        latest.attempt AS latest_attempt, latest.status AS latest_status,
        latest.owner AS latest_owner, latest.session_id AS latest_session_id,
        latest.worktree_path AS latest_worktree_path, latest.heartbeat_at AS latest_heartbeat_at,
        latest.expires_at AS latest_expires_at, latest.started_at AS latest_started_at,
        latest.completed_at AS latest_completed_at, latest.verification_json AS latest_verification_json,
        latest.progress_json AS latest_progress_json,
        latest.failure_reason AS latest_failure_reason, latest.error_reason AS latest_error_reason,
        latest.operation_id AS latest_operation_id, latest.created_at AS latest_created_at,
        latest.updated_at AS latest_updated_at
      FROM dependency_validations v
      JOIN tasks upstream ON upstream.task_id = v.upstream_task_id
      JOIN tasks downstream ON downstream.task_id = v.downstream_task_id
      LEFT JOIN dependency_validation_runs latest
        ON latest.validation_id = v.validation_id
       AND latest.attempt = (SELECT MAX(attempt) FROM dependency_validation_runs WHERE validation_id = v.validation_id)
      WHERE v.validation_id = ?
    `).get(validationId);
    return row === undefined ? undefined : this.#hydrateDependencyValidationView(row);
  }

  listDependencyValidationViews(taskId: string): DependencyValidationView[] {
    return this.#database.prepare(`
      SELECT v.*,
        upstream.owner AS upstream_owner,
        upstream.repository_id AS upstream_repository_id,
        upstream.title AS upstream_title,
        downstream.owner AS downstream_owner,
        downstream.repository_id AS downstream_repository_id,
        downstream.title AS downstream_title,
        latest.run_id AS latest_run_id, latest.validation_id AS latest_validation_id,
        latest.attempt AS latest_attempt, latest.status AS latest_status,
        latest.owner AS latest_owner, latest.session_id AS latest_session_id,
        latest.worktree_path AS latest_worktree_path, latest.heartbeat_at AS latest_heartbeat_at,
        latest.expires_at AS latest_expires_at, latest.started_at AS latest_started_at,
        latest.completed_at AS latest_completed_at, latest.verification_json AS latest_verification_json,
        latest.progress_json AS latest_progress_json,
        latest.failure_reason AS latest_failure_reason, latest.error_reason AS latest_error_reason,
        latest.operation_id AS latest_operation_id, latest.created_at AS latest_created_at,
        latest.updated_at AS latest_updated_at
      FROM dependency_validations v
      JOIN tasks upstream ON upstream.task_id = v.upstream_task_id
      JOIN tasks downstream ON downstream.task_id = v.downstream_task_id
      LEFT JOIN dependency_validation_runs latest
        ON latest.validation_id = v.validation_id
       AND latest.attempt = (SELECT MAX(attempt) FROM dependency_validation_runs WHERE validation_id = v.validation_id)
      WHERE v.upstream_task_id = ?
      ORDER BY v.cycle DESC, downstream.repository_id, downstream.title
    `).all(taskId).map((row) => this.#hydrateDependencyValidationView(row));
  }

  listDependencyValidationActivities(
    owner: string,
    filter: DependencyValidationListFilter = {}
  ): DependencyValidationActivity[] {
    const conditions: string[] = [];
    const parameters: string[] = [owner, owner];
    if (filter.repositoryId !== undefined) {
      conditions.push("repository_id = ?");
      parameters.push(filter.repositoryId);
    }
    if (filter.unreadOnly === true) {
      conditions.push("read_at IS NULL");
    }
    parameters.push(String(filter.limit ?? 100));
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;

    return this.#database.prepare(`
      SELECT * FROM (
        SELECT v.*,
          upstream.owner AS upstream_owner,
          upstream.repository_id AS upstream_repository_id,
          upstream.title AS upstream_title,
          downstream.owner AS downstream_owner,
          downstream.repository_id AS downstream_repository_id,
          downstream.title AS downstream_title,
          latest.run_id AS latest_run_id, latest.validation_id AS latest_validation_id,
          latest.attempt AS latest_attempt, latest.status AS latest_status,
          latest.owner AS latest_owner, latest.session_id AS latest_session_id,
          latest.worktree_path AS latest_worktree_path, latest.heartbeat_at AS latest_heartbeat_at,
          latest.expires_at AS latest_expires_at, latest.started_at AS latest_started_at,
          latest.completed_at AS latest_completed_at, latest.verification_json AS latest_verification_json,
          latest.progress_json AS latest_progress_json,
          latest.failure_reason AS latest_failure_reason, latest.error_reason AS latest_error_reason,
          latest.operation_id AS latest_operation_id, latest.created_at AS latest_created_at,
          latest.updated_at AS latest_updated_at,
          'request' AS perspective,
          downstream.repository_id AS repository_id,
          downstream.task_id AS task_id,
          downstream.title AS task_title,
          v.request_read_at AS read_at,
          v.requested_at AS created_at
        FROM dependency_validations v
        JOIN tasks upstream ON upstream.task_id = v.upstream_task_id
        JOIN tasks downstream ON downstream.task_id = v.downstream_task_id
        LEFT JOIN dependency_validation_runs latest
          ON latest.validation_id = v.validation_id
         AND latest.attempt = (SELECT MAX(attempt) FROM dependency_validation_runs WHERE validation_id = v.validation_id)
        WHERE downstream.owner = ?

        UNION ALL

        SELECT v.*,
          upstream.owner AS upstream_owner,
          upstream.repository_id AS upstream_repository_id,
          upstream.title AS upstream_title,
          downstream.owner AS downstream_owner,
          downstream.repository_id AS downstream_repository_id,
          downstream.title AS downstream_title,
          latest.run_id AS latest_run_id, latest.validation_id AS latest_validation_id,
          latest.attempt AS latest_attempt, latest.status AS latest_status,
          latest.owner AS latest_owner, latest.session_id AS latest_session_id,
          latest.worktree_path AS latest_worktree_path, latest.heartbeat_at AS latest_heartbeat_at,
          latest.expires_at AS latest_expires_at, latest.started_at AS latest_started_at,
          latest.completed_at AS latest_completed_at, latest.verification_json AS latest_verification_json,
          latest.progress_json AS latest_progress_json,
          latest.failure_reason AS latest_failure_reason, latest.error_reason AS latest_error_reason,
          latest.operation_id AS latest_operation_id, latest.created_at AS latest_created_at,
          latest.updated_at AS latest_updated_at,
          'response' AS perspective,
          upstream.repository_id AS repository_id,
          upstream.task_id AS task_id,
          upstream.title AS task_title,
          v.response_read_at AS read_at,
          v.responded_at AS created_at
        FROM dependency_validations v
        JOIN tasks upstream ON upstream.task_id = v.upstream_task_id
        JOIN tasks downstream ON downstream.task_id = v.downstream_task_id
        LEFT JOIN dependency_validation_runs latest
          ON latest.validation_id = v.validation_id
         AND latest.attempt = (SELECT MAX(attempt) FROM dependency_validation_runs WHERE validation_id = v.validation_id)
        WHERE upstream.owner = ?
          AND (
            v.status IN ('passed', 'rejected')
            OR (v.status = 'superseded' AND v.responded_at IS NOT NULL)
          )
          AND NOT (
            upstream.owner = downstream.owner
            AND upstream.repository_id = downstream.repository_id
          )
      ) activities
      ${where}
      ORDER BY created_at DESC, validation_id, perspective
      LIMIT ?
    `).all(...parameters).map((row) => ({
      ...this.#hydrateDependencyValidationView(row),
      perspective: row.perspective as DependencyValidationPerspective,
      repository_id: String(row.repository_id),
      task_id: String(row.task_id),
      task_title: String(row.task_title),
      read_at: row.read_at === null ? null : String(row.read_at),
      created_at: String(row.created_at)
    }));
  }

  #hydrateDependencyValidationView(row: SqliteRow): DependencyValidationView {
    const upstreamVersionRow = this.#database.prepare(
      "SELECT version FROM tasks WHERE task_id = ?"
    ).get(String(row.upstream_task_id));
    const upstreamTaskVersion = upstreamVersionRow?.version === undefined
      ? undefined
      : Number(upstreamVersionRow.version);
    const base = dependencyValidationViewFromRow(row, [], upstreamTaskVersion);
    const runs = this.#database.prepare(`
      SELECT run_id, validation_id, attempt, status, owner, session_id,
        worktree_path, heartbeat_at, expires_at, started_at, completed_at,
        verification_json, progress_json, failure_reason, error_reason,
        operation_id, created_at, updated_at
      FROM dependency_validation_runs
      WHERE validation_id = ?
      ORDER BY attempt DESC, created_at DESC, run_id DESC
    `).all(base.validation_id).map((runRow) => (
      dependencyValidationRunViewFromRow(runRow, base.validation_spec)
    ));
    return {
      ...base,
      latest_run: runs[0] ?? null,
      runs
    };
  }

  getDependencyValidationGate(taskId: string): DependencyValidationGate {
    const dependentRow = this.#database.prepare(`
      SELECT COUNT(*) AS dependent_count
      FROM task_dependencies dependency
      JOIN tasks downstream ON downstream.task_id = dependency.task_id
      WHERE dependency.depends_on_task_id = ?
        AND dependency.policy IN ('acceptance_gate', 'hard_block')
        AND downstream.status NOT IN ('done', 'cancelled')
    `).get(taskId);
    const dependentCount = Number(dependentRow?.dependent_count ?? 0);
    if (dependentCount === 0) {
      return {
        dependent_count: 0,
        latest_cycle: null,
        ready_for_acceptance: true
      };
    }
    const cycleRow = this.#database.prepare(`
      SELECT MAX(validation.cycle) AS latest_cycle
      FROM dependency_validations validation
      JOIN task_dependencies dependency
        ON dependency.task_id = validation.downstream_task_id
       AND dependency.depends_on_task_id = validation.upstream_task_id
      JOIN tasks downstream ON downstream.task_id = dependency.task_id
      WHERE validation.upstream_task_id = ?
        AND dependency.policy IN ('acceptance_gate', 'hard_block')
        AND downstream.status NOT IN ('done', 'cancelled')
        AND validation.requested_at >= dependency.created_at
    `).get(taskId);
    const latestCycle = cycleRow?.latest_cycle === null || cycleRow?.latest_cycle === undefined
      ? null
      : Number(cycleRow.latest_cycle);
    if (latestCycle === null) {
      return {
        dependent_count: dependentCount,
        latest_cycle: null,
        ready_for_acceptance: false
      };
    }
    const incompleteRow = this.#database.prepare(`
      SELECT COUNT(*) AS incomplete_count
      FROM task_dependencies dependency
      JOIN tasks downstream ON downstream.task_id = dependency.task_id
      WHERE dependency.depends_on_task_id = ?
        AND dependency.policy IN ('acceptance_gate', 'hard_block')
        AND downstream.status NOT IN ('done', 'cancelled')
        AND NOT EXISTS (
          SELECT 1
          FROM dependency_validations validation
          WHERE validation.upstream_task_id = ?
            AND validation.downstream_task_id = dependency.task_id
            -- A passed response predating the current edge generation must
            -- not be reused after remove/re-add.  The dependency row is
            -- recreated with a fresh created_at on every replacement.
            AND validation.requested_at >= dependency.created_at
            AND validation.cycle = (
              SELECT MAX(candidate.cycle)
              FROM dependency_validations candidate
              WHERE candidate.upstream_task_id = ?
                AND candidate.downstream_task_id = dependency.task_id
                AND candidate.requested_at >= dependency.created_at
            )
            AND validation.status = 'passed'
        )
    `).get(taskId, taskId, taskId);
    return {
      dependent_count: dependentCount,
      latest_cycle: latestCycle,
      ready_for_acceptance: Number(incompleteRow?.incomplete_count ?? 0) === 0
    };
  }

  markDependencyValidationRead(
    validationId: string,
    owner: string,
    perspective: DependencyValidationPerspective
  ): void {
    const nowIso = new Date().toISOString();
    if (perspective === "request") {
      this.#database.prepare(`
        UPDATE dependency_validations
        SET request_read_at = COALESCE(request_read_at, ?)
        WHERE validation_id = ?
          AND EXISTS (
            SELECT 1 FROM tasks downstream
            WHERE downstream.task_id = dependency_validations.downstream_task_id
              AND downstream.owner = ?
          )
      `).run(nowIso, validationId, owner);
      return;
    }
    this.#database.prepare(`
      UPDATE dependency_validations
      SET response_read_at = COALESCE(response_read_at, ?)
      WHERE validation_id = ? AND status <> 'pending'
        AND EXISTS (
          SELECT 1 FROM tasks upstream
          WHERE upstream.task_id = dependency_validations.upstream_task_id
            AND upstream.owner = ?
        )
    `).run(nowIso, validationId, owner);
  }

  listTaskDependencyViews(taskId: string): TaskDependencyView[] {
    return this.#database.prepare(`
      SELECT td.task_id, td.depends_on_task_id, td.created_at,
        td.policy, td.ctx_id, td.generation,
        t.title AS title, t.status AS status, t.repository_id AS repository_id
      FROM task_dependencies td
      JOIN tasks t ON t.task_id = td.depends_on_task_id
      WHERE td.task_id = ?
      ORDER BY td.created_at
    `).all(taskId).map((row) => ({
      task_id: String(row.task_id),
      depends_on_task_id: String(row.depends_on_task_id),
      created_at: String(row.created_at),
      policy: (row.policy === null || row.policy === undefined
        ? "acceptance_gate"
        : String(row.policy)) as NonNullable<TaskDependencyRecord["policy"]>,
      ...(row.ctx_id === null || row.ctx_id === undefined ? {} : { ctx_id: String(row.ctx_id) }),
      generation: Number(row.generation ?? 1),
      title: String(row.title),
      status: taskStatusSchema.parse(row.status),
      repository_id: String(row.repository_id)
    }));
  }

  listTaskEventViews(taskId: string): TaskEventView[] {
    return this.#database.prepare(`
      SELECT event_id, event_type, payload_json, created_at
      FROM task_events
      WHERE task_id = ?
      ORDER BY created_at DESC, event_id
      LIMIT 50
    `).all(taskId).map((row) => ({
      event_id: String(row.event_id),
      event_type: String(row.event_type),
      payload: parseJson(row.payload_json),
      created_at: String(row.created_at)
    }));
  }

  listSessionEvents(sessionId: string): SessionEventRecord[] {
    return this.#database.prepare(`
      SELECT event_id, session_id, event_type, payload_json, created_at
      FROM session_events
      WHERE session_id = ?
      ORDER BY created_at, event_id
    `).all(sessionId).map(sessionEventFromRow);
  }

  listRepoSnapshotViews(taskId: string): RepoSnapshotView[] {
    return this.#database.prepare(`
      SELECT snapshot_id, head_commit, captured_at
      FROM repo_snapshots
      WHERE task_id = ?
      ORDER BY captured_at DESC, snapshot_id
      LIMIT 5
    `).all(taskId).map((row) => ({
      snapshot_id: String(row.snapshot_id),
      head_commit: String(row.head_commit),
      captured_at: String(row.captured_at)
    }));
  }

  latestSnapshotsForWorktree(worktreePath: string): SnapshotConflictView[] {
    return this.#database.prepare(`
      SELECT rs.task_id, rs.worktree_path, rs.changed_files_json, rs.captured_at
      FROM repo_snapshots rs
      INNER JOIN (
        SELECT task_id, MAX(captured_at) AS max_captured
        FROM repo_snapshots
        WHERE worktree_path = ?
        GROUP BY task_id
      ) latest ON rs.task_id = latest.task_id AND rs.captured_at = latest.max_captured
      WHERE rs.worktree_path = ?
    `).all(worktreePath, worktreePath).map((row) => ({
      task_id: String(row.task_id),
      worktree_path: row.worktree_path === null ? undefined : String(row.worktree_path),
      changed_files: row.changed_files_json === null
        ? []
        : JSON.parse(String(row.changed_files_json)) as string[],
      captured_at: String(row.captured_at)
    }));
  }

  listProjects(owner?: string, options: ListProjectsOptions = {}): ProjectWithRepositories[] {
    const taskSummaryOwnerClause = owner === undefined ? "" : `WHERE tasks.owner = ?
          OR summary_projects.created_by = ?
          OR EXISTS (
            SELECT 1 FROM project_members summary_members
            WHERE summary_members.project_id = summary_projects.project_id
              AND summary_members.owner = ?
              AND summary_members.revoked_at IS NULL
          )`;
    const ownerVisibility = owner === undefined
      ? undefined
      : `projects.created_by = ? OR EXISTS (
          SELECT 1 FROM tasks owned_tasks
          JOIN repositories owned_task_repositories
            ON owned_task_repositories.repository_id = owned_tasks.repository_id
          WHERE owned_task_repositories.project_id = projects.project_id
            AND owned_tasks.owner = ?
        ) OR EXISTS (
          SELECT 1 FROM sessions owned_sessions
          JOIN repositories owned_session_repositories
            ON owned_session_repositories.repository_id = owned_sessions.repository_id
          WHERE owned_session_repositories.project_id = projects.project_id
            AND owned_sessions.owner = ?
        ) OR EXISTS (
          SELECT 1 FROM project_members members
          WHERE members.project_id = projects.project_id
            AND members.owner = ?
            AND members.revoked_at IS NULL
        )`;
    // The owner clause is a chain of ORs, so it must be parenthesized before
    // the archive filter is AND-ed on; otherwise the filter binds only to the
    // last OR branch and archived projects leak through the others.
    const conditions = [
      ...(ownerVisibility === undefined ? [] : [`(${ownerVisibility})`]),
      ...(options.include_archived === true ? [] : ["projects.archived_at IS NULL"])
    ];
    const repositoryOwnerClause = conditions.length === 0
      ? ""
      : `WHERE ${conditions.join(" AND ")}`;
    const parameters = owner === undefined
      ? []
      : [owner, owner, owner, owner, owner, owner, owner];
    const rows = this.#database.prepare(`
      WITH task_summary AS (
        SELECT
          tasks.repository_id AS repository_id,
          COUNT(*) AS task_count,
          SUM(CASE WHEN tasks.status = 'pending_acceptance' THEN 1 ELSE 0 END)
            AS pending_acceptance_count,
          SUM(CASE WHEN tasks.status = 'blocked' THEN 1 ELSE 0 END)
            AS blocked_count,
          SUM(CASE
            WHEN tasks.status IN ('in_progress', 'verifying')
              AND unixepoch(tasks.updated_at) < unixepoch('now') - 1800
            THEN 1 ELSE 0 END) AS stale_count
        FROM tasks
        JOIN repositories summary_repositories
          ON summary_repositories.repository_id = tasks.repository_id
        JOIN projects summary_projects
          ON summary_projects.project_id = summary_repositories.project_id
        ${taskSummaryOwnerClause}
        GROUP BY tasks.repository_id
      )
      SELECT
        projects.project_id AS project_id,
        projects.name AS project_name,
        projects.created_by AS project_created_by,
        projects.archived_at AS project_archived_at,
        projects.archived_by AS project_archived_by,
        repositories.repository_id AS repository_id,
        repositories.label AS repository_label,
        COALESCE(task_summary.task_count, 0) AS task_count,
        COALESCE(task_summary.pending_acceptance_count, 0) AS pending_acceptance_count,
        COALESCE(task_summary.blocked_count, 0) AS blocked_count,
        COALESCE(task_summary.stale_count, 0) AS stale_count
      FROM projects
      JOIN repositories ON repositories.project_id = projects.project_id
      LEFT JOIN task_summary ON task_summary.repository_id = repositories.repository_id
      ${repositoryOwnerClause}
      ORDER BY projects.project_id, repositories.repository_id
    `).all(...parameters);
    const byProject = new Map<string, ProjectWithRepositories>();
    for (const row of rows) {
      const project = byProject.get(String(row.project_id)) ?? {
        project_id: String(row.project_id),
        name: String(row.project_name),
        created_by: row.project_created_by === null
          ? null
          : String(row.project_created_by),
        archived_at: row.project_archived_at === null
          ? null
          : String(row.project_archived_at),
        archived_by: row.project_archived_by === null
          ? null
          : String(row.project_archived_by),
        repositories: []
      };
      if (row.repository_id !== null) {
        project.repositories.push({
          repository_id: String(row.repository_id),
          label: String(row.repository_label),
          task_count: Number(row.task_count),
          attention: {
            pending_acceptance: Number(row.pending_acceptance_count),
            blocked: Number(row.blocked_count),
            stale: Number(row.stale_count)
          }
        });
      }
      byProject.set(project.project_id, project);
    }
    return [...byProject.values()];
  }

  createBoardPairing(record: BoardPairingChallengeRecord): void {
    const parsed = boardPairingChallengeSchema.parse(record);
    this.#database.prepare(`
      INSERT INTO board_pairing_challenges(
        challenge_id, code_hash, browser_secret_hash, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      parsed.challenge_id,
      parsed.code_hash,
      parsed.browser_secret_hash,
      parsed.created_at,
      parsed.expires_at
    );
  }

  approveBoardPairing(
    codeHash: string,
    sessionId: string,
    owner: string,
    approvedAt: string
  ): BoardPairingChallengeRecord | undefined {
    const row = optionalRow(this.#database.prepare(`
      UPDATE board_pairing_challenges
      SET approved_session_id = ?, approved_owner = ?, approved_at = ?
      WHERE code_hash = ?
        AND approved_at IS NULL
        AND consumed_at IS NULL
        AND expires_at > ?
      RETURNING *
    `).get(sessionId, owner, approvedAt, codeHash, approvedAt));
    return row === undefined ? undefined : boardPairingFromRow(row);
  }

  getBoardPairing(
    challengeId: string,
    browserSecretHash: string
  ): BoardPairingChallengeRecord | undefined {
    const row = optionalRow(this.#database.prepare(`
      SELECT * FROM board_pairing_challenges
      WHERE challenge_id = ? AND browser_secret_hash = ?
    `).get(challengeId, browserSecretHash));
    return row === undefined ? undefined : boardPairingFromRow(row);
  }

  consumeBoardPairing(
    challengeId: string,
    browserSecretHash: string,
    session: BoardSessionRecord,
    consumedAt: string
  ): boolean {
    const parsed = boardSessionSchema.parse(session);
    return this.#runTransaction(() => {
      const result = this.#database.prepare(`
        UPDATE board_pairing_challenges
        SET consumed_at = ?
        WHERE challenge_id = ?
          AND browser_secret_hash = ?
          AND approved_at IS NOT NULL
          AND consumed_at IS NULL
          AND expires_at > ?
      `).run(consumedAt, challengeId, browserSecretHash, consumedAt);
      if (result.changes !== 1) {
        return false;
      }
      this.#database.prepare(`
        INSERT INTO board_sessions(
          board_session_id, token_hash, owner, source_session_id,
          created_at, expires_at, last_seen_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        parsed.board_session_id,
        parsed.token_hash,
        parsed.owner,
        parsed.source_session_id,
        parsed.created_at,
        parsed.expires_at,
        parsed.last_seen_at,
        parsed.revoked_at ?? null
      );
      return true;
    });
  }

  resolveBoardSession(
    tokenHash: string,
    seenAt: string,
    cookieExpiresAt: string
  ): BoardSessionRecord | undefined {
    return this.#runTransaction(() => {
      const row = optionalRow(this.#database.prepare(`
        SELECT * FROM board_sessions
        WHERE token_hash = ? AND revoked_at IS NULL
      `).get(tokenHash));
      if (row === undefined) {
        return undefined;
      }
      const boardSessionId = z.string().min(1).parse(row.board_session_id);
      this.#database.prepare(`
        UPDATE board_sessions
        SET last_seen_at = ?, expires_at = ?
        WHERE board_session_id = ?
      `).run(seenAt, cookieExpiresAt, boardSessionId);
      return boardSessionFromRow({
        ...row,
        last_seen_at: seenAt,
        expires_at: cookieExpiresAt
      });
    });
  }

  revokeBoardSession(tokenHash: string, revokedAt: string): boolean {
    const result = this.#database.prepare(`
      UPDATE board_sessions SET revoked_at = ?
      WHERE token_hash = ? AND revoked_at IS NULL
    `).run(revokedAt, tokenHash);
    return result.changes === 1;
  }

  listActiveTaskScopes(repositoryId: string): ActiveTaskScope[] {
    return this.#database.prepare(`
      SELECT task_scopes.task_id, task_scopes.scope_type, task_scopes.scope_value
      FROM task_scopes
      JOIN tasks ON tasks.task_id = task_scopes.task_id
      WHERE tasks.repository_id = ?
        AND tasks.status NOT IN ('done', 'cancelled')
      ORDER BY task_scopes.task_id, task_scopes.scope_type, task_scopes.scope_value
    `).all(repositoryId).map((row) => activeTaskScopeSchema.parse(row));
  }
}
