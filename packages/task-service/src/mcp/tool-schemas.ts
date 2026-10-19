import { z } from "zod";
import {
  checkpointPayloadSchema,
  checkpointWritePayloadSchema,
  taskPrioritySchema,
  taskStatusSchema
} from "../shared/task-contracts.js";
import { dependencyValidationEvidenceSchema } from "../shared/dependency-validation-contracts.js";
import { hostEvidencePayloadSchema } from "../core/host-evidence-service.js";

/**
 * Zod input schemas for the MCP tools. Every schema is a plain object
 * schema, so fields the agent must not control (client metadata, transport
 * session ids) that a caller still sends are stripped instead of persisted.
 */

export const taskScopeSeedSchema = z.object({
  scope_type: z.enum(["worktree_path", "module_path"]),
  scope_value: z.string().min(1)
});

export const verificationEntrySchema = z.object({
  command: z.string().min(1),
  outcome: z.enum(["passed", "failed", "not_run"]),
  summary: z.string().min(1)
});

export const expectedVersionSchema = z.number().int().min(0);

/** `task_create` and `task_adopt` only ever target a task that does not exist. */
export const createOnlyVersionSchema = z.literal(0);

/** Agent checkpoint targets must be non-terminal and must not bypass review. */
export const checkpointTargetStatusSchema = z.enum([
  "backlog",
  "in_progress",
  "waiting_human",
  "blocked",
  "paused",
  "verifying"
]);

export const adoptSnapshotSchema = z.object({
  repository_path: z.string().min(1).optional(),
  head_commit: z.string().min(1),
  captured_at: z.iso.datetime().optional()
});

/**
 * Only `workspace_path`, `repository_id`, and `worktree_path` are agent input.
 * Client metadata and the transport session id are captured from the MCP
 * initialize handshake and cannot be overridden from the request body.
 */
const ownerSchema = z.string().min(1).optional().describe(
  "Identity of the person this session works for (e.g. `git config user.name` "
    + "run on YOUR machine). The server cannot read your local git config "
    + "when it runs remotely, so pass this explicitly; tasks you create "
    + "inherit it and the web board groups/filters by it."
);

export const sessionContextInputSchema = z.object({
  workspace_path: z.string().min(1),
  repository_id: z.string().min(1),
  worktree_path: z.string().min(1),
  owner: ownerSchema,
  successor_session_id: z.string().min(1).optional(),
  successor_ctx_id: z.string().min(1).optional(),
  resume_session_id: z.string().min(1).optional().describe(
    "Re-attach this session after its MCP transport died (e.g. SESSION_NOT_FOUND after a"
      + " server restart). Requires the original workspace/worktree/repository context and resume_token."
  ),
  resume_token: z.string().min(1).optional().describe(
    "Raw resume token returned by the original session_context call; rotated on every bind or resume."
  )
});

export const sessionRebindInputSchema = z.object({
  session_id: z.string().min(1),
  operation_id: z.string().min(1),
  repository_id: z.string().min(1),
  owner: z.string().min(1).describe(
    "Exact git config user.name already bound to this session; rebinding cannot change it."
  ),
  expected_worktree_path: z.string().min(1).describe(
    "Current worktree_path returned by session_context, used as an optimistic guard."
  ),
  workspace_path: z.string().min(1),
  worktree_path: z.string().min(1)
});

export const boardPairInputSchema = z.object({
  pairing_code: z.string().min(1).max(64)
});

export const repositoryBootstrapInputSchema = z.object({
  owner: z.string().min(1).describe(
    "Exact git config user.name read from the current worktree."
  ),
  operation_id: z.string().min(1).describe(
    "Fresh idempotency key; reuse it only when retrying this bootstrap."
  ),
  project_name: z.string().min(1).max(120),
  project_id: z.string().min(1).max(64).optional(),
  repository_id: z.string().min(1).max(64),
  repository_name: z.string().min(1).max(120),
  path: z.string().min(1).max(1024),
  workspace_path: z.string().min(1).max(1024),
  worktree_path: z.string().min(1).max(1024)
});

export const repositoryRebindInputSchema = z.object({
  session_id: z.string().min(1),
  operation_id: z.string().min(1),
  owner: z.string().min(1),
  repository_id: z.string().min(1).max(64),
  path: z.string().min(1).max(1024),
  repository_name: z.string().min(1).max(120).optional()
});

export const taskListInputSchema = z.object({
  owner: ownerSchema,
  repository_id: z.string().min(1).optional(),
  project_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  scope: z.enum(["project"]).optional(),
  status: z.array(taskStatusSchema).optional(),
  priority: z.array(taskPrioritySchema).optional()
});

export const projectShareCreateInputSchema = z.object({
  session_id: z.string().min(1),
  operation_id: z.string().min(1),
  project_id: z.string().min(1)
});

export const projectShareAcceptInputSchema = z.object({
  session_id: z.string().min(1),
  operation_id: z.string().min(1),
  token: z.string().min(1)
});

export const projectMembersListInputSchema = z.object({
  session_id: z.string().min(1),
  project_id: z.string().min(1)
});

export const projectMemberRemoveInputSchema = z.object({
  session_id: z.string().min(1),
  operation_id: z.string().min(1),
  project_id: z.string().min(1),
  owner: z.string().min(1)
});

export const projectShareRevokeInputSchema = z.object({
  session_id: z.string().min(1),
  operation_id: z.string().min(1),
  project_id: z.string().min(1),
  share_id: z.string().min(1)
});

/** Agent-facing dependency validation tools. The repository id is explicit in
 * the list request for callers to declare the intended bound repository; the
 * service still authorizes against the transport-bound session. */
export const dependencyValidationListInputSchema = z.object({
  session_id: z.string().min(1),
  owner: z.string().min(1),
  repository_id: z.string().min(1)
});

export const dependencyContextGetInputSchema = z.object({
  session_id: z.string().min(1),
  ctx_id: z.string().min(1)
});

export const dependencyValidationReceiveInputSchema = z.object({
  session_id: z.string().min(1),
  operation_id: z.string().min(1),
  validation_id: z.string().min(1),
  owner: z.string().min(1)
});

export const dependencyValidationCheckpointInputSchema = dependencyValidationReceiveInputSchema.extend({
  run_id: z.string().min(1),
  progress: z.unknown()
});

export const dependencyValidationCompleteInputSchema = dependencyValidationReceiveInputSchema.extend({
  run_id: z.string().min(1),
  status: z.enum(["passed", "rejected", "error"]),
  // Do not reuse the task checkpoint schema here: it strips revision and
  // worktree evidence that the Board must audit.
  verification: z.array(dependencyValidationEvidenceSchema).max(256),
  reason: z.string().optional()
});

export const taskGetInputSchema = z.object({
  task_id: z.string().min(1),
  session_id: z.string().min(1).optional()
});

export const taskRecoveryGetInputSchema = z.object({
  session_id: z.string().min(1),
  task_id: z.string().min(1)
});

export const operationResultGetInputSchema = z.object({
  session_id: z.string().min(1),
  operation_id: z.string().min(1)
});

export const dependencyRepairListInputSchema = z.object({
  session_id: z.string().min(1),
  owner: z.string().min(1),
  repository_id: z.string().min(1).optional()
});

export const dependencyRepairReceiveInputSchema = z.object({
  session_id: z.string().min(1),
  operation_id: z.string().min(1),
  repair_id: z.string().min(1),
  owner: z.string().min(1),
  expected_version: expectedVersionSchema
});

export const conflictProposedScopeSchema = z.object({
  repository_id: z.string().min(1),
  worktree_path: z.string().min(1),
  scopes: z.array(taskScopeSeedSchema).optional(),
  changed_files: z.array(z.string().min(1)).optional()
});

/**
 * Exactly one of `task_id` (existing task) or `proposed` (scope that has no
 * task yet); sending both or neither is rejected.
 */
export const taskConflictsInputSchema = z.object({
  task_id: z.string().min(1).optional(),
  proposed: conflictProposedScopeSchema.optional()
}).superRefine((value, ctx) => {
  const hasTaskId = value.task_id !== undefined;
  const hasProposed = value.proposed !== undefined;
  if (hasTaskId === hasProposed) {
    ctx.addIssue({
      code: "custom",
      path: [hasTaskId ? "proposed" : "task_id"],
      message: "Provide exactly one of task_id or proposed"
    });
  }
});

export const taskAttachInputSchema = z.object({
  session_id: z.string().min(1),
  operation_id: z.string().min(1),
  expected_version: expectedVersionSchema,
  task_id: z.string().min(1),
  role: z.string().min(1)
});

export const taskCreateInputSchema = z.object({
  owner: ownerSchema,
  session_id: z.string().min(1),
  operation_id: z.string().min(1),
  expected_version: createOnlyVersionSchema,
  repository_id: z.string().min(1),
  title: z.string().min(1),
  goal: z.string().min(1),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  next_action: z.string().min(1),
  priority: taskPrioritySchema,
  scopes: z.array(taskScopeSeedSchema).optional(),
  dependencies: z.array(z.string().min(1)).optional()
});

export const repositoryRegisterInputSchema = z.object({
  session_id: z.string().min(1).describe(
    "Existing bound platform session authorizing this registration."
  ),
  operation_id: z.string().min(1).describe(
    "Fresh idempotency key; reuse it only when retrying the same registration."
  ),
  project_name: z.string().min(1).max(120).describe(
    "Project name as stated by the user. Matched against existing project"
      + " names; an unknown name creates a new project."
  ),
  project_id: z.string().min(1).max(64).optional().describe(
    "Explicit project id; omit it unless the user provided one."
  ),
  repository_id: z.string().min(1).max(64).describe(
    "Stable id for the repository. Derive it from the git remote"
      + " (e.g. `lkf-frontend`) or the directory name."
  ),
  repository_name: z.string().min(1).max(120).describe(
    "Human-readable label, e.g. the repo directory name."
  ),
  path: z.string().min(1).max(1024).describe(
    "Absolute path of the repository root on YOUR machine"
      + " (git rev-parse --show-toplevel)."
  )
});

export const taskAdoptInputSchema = z.object({
  session_id: z.string().min(1),
  operation_id: z.string().min(1),
  expected_version: createOnlyVersionSchema,
  owner: ownerSchema,
  legacy_import_key: z.string().min(1),
  source_session_label: z.string().min(1),
  project_id: z.string().min(1),
  repository_id: z.string().min(1),
  worktree_path: z.string().min(1),
  normalized_title: z.string().min(1),
  title: z.string().min(1).optional(),
  goal: z.string().min(1),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  priority: taskPrioritySchema,
  status: taskStatusSchema,
  checkpoint: checkpointPayloadSchema,
  snapshot: adoptSnapshotSchema,
  scopes: z.array(taskScopeSeedSchema).optional(),
  dependencies: z.array(z.string().min(1)).optional()
});

export const taskStartInputSchema = z.object({
  session_id: z.string().min(1),
  operation_id: z.string().min(1),
  task_id: z.string().min(1),
  expected_version: expectedVersionSchema,
  acknowledged_warning_codes: z.array(z.string().min(1)).optional()
});

export const taskConfirmDecisionInputSchema = z.object({
  session_id: z.string().min(1),
  operation_id: z.string().min(1),
  task_id: z.string().min(1),
  expected_version: expectedVersionSchema,
  question: z.string().trim().min(1),
  decision: z.string().trim().min(1)
});

export const taskCheckpointInputSchema = z.object({
  session_id: z.string().min(1),
  operation_id: z.string().min(1),
  task_id: z.string().min(1),
  expected_version: expectedVersionSchema,
  checkpoint: checkpointWritePayloadSchema,
  target_status: checkpointTargetStatusSchema.optional()
});

export const taskSwitchInputSchema = z.object({
  session_id: z.string().min(1),
  operation_id: z.string().min(1),
  task_id: z.string().min(1),
  expected_version: expectedVersionSchema,
  checkpoint: checkpointWritePayloadSchema,
  target_task_id: z.string().min(1),
  target_expected_version: expectedVersionSchema,
  target_worktree_path: z.string().min(1).optional().describe(
    "Desired worktree_path for the target task. When provided, task_switch uses it"
      + " instead of the target task's existing worktree scope and atomically replaces"
      + " that scope after conflict checks."
  ),
  acknowledged_warning_codes: z.array(z.string().min(1)).optional()
});

export const taskDependenciesUpdateInputSchema = z.object({
  session_id: z.string().min(1),
  operation_id: z.string().min(1),
  task_id: z.string().min(1),
  expected_version: z.number().int().min(0),
  dependencies: z.array(z.string().min(1)),
  policies: z.record(z.string().min(1), z.enum(["informational", "validation_gate", "acceptance_gate", "hard_block"])).optional()
});

export const taskSubmitInputSchema = z.object({
  session_id: z.string().min(1),
  operation_id: z.string().min(1),
  task_id: z.string().min(1),
  expected_version: expectedVersionSchema,
  verification: z.array(verificationEntrySchema).min(1)
});

export const taskDependencyValidationRequestInputSchema = taskSubmitInputSchema;

export const hostKeyRegisterInputSchema = z.object({
  owner: z.string().min(1).describe(
    "Exact git config user.name this host key is bound to."
  ),
  label: z.string().min(1).max(200).describe(
    "Human-readable host label, e.g. hostname."
  ),
  public_key_b64: z.string().min(1).describe(
    "Ed25519 public key, SPKI DER, base64."
  ),
  rotation_signature_b64: z.string().min(1).optional().describe(
    "Rotation proof: previous host key's Ed25519 signature over the "
      + "SHA-256 digest of the new SPKI public key."
  )
});

export const worktreeEvidenceChallengeInputSchema = z.object({
  session_id: z.string().min(1),
  operation: z.enum(["checkpoint", "submit"]),
  task_id: z.string().min(1).optional().describe(
    "Required for submit; recommended for checkpoint when the task is leased."
  )
});

export const worktreeEvidenceSubmitInputSchema = z.object({
  payload: hostEvidencePayloadSchema,
  signature_b64: z.string().min(1).describe(
    "Base64 Ed25519 signature over the canonical JSON bytes of payload."
  )
});

export type SessionContextToolInput = z.infer<typeof sessionContextInputSchema>;
export type SessionRebindToolInput = z.infer<typeof sessionRebindInputSchema>;
export type BoardPairToolInput = z.infer<typeof boardPairInputSchema>;
export type TaskListToolInput = z.infer<typeof taskListInputSchema>;
export type DependencyValidationListToolInput = z.infer<typeof dependencyValidationListInputSchema>;
export type DependencyValidationReceiveToolInput = z.infer<typeof dependencyValidationReceiveInputSchema>;
export type DependencyValidationCheckpointToolInput = z.infer<typeof dependencyValidationCheckpointInputSchema>;
export type DependencyValidationCompleteToolInput = z.infer<typeof dependencyValidationCompleteInputSchema>;
export type TaskGetToolInput = z.infer<typeof taskGetInputSchema>;
export type TaskRecoveryGetToolInput = z.infer<typeof taskRecoveryGetInputSchema>;
export type DependencyRepairListToolInput = z.infer<typeof dependencyRepairListInputSchema>;
export type DependencyRepairReceiveToolInput = z.infer<typeof dependencyRepairReceiveInputSchema>;
export type TaskConflictsToolInput = z.infer<typeof taskConflictsInputSchema>;
export type ConflictProposedScopeInput = z.infer<typeof conflictProposedScopeSchema>;
export type TaskAttachToolInput = z.infer<typeof taskAttachInputSchema>;
export type TaskCreateToolInput = z.infer<typeof taskCreateInputSchema>;
export type TaskAdoptToolInput = z.infer<typeof taskAdoptInputSchema>;
export type TaskStartToolInput = z.infer<typeof taskStartInputSchema>;
export type TaskConfirmDecisionToolInput = z.infer<typeof taskConfirmDecisionInputSchema>;
export type TaskCheckpointToolInput = z.infer<typeof taskCheckpointInputSchema>;
export type TaskSwitchToolInput = z.infer<typeof taskSwitchInputSchema>;
export type TaskSubmitToolInput = z.infer<typeof taskSubmitInputSchema>;
