import { z } from "zod";
import {
  taskAttemptDraftSchema,
  taskAttemptSchema,
  taskVerificationEvidenceSchema
} from "./task-recovery-contracts.js";

export const taskStatusSchema = z.enum([
  "backlog",
  "in_progress",
  "waiting_human",
  "blocked",
  "paused",
  "verifying",
  "pending_acceptance",
  "done",
  "cancelled"
]);

export const taskPrioritySchema = z.enum(["P0", "P1", "P2", "P3"]);

export const dependencyPolicySchema = z.enum([
  "informational",
  "validation_gate",
  "acceptance_gate",
  "hard_block"
]);

export const dependencyContextStatusSchema = z.enum([
  "active",
  "cancelled",
  "superseded",
  "closed"
]);

export const dependencySyncStateSchema = z.enum([
  "not_requested",
  "pending",
  "claimed",
  "passed",
  "rejected",
  "cancelled",
  "superseded"
]);

export const dependencyContextEventEnvelopeSchema = z.object({
  ctx_id: z.string().min(1),
  sequence: z.number().int().positive(),
  upstream_task_id: z.string().min(1),
  downstream_task_id: z.string().min(1),
  upstream_repository_id: z.string().min(1),
  downstream_repository_id: z.string().min(1),
  generation: z.number().int().positive(),
  cycle: z.number().int().min(0),
  event_type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  created_at: z.iso.datetime()
});

const checkpointBaseShape = {
  completed_items: z.array(z.string()),
  current_state: z.string().min(1),
  human_context: z.array(z.string()).default([]),
  confirmed_decisions: z.array(z.string()),
  pending_decisions: z.array(z.string()),
  blockers: z.array(z.string()),
  verification: z.array(taskVerificationEvidenceSchema),
  next_action: z.string().min(1),
  source: z.object({
    source_type: z.enum(["native", "legacy_adoption"]),
    source_session_label: z.string().min(1),
    adoption_method: z.enum(["mcp", "web"]),
    adopted_at: z.iso.datetime()
  }).optional()
};

function rejectDuplicateAttempts(
  attempts: readonly { attempt_id: string }[],
  context: z.core.$RefinementCtx
): void {
  const seen = new Set<string>();
  for (const [index, attempt] of attempts.entries()) {
    if (seen.has(attempt.attempt_id)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate attempt_id: ${attempt.attempt_id}`,
        path: [index, "attempt_id"]
      });
    }
    seen.add(attempt.attempt_id);
  }
}

export const checkpointPayloadSchema = z.object({
  ...checkpointBaseShape,
  attempts: z.array(taskAttemptSchema).max(20).optional()
}).superRefine((value, context) => {
  rejectDuplicateAttempts(value.attempts ?? [], context);
});

export const checkpointWritePayloadSchema = z.object({
  ...checkpointBaseShape,
  attempts: z.array(taskAttemptDraftSchema).max(20).optional()
}).superRefine((value, context) => {
  rejectDuplicateAttempts(value.attempts ?? [], context);
});

export const repoSnapshotSchema = z.object({
  repository_id: z.string().min(1),
  repository_path: z.string().min(1),
  head_commit: z.string().min(1),
  captured_at: z.iso.datetime()
});

export const clientFamilySchema = z.enum(["codex", "claude_code", "generic_mcp"]);

export const sessionRecordSchema = z.object({
  session_id: z.string().min(1),
  repository_id: z.string().min(1),
  label: z.string().min(1),
  started_at: z.iso.datetime(),
  ended_at: z.iso.datetime().optional(),
  owner: z.string().min(1).optional(),
  transport_session_id: z.string().min(1).optional(),
  client_name: z.string().min(1).optional(),
  client_version: z.string().min(1).optional(),
  client_family: clientFamilySchema.optional(),
  protocol_version: z.string().min(1).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  workspace_path: z.string().min(1).optional(),
  worktree_path: z.string().min(1).optional(),
  last_activity_at: z.iso.datetime().optional(),
  stale_at: z.iso.datetime().optional(),
  successor_session_id: z.string().min(1).optional(),
  successor_ctx_id: z.string().min(1).optional(),
  /** SHA-256 of the one-time resume token; the raw token is never stored. */
  resume_token_hash: z.string().min(1).optional()
});

export const taskRecordSchema = z.object({
  task_id: z.string().min(1),
  repository_id: z.string().min(1),
  session_id: z.string().min(1).optional(),
  owner: z.string().min(1).optional(),
  title: z.string().min(1),
  status: taskStatusSchema,
  priority: taskPrioritySchema,
  goal: z.string().min(1).optional(),
  acceptance_criteria: z.array(z.string().min(1)).min(1).optional(),
  checkpoint: checkpointPayloadSchema.optional(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime()
});

export const platformErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  evidence: z.array(z.string()),
  recovery_actions: z.array(z.string()),
  current_version: z.string().min(1).optional()
});

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskPriority = z.infer<typeof taskPrioritySchema>;
export type DependencyPolicy = z.infer<typeof dependencyPolicySchema>;
export type DependencyContextStatus = z.infer<typeof dependencyContextStatusSchema>;
export type DependencySyncState = z.infer<typeof dependencySyncStateSchema>;
export type DependencyContextEventEnvelope = z.infer<typeof dependencyContextEventEnvelopeSchema>;
export type TaskRecord = z.infer<typeof taskRecordSchema>;
export type ClientFamily = z.infer<typeof clientFamilySchema>;
export type SessionRecord = z.infer<typeof sessionRecordSchema>;
export type CheckpointPayload = z.infer<typeof checkpointPayloadSchema>;
export type CheckpointWritePayload = z.infer<typeof checkpointWritePayloadSchema>;
export type RepoSnapshot = z.infer<typeof repoSnapshotSchema>;
export type PlatformError = z.infer<typeof platformErrorSchema>;
