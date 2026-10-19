/// <reference types="node" />

import { randomUUID } from "node:crypto";
import type {
  ConflictReport,
  ConflictSide,
  SoftDependency
} from "./conflict-policy.js";
import { evaluateConflicts } from "./conflict-policy.js";
import { canonicalRequestHash } from "./operation-fingerprint.js";
import { normalizeWorktreePath } from "../shared/worktree-path.js";
import type {
  RepoProbeInput,
  RepoSnapshotDraft
} from "../repo/repo-probe.js";
import {
  checkpointPayloadSchema,
  checkpointWritePayloadSchema,
  type CheckpointPayload,
  type CheckpointWritePayload,
  type SessionRecord,
  type TaskPriority,
  type TaskRecord,
  type TaskStatus
} from "../shared/task-contracts.js";
import {
  taskAttemptSchema,
  type TaskAttempt,
  type TaskAttemptDraft
} from "../shared/task-recovery-contracts.js";
import {
  assertDependencyValidationSpecIdentity,
  dependencyValidationEvidenceSchema,
  sanitizeDependencyValidationEvidence,
  sanitizeDependencyValidationProgress,
  sanitizeDependencyValidationSpec,
  sanitizeDependencyValidationText,
  type DependencyValidationEvidence,
  type DependencyValidationSpec
} from "../shared/dependency-validation-contracts.js";
import {
  StorageError,
  type ActiveTaskLease,
  type ActiveTaskScope,
  type DependencyRepairRequestRecord,
  type DependencyValidationRecord,
  type DependencyValidationRunRecord,
  type DependencyValidationView,
  type DependencyValidationGate,
  type DependencyContextEventRecord,
  type DependencyContextRecord,
  type JsonValue,
  type LegacyTaskImport,
  type OperationResult,
  type ProgressStore,
  type ProgressTransaction,
  type RepoSnapshotRecord,
  type RepositoryRecord,
  type TaskDetail,
  type TaskDependencyRecord,
  type TaskListFilter,
  type TaskSummary,
  type TaskRecoveryView
} from "../storage/progress-store.js";
import { assertHumanOnlyAction, assertTransition, statusHoldsLease } from "./task-state.js";
import type { ProjectAccessService } from "./project-access-service.js";

export type TaskActor = "agent" | "human";

export interface RepoProbeLike {
  inspect(input: RepoProbeInput): Promise<RepoSnapshotDraft>;
}

export type PlatformErrorCode =
  | "INVALID_INPUT"
  | "BOARD_AUTH_REQUIRED"
  | "BOARD_PAIRING_EXPIRED"
  | "BOARD_PAIRING_NOT_FOUND"
  | "BOARD_PAIRING_SESSION_INVALID"
  | "CHECKPOINT_REQUIRED"
  | "HUMAN_CONFIRMATION_REQUIRED"
  | "TASK_VERSION_CONFLICT"
  | "TASK_LEASE_CONFLICT"
  | "TASK_ALREADY_ADOPTED"
  | "TASK_NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "SESSION_CONTEXT_CONFLICT"
  | "SESSION_SUPERSEDED"
  | "SESSION_RESUME_FAILED"
  | "LEASE_NOT_FOUND"
  | "DECISION_NOT_PENDING"
  | "ACTIVE_UPSTREAM_DEPENDENCY"
  | "DEPENDENCY_VALIDATION_NOT_FOUND"
  | "DEPENDENCY_VALIDATION_REQUIRED"
  | "DEPENDENCY_VALIDATION_ALREADY_RESPONDED"
  | "DEPENDENCY_REPAIR_NOT_FOUND"
  | "INVALID_TRANSITION"
  | "REPOSITORY_NOT_ALLOWED"
  | "REMOTE_WORKTREE_EVIDENCE_REQUIRED"
  | "HOST_KEY_REJECTED"
  | "CHALLENGE_EXPIRED"
  | "CHALLENGE_REPLAY"
  | "HOST_EVIDENCE_MISMATCH"
  | "REPOSITORY_EXISTS"
  | "PROJECT_CONFLICT"
  | "PROJECT_ACCESS_REQUIRED"
  | "PROJECT_CREATOR_REQUIRED"
  | "PROJECT_SHARE_INVALID"
  | "PROJECT_ARCHIVED"
  | "PROJECT_HAS_OPEN_TASKS"
  | "REPOSITORY_PATH_CONFLICT"
  | "BOOTSTRAP_NOT_CONFIGURED"
  | "REPO_PROBE_FAILED"
  | "SESSION_MISMATCH"
  | "OWNER_MISMATCH"
  | "OPERATION_ID_CONFLICT"
  | "WORKTREE_CONFLICT"
  | "FILE_CONFLICT"
  | "MODULE_OVERLAP"
  | "SOFT_DEPENDENCY"
  | "STORAGE_BUSY";

export interface PlatformDomainErrorOptions {
  retryable?: boolean;
  evidence?: readonly string[];
  recovery_actions?: readonly string[];
  current_version?: string;
  /** Optional machine-readable context (for example open-task breakdowns). */
  details?: Readonly<Record<string, JsonValue>>;
}

/**
 * Domain error whose fields line up with `platformErrorSchema`: code, message,
 * retryable, evidence, recovery_actions, and an optional current_version
 * (stringified because the shared schema declares it a string).
 */
export class PlatformDomainError extends Error {
  readonly code: PlatformErrorCode;
  readonly retryable: boolean;
  readonly evidence: readonly string[];
  readonly recovery_actions: readonly string[];
  readonly current_version?: string;
  readonly details?: Readonly<Record<string, JsonValue>>;

  constructor(
    code: PlatformErrorCode,
    message: string,
    options: PlatformDomainErrorOptions = {}
  ) {
    super(message);
    this.name = "PlatformDomainError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.evidence = options.evidence ?? [];
    this.recovery_actions = options.recovery_actions ?? [];
    if (options.current_version !== undefined) {
      this.current_version = options.current_version;
    }
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

/** Minimal project shape needed to report an archived project. */
export interface ArchivableProject {
  project_id: string;
  name: string;
  archived_at?: string | null;
  archived_by?: string | null;
}

export function assertProjectNotArchived(project: ArchivableProject | undefined): void {
  if (project === undefined || project.archived_at === null || project.archived_at === undefined) {
    return;
  }
  throw projectArchivedError(project);
}

export function projectArchivedError(project: ArchivableProject): PlatformDomainError {
  return new PlatformDomainError(
    "PROJECT_ARCHIVED",
    `Project ${project.name} (${project.project_id}) is archived and read-only`,
    {
      evidence: [
        project.project_id,
        `archived_at=${project.archived_at ?? ""}`,
        `archived_by=${project.archived_by ?? ""}`
      ],
      recovery_actions: [
        "Restore the project from the Board dashboard's archived section before writing to it."
      ]
    }
  );
}

export interface TaskScopeSeed {
  scope_type: string;
  scope_value: string;
}

export interface VerificationEntry {
  command: string;
  outcome: "passed" | "failed" | "not_run";
  summary: string;
}

export interface OperationResultLookup extends OperationResult {
  source_session_id: string;
}

export interface CreateTaskInput {
  session_id: string;
  operation_id: string;
  expected_version: 0;
  owner?: string;
  repository_id: string;
  title: string;
  goal: string;
  acceptance_criteria: readonly string[];
  next_action: string;
  priority: TaskPriority;
  scopes?: readonly TaskScopeSeed[];
  dependencies?: readonly string[];
}

export interface AttachTaskInput {
  session_id: string;
  operation_id: string;
  task_id: string;
  role: string;
}

export interface StartTaskInput {
  session_id: string;
  operation_id: string;
  task_id: string;
  expected_version: number;
  acknowledged_warning_codes?: readonly string[];
}

export interface CheckpointTaskInput {
  session_id: string;
  operation_id: string;
  task_id: string;
  expected_version: number;
  checkpoint: CheckpointWritePayload;
  target_status?: TaskStatus;
}

export interface SwitchTaskInput {
  session_id: string;
  operation_id: string;
  task_id: string;
  expected_version: number;
  checkpoint: CheckpointWritePayload | undefined;
  target_task_id: string;
  target_expected_version: number;
  target_worktree_path?: string;
  acknowledged_warning_codes?: readonly string[];
}

export interface SubmitTaskInput {
  session_id: string;
  operation_id: string;
  task_id: string;
  expected_version: number;
  verification: readonly VerificationEntry[];
}

export type RequestTaskDependencyValidationInput = SubmitTaskInput;

export interface AdoptSnapshotInput {
  repository_path?: string;
  head_commit: string;
  captured_at?: string;
}

export interface AdoptTaskInput {
  session_id: string;
  operation_id: string;
  expected_version: 0;
  owner?: string;
  legacy_import_key: string;
  source_session_label: string;
  project_id: string;
  repository_id: string;
  worktree_path: string;
  normalized_title: string;
  title?: string;
  goal: string;
  acceptance_criteria: readonly string[];
  priority: TaskPriority;
  status: TaskStatus;
  checkpoint: CheckpointPayload;
  snapshot: AdoptSnapshotInput;
  scopes?: readonly TaskScopeSeed[];
  dependencies?: readonly string[];
}

/** Scope a caller proposes to work in, before any task exists for it. */
export interface ConflictProposedScope {
  repository_id: string;
  worktree_path: string;
  scopes?: readonly TaskScopeSeed[];
  changed_files?: readonly string[];
}

/**
 * Either an existing task to probe-and-compare, or a proposed scope that has
 * no task yet. Provide exactly one of `task_id` / `proposed`.
 */
export type CheckConflictsInput = {
  session_id: string;
  task_id: string;
} | {
  session_id: string;
  proposed: ConflictProposedScope;
};

export interface HumanActionContext {
  expected_version?: number;
  note?: string;
}

export interface DependencyValidationResponseResult {
  validation_id: string;
  upstream_task_id: string;
  downstream_task_id: string;
  status: "passed" | "rejected";
}

export interface DependencyValidationListInput {
  session_id: string;
  owner: string;
  repository_id?: string;
}

export interface DependencyValidationReceiveInput {
  session_id: string;
  operation_id: string;
  validation_id: string;
  owner: string;
}

export interface DependencyValidationCheckpointInput extends DependencyValidationReceiveInput {
  run_id: string;
  progress: JsonValue;
}

export interface DependencyValidationCompleteInput extends DependencyValidationReceiveInput {
  run_id: string;
  status: "passed" | "rejected" | "error";
  verification: readonly DependencyValidationEvidence[];
  reason?: string;
}

export interface DependencyValidationReceiveResult {
  validation_id: string;
  run_id: string;
  attempt: number;
  status: "claimed" | "capped";
  validation_spec: DependencyValidationSpec;
  run?: DependencyValidationRunRecord;
  capped?: boolean;
  recovery_actions?: readonly string[];
}

export interface DependencyValidationCompleteResult {
  request: DependencyValidationRecord;
  validation: DependencyValidationRecord;
  run: DependencyValidationRunRecord;
  gate: DependencyValidationGate;
}

export interface DependencyRepairListInput {
  session_id: string;
  owner: string;
  repository_id?: string;
}

export interface DependencyRepairReceiveInput {
  session_id: string;
  operation_id: string;
  repair_id: string;
  owner: string;
  expected_version: number;
}

export interface DependencyRepairReceiveResult extends TaskMutationResult {
  repair: DependencyRepairRequestRecord;
}

export interface UpdateTaskDependenciesInput {
  session_id: string;
  operation_id: string;
  task_id: string;
  expected_version: number;
  dependencies: readonly string[];
  policies?: Readonly<Record<string, TaskDependencyRecord["policy"]>>;
}

export interface HumanUpdateChanges {
  title?: string;
  priority?: TaskPriority;
}

export interface ConfirmTaskDecisionInput {
  session_id: string;
  operation_id: string;
  task_id: string;
  expected_version: number;
  question: string;
  decision: string;
}

export interface TaskMutationResult {
  task_id: string;
  status: TaskStatus;
  version: number;
  dependency_repair_changes?: readonly DependencyRepairChangeIdentity[];
}

export interface DependencyRepairChangeIdentity {
  repair_id: string;
  validation_id: string;
  upstream_task_id: string;
  downstream_task_id: string;
  cycle: number;
  status: DependencyRepairRequestRecord["status"];
}

export interface SwitchTaskResult extends TaskMutationResult {
  paused_task_id: string;
  paused_task_version: number;
  previous_worktree_path: string;
  worktree_path: string;
}

export interface AttachTaskResult extends TaskMutationResult {
  session_id: string;
  role: string;
}

export interface HumanUpdateResult extends TaskMutationResult {
  title: string;
  priority: TaskPriority;
}

export interface TaskServiceDeps {
  store: ProgressStore;
  probe: RepoProbeLike;
  projectAccess?: ProjectAccessService;
  now?: () => string;
  leaseTtlMs?: number;
}

export interface DependencyContextView {
  context: DependencyContextRecord;
  events: readonly DependencyContextEventRecord[];
}

const defaultLeaseTtlMs = 1_800_000;
const maxDependencyValidationAttempts = 2;

/**
 * Task lifecycle service on top of ProgressStore, RepoProbe, the conflict
 * policy, and the task state machine. All agent writes run inside a single
 * store transaction behind an operation-result idempotency wrapper; repo
 * probes happen strictly before the transaction so transaction bodies stay
 * synchronous.
 */
export class TaskService {
  readonly #store: ProgressStore;
  readonly #probe: RepoProbeLike;
  readonly #projectAccess?: ProjectAccessService;
  readonly #now: () => string;
  readonly #leaseTtlMs: number;

  constructor(deps: TaskServiceDeps) {
    this.#store = deps.store;
    this.#probe = deps.probe;
    if (deps.projectAccess !== undefined) {
      this.#projectAccess = deps.projectAccess;
    }
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.#leaseTtlMs = deps.leaseTtlMs ?? defaultLeaseTtlMs;
  }

  async listTasks(filter: TaskListFilter = {}): Promise<TaskSummary[]> {
    return this.#store.listTasks(filter);
  }

  async listDependencyRepairRequests(
    input: DependencyRepairListInput
  ): Promise<DependencyRepairRequestRecord[]> {
    const session = this.#session(input.session_id);
    if (session.owner !== input.owner) {
      throw new PlatformDomainError(
        "OWNER_MISMATCH",
        "Session owner does not match repair-list owner"
      );
    }
    if (input.repository_id !== undefined
      && input.repository_id !== session.repository_id) {
      throw new PlatformDomainError(
        "SESSION_CONTEXT_CONFLICT",
        "Repair-list repository does not match the bound session"
      );
    }
    return this.#store.listDependencyRepairRequests(
      input.owner,
      input.repository_id ?? session.repository_id
    ).filter((repair) => repair.status === "pending" || repair.status === "claimed");
  }

  async receiveDependencyRepair(
    input: DependencyRepairReceiveInput
  ): Promise<DependencyRepairReceiveResult> {
    const cached = this.#cachedOperation<DependencyRepairReceiveResult>(
      input.session_id,
      input.operation_id,
      "dependency_repair_receive",
      input
    );
    if (cached !== undefined) {
      return cached;
    }
    const session = this.#session(input.session_id);
    if (session.owner !== input.owner) {
      throw new PlatformDomainError(
        "OWNER_MISMATCH",
        "Session owner does not match repair owner"
      );
    }
    const draft = await this.#probeWorktree(session);
    return this.#runTx(() => this.#withOperation(
      input.session_id,
      input.operation_id,
      "dependency_repair_receive",
      input,
      (tx) => {
        const txSession = this.#txSession(tx, input.session_id);
        if (txSession.owner !== input.owner) {
          throw new PlatformDomainError("OWNER_MISMATCH", "Session owner changed");
        }
        const repair = tx.getDependencyRepairRequest(input.repair_id);
        if (repair === undefined) {
          throw new PlatformDomainError(
            "DEPENDENCY_REPAIR_NOT_FOUND",
            `Dependency repair ${input.repair_id} was not found`,
            { evidence: [input.repair_id] }
          );
        }
        const task = this.#txTask(tx, repair.upstream_task_id);
        this.#assertSameRepository(txSession, task.repository_id);
        this.#assertSameOwner(txSession, task.owner, task.task_id);
        if (repair.status !== "pending") {
          throw new PlatformDomainError(
            "INVALID_TRANSITION",
            `Dependency repair ${repair.repair_id} is ${repair.status}`,
            { evidence: [repair.repair_id, repair.status] }
          );
        }
        this.#assertVersion(task.task_id, input.expected_version);
        if (task.status !== "pending_acceptance") {
          throw new PlatformDomainError(
            "INVALID_TRANSITION",
            "Only a pending_acceptance task can receive dependency repair work",
            { evidence: [task.task_id, task.status] }
          );
        }
        const validation = tx.getDependencyValidation(repair.validation_id);
        if (validation === undefined
          || validation.status !== "rejected"
          || validation.cycle !== repair.cycle
          || validation.upstream_task_id !== task.task_id
          || validation.downstream_task_id !== repair.downstream_task_id) {
          throw new PlatformDomainError(
            "DEPENDENCY_VALIDATION_REQUIRED",
            "Repair request no longer matches a rejected dependency validation",
            { evidence: [repair.repair_id, repair.validation_id] }
          );
        }
        this.#assertDependencyValidationLink(tx, validation);
        const downstream = this.#txTask(tx, repair.downstream_task_id);
        if (downstream.status === "done" || downstream.status === "cancelled") {
          throw new PlatformDomainError(
            "DEPENDENCY_VALIDATION_REQUIRED",
            "Repair request belongs to a terminal downstream task",
            { evidence: [repair.repair_id, downstream.status] }
          );
        }
        const latestCycle = this.#latestDependencyValidationCycle(tx, validation);
        if (latestCycle !== repair.cycle) {
          throw new PlatformDomainError(
            "TASK_VERSION_CONFLICT",
            "Repair request was superseded by a newer validation cycle",
            { current_version: String(latestCycle) }
          );
        }
        const newerActiveRepair = tx.listDependencyRepairsForUpstream(task.task_id)
          .some((candidate) => candidate.cycle > repair.cycle
            && (candidate.status === "pending" || candidate.status === "claimed"));
        if (newerActiveRepair) {
          throw new PlatformDomainError(
            "TASK_VERSION_CONFLICT",
            "Repair request was superseded by newer repair work"
          );
        }
        this.#assertLeasesAvailable(
          tx,
          task.task_id,
          input.session_id,
          draft.worktree_path
        );
        this.#assertWorktreeFreeInTx(tx, draft.worktree_path, [task.task_id]);
        assertTransition("dependency_repair", task.status, "in_progress");
        const nowIso = this.#now();
        tx.updateTask({
          ...task,
          status: "in_progress",
          session_id: input.session_id,
          updated_at: nowIso
        }, input.expected_version);
        this.#setWorktreeScope(tx, task.task_id, draft.worktree_path);
        tx.upsertTaskSessionLink({
          task_id: task.task_id,
          session_id: input.session_id,
          linked_at: nowIso
        });
        tx.putLease(this.#lease(
          task.task_id,
          input.session_id,
          nowIso,
          input.expected_version + 1
        ));
        const claimedRepair: DependencyRepairRequestRecord = {
          ...repair,
          status: "claimed",
          claimed_session_id: input.session_id,
          claimed_worktree_path: draft.worktree_path,
          claimed_at: nowIso,
          updated_at: nowIso
        };
        tx.updateDependencyRepairRequest(claimedRepair, "pending");
        this.#appendDependencyContextEvent(
          tx,
          repair.ctx_id ?? undefined,
          "dependency_repair_claimed",
          {
            repair_id: repair.repair_id,
            validation_id: repair.validation_id,
            cycle: repair.cycle,
            upstream_task_id: task.task_id,
            downstream_task_id: repair.downstream_task_id
          },
          nowIso,
          "active",
          repair.cycle
        );
        this.#emit(tx, {
          task_id: task.task_id,
          session_id: input.session_id,
          event_type: "dependency_repair_claimed",
          payload: {
            actor: "agent",
            repair_id: repair.repair_id,
            validation_id: repair.validation_id,
            cycle: repair.cycle,
            downstream_task_id: repair.downstream_task_id
          }
        });
        this.#emit(tx, {
          task_id: task.task_id,
          session_id: input.session_id,
          event_type: "task_repair_started",
          payload: {
            actor: "agent",
            repair_id: repair.repair_id,
            from_status: "pending_acceptance",
            worktree_path: draft.worktree_path
          }
        });
        return {
          task_id: task.task_id,
          status: "in_progress",
          version: input.expected_version + 1,
          repair: claimedRepair
        };
      }
    ), undefined);
  }

  async getDependencyContext(sessionId: string, ctxId: string): Promise<DependencyContextView | undefined> {
    const session = this.#session(sessionId);
    if (this.#store.getDependencyContext === undefined) return undefined;
    return this.#store.transaction((tx) => {
      const context = tx.getDependencyContext?.(ctxId);
      if (context === undefined) return undefined;
      const upstream = tx.getTask(context.upstream_task_id);
      const downstream = tx.getTask(context.downstream_task_id);
      const authorized = (upstream?.repository_id === session.repository_id && upstream.owner === session.owner)
        || (downstream?.repository_id === session.repository_id && downstream.owner === session.owner);
      if (!authorized) {
        throw new PlatformDomainError("OWNER_MISMATCH", "Session cannot read this dependency context", {
          evidence: [ctxId, session.repository_id, session.owner ?? "unassigned"]
        });
      }
      return {
        context,
        events: tx.listDependencyContextEvents?.(ctxId) ?? []
      };
    });
  }

  async listDependencyValidationRequests(
    input: DependencyValidationListInput
  ): Promise<DependencyValidationView[]> {
    const session = this.#session(input.session_id);
    if (session.owner !== input.owner) {
      throw new PlatformDomainError("OWNER_MISMATCH", "Session owner does not match request owner", {
        evidence: [session.owner ?? "unassigned", input.owner]
      });
    }
    const repositoryId = input.repository_id;
    if (repositoryId !== undefined && session.repository_id !== repositoryId) {
      throw new PlatformDomainError("SESSION_CONTEXT_CONFLICT", "Repository does not match the transport-bound session", {
        evidence: [session.repository_id, repositoryId],
        recovery_actions: ["Use the repository_id returned by session_context for this connection."]
      });
    }
    this.#assertSameRepository(session, session.repository_id);
    const candidates = this.#store.listTasks({})
      .flatMap((task) => this.#store.listDependencyValidationViews(task.task_id))
      .filter((validation) => validation.downstream_owner === input.owner
        && validation.downstream_repository_id === session.repository_id
        && validation.status === "pending");
    // A direct database seed (or an old migration) may contain a validation
    // row without the corresponding dependency edge.  Such an orphan must
    // never become claimable; check the edge in a transaction before exposing
    // it to an Agent.
    const linked = candidates.filter((validation) => this.#store.transaction((tx) => {
      const downstream = tx.getTask(validation.downstream_task_id);
      // Terminal downstream tasks cannot execute a validation anymore.  Keep
      // their historical request visible through Board reads, but do not
      // publish it to an Agent's claim queue.
      if (downstream === undefined
        || downstream.status === "done"
        || downstream.status === "cancelled") {
        return false;
      }
      const dependency = tx.listTaskDependencies(validation.downstream_task_id)
        .find((candidate) => candidate.depends_on_task_id === validation.upstream_task_id);
      return dependency !== undefined && validation.requested_at >= dependency.created_at;
    }));
    return linked.filter((validation) => {
      const latestCycle = this.#store.transaction((tx) => (
        this.#latestDependencyValidationCycle(tx, validation)
      ));
      return validation.cycle === latestCycle;
    });
  }

  async receiveDependencyValidation(
    input: DependencyValidationReceiveInput
  ): Promise<DependencyValidationReceiveResult> {
    // Authenticate the caller before consulting the operation replay cache.
    // A session/operation key alone is not an authorization credential: a
    // caller that forges `owner` must never receive a previously cached run.
    this.#assertValidationSessionOwner(input.session_id, input.owner);
    return this.#runTx(() => this.#withOperation(
      input.session_id,
      input.operation_id,
      "dependency_validation_receive",
      input,
      (tx) => {
        const session = this.#txSession(tx, input.session_id);
        if (session.owner !== input.owner) {
          throw new PlatformDomainError("OWNER_MISMATCH", "Session owner does not match request owner", {
            evidence: [session.owner ?? "unassigned", input.owner]
          });
        }
        const validation = tx.getDependencyValidation(input.validation_id);
        if (validation === undefined) {
          throw new PlatformDomainError("DEPENDENCY_VALIDATION_NOT_FOUND", `Dependency validation ${input.validation_id} was not found`, {
            evidence: [input.validation_id]
          });
        }
        this.#assertDependencyValidationLink(tx, validation);
        const latestCycle = this.#latestDependencyValidationCycle(tx, validation);
        if (validation.cycle !== latestCycle) {
          throw new PlatformDomainError("TASK_VERSION_CONFLICT", "Validation request was superseded by a newer cycle", {
            current_version: String(latestCycle)
          });
        }
        if (validation.status !== "pending") {
          throw new PlatformDomainError("DEPENDENCY_VALIDATION_ALREADY_RESPONDED", `Dependency validation ${input.validation_id} is ${validation.status}`, {
            evidence: [validation.status]
          });
        }
        const downstream = this.#txTask(tx, validation.downstream_task_id);
        this.#assertSameRepository(session, downstream.repository_id);
        if (downstream.status === "done" || downstream.status === "cancelled") throw new PlatformDomainError("DEPENDENCY_VALIDATION_ALREADY_RESPONDED", "Downstream task is terminal");
        if (downstream.owner !== input.owner) {
          throw new PlatformDomainError("OWNER_MISMATCH", "Only the downstream owner may receive validation", {
            evidence: [downstream.owner ?? "unassigned", input.owner]
          });
        }
        if (session.worktree_path === undefined) {
          throw new PlatformDomainError("SESSION_CONTEXT_CONFLICT", "Validation requires a session worktree", {
            evidence: [input.session_id]
          });
        }
        const nowIso = this.#now();
        let run = tx.getActiveDependencyValidationRun(validation.validation_id);
        const runExpired = run !== undefined && Date.parse(run.expires_at) <= Date.parse(nowIso);
        if (run !== undefined && run.owner !== input.owner) {
          throw new PlatformDomainError("TASK_LEASE_CONFLICT", "Validation is already claimed by another session", {
            evidence: [run.session_id, run.owner]
          });
        }
        // A live run is exclusive to its session; once expired, the same
        // downstream owner may reclaim it from a fresh session.
        if (run !== undefined && !runExpired && run.session_id !== input.session_id) {
          throw new PlatformDomainError("TASK_LEASE_CONFLICT", "Validation is already claimed by another session", {
            evidence: [run.session_id, run.owner]
          });
        }
        if (run !== undefined && runExpired) {
          tx.updateDependencyValidationRun({
            ...run,
            status: "error",
            error_reason: "lease expired",
            completed_at: nowIso,
            updated_at: nowIso
          }, run.status);
          // Keep the terminal attempt in hand.  If the cap is reached we
          // return a committed recovery result below instead of throwing from
          // this transaction (which would roll back the expiry evidence in
          // SQLite).
          run = tx.getDependencyValidationRun(run.run_id)!;
        }
        if (run !== undefined && run.status === "queued") {
          // A queued run may be provisioned by a worker before the Agent
          // calls receive.  Claim it atomically here so the normal
          // receive -> checkpoint/complete lifecycle never returns a run
          // state that those tools cannot accept.
          tx.updateDependencyValidationRun({
            ...run,
            status: "claimed",
            session_id: input.session_id,
            worktree_path: session.worktree_path,
            heartbeat_at: nowIso,
            expires_at: new Date(Date.parse(nowIso) + this.#leaseTtlMs).toISOString(),
            started_at: run.started_at ?? nowIso,
            updated_at: nowIso
          }, "queued");
          run = tx.getDependencyValidationRun(run.run_id)!;
        }
        const latestRun = tx.listDependencyValidationRuns(validation.validation_id)[0];
        if (run === undefined && latestRun?.status === "cancelled") {
          throw new PlatformDomainError(
            "INVALID_TRANSITION",
            "Cancelled validation runs cannot be reclaimed; request a new validation cycle.",
            {
              evidence: [latestRun.run_id],
              recovery_actions: ["Request a new dependency validation cycle after restoring the dependency."]
            }
          );
        }
        if (run === undefined || run.status === "error") {
          const attempt = tx.listDependencyValidationRuns(validation.validation_id)
            .reduce((max, candidate) => Math.max(max, candidate.attempt), 0) + 1;
          if (attempt > maxDependencyValidationAttempts) {
            const cappedRun = run ?? tx.listDependencyValidationRuns(validation.validation_id)[0];
            if (cappedRun === undefined) {
              throw new PlatformDomainError("DEPENDENCY_VALIDATION_REQUIRED", "Validation retry limit reached", {
                retryable: false,
                recovery_actions: ["Review the failed validation attempts and request a new validation cycle."]
              });
            }
            const safeSpec = this.#safeValidationSpec(tx, validation);
            const recoveryActions = [
              "Review the failed validation attempts and request a new validation cycle."
            ] as const;
            tx.markDependencyValidationRequestRead(validation.validation_id, nowIso);
            this.#emit(tx, {
              task_id: validation.downstream_task_id,
              session_id: input.session_id,
              event_type: "dependency_validation_retry_capped",
              payload: {
                actor: "agent",
                validation_id: validation.validation_id,
                run_id: cappedRun.run_id,
                attempt: cappedRun.attempt,
                status: "capped"
              }
            });
            return {
              validation_id: validation.validation_id,
              run_id: cappedRun.run_id,
              attempt: cappedRun.attempt,
              status: "capped",
              validation_spec: safeSpec,
              run: cappedRun,
              capped: true,
              recovery_actions: recoveryActions
            } satisfies DependencyValidationReceiveResult;
          }
          run = {
            run_id: randomUUID(),
            validation_id: validation.validation_id,
            attempt,
            status: "claimed",
            owner: input.owner,
            session_id: input.session_id,
            worktree_path: session.worktree_path,
            heartbeat_at: nowIso,
            expires_at: new Date(Date.parse(nowIso) + this.#leaseTtlMs).toISOString(),
            started_at: nowIso,
            completed_at: null,
            verification: [],
            failure_reason: null,
            error_reason: null,
            operation_id: input.operation_id,
            created_at: nowIso,
            updated_at: nowIso
          };
          tx.insertDependencyValidationRun(run);
        }
        tx.markDependencyValidationRequestRead(validation.validation_id, nowIso);
        this.#emit(tx, {
          task_id: validation.downstream_task_id,
          session_id: input.session_id,
          event_type: "dependency_validation_received",
          payload: { actor: "agent", validation_id: validation.validation_id, run_id: run.run_id, attempt: run.attempt }
        });
        return {
          validation_id: validation.validation_id,
          ctx_id: validation.ctx_id ?? validation.validation_id,
          run_id: run.run_id,
          attempt: run.attempt,
          status: "claimed",
          validation_spec: this.#safeValidationSpec(tx, validation),
          run
        };
      }
    ));
  }

  async checkpointDependencyValidation(
    input: DependencyValidationCheckpointInput
  ): Promise<DependencyValidationRunRecord> {
    this.#assertValidationSessionOwner(input.session_id, input.owner);
    const progress = sanitizeDependencyValidationProgress(input.progress);
    return this.#runTx(() => this.#withOperation(
      input.session_id,
      input.operation_id,
      "dependency_validation_checkpoint",
      { ...input, progress },
      (tx) => {
      const session = this.#txSession(tx, input.session_id);
      if (session.owner !== input.owner) throw new PlatformDomainError("OWNER_MISMATCH", "Session owner does not match request owner");
      const validation = tx.getDependencyValidation(input.validation_id);
      if (validation === undefined) throw new PlatformDomainError("DEPENDENCY_VALIDATION_NOT_FOUND", `Dependency validation ${input.validation_id} was not found`);
      this.#assertDependencyValidationLink(tx, validation);
      const downstream = this.#txTask(tx, validation.downstream_task_id);
      this.#assertSameRepository(session, downstream.repository_id);
      if (downstream.owner !== input.owner) throw new PlatformDomainError("OWNER_MISMATCH", "Only the downstream owner may checkpoint validation");
      if (downstream.status === "done" || downstream.status === "cancelled") throw new PlatformDomainError("DEPENDENCY_VALIDATION_ALREADY_RESPONDED", "Downstream task is terminal");
      const currentCycle = this.#latestDependencyValidationCycle(tx, validation);
      if (currentCycle !== validation.cycle) throw new PlatformDomainError("TASK_VERSION_CONFLICT", "Validation request was superseded by a newer cycle");
      if (validation.status !== "pending") throw new PlatformDomainError("DEPENDENCY_VALIDATION_ALREADY_RESPONDED", `Dependency validation ${input.validation_id} is ${validation.status}`);
      const run = tx.getDependencyValidationRun(input.run_id);
      if (run === undefined || run.validation_id !== input.validation_id) throw new PlatformDomainError("DEPENDENCY_VALIDATION_NOT_FOUND", `Validation run ${input.run_id} was not found`);
      if (run.owner !== input.owner || run.session_id !== input.session_id) throw new PlatformDomainError("OWNER_MISMATCH", "Validation run owner/session mismatch");
      if (session.worktree_path === undefined || this.#normalizePath(session.worktree_path) !== this.#normalizePath(run.worktree_path)) throw new PlatformDomainError("SESSION_CONTEXT_CONFLICT", "Validation run worktree no longer matches session context");
      if (!(run.status === "claimed" || run.status === "running")) throw new PlatformDomainError("INVALID_TRANSITION", `Validation run is ${run.status}`);
      const nowIso = this.#now();
      if (Date.parse(run.expires_at) <= Date.parse(nowIso)) throw new PlatformDomainError("TASK_LEASE_CONFLICT", "Validation run lease expired", { retryable: true });
      tx.renewDependencyValidationRunLease(run.run_id, input.owner, input.session_id, nowIso, new Date(Date.parse(nowIso) + this.#leaseTtlMs).toISOString(), nowIso);
      const renewed = tx.getDependencyValidationRun(run.run_id)!;
      const withProgress = {
        ...renewed,
        progress
      } as DependencyValidationRunRecord;
      tx.updateDependencyValidationRun(withProgress);
      return withProgress;
      }
    ));
  }

  async completeDependencyValidation(
    input: DependencyValidationCompleteInput
  ): Promise<DependencyValidationCompleteResult> {
    this.#assertValidationSessionOwner(input.session_id, input.owner);
    // Parse the dedicated evidence contract first, then sanitize before any
    // result can be returned or placed in the idempotency cache.  Storage
    // applies the same sanitizer, but relying on the persistence round-trip
    // here would leak raw command output through this method's response.
    const verification = sanitizeDependencyValidationEvidence(
      input.verification.map((entry) => dependencyValidationEvidenceSchema.parse(entry))
    );
    const reason = sanitizeDependencyValidationText(input.reason);
    const semanticInput = { ...input, reason, verification };
    const cached = this.#cachedOperation<DependencyValidationCompleteResult>(
      input.session_id,
      input.operation_id,
      "dependency_validation_complete",
      semanticInput
    );
    if (cached !== undefined) return cached;
    if (input.status === "rejected" && !reason) throw new PlatformDomainError("DEPENDENCY_VALIDATION_REQUIRED", "A rejection reason is required");
    if (input.status === "rejected" && !verification.some((entry) => entry.outcome === "failed")) throw new PlatformDomainError("DEPENDENCY_VALIDATION_REQUIRED", "Rejected validation requires failed verification evidence");
    if (input.status === "passed" && (verification.length === 0 || verification.some((entry) => entry.outcome !== "passed"))) {
      throw new PlatformDomainError("INVALID_TRANSITION", "Passed validation requires non-empty all-passed verification");
    }
    return this.#runTx(() => this.#withOperation(
      input.session_id,
      input.operation_id,
      "dependency_validation_complete",
      semanticInput,
      (tx) => {
      const session = this.#txSession(tx, input.session_id);
      if (session.owner !== input.owner) throw new PlatformDomainError("OWNER_MISMATCH", "Session owner does not match request owner");
      const validation = tx.getDependencyValidation(input.validation_id);
      if (validation === undefined) throw new PlatformDomainError("DEPENDENCY_VALIDATION_NOT_FOUND", `Dependency validation ${input.validation_id} was not found`);
      this.#assertDependencyValidationLink(tx, validation);
      const downstream = this.#txTask(tx, validation.downstream_task_id);
      this.#assertSameRepository(session, downstream.repository_id);
      if (downstream.owner !== input.owner) throw new PlatformDomainError("OWNER_MISMATCH", "Only the downstream owner may complete validation");
      if (downstream.status === "done" || downstream.status === "cancelled") throw new PlatformDomainError("DEPENDENCY_VALIDATION_ALREADY_RESPONDED", "Downstream task is terminal");
      const latestCycle = this.#latestDependencyValidationCycle(tx, validation);
      if (latestCycle !== validation.cycle) throw new PlatformDomainError("TASK_VERSION_CONFLICT", "Validation request was superseded by a newer cycle", { current_version: String(latestCycle) });
      if (validation.status !== "pending") throw new PlatformDomainError("DEPENDENCY_VALIDATION_ALREADY_RESPONDED", `Dependency validation ${input.validation_id} is ${validation.status}`);
      const run = tx.getDependencyValidationRun(input.run_id);
      if (run === undefined || run.validation_id !== input.validation_id) throw new PlatformDomainError("DEPENDENCY_VALIDATION_NOT_FOUND", `Validation run ${input.run_id} was not found`);
      if (run.owner !== input.owner || run.session_id !== input.session_id) throw new PlatformDomainError("OWNER_MISMATCH", "Validation run owner/session mismatch");
      if (session.worktree_path === undefined || this.#normalizePath(session.worktree_path) !== this.#normalizePath(run.worktree_path)) throw new PlatformDomainError("SESSION_CONTEXT_CONFLICT", "Validation run worktree no longer matches session context");
      if (!(run.status === "claimed" || run.status === "running")) throw new PlatformDomainError("INVALID_TRANSITION", `Validation run is ${run.status}`);
      const nowIso = this.#now();
      if (Date.parse(run.expires_at) <= Date.parse(nowIso)) throw new PlatformDomainError("TASK_LEASE_CONFLICT", "Validation run lease expired", { retryable: true });
      const updatedRun: DependencyValidationRunRecord = {
        ...run,
        status: input.status,
        completed_at: nowIso,
        verification: verification.map((entry) => ({ ...entry })),
        ...(input.status === "rejected" ? { failure_reason: reason! } : {}),
        ...(input.status === "error" ? { error_reason: reason ?? "validation error" } : {}),
        updated_at: nowIso
      };
      tx.updateDependencyValidationRun(updatedRun, run.status);
      if (input.status !== "error") {
        tx.updateDependencyValidationResponse(input.validation_id, "pending", {
          status: input.status,
          responded_by_owner: input.owner,
          response_reason: reason ?? null,
          responded_at: nowIso,
          response_read_at: null
        });
        const edge = tx.listTaskDependencies(validation.downstream_task_id)
          .find((dependency) => dependency.depends_on_task_id === validation.upstream_task_id);
        this.#appendDependencyContextEvent(
          tx,
          edge?.ctx_id,
          `validation_${input.status}`,
          {
            validation_id: input.validation_id,
            cycle: validation.cycle,
            status: input.status,
            responder_owner: input.owner
          },
          nowIso,
          "active",
          validation.cycle
        );
        if (input.status === "rejected") {
          const repair: DependencyRepairRequestRecord = {
            repair_id: randomUUID(),
            validation_id: validation.validation_id,
            source_run_id: updatedRun.run_id,
            ctx_id: edge?.ctx_id ?? validation.ctx_id ?? null,
            upstream_task_id: validation.upstream_task_id,
            downstream_task_id: validation.downstream_task_id,
            cycle: validation.cycle,
            status: "pending",
            rejection_reason: reason!,
            claimed_session_id: null,
            claimed_worktree_path: null,
            claimed_at: null,
            resolved_at: null,
            superseded_at: null,
            created_at: nowIso,
            updated_at: nowIso
          };
          tx.insertDependencyRepairRequest(repair);
          this.#appendDependencyContextEvent(
            tx,
            edge?.ctx_id,
            "dependency_repair_requested",
            {
              repair_id: repair.repair_id,
              validation_id: validation.validation_id,
              cycle: validation.cycle,
              upstream_task_id: validation.upstream_task_id,
              downstream_task_id: validation.downstream_task_id
            },
            nowIso,
            "active",
            validation.cycle
          );
          const repairPayload = {
            actor: "agent",
            repair_id: repair.repair_id,
            validation_id: validation.validation_id,
            source_run_id: updatedRun.run_id,
            cycle: validation.cycle,
            upstream_task_id: validation.upstream_task_id,
            downstream_task_id: validation.downstream_task_id
          } satisfies Record<string, JsonValue>;
          this.#emit(tx, {
            task_id: validation.upstream_task_id,
            session_id: input.session_id,
            event_type: "dependency_repair_requested",
            payload: repairPayload
          });
          this.#emit(tx, {
            task_id: validation.downstream_task_id,
            session_id: input.session_id,
            event_type: "dependency_repair_requested",
            payload: repairPayload
          });
        }
      }
      const updatedValidation = tx.getDependencyValidation(input.validation_id)!;
      const gate = this.#dependencyValidationGate(tx, validation.upstream_task_id);
      const payload: Record<string, JsonValue> = { actor: "agent", validation_id: input.validation_id, ctx_id: validation.ctx_id ?? input.validation_id, run_id: input.run_id, status: input.status, responder_owner: input.owner };
      if (reason) payload.reason = reason;
      if (input.status !== "error") {
        this.#emit(tx, { task_id: validation.upstream_task_id, session_id: input.session_id, event_type: "dependency_validation_responded", payload });
        this.#emit(tx, { task_id: validation.downstream_task_id, session_id: input.session_id, event_type: "dependency_validation_responded", payload });
      }
      return { request: updatedValidation, validation: updatedValidation, run: updatedRun, gate };
      }
    ));
  }

  async getTask(taskId: string): Promise<TaskDetail | undefined> {
    return this.#store.getTaskDetail(taskId);
  }

  async getTaskRecovery(input: {
    task_id: string;
    session_id?: string;
  }): Promise<TaskRecoveryView> {
    const task = this.#detail(input.task_id);
    if (task === undefined) {
      throw this.#taskNotFound(input.task_id);
    }
    if (input.session_id !== undefined) {
      const session = this.#session(input.session_id);
      this.#assertSameRepository(session, task.repository_id);
      if (task.owner !== undefined && session.owner !== task.owner) {
        throw new PlatformDomainError(
          "OWNER_MISMATCH",
          "Session owner cannot read this task recovery view",
          { evidence: [session.owner ?? "unassigned", task.owner] }
        );
      }
    }

    const assembled = this.#store.transaction((tx) => {
      const activeLease = tx.getLeaseByTask(task.task_id) ?? null;
      const repairs = tx.listDependencyRepairsForUpstream(task.task_id)
        .filter((repair) => repair.status === "pending" || repair.status === "claimed")
        .sort((left, right) => right.cycle - left.cycle
          || right.created_at.localeCompare(left.created_at));
      return {
        activeLease,
        leaseSession: activeLease === null ? null : tx.getSession(activeLease.session_id) ?? null,
        latestSnapshot: tx.getLatestRepoSnapshot(task.task_id) ?? null,
        pendingDecisions: tx.listPendingHumanDecisions(task.task_id),
        gate: this.#dependencyValidationGate(tx, task.task_id),
        activeRepair: repairs[0] ?? null,
        recentEvents: tx.listRecentTaskEvents(task.task_id, 20)
      };
    });
    const evidenceState = await this.#recoveryEvidenceState(
      task,
      assembled.latestSnapshot
    );
    return {
      task,
      checkpoint: task.checkpoint ?? null,
      active_lease: assembled.activeLease,
      lease_session: assembled.leaseSession,
      latest_snapshot: assembled.latestSnapshot,
      evidence_state: evidenceState,
      pending_decisions: assembled.pendingDecisions,
      dependency_validation_gate: assembled.gate,
      active_repair: assembled.activeRepair,
      recent_events: assembled.recentEvents,
      next_action: this.#recoveryNextAction(
        task,
        evidenceState,
        assembled.pendingDecisions.length,
        assembled.gate,
        assembled.activeRepair
      )
    };
  }

  async getOperationResult(input: {
    session_id: string;
    operation_id: string;
  }): Promise<OperationResultLookup | undefined> {
    const origin = this.#session(input.session_id);
    const visited = new Set<string>();
    let sessionId: string | undefined = origin.session_id;
    for (let depth = 0; sessionId !== undefined && depth < 32; depth += 1) {
      if (visited.has(sessionId)) {
        break;
      }
      visited.add(sessionId);
      const lookupSessionId: string = sessionId;
      const step: {
        operation: OperationResult | undefined;
        predecessor: SessionRecord | undefined;
      } = this.#store.transaction((tx) => ({
        operation: tx.getOperationResult(lookupSessionId, input.operation_id),
        predecessor: tx.getSessionBySuccessorId(lookupSessionId)
      }));
      if (step.operation !== undefined) {
        return { ...step.operation, source_session_id: lookupSessionId };
      }
      if (step.predecessor === undefined
        || step.predecessor.repository_id !== origin.repository_id
        || step.predecessor.owner !== origin.owner) {
        break;
      }
      sessionId = step.predecessor.session_id;
    }
    return undefined;
  }

  async checkTaskConflicts(input: CheckConflictsInput): Promise<ConflictReport> {
    const session = this.#session(input.session_id);
    if ("proposed" in input) {
      return this.#checkProposedScope(input.proposed);
    }
    const draft = await this.#probeWorktree(session);
    const detail = this.#detail(input.task_id);
    if (detail === undefined) {
      throw this.#taskNotFound(input.task_id);
    }
    return this.#evaluateAgainstActiveSides({
      repositoryId: detail.repository_id,
      left: this.#leftSide(detail, draft),
      excludeTaskIds: [detail.task_id],
      softDependencies: this.#softDependenciesFor(detail.task_id)
    });
  }

  async createTask(input: CreateTaskInput): Promise<TaskMutationResult> {
    if (input.expected_version !== 0) {
      throw new PlatformDomainError(
        "TASK_VERSION_CONFLICT",
        "task_create expects expected_version 0 for a task that does not exist yet",
        { evidence: [`expected_version ${input.expected_version}`] }
      );
    }
    if (this.#store.getRepository(input.repository_id) === undefined) {
      throw new PlatformDomainError(
        "REPOSITORY_NOT_ALLOWED",
        `Repository ${input.repository_id} is not registered`,
        { evidence: [input.repository_id] }
      );
    }
    this.#declaredWorktreeScope(input.scopes);
    return this.#runTx(() => this.#withOperation(
      input.session_id,
      input.operation_id,
      "task_create",
      input,
      (tx) => {
        const session = this.#txSession(tx, input.session_id);
        this.#assertSameRepository(session, input.repository_id);
        if (input.owner !== undefined) {
          this.#assertSameOwner(session, input.owner, "new task");
        }
        this.#assertRepositoryProjectWritable(tx, input.repository_id);
        const nowIso = this.#now();
        const taskId = randomUUID();
        const seedCheckpoint = this.#initialCheckpoint(input.next_action);
        tx.insertTask({
          task_id: taskId,
          repository_id: input.repository_id,
          ...(input.owner !== undefined
            ? { owner: input.owner }
            : session?.owner !== undefined ? { owner: session.owner } : {}),
          title: input.title,
          status: "backlog",
          priority: input.priority,
          goal: input.goal,
          acceptance_criteria: [...input.acceptance_criteria],
          checkpoint: seedCheckpoint,
          created_at: nowIso,
          updated_at: nowIso
        });
        tx.insertCheckpoint({
          checkpoint_id: randomUUID(),
          task_id: taskId,
          session_id: input.session_id,
          payload: seedCheckpoint,
          created_at: nowIso
        });
        for (const scope of input.scopes ?? []) {
          if (scope.scope_type === "worktree_path") {
            this.#setWorktreeScope(
              tx,
              taskId,
              this.#normalizePath(scope.scope_value)
            );
            continue;
          }
          tx.insertTaskScope({
            task_scope_id: randomUUID(),
            task_id: taskId,
            scope_type: scope.scope_type,
            scope_value: this.#normalizePath(scope.scope_value)
          });
        }
        for (const dependsOn of input.dependencies ?? []) {
          this.#txTask(tx, dependsOn);
          tx.insertTaskDependency({
            task_id: taskId,
            depends_on_task_id: dependsOn,
            created_at: nowIso
          });
        }
        this.#emit(tx, {
          task_id: taskId,
          session_id: input.session_id,
          event_type: "task_created",
          payload: {
            actor: "agent",
            title: input.title,
            priority: input.priority,
            scopes: (input.scopes ?? []).map((scope) => ({
              scope_type: scope.scope_type,
              scope_value: scope.scope_value
            }))
          }
        });
        return this.#mutation(taskId, "backlog", 0);
      }
    ));
  }

  /** Read inside the write transaction so archive and create cannot race. */
  #assertRepositoryProjectWritable(tx: ProgressTransaction, repositoryId: string): void {
    const projectId = this.#store.getRepository(repositoryId)?.project_id;
    if (projectId !== undefined) {
      assertProjectNotArchived(tx.getProject(projectId));
    }
  }

  async attachTask(input: AttachTaskInput): Promise<AttachTaskResult> {
    const detail = this.#detail(input.task_id);
    if (detail === undefined) {
      throw this.#taskNotFound(input.task_id);
    }
    return this.#runTx(() => this.#withOperation(
      input.session_id,
      input.operation_id,
      "task_attach",
      input,
      (tx) => {
        const session = this.#txSession(tx, input.session_id);
        const task = this.#txTask(tx, input.task_id);
        this.#assertSameRepository(session, task.repository_id);
        this.#assertSameOwner(session, task.owner, task.task_id);
        tx.upsertTaskSessionLink({
          task_id: task.task_id,
          session_id: input.session_id,
          linked_at: this.#now()
        });
        this.#emit(tx, {
          task_id: task.task_id,
          session_id: input.session_id,
          event_type: "task_attached",
          payload: { actor: "agent", role: input.role }
        });
        return {
          task_id: task.task_id,
          status: detail.status,
          version: detail.version,
          session_id: input.session_id,
          role: input.role
        } satisfies AttachTaskResult;
      }
    ));
  }

  async startTask(input: StartTaskInput): Promise<TaskMutationResult> {
    const cached = this.#cachedOperation<TaskMutationResult>(
      input.session_id,
      input.operation_id,
      "task_start",
      input
    );
    if (cached !== undefined) {
      return cached;
    }
    const session = this.#session(input.session_id);
    const draft = await this.#probeWorktree(session);
    const heldLease = this.#store.transaction((tx) => (
      tx.getLeaseBySession(input.session_id)
    ));
    if (heldLease !== undefined
      && heldLease.task_id !== input.task_id
      && !this.#leaseExpired(heldLease, this.#now())) {
      throw this.#sessionLeaseConflict(
        input.session_id,
        heldLease.task_id,
        session.worktree_path
      );
    }
    const detail = this.#detail(input.task_id);
    if (detail === undefined) {
      throw this.#taskNotFound(input.task_id);
    }
    const softDependencies = this.#softDependenciesFor(detail.task_id);
    const report = this.#evaluateAgainstActiveSides({
      repositoryId: detail.repository_id,
      left: this.#leftSide(detail, draft),
      excludeTaskIds: [detail.task_id],
      softDependencies
    });
    this.#rejectHardConflict(report);
    this.#requireWarningAcknowledgement(report, input.acknowledged_warning_codes ?? []);

    return this.#runTx(() => this.#withOperation(
      input.session_id,
      input.operation_id,
      "task_start",
      input,
      (tx) => {
        const session = this.#txSession(tx, input.session_id);
        const task = this.#txTask(tx, input.task_id);
        this.#assertSameRepository(tx.getSession(input.session_id)!, task.repository_id);
        this.#assertVersion(task.task_id, input.expected_version);
        this.#assertSameOwner(session, task.owner, task.task_id);
        const previousLease = tx.getLeaseByTask(task.task_id);
        const leaseCheckAt = this.#now();
        let recoveryReason: "missing_lease" | "expired_lease" | undefined;
        if (task.status === "in_progress") {
          if (previousLease === undefined) {
            recoveryReason = "missing_lease";
          } else if (this.#leaseExpired(previousLease, leaseCheckAt)) {
            recoveryReason = "expired_lease";
          }
        }
        if (recoveryReason !== undefined
          && !tx.listActiveScopesByWorktree(draft.worktree_path)
            .some((scope) => scope.task_id === task.task_id)) {
          throw new PlatformDomainError(
            "WORKTREE_CONFLICT",
            "An in-progress task without an active lease can only be recovered from its existing worktree",
            {
              evidence: [task.task_id, draft.worktree_path],
              recovery_actions: ["Bind the original worktree or ask the task owner to release the Session on the Board."]
            }
          );
        }
        this.#assertLeasesAvailable(
          tx,
          task.task_id,
          input.session_id,
          session.worktree_path,
          leaseCheckAt
        );
        this.#assertPendingDecisionsResolved(task, "in_progress");
        this.#assertHardBlockDependencies(tx, task.task_id);
        assertTransition("agent", recoveryReason === undefined ? task.status : "paused", "in_progress");
        this.#assertWorktreeFreeInTx(tx, draft.worktree_path, [task.task_id]);
        const transactionReport = this.#evaluateAgainstActiveSides({
          repositoryId: task.repository_id,
          left: this.#leftSide(task, draft),
          excludeTaskIds: [task.task_id],
          softDependencies
        });
        this.#rejectHardConflict(transactionReport);
        this.#requireWarningAcknowledgement(
          transactionReport,
          input.acknowledged_warning_codes ?? []
        );
        const nowIso = this.#now();
        tx.updateTask({
          ...task,
          status: "in_progress",
          session_id: input.session_id,
          updated_at: nowIso
        }, input.expected_version);
        this.#setWorktreeScope(tx, task.task_id, draft.worktree_path);
        tx.insertRepoSnapshot({
          snapshot_id: randomUUID(),
          task_id: task.task_id,
          repository_id: draft.repository_id,
          repository_path: draft.repository_path,
          head_commit: draft.head_commit,
          captured_at: draft.captured_at,
          worktree_path: draft.worktree_path,
          branch: draft.branch,
          changed_files: draft.changed_files,
          ...(draft.content_digest === undefined
            ? {}
            : { content_digest: draft.content_digest }),
          ...(draft.provenance_source === undefined
            ? {}
            : { provenance: draft.provenance_source }),
          ...(draft.host_evidence_id === undefined
            ? {}
            : { host_evidence_id: draft.host_evidence_id })
        });
        tx.putLease(this.#lease(
          task.task_id,
          input.session_id,
          nowIso,
          input.expected_version + 1
        ));
        if (recoveryReason !== undefined) {
          this.#emit(tx, {
            task_id: task.task_id,
            session_id: input.session_id,
            event_type: "task_lease_recovered",
            payload: {
              actor: "agent",
              reason: recoveryReason,
              previous_session_id: task.session_id ?? null,
              worktree_path: draft.worktree_path
            }
          });
        }
        this.#emit(tx, {
          task_id: task.task_id,
          session_id: input.session_id,
          event_type: "task_started",
          payload: {
            actor: "agent",
            from_status: task.status,
            worktree_path: draft.worktree_path
          }
        });
        return this.#mutation(task.task_id, "in_progress", input.expected_version + 1);
      }
    ), input.task_id);
  }

  async checkpointTask(input: CheckpointTaskInput): Promise<TaskMutationResult> {
    const cached = this.#cachedOperation<TaskMutationResult>(
      input.session_id,
      input.operation_id,
      "task_checkpoint",
      input
    );
    if (cached !== undefined) {
      return cached;
    }
    const session = this.#session(input.session_id);
    const payload = checkpointWritePayloadSchema.parse(input.checkpoint);
    const draft = session.worktree_path === undefined
      ? undefined
      : await this.#probeWorktree(session);

    return this.#runTx(() => this.#withOperation(
      input.session_id,
      input.operation_id,
      "task_checkpoint",
      input,
      (tx) => {
        const session = this.#txSession(tx, input.session_id);
        const task = this.#txTask(tx, input.task_id);
        this.#assertSameRepository(tx.getSession(input.session_id)!, task.repository_id);
        this.#assertVersion(task.task_id, input.expected_version);
        this.#assertLeaseHolder(tx, task.task_id, input.session_id);
        this.#assertSameOwner(session, task.owner, task.task_id);
        const target = input.target_status ?? task.status;
        this.#assertPendingDecisionsResolved(task, target);
        if (target !== task.status) {
          assertTransition("agent", task.status, target);
        }
        const nowIso = this.#now();
        const checkpointId = randomUUID();
        const effectivePayload = this.#materializeCheckpoint(
          tx,
          task,
          payload,
          draft,
          nowIso,
          input.session_id
        );
        tx.insertCheckpoint({
          checkpoint_id: checkpointId,
          task_id: task.task_id,
          session_id: input.session_id,
          payload: effectivePayload,
          created_at: nowIso
        });
        if (draft !== undefined) {
          tx.insertRepoSnapshot({
            snapshot_id: randomUUID(),
            task_id: task.task_id,
            checkpoint_id: checkpointId,
            repository_id: draft.repository_id,
            repository_path: draft.repository_path,
            head_commit: draft.head_commit,
            captured_at: draft.captured_at,
            worktree_path: draft.worktree_path,
            branch: draft.branch,
            changed_files: draft.changed_files,
            ...(draft.content_digest === undefined
              ? {}
              : { content_digest: draft.content_digest }),
            ...(draft.provenance_source === undefined
              ? {}
              : { provenance: draft.provenance_source }),
            ...(draft.host_evidence_id === undefined
              ? {}
              : { host_evidence_id: draft.host_evidence_id })
          });
        }
        tx.updateTask({
          ...task,
          status: target,
          checkpoint: effectivePayload,
          updated_at: nowIso
        }, input.expected_version);
        const releasesLease = target !== task.status && !statusHoldsLease(target);
        if (releasesLease) {
          tx.deleteLeaseByTask(task.task_id);
        } else {
          const lease = tx.getLeaseByTask(task.task_id);
          if (lease !== undefined) {
            tx.deleteLeaseByTask(task.task_id);
            tx.putLease({
              ...lease,
              heartbeat_at: nowIso,
              expires_at: new Date(Date.parse(nowIso) + this.#leaseTtlMs).toISOString(),
              generation: lease.generation ?? 1
            });
          }
        }
        this.#emit(tx, {
          task_id: task.task_id,
          session_id: input.session_id,
          event_type: "task_checkpointed",
          payload: {
            actor: "agent",
            from_status: task.status,
            to_status: target,
            released_lease: releasesLease
          }
        });
        return this.#mutation(task.task_id, target, input.expected_version + 1);
      }
    ), input.task_id);
  }

  async switchTask(input: SwitchTaskInput): Promise<SwitchTaskResult> {
    if (input.checkpoint === undefined) {
      throw new PlatformDomainError(
        "CHECKPOINT_REQUIRED",
        "task_switch requires a checkpoint of the current task",
        {
          evidence: [input.task_id],
          recovery_actions: [
            "Collect a structured checkpoint for the current task and retry task_switch."
          ]
        }
      );
    }
    const cached = this.#cachedOperation<SwitchTaskResult>(
      input.session_id,
      input.operation_id,
      "task_switch",
      input
    );
    if (cached !== undefined) {
      return cached;
    }
    const session = this.#session(input.session_id);
    const payload = checkpointWritePayloadSchema.parse(input.checkpoint);
    const currentDraft = await this.#probeWorktree(session);
    const targetDetail = this.#detail(input.target_task_id);
    if (targetDetail === undefined) {
      throw this.#taskNotFound(input.target_task_id);
    }
    this.#assertSameRepository(session, targetDetail.repository_id);
    const targetWorktree = input.target_worktree_path === undefined
      ? this.#worktreeScopeFor(targetDetail) ?? session.worktree_path
      : this.#normalizePath(input.target_worktree_path);
    if (targetWorktree === undefined) {
      throw new PlatformDomainError(
        "REPOSITORY_NOT_ALLOWED",
        "Neither the target task nor the session declares a worktree to probe",
        { evidence: [input.target_task_id] }
      );
    }
    const targetDraft = targetWorktree === currentDraft.worktree_path
      ? currentDraft
      : await this.#probeSessionWorktree(
        targetDetail.repository_id,
        targetWorktree
      );
    const report = this.#evaluateAgainstActiveSides({
      repositoryId: targetDetail.repository_id,
      left: this.#leftSide(targetDetail, targetDraft),
      excludeTaskIds: [input.task_id, input.target_task_id],
      softDependencies: this.#softDependenciesFor(targetDetail.task_id)
    });
    this.#rejectHardConflict(report);
    this.#requireWarningAcknowledgement(report, input.acknowledged_warning_codes ?? []);

    return this.#runTx(() => this.#withOperation(
      input.session_id,
      input.operation_id,
      "task_switch",
      input,
      (tx) => {
        const txSession = this.#txSession(tx, input.session_id);
        if (txSession.worktree_path === undefined
          || this.#normalizePath(txSession.worktree_path)
            !== this.#normalizePath(currentDraft.worktree_path)) {
          throw new PlatformDomainError(
            "SESSION_CONTEXT_CONFLICT",
            "The session worktree changed while task_switch was probing",
            {
              evidence: [
                `probed ${currentDraft.worktree_path}`,
                `current ${txSession.worktree_path ?? "unset"}`
              ],
              recovery_actions: [
                "Read session_context and retry task_switch from the current worktree."
              ]
            }
          );
        }
        const current = this.#txTask(tx, input.task_id);
        this.#assertSameRepository(txSession, current.repository_id);
        this.#assertSameOwner(txSession, current.owner, current.task_id);
        this.#assertVersion(current.task_id, input.expected_version);
        assertTransition("agent", current.status, "paused");
        const target = this.#txTask(tx, input.target_task_id);
        this.#assertSameRepository(txSession, target.repository_id);
        this.#assertSameOwner(txSession, target.owner, target.task_id);
        this.#assertVersion(target.task_id, input.target_expected_version);
        this.#assertPendingDecisionsResolved(target, "in_progress");
        assertTransition("agent", target.status, "in_progress");
        const currentLease = tx.getLeaseByTask(current.task_id);
        if (currentLease !== undefined
          && currentLease.session_id !== input.session_id
          && !this.#clearLeaseIfExpired(tx, currentLease)) {
          throw this.#taskLeaseConflict(
            current.task_id,
            currentLease.session_id,
            session.worktree_path
          );
        }
        const sessionLease = tx.getLeaseBySession(input.session_id);
        if (sessionLease !== undefined
          && sessionLease.task_id !== current.task_id
          && !this.#clearLeaseIfExpired(tx, sessionLease)) {
          throw this.#sessionLeaseConflict(
            input.session_id,
            sessionLease.task_id,
            session.worktree_path
          );
        }
        const targetLease = tx.getLeaseByTask(target.task_id);
        if (targetLease !== undefined
          && targetLease.session_id !== input.session_id
          && !this.#clearLeaseIfExpired(tx, targetLease)) {
          throw this.#taskLeaseConflict(
            target.task_id,
            targetLease.session_id,
            targetWorktree
          );
        }
        this.#assertWorktreeFreeInTx(
          tx,
          targetDraft.worktree_path,
          [current.task_id, target.task_id]
        );

        const nowIso = this.#now();
        const previousWorktreePath = txSession.worktree_path;
        const changesWorktree = this.#normalizePath(previousWorktreePath)
          !== this.#normalizePath(targetDraft.worktree_path);
        if (changesWorktree) {
          tx.updateSessionContext(
            txSession.session_id,
            targetDraft.worktree_path,
            targetDraft.worktree_path,
            nowIso
          );
          tx.insertSessionEvent({
            event_id: randomUUID(),
            session_id: txSession.session_id,
            event_type: "session_rebound",
            payload: {
              actor: "agent",
              repository_id: txSession.repository_id,
              owner: txSession.owner ?? null,
              previous_workspace_path: txSession.workspace_path ?? null,
              previous_worktree_path: previousWorktreePath,
              workspace_path: targetDraft.worktree_path,
              worktree_path: targetDraft.worktree_path,
              via: "task_switch",
              current_task_id: current.task_id,
              target_task_id: target.task_id
            },
            created_at: nowIso
          });
        } else {
          tx.updateSessionActivity(txSession.session_id, nowIso);
        }
        const checkpointId = randomUUID();
        const effectivePayload = this.#materializeCheckpoint(
          tx,
          current,
          payload,
          currentDraft,
          nowIso,
          input.session_id
        );
        tx.insertCheckpoint({
          checkpoint_id: checkpointId,
          task_id: current.task_id,
          session_id: input.session_id,
          payload: effectivePayload,
          created_at: nowIso
        });
        tx.insertRepoSnapshot({
          snapshot_id: randomUUID(),
          task_id: current.task_id,
          checkpoint_id: checkpointId,
          repository_id: currentDraft.repository_id,
          repository_path: currentDraft.repository_path,
          head_commit: currentDraft.head_commit,
          captured_at: currentDraft.captured_at,
          worktree_path: currentDraft.worktree_path,
          branch: currentDraft.branch,
          changed_files: currentDraft.changed_files,
          ...(currentDraft.content_digest === undefined
            ? {}
            : { content_digest: currentDraft.content_digest }),
          ...(currentDraft.provenance_source === undefined
            ? {}
            : { provenance: currentDraft.provenance_source }),
          ...(currentDraft.host_evidence_id === undefined
            ? {}
            : { host_evidence_id: currentDraft.host_evidence_id })
        });
        this.#emit(tx, {
          task_id: current.task_id,
          session_id: input.session_id,
          event_type: "task_checkpointed",
          payload: {
            actor: "agent",
            from_status: current.status,
            to_status: "paused",
            via: "task_switch"
          }
        });
        tx.updateTask({
          ...current,
          status: "paused",
          checkpoint: effectivePayload,
          updated_at: nowIso
        }, input.expected_version);
        tx.deleteLeaseByTask(current.task_id);
        this.#emit(tx, {
          task_id: current.task_id,
          session_id: input.session_id,
          event_type: "task_paused",
          payload: {
            actor: "agent",
            via: "task_switch",
            target_task_id: target.task_id
          }
        });
        tx.updateTask({
          ...target,
          status: "in_progress",
          session_id: input.session_id,
          updated_at: nowIso
        }, input.target_expected_version);
        this.#setWorktreeScope(tx, target.task_id, targetDraft.worktree_path);
        tx.putLease(this.#lease(
          target.task_id,
          input.session_id,
          nowIso,
          input.target_expected_version + 1
        ));
        this.#emit(tx, {
          task_id: target.task_id,
          session_id: input.session_id,
          event_type: "task_started",
          payload: {
            actor: "agent",
            from_status: target.status,
            via: "task_switch",
            worktree_path: targetDraft.worktree_path
          }
        });
        return {
          task_id: target.task_id,
          status: "in_progress",
          version: input.target_expected_version + 1,
          paused_task_id: current.task_id,
          paused_task_version: input.expected_version + 1,
          previous_worktree_path: previousWorktreePath,
          worktree_path: targetDraft.worktree_path
        } satisfies SwitchTaskResult;
      }
    ), input.task_id);
  }

  async submitTask(input: SubmitTaskInput): Promise<TaskMutationResult> {
    const failures = input.verification
      .filter((entry) => entry.outcome !== "passed")
      .map((entry) => `${entry.command}: ${entry.outcome}`);
    if (input.verification.length === 0 || failures.length > 0) {
      throw new PlatformDomainError(
        "INVALID_TRANSITION",
        "Only non-empty verification evidence where every entry passed can submit a task",
        {
          evidence: failures,
          recovery_actions: [
            "Fix the failing verification commands and re-run them before submitting."
          ]
        }
      );
    }
    const cached = this.#cachedOperation<TaskMutationResult>(
      input.session_id,
      input.operation_id,
      "task_submit",
      input
    );
    if (cached !== undefined) {
      return cached;
    }
    const submitSession = this.#session(input.session_id);
    const draft = submitSession.worktree_path === undefined
      ? undefined
      : await this.#probeWorktree(submitSession);
    return this.#runTx(() => this.#withOperation(
      input.session_id,
      input.operation_id,
      "task_submit",
      input,
      (tx) => {
        const session = this.#txSession(tx, input.session_id);
        const task = this.#txTask(tx, input.task_id);
        this.#assertSameRepository(tx.getSession(input.session_id)!, task.repository_id);
        this.#assertVersion(task.task_id, input.expected_version);
        this.#assertLeaseHolder(tx, task.task_id, input.session_id);
        this.#assertSameOwner(session, task.owner, task.task_id);
        const checkpoint = task.checkpoint;
        if (checkpoint === undefined) {
          throw new PlatformDomainError(
            "CHECKPOINT_REQUIRED",
            "task_submit requires an existing checkpoint on the task",
            {
              evidence: [task.task_id],
              recovery_actions: ["Checkpoint the task before submitting it."]
            }
          );
        }
        this.#assertFreshSubmissionEvidence(checkpoint, input.verification, draft);
        const updatedCheckpoint = checkpoint;
        const nowIso = this.#now();
        let version = input.expected_version;
        let latestTask: TaskRecord = task;
        if (task.status === "in_progress") {
          assertTransition("agent", "in_progress", "verifying");
          latestTask = {
            ...latestTask,
            status: "verifying",
            checkpoint: updatedCheckpoint,
            updated_at: nowIso
          };
          tx.updateTask(latestTask, version);
          version += 1;
        }
        assertTransition("agent", latestTask.status === "in_progress"
          ? "verifying"
          : latestTask.status, "pending_acceptance");
        latestTask = {
          ...latestTask,
          status: "pending_acceptance",
          checkpoint: updatedCheckpoint,
          updated_at: nowIso
        };
        tx.updateTask(latestTask, version);
        version += 1;
        if (draft !== undefined) {
          tx.insertRepoSnapshot({
            snapshot_id: randomUUID(),
            task_id: latestTask.task_id,
            repository_id: draft.repository_id,
            repository_path: draft.repository_path,
            head_commit: draft.head_commit,
            captured_at: draft.captured_at,
            worktree_path: draft.worktree_path,
            branch: draft.branch,
            changed_files: draft.changed_files,
            ...(draft.content_digest === undefined
              ? {}
              : { content_digest: draft.content_digest }),
            ...(draft.provenance_source === undefined
              ? {}
              : { provenance: draft.provenance_source }),
            ...(draft.host_evidence_id === undefined
              ? {}
              : { host_evidence_id: draft.host_evidence_id })
          });
        }
        tx.deleteLeaseByTask(latestTask.task_id);
        this.#emit(tx, {
          task_id: latestTask.task_id,
          session_id: input.session_id,
          event_type: "task_submitted",
          payload: {
            actor: "agent",
            verification: input.verification.map((entry) => ({
              command: entry.command,
              outcome: entry.outcome
            }))
          }
        });
        for (const repair of tx.listDependencyRepairsForUpstream(latestTask.task_id)
          .filter((candidate) => candidate.status === "pending" || candidate.status === "claimed")) {
          const resolvesClaim = repair.status === "claimed"
            && repair.claimed_session_id === input.session_id;
          const updatedRepair: DependencyRepairRequestRecord = resolvesClaim
            ? {
              ...repair,
              status: "resolved",
              resolved_at: nowIso,
              updated_at: nowIso
            }
            : {
              ...repair,
              status: "superseded",
              superseded_at: nowIso,
              updated_at: nowIso
            };
          tx.updateDependencyRepairRequest(updatedRepair, repair.status);
          const eventType = resolvesClaim
            ? "dependency_repair_resolved"
            : "dependency_repair_superseded";
          this.#appendDependencyContextEvent(
            tx,
            repair.ctx_id ?? undefined,
            eventType,
            {
              repair_id: repair.repair_id,
              validation_id: repair.validation_id,
              cycle: repair.cycle,
              upstream_task_id: repair.upstream_task_id,
              downstream_task_id: repair.downstream_task_id
            },
            nowIso,
            "active",
            repair.cycle
          );
          this.#emit(tx, {
            task_id: latestTask.task_id,
            session_id: input.session_id,
            event_type: eventType,
            payload: {
              actor: "agent",
              repair_id: repair.repair_id,
              validation_id: repair.validation_id,
              cycle: repair.cycle,
              downstream_task_id: repair.downstream_task_id
            }
          });
        }
        this.#requestDependencyValidations(
          tx,
          latestTask,
          "agent",
          session.owner ?? null,
          nowIso,
          version
        );
        return this.#mutation(latestTask.task_id, "pending_acceptance", version);
      }
    ), input.task_id);
  }

  async adoptTask(input: AdoptTaskInput): Promise<TaskMutationResult> {
    if (input.expected_version !== 0) {
      throw new PlatformDomainError(
        "TASK_VERSION_CONFLICT",
        "task_adopt expects expected_version 0 for a task that does not exist yet",
        { evidence: [`expected_version ${input.expected_version}`] }
      );
    }
    const cached = this.#cachedOperation<TaskMutationResult>(
      input.session_id,
      input.operation_id,
      "task_adopt",
      input
    );
    if (cached !== undefined) {
      return cached;
    }
    if (input.status === "pending_acceptance") {
      const failed = input.checkpoint.verification
        .filter((entry) => entry.outcome !== "passed")
        .map((entry) => `${entry.command}: ${entry.outcome}`);
      if (input.checkpoint.verification.length === 0 || failed.length > 0) {
        throw new PlatformDomainError(
          "INVALID_TRANSITION",
          "Importing a task as pending_acceptance requires non-empty verification evidence where every entry passed",
          {
            evidence: failed,
            recovery_actions: [
              "Re-run the failing verification commands, or import at an earlier status and submit with evidence instead."
            ]
          }
        );
      }
    }
    if (input.status === "done" || input.status === "cancelled") {
      throw new PlatformDomainError(
        "INVALID_TRANSITION",
        "Terminal legacy tasks are not adopted",
        { evidence: [input.status] }
      );
    }
    const payload = checkpointPayloadSchema.parse(input.checkpoint);
    if (payload.source?.source_type !== "legacy_adoption") {
      throw new PlatformDomainError(
        "CHECKPOINT_REQUIRED",
        "task_adopt requires a checkpoint with legacy_adoption source details",
        {
          evidence: [input.legacy_import_key],
          recovery_actions: [
            "Rebuild the migration checkpoint with source_type legacy_adoption."
          ]
        }
      );
    }
    const repository = this.#store.getRepository(input.repository_id);
    if (repository === undefined || repository.project_id !== input.project_id) {
      throw new PlatformDomainError(
        "REPOSITORY_NOT_ALLOWED",
        `Repository ${input.repository_id} is not registered under project ${input.project_id}`,
        { evidence: [input.repository_id, input.project_id] }
      );
    }
    const worktreePath = this.#normalizePath(input.worktree_path);
    const declaredWorktree = this.#declaredWorktreeScope(input.scopes);
    if (declaredWorktree !== undefined && declaredWorktree !== worktreePath) {
      throw new PlatformDomainError(
        "WORKTREE_CONFLICT",
        "task_adopt worktree_path conflicts with its declared worktree scope",
        {
          evidence: [worktreePath, declaredWorktree],
          recovery_actions: [
            "Use one worktree path consistently in task_adopt."
          ]
        }
      );
    }

    return this.#runTx(() => this.#withOperation(
      input.session_id,
      input.operation_id,
      "task_adopt",
      input,
      (tx) => {
        const session = this.#txSession(tx, input.session_id);
        this.#assertSameRepository(session, input.repository_id);
        if (input.owner !== undefined) {
          this.#assertSameOwner(session, input.owner, "legacy adoption");
        }
        const existing = tx.findLegacyImport(input.legacy_import_key);
        if (existing !== undefined) {
          this.#assertLegacyIdentity(existing, input);
          const detail = this.#detail(existing.task_id);
          if (detail === undefined) {
            throw this.#taskNotFound(existing.task_id);
          }
          return this.#mutation(detail.task_id, detail.status, detail.version);
        }
        this.#assertRepositoryProjectWritable(tx, input.repository_id);

        const nowIso = this.#now();
        const taskId = randomUUID();
        const bindLease = statusHoldsLease(input.status);
        const insertedTask: TaskRecord = {
          task_id: taskId,
          repository_id: input.repository_id,
          session_id: bindLease ? input.session_id : undefined,
          ...(input.owner !== undefined
            ? { owner: input.owner }
            : session.owner !== undefined
              ? { owner: session.owner }
              : {}),
          title: input.title ?? input.normalized_title,
          status: input.status,
          priority: input.priority,
          goal: input.goal,
          acceptance_criteria: [...input.acceptance_criteria],
          checkpoint: payload,
          created_at: nowIso,
          updated_at: nowIso
        };
        tx.insertTask(insertedTask);
        for (const scope of input.scopes ?? []) {
          if (scope.scope_type === "worktree_path") {
            continue;
          }
          tx.insertTaskScope({
            task_scope_id: randomUUID(),
            task_id: taskId,
            scope_type: scope.scope_type,
            scope_value: this.#normalizePath(scope.scope_value)
          });
        }
        for (const dependsOn of input.dependencies ?? []) {
          this.#txTask(tx, dependsOn);
          tx.insertTaskDependency({
            task_id: taskId,
            depends_on_task_id: dependsOn,
            created_at: nowIso
          });
        }
        this.#setWorktreeScope(tx, taskId, worktreePath);
        tx.upsertTaskSessionLink({
          task_id: taskId,
          session_id: input.session_id,
          linked_at: nowIso
        });
        const checkpointId = randomUUID();
        tx.insertCheckpoint({
          checkpoint_id: checkpointId,
          task_id: taskId,
          session_id: input.session_id,
          payload,
          created_at: nowIso
        });
        tx.insertRepoSnapshot({
          snapshot_id: randomUUID(),
          task_id: taskId,
          checkpoint_id: checkpointId,
          repository_id: input.repository_id,
          repository_path: input.snapshot.repository_path ?? repository.path,
          head_commit: input.snapshot.head_commit,
          captured_at: input.snapshot.captured_at ?? nowIso,
          worktree_path: worktreePath
        });
        tx.insertLegacyImport({
          legacy_import_key: input.legacy_import_key,
          source_session_label: input.source_session_label,
          project_id: input.project_id,
          repository_id: input.repository_id,
          worktree_path: worktreePath,
          normalized_title: input.normalized_title,
          task_id: taskId,
          created_at: nowIso
        });
        this.#emit(tx, {
          task_id: taskId,
          session_id: input.session_id,
          event_type: "legacy_task_adopted",
          payload: {
            actor: "agent",
            source_session_label: input.source_session_label,
            adoption_method: "mcp",
            adopted_at: nowIso,
            worktree_path: worktreePath,
            status: input.status
          }
        });
        for (const attempt of payload.attempts ?? []) {
          this.#emit(tx, {
            task_id: taskId,
            session_id: input.session_id,
            event_type: "task_attempt_recorded",
            payload: {
              actor: "agent",
              attempt_id: attempt.attempt_id,
              summary: attempt.summary,
              outcome: attempt.outcome,
              evidence_refs: [...attempt.evidence_refs],
              recorded_at: attempt.recorded_at,
              source: "legacy_adoption"
            }
          });
        }

        const conflictingScopes = tx.listActiveScopesByWorktree(worktreePath)
          .filter((scope) => scope.task_id !== taskId)
          .filter((scope) => {
            const other = tx.getTask(scope.task_id);
            return other !== undefined && statusHoldsLease(other.status);
          });
        for (const scope of conflictingScopes) {
          const other = tx.getTask(scope.task_id);
          if (other !== undefined && !this.#isLegacyAdopted(other)) {
            // An agent-side adopt must not force-takeover a running native
            // task; mirror the startTask/switchTask contention semantics.
            throw new PlatformDomainError(
              "WORKTREE_CONFLICT",
              `Worktree ${worktreePath} is held by native task ${other.task_id}`,
              {
                evidence: [
                  worktreePath,
                  `task ${other.task_id} is ${other.status}`
                ],
                recovery_actions: [
                  "Pause or finish the native task first, or adopt into a dedicated worktree."
                ]
              }
            );
          }
        }
        if (conflictingScopes.length > 0) {
          for (const scope of conflictingScopes) {
            this.#pauseConflictingLegacyTask(tx, scope, worktreePath, taskId, nowIso);
          }
          if (input.status === "in_progress") {
            tx.updateTask({
              ...insertedTask,
              status: "paused",
              updated_at: nowIso
            }, 0);
            this.#emit(tx, {
              task_id: taskId,
              session_id: input.session_id,
              event_type: "legacy_worktree_conflict",
              payload: {
                actor: "agent",
                worktree_path: worktreePath,
                action: "paused"
              }
            });
            return this.#mutation(taskId, "paused", 1);
          }
          this.#emit(tx, {
            task_id: taskId,
            session_id: input.session_id,
            event_type: "legacy_worktree_conflict",
            payload: {
              actor: "agent",
              worktree_path: worktreePath,
              action: "flagged"
            }
          });
          return this.#mutation(taskId, input.status, 0);
        }

        if (bindLease) {
          this.#assertLeasesAvailable(tx, taskId, input.session_id, worktreePath);
          tx.putLease(this.#lease(taskId, input.session_id, nowIso, 1));
        }
        return this.#mutation(taskId, input.status, 0);
      }
    ));
  }

  async humanUpdateTask(
    taskId: string,
    actor: TaskActor,
    changes: HumanUpdateChanges,
    context: HumanActionContext = {}
  ): Promise<HumanUpdateResult> {
    this.#requireHuman(actor, "update task metadata");
    return this.#runTx(() => this.#store.transaction((tx) => {
      const task = this.#txTask(tx, taskId);
      const version = this.#versionOf(taskId);
      this.#assertOptionalVersion(taskId, context.expected_version);
      const title = changes.title ?? task.title;
      const priority = changes.priority ?? task.priority;
      tx.updateTask({ ...task, title, priority, updated_at: this.#now() }, version);
      this.#emit(tx, {
        task_id: taskId,
        event_type: "task_updated",
        payload: { actor: "human", title, priority }
      });
      return {
        task_id: taskId,
        status: task.status,
        version: version + 1,
        title,
        priority
      } satisfies HumanUpdateResult;
    }), taskId);
  }

  async requestTaskDependencyValidation(
    input: RequestTaskDependencyValidationInput
  ): Promise<TaskMutationResult> {
    const cached = this.#cachedOperation<TaskMutationResult>(
      input.session_id, input.operation_id, "task_dependency_validation_request", input
    );
    if (cached !== undefined) return cached;
    const requestSession = this.#session(input.session_id);
    const requestTask = this.#store.transaction((tx) => this.#txTask(tx, input.task_id));
    this.#assertSameRepository(requestSession, requestTask.repository_id);
    this.#assertSameOwner(requestSession, requestTask.owner, requestTask.task_id);
    const expectedWorktreePath = requestSession.worktree_path;
    const draft = await this.#probeWorktree(requestSession);
    return this.#runTx(() => this.#withOperation(
      input.session_id, input.operation_id, "task_dependency_validation_request", input,
      (tx) => {
        const session = this.#txSession(tx, input.session_id);
        const task = this.#txTask(tx, input.task_id);
        this.#assertSameRepository(session, task.repository_id);
        this.#assertSameOwner(session, task.owner, task.task_id);
        this.#assertVersion(task.task_id, input.expected_version);
        if (session.worktree_path !== expectedWorktreePath) {
          throw new PlatformDomainError("SESSION_CONTEXT_CONFLICT", "Session worktree changed during validation evidence collection");
        }
        if (task.status !== "pending_acceptance") {
          throw new PlatformDomainError("INVALID_TRANSITION", "Only pending_acceptance tasks can request missing validation cycles");
        }
        // Submission releases the execution lease. This metadata operation
        // must never take over a live task or an occupied caller session.
        if (tx.getLeaseByTask(task.task_id) !== undefined
          || tx.getLeaseBySession(input.session_id) !== undefined) {
          throw new PlatformDomainError("TASK_LEASE_CONFLICT", "Validation backfill requires an idle session and an unleased submitted task");
        }
        const snapshot = tx.getLatestRepoSnapshot(task.task_id);
        if (task.checkpoint === undefined || snapshot === undefined
          || snapshot.content_digest === undefined
          || snapshot.content_digest !== draft.content_digest
          || snapshot.head_commit !== draft.head_commit
          || snapshot.worktree_path === undefined
          || this.#normalizePath(snapshot.worktree_path) !== this.#normalizePath(draft.worktree_path)) {
          throw new PlatformDomainError("CHECKPOINT_REQUIRED", "Validation backfill requires the unchanged submitted worktree and its original snapshot", {
            recovery_actions: ["Ask the human to reject the stale submission, then resume, verify, checkpoint and submit through the normal lifecycle."]
          });
        }
        this.#assertFreshSubmissionEvidence(task.checkpoint, input.verification, draft);
        if (task.checkpoint.blockers.length > 0 || task.checkpoint.pending_decisions.length > 0) {
          throw new PlatformDomainError("CHECKPOINT_REQUIRED", "Resolve blockers and pending decisions through the normal lifecycle");
        }
        const count = this.#requestDependencyValidations(
          tx, task, "agent", session.owner ?? null, this.#now(), input.expected_version + 1, true,
          () => tx.updateTask({ ...task, updated_at: this.#maxIsoTimestamp(this.#now(), [task.updated_at]) }, input.expected_version)
        );
        if (count === 0) return this.#mutation(task.task_id, task.status, input.expected_version);
        return this.#mutation(task.task_id, task.status, input.expected_version + 1);
      }
    ), input.task_id);
  }

  async updateTaskDependencies(
    input: UpdateTaskDependenciesInput
  ): Promise<TaskMutationResult> {
    return this.#runTx(() => this.#withOperation(
      input.session_id,
      input.operation_id,
      "task_dependencies_update",
      input,
      (tx) => {
        const session = this.#txSession(tx, input.session_id);
        const task = this.#txTask(tx, input.task_id);
        this.#assertSameRepository(session, task.repository_id);
        this.#assertSameOwner(session, task.owner, input.task_id);
        this.#assertVersion(task.task_id, input.expected_version);
        if (task.status === "done" || task.status === "cancelled") {
          throw new PlatformDomainError("INVALID_TRANSITION", "Terminal task dependencies are immutable");
        }
        const lease = tx.getLeaseByTask(task.task_id);
        if (lease !== undefined && lease.session_id !== input.session_id) {
          throw new PlatformDomainError("TASK_LEASE_CONFLICT", "Only the lease holder may update active task dependencies");
        }
        for (const dependsOn of input.dependencies) {
          this.#txTask(tx, dependsOn);
        }
        const nowIso = this.#now();
        const previousDependencyRows = tx.listTaskDependencies(task.task_id);
        const previousDependencies = previousDependencyRows
          .map((dependency) => dependency.depends_on_task_id)
          .sort();
        const nextDependencies = [...input.dependencies].sort();
        const effectivePolicies = Object.fromEntries(input.dependencies.map((dependencyId) => [
          dependencyId,
          input.policies === undefined
            ? previousDependencyRows.find((edge) => edge.depends_on_task_id === dependencyId)?.policy ?? "acceptance_gate"
            : input.policies[dependencyId] ?? "acceptance_gate"
        ]));
        const dependenciesChanged = previousDependencies.length !== nextDependencies.length
          || previousDependencies.some((dependency, index) => dependency !== nextDependencies[index])
          || previousDependencyRows.some((edge) => (
            (edge.policy ?? "acceptance_gate") !== effectivePolicies[edge.depends_on_task_id]
          ));
        if (dependenciesChanged) {
          // A prior passed response is only valid for the exact dependency
          // generation that produced it.  Changing an edge invalidates all
          // old requests (including terminal responses) before replacing the
          // relation, so the acceptance gate cannot be bypassed by removing
          // and re-adding a dependency.
          tx.supersedeDependencyValidationsForDownstream(task.task_id, nowIso);
          for (const previousDependency of previousDependencyRows) {
            for (const repair of tx.listDependencyRepairsForUpstream(
              previousDependency.depends_on_task_id
            ).filter((candidate) => candidate.downstream_task_id === task.task_id
              && (candidate.status === "pending" || candidate.status === "claimed"))) {
              tx.updateDependencyRepairRequest({
                ...repair,
                status: "superseded",
                superseded_at: nowIso,
                updated_at: nowIso
              }, repair.status);
            }
          }
          // `created_at` is the persisted edge-generation marker.  Keep it
          // strictly monotonic even when the wall clock moves backwards or
          // two updates happen in the same millisecond; otherwise an old
          // passed response could compare as current in the gate query.
          const historicalValidationTimes = input.dependencies.flatMap((dependsOn) => (
            tx.listDependencyValidationsForUpstream(dependsOn)
              .filter((validation) => validation.downstream_task_id === task.task_id)
              .map((validation) => validation.requested_at)
          ));
          const edgeCreatedAt = this.#nextDependencyGenerationTimestamp(
            previousDependencyRows,
            task.updated_at,
            nowIso,
            historicalValidationTimes
          );
          tx.replaceTaskDependencies(
            task.task_id,
            input.dependencies,
            edgeCreatedAt,
            effectivePolicies
          );
          tx.updateTask({ ...task, updated_at: edgeCreatedAt }, input.expected_version);
        } else {
          // Preserve the last dependency generation marker even when a
          // no-op update arrives after a wall-clock rollback.  Otherwise a
          // subsequent remove/re-add could reuse an older passed response.
          const taskUpdatedMs = Date.parse(task.updated_at);
          const nowMs = Date.parse(nowIso);
          const stableUpdatedAt = Number.isFinite(taskUpdatedMs)
            ? new Date(Math.max(taskUpdatedMs, nowMs)).toISOString()
            : nowIso;
          tx.updateTask({ ...task, updated_at: stableUpdatedAt }, input.expected_version);
        }
        const serializedPolicies: Record<string, JsonValue> = {};
        for (const [dependencyId, policy] of Object.entries(input.policies ?? {})) {
          if (policy !== undefined) serializedPolicies[dependencyId] = policy;
        }
        this.#emit(tx, {
          task_id: task.task_id,
          session_id: input.session_id,
          event_type: "dependencies_updated",
          payload: {
            actor: "agent",
            dependencies: [...input.dependencies],
            policies: serializedPolicies
          }
        });
        return this.#mutation(task.task_id, task.status, input.expected_version + 1);
      }
    ), input.task_id);
  }

  async confirmTaskDecision(input: ConfirmTaskDecisionInput): Promise<TaskMutationResult> {
    return this.#runTx(() => this.#withOperation(
      input.session_id,
      input.operation_id,
      "task_confirm_decision",
      input,
      (tx) => {
        const session = this.#txSession(tx, input.session_id);
        const task = this.#txTask(tx, input.task_id);
        this.#assertSameRepository(session, task.repository_id);
        this.#assertSameOwner(session, task.owner, input.task_id);
        this.#assertVersion(input.task_id, input.expected_version);
        if (task.status !== "waiting_human") {
          throw new PlatformDomainError(
            "INVALID_TRANSITION",
            `Task ${input.task_id} is ${task.status}, not waiting for a human decision`,
            {
              evidence: [task.status],
              recovery_actions: [
                "Only confirm decisions for a task whose status is waiting_human."
              ]
            }
          );
        }
        const checkpoint = task.checkpoint;
        if (checkpoint === undefined) {
          throw new PlatformDomainError(
            "CHECKPOINT_REQUIRED",
            "Recording a decision requires a checkpoint that lists pending decisions",
            {
              evidence: [input.task_id],
              recovery_actions: ["Checkpoint the task with its pending decisions first."]
            }
          );
        }
        if (!checkpoint.pending_decisions.includes(input.question)) {
          throw new PlatformDomainError(
            "DECISION_NOT_PENDING",
            `Question is not pending for task ${input.task_id}`,
            {
              evidence: [input.question],
              recovery_actions: ["Use one of the pending decision questions verbatim."]
            }
          );
        }
        const nowIso = this.#now();
        const updatedCheckpoint: CheckpointPayload = {
          ...checkpoint,
          pending_decisions: checkpoint.pending_decisions
            .filter((question) => question !== input.question),
          confirmed_decisions: [
            ...checkpoint.confirmed_decisions,
            `${input.question} => ${input.decision}`
          ]
        };
        tx.updateTask({
          ...task,
          checkpoint: updatedCheckpoint,
          updated_at: nowIso
        }, input.expected_version);
        tx.insertHumanDecision({
          decision_id: randomUUID(),
          task_id: input.task_id,
          question: input.question,
          decision: input.decision,
          status: "decided",
          created_at: nowIso,
          decided_at: nowIso
        });
        this.#emit(tx, {
          task_id: input.task_id,
          session_id: input.session_id,
          event_type: "task_decision_confirmed",
          payload: {
            actor: "agent",
            confirmation_source: "current_user_message",
            owner: session.owner ?? null,
            question: input.question,
            decision: input.decision
          }
        });
        return this.#mutation(input.task_id, task.status, input.expected_version + 1);
      }
    ), input.task_id);
  }

  async humanAccept(
    taskId: string,
    actor: TaskActor,
    context: HumanActionContext = {}
  ): Promise<TaskMutationResult> {
    assertHumanOnlyAction("accept", actor);
    return this.#humanClose(taskId, "done", "accepted", "task_accepted", context);
  }

  async humanRequestDependencyValidation(
    taskId: string,
    actor: TaskActor,
    requestedByOwner: string,
    context: HumanActionContext = {}
  ): Promise<TaskMutationResult> {
    this.#requireHuman(actor, "request downstream dependency validation");
    // Compatibility method retained for callers compiled against the old
    // API.  Validation requests are now created only by the Agent
    // task_submit path; a human must not manufacture a request through the
    // Board and thereby bypass the bound Agent run/evidence contract.
    void taskId;
    void requestedByOwner;
    void context;
    throw new PlatformDomainError(
      "INVALID_TRANSITION",
      "Human dependency-validation requests are read-only compatibility APIs",
      {
        recovery_actions: [
          "Use task_submit to create a validation request, then let the downstream Agent receive it."
        ]
      }
    );
  }

  async humanRespondDependencyValidation(
    validationId: string,
    actor: TaskActor,
    responderOwner: string,
    status: "passed" | "rejected",
    reason?: string
  ): Promise<DependencyValidationResponseResult> {
    this.#requireHuman(actor, "respond to downstream dependency validation");
    void validationId;
    void responderOwner;
    void status;
    void reason;
    throw new PlatformDomainError(
      "INVALID_TRANSITION",
      "Human dependency-validation responses are read-only compatibility APIs",
      {
        recovery_actions: [
          "Use dependency_validation_receive and dependency_validation_complete from the bound downstream Agent."
        ]
      }
    );
  }

  async humanReject(
    taskId: string,
    actor: TaskActor,
    context: HumanActionContext = {}
  ): Promise<TaskMutationResult> {
    assertHumanOnlyAction("reject", actor);
    // Rejecting only makes sense on a task awaiting acceptance; otherwise
    // paused would be reachable from almost any state via the agent matrix.
    const detail = this.#detail(taskId);
    if (detail === undefined) {
      throw this.#taskNotFound(taskId);
    }
    if (detail.status !== "pending_acceptance") {
      throw new PlatformDomainError(
        "INVALID_TRANSITION",
        `Reject requires pending_acceptance, but the task is ${detail.status}`,
        { evidence: [detail.status] }
      );
    }
    // Rejecting lands the task in paused (not in_progress) so the leasing
    // session can task_start it again directly; in_progress without a lease
    // has no re-entry path in the state machine.
    return this.#humanClose(taskId, "paused", "rejected", "task_rejected", context);
  }

  async humanResume(
    taskId: string,
    actor: TaskActor,
    context: HumanActionContext = {}
  ): Promise<TaskMutationResult> {
    assertHumanOnlyAction("resume", actor);
    const detail = this.#detail(taskId);
    if (detail === undefined) throw this.#taskNotFound(taskId);
    if (detail.status !== "pending_acceptance") {
      throw new PlatformDomainError("INVALID_TRANSITION", `Resume requires pending_acceptance, but the task is ${detail.status}`, { evidence: [detail.status] });
    }
    // A human decision cannot safely create an Agent lease.  Leave the task
    // paused so the owning Agent can explicitly task_start it in its current
    // session and worktree; this keeps resume distinct from rejection while
    // preserving the lease boundary.
    return this.#humanClose(taskId, "paused", "resumed_after_validation", "task_resumed", context);
  }

  async humanCancel(
    taskId: string,
    actor: TaskActor,
    context: HumanActionContext = {}
  ): Promise<TaskMutationResult> {
    assertHumanOnlyAction("cancel", actor);
    return this.#humanClose(taskId, "cancelled", "cancelled", "task_cancelled", context);
  }

  async humanReleaseSession(
    sessionId: string,
    actor: TaskActor,
    context: HumanActionContext = {}
  ): Promise<TaskMutationResult> {
    this.#requireHuman(actor, "release a session lease");
    return this.#runTx(() => this.#store.transaction((tx) => {
      const lease = tx.getLeaseBySession(sessionId);
      if (lease === undefined) {
        throw new PlatformDomainError(
          "LEASE_NOT_FOUND",
          `Session ${sessionId} holds no active lease`,
          {
            evidence: [sessionId],
            recovery_actions: ["Only sessions with an active lease can be released."]
          }
        );
      }
      const task = this.#txTask(tx, lease.task_id);
      const version = this.#versionOf(lease.task_id);
      this.#assertOptionalVersion(lease.task_id, context.expected_version);
      const nowIso = this.#now();
      tx.deleteLeaseByTask(lease.task_id);
      let status = task.status;
      if (statusHoldsLease(task.status)) {
        assertTransition("human", task.status, "paused");
        status = "paused";
        tx.updateTask({ ...task, status, updated_at: nowIso }, version);
      }
      this.#emit(tx, {
        task_id: lease.task_id,
        event_type: "task_released",
        payload: { actor: "human", session_id: sessionId }
      });
      return this.#mutation(
        lease.task_id,
        status,
        status === task.status ? version : version + 1
      );
    }));
  }

  #humanClose(
    taskId: string,
    target: TaskStatus,
    decisionText: string,
    eventType: string,
    context: HumanActionContext
  ): TaskMutationResult {
    return this.#runTx(() => this.#store.transaction((tx) => {
      const task = this.#txTask(tx, taskId);
      const version = this.#versionOf(taskId);
      this.#assertOptionalVersion(taskId, context.expected_version);
      assertTransition("human", task.status, target);
      if (target === "done") {
        this.#assertDependencyValidationGate(tx, taskId);
      }
      const nowIso = this.#now();
      const repairChanges: DependencyRepairChangeIdentity[] = [];
      if (target === "done" || target === "cancelled") {
        // Incoming validations belong to this downstream task and cannot be
        // reclaimed after a terminal transition.  A successful human accept
        // normally has no active run (the gate requires passed), but cleaning
        // up here also handles legacy/seeded rows without leaving an active
        // lease attached to a completed task.
        tx.supersedeDependencyValidationsForDownstream(taskId, nowIso);
        for (const repair of tx.listDependencyRepairsForDownstream(taskId)
          .filter((candidate) => candidate.status === "pending"
            || candidate.status === "claimed")) {
          tx.updateDependencyRepairRequest({
            ...repair,
            status: "superseded",
            superseded_at: nowIso,
            updated_at: nowIso
          }, repair.status);
          this.#appendDependencyContextEvent(
            tx,
            repair.ctx_id ?? undefined,
            "dependency_repair_superseded",
            {
              repair_id: repair.repair_id,
              validation_id: repair.validation_id,
              cycle: repair.cycle,
              upstream_task_id: repair.upstream_task_id,
              downstream_task_id: repair.downstream_task_id,
              terminal_status: target
            },
            nowIso,
            target === "cancelled" ? "cancelled" : "closed",
            repair.cycle
          );
          this.#emit(tx, {
            task_id: repair.upstream_task_id,
            event_type: "dependency_repair_superseded",
            payload: {
              actor: "human",
              repair_id: repair.repair_id,
              validation_id: repair.validation_id,
              cycle: repair.cycle,
              downstream_task_id: repair.downstream_task_id,
              terminal_status: target
            }
          });
          repairChanges.push({
            repair_id: repair.repair_id,
            validation_id: repair.validation_id,
            upstream_task_id: repair.upstream_task_id,
            downstream_task_id: repair.downstream_task_id,
            cycle: repair.cycle,
            status: "superseded"
          });
        }
      }
      if (target === "cancelled") {
        // Outgoing pending validations are superseded as well so active runs
        // do not retain a retry slot after the upstream task is cancelled.
        tx.supersedePendingDependencyValidations(taskId, nowIso);
        for (const repair of tx.listDependencyRepairsForUpstream(taskId)
          .filter((candidate) => candidate.status === "pending"
            || candidate.status === "claimed")) {
          tx.updateDependencyRepairRequest({
            ...repair,
            status: "cancelled",
            updated_at: nowIso
          }, repair.status);
          this.#appendDependencyContextEvent(
            tx,
            repair.ctx_id ?? undefined,
            "dependency_repair_cancelled",
            {
              repair_id: repair.repair_id,
              validation_id: repair.validation_id,
              cycle: repair.cycle,
              upstream_task_id: repair.upstream_task_id,
              downstream_task_id: repair.downstream_task_id
            },
            nowIso,
            "cancelled",
            repair.cycle
          );
          this.#emit(tx, {
            task_id: repair.upstream_task_id,
            event_type: "dependency_repair_cancelled",
            payload: {
              actor: "human",
              repair_id: repair.repair_id,
              validation_id: repair.validation_id,
              cycle: repair.cycle,
              downstream_task_id: repair.downstream_task_id
            }
          });
          repairChanges.push({
            repair_id: repair.repair_id,
            validation_id: repair.validation_id,
            upstream_task_id: repair.upstream_task_id,
            downstream_task_id: repair.downstream_task_id,
            cycle: repair.cycle,
            status: "cancelled"
          });
        }
      }
      tx.updateTask({ ...task, status: target, updated_at: nowIso }, version);
      if (target !== "in_progress") {
        tx.deleteLeaseByTask(taskId);
      }
      if (target === "cancelled") {
        for (const dependency of tx.listTaskDependencies(taskId)) {
          this.#appendDependencyContextEvent(tx, dependency.ctx_id, "task_cancelled", {
            upstream_task_id: dependency.depends_on_task_id,
            downstream_task_id: taskId,
            status: "cancelled"
          }, nowIso, "cancelled");
        }
        for (const validation of tx.listDependencyValidationsForUpstream(taskId)) {
          const edge = tx.listTaskDependencies(validation.downstream_task_id)
            .find((dependency) => dependency.depends_on_task_id === taskId);
          this.#appendDependencyContextEvent(tx, edge?.ctx_id, "task_cancelled", {
            upstream_task_id: taskId,
            downstream_task_id: validation.downstream_task_id,
            validation_id: validation.validation_id,
            cycle: validation.cycle,
            status: "cancelled"
          }, nowIso, "cancelled", validation.cycle);
        }
      }
      tx.insertHumanDecision({
        decision_id: randomUUID(),
        task_id: taskId,
        question: `${eventType} request`,
        decision: context.note ?? decisionText,
        status: "decided",
        created_at: nowIso,
        decided_at: nowIso
      });
      const payload: Record<string, JsonValue> = { actor: "human" };
      if (eventType === "task_resumed" || target === "cancelled") {
        payload.dependency_contexts = this.#dependencyContexts(tx, taskId, target);
      }
      if (context.note !== undefined) {
        payload.note = context.note;
      }
      this.#emit(tx, { task_id: taskId, event_type: eventType, payload });
      if (target === "cancelled") {
        this.#notifyDependents(tx, taskId, target, task.title);
      }
      return {
        ...this.#mutation(taskId, target, version + 1),
        ...(repairChanges.length === 0
          ? {}
          : { dependency_repair_changes: repairChanges })
      };
    }), taskId);
  }

  #dependencyContexts(
    tx: ProgressTransaction,
    taskId: string,
    status: TaskStatus
  ): JsonValue[] {
    const task = tx.getTask(taskId);
    if (task === undefined) return [];
    const incoming = tx.listTaskDependencies(taskId).map((dependency) => {
      const upstream = tx.getTask(dependency.depends_on_task_id);
      return {
        ctx_id: dependency.ctx_id
          ?? `${upstream?.repository_id ?? "unknown"}:${dependency.depends_on_task_id}:${task.repository_id}:${task.task_id}:${dependency.created_at}`,
        validation_id: null,
        cycle: null,
        upstream_task_id: dependency.depends_on_task_id,
        downstream_task_id: task.task_id,
        status,
        policy: dependency.policy ?? "acceptance_gate"
      };
    });
    const outgoing = tx.listDependencyValidationsForUpstream(taskId).map((validation) => ({
      ctx_id: validation.ctx_id ?? validation.validation_id,
      validation_id: validation.validation_id,
      cycle: validation.cycle,
      upstream_task_id: validation.upstream_task_id,
      downstream_task_id: validation.downstream_task_id,
      status: status === "cancelled" ? "cancelled" : validation.status
    }));
    return [...incoming, ...outgoing];
  }

  #appendDependencyContextEvent(
    tx: ProgressTransaction,
    ctxId: string | undefined,
    eventType: string,
    payload: JsonValue,
    createdAt: string,
    status?: "active" | "cancelled" | "superseded" | "closed",
    cycle?: number
  ): void {
    if (ctxId === undefined
      || tx.getDependencyContext === undefined
      || tx.appendDependencyContextEvent === undefined
      || tx.listDependencyContextEvents === undefined) {
      return;
    }
    const context = tx.getDependencyContext(ctxId);
    if (context === undefined) return;
    if (tx.updateDependencyContext !== undefined && (status !== undefined || cycle !== undefined)) {
      tx.updateDependencyContext({
        ...context,
        ...(status === undefined ? {} : { status }),
        ...(cycle === undefined ? {} : { current_cycle: Math.max(context.current_cycle, cycle) }),
        updated_at: createdAt
      }, context.updated_at);
    }
    const sequence = tx.listDependencyContextEvents(ctxId).reduce(
      (max, event) => Math.max(max, event.sequence),
      0
    ) + 1;
    const enrichedPayload: JsonValue = typeof payload === "object"
      && payload !== null
      && !Array.isArray(payload)
      ? {
        ctx_id: context.ctx_id,
        upstream_repository_id: context.upstream_repository_id,
        downstream_repository_id: context.downstream_repository_id,
        generation: context.generation,
        cycle: cycle ?? context.current_cycle,
        ...(payload as { [key: string]: JsonValue })
      }
      : payload;
    tx.appendDependencyContextEvent({
      event_id: randomUUID(),
      ctx_id: ctxId,
      sequence,
      event_type: eventType,
      payload: enrichedPayload,
      created_at: createdAt
    });
  }

  #safeValidationSpec(
    tx: ProgressTransaction,
    validation: DependencyValidationRecord
  ): DependencyValidationSpec {
    const upstream = tx.getTask(validation.upstream_task_id);
    const downstream = tx.getTask(validation.downstream_task_id);
    try {
      // A persisted JSON blob may be legacy-shaped, but explicit identity
      // fields must agree with the authoritative validation row/task links.
      // Otherwise a direct seed or tampered record could be relabeled while
      // still passing the normal owner/repository checks.
      assertDependencyValidationSpecIdentity(validation.validation_spec, {
        upstream_task_id: validation.upstream_task_id,
        upstream_repository_id: upstream?.repository_id,
        downstream_task_id: validation.downstream_task_id,
        downstream_repository_id: downstream?.repository_id,
        cycle: validation.cycle
      });
    } catch (error) {
      throw new PlatformDomainError(
        "INVALID_INPUT",
        error instanceof Error ? error.message : "Validation contract identity mismatch",
        {
          evidence: [validation.validation_id],
          recovery_actions: ["Request a fresh validation cycle from the authoritative task dependency."]
        }
      );
    }
    // The request contract is immutable.  Read back the stored, already
    // sanitized spec; only relationship identities are re-authorized here.
    // Do not substitute the current task checkpoint/snapshot, which may have
    // changed after this cycle was created.
    return sanitizeDependencyValidationSpec(validation.validation_spec, {
      preserve_persisted_fields: true,
      upstream_task_id: validation.upstream_task_id,
      // The authoritative task row supplies the version; a legacy JSON blob
      // cannot relabel a request to an arbitrary version.
      upstream_task_version: tx.getTaskVersion(validation.upstream_task_id) ?? 0,
      upstream_repository_id: upstream?.repository_id,
      downstream_task_id: validation.downstream_task_id,
      downstream_repository_id: downstream?.repository_id,
      cycle: validation.cycle
    });
  }

  #buildDependencyValidationSpec(
    tx: ProgressTransaction,
    upstream: TaskRecord,
    downstream: TaskRecord,
    cycle: number,
    upstreamVersion: number
  ): DependencyValidationSpec {
    const snapshot = tx.getLatestRepoSnapshot(upstream.task_id);
    const commands = upstream.checkpoint?.verification
      .map((entry) => entry.command.trim())
      .filter((command) => command.length > 0) ?? [];
    return sanitizeDependencyValidationSpec({}, {
      upstream_task_id: upstream.task_id,
      upstream_task_version: upstreamVersion,
      upstream_repository_id: upstream.repository_id,
      downstream_task_id: downstream.task_id,
      downstream_repository_id: downstream.repository_id,
      cycle,
      target_revision: snapshot?.head_commit,
      target_head_commit: snapshot?.head_commit,
      worktree_path: snapshot?.worktree_path,
      changed_files: snapshot?.changed_files,
      command: commands[0] ?? "not specified",
      commands: commands.length > 0 ? commands : ["not specified"],
      lease_ttl_ms: this.#leaseTtlMs,
      max_attempts: maxDependencyValidationAttempts
    });
  }

  #assertDependencyValidationLink(
    tx: ProgressTransaction,
    validation: DependencyValidationRecord
  ): void {
    const linked = tx.listTaskDependencies(validation.downstream_task_id)
      .some((dependency) => dependency.depends_on_task_id === validation.upstream_task_id);
    if (!linked) {
      throw new PlatformDomainError(
        "DEPENDENCY_VALIDATION_NOT_FOUND",
        "Dependency validation is not linked to the downstream task",
        {
          evidence: [validation.validation_id],
          recovery_actions: ["Restore the task dependency link before receiving this validation."]
        }
      );
    }
  }

  #assertValidationSessionOwner(sessionId: string, owner: string): void {
    const session = this.#session(sessionId);
    if (session.owner !== owner) {
      throw new PlatformDomainError(
        "OWNER_MISMATCH",
        "Session owner does not match request owner",
        { evidence: [session.owner ?? "unassigned", owner] }
      );
    }
  }

  #latestDependencyValidationCycle(
    tx: ProgressTransaction,
    validation: DependencyValidationRecord
  ): number {
    return tx.listDependencyValidationsForUpstream(validation.upstream_task_id)
      .filter((candidate) => {
        if (candidate.downstream_task_id !== validation.downstream_task_id) {
          return false;
        }
        const dependency = tx.listTaskDependencies(candidate.downstream_task_id)
          .find((entry) => entry.depends_on_task_id === candidate.upstream_task_id);
        return dependency !== undefined && candidate.requested_at >= dependency.created_at;
      })
      .reduce((max, candidate) => Math.max(max, candidate.cycle), 0);
  }

  #requestDependencyValidations(
    tx: ProgressTransaction,
    upstream: TaskRecord,
    requestedByActor: TaskActor,
    requestedByOwner: string | null,
    requestedAt: string,
    upstreamVersion?: number,
    missingOnly = false,
    beforeRequest?: () => void
  ): number {
    const dependents = tx.listDependentsOf(upstream.task_id)
      .map((dependency) => tx.getTask(dependency.task_id))
      .filter((dependent): dependent is TaskRecord => (
        dependent !== undefined
        && dependent.task_id !== upstream.task_id
        && dependent.status !== "done"
        && dependent.status !== "cancelled"
        && tx.listTaskDependencies(dependent.task_id)
          .find((edge) => edge.depends_on_task_id === upstream.task_id)?.policy !== "informational"
        && (!missingOnly || !tx.listDependencyValidationsForUpstream(upstream.task_id).some((validation) => {
          const edge = tx.listTaskDependencies(dependent.task_id)
            .find((dependency) => dependency.depends_on_task_id === upstream.task_id);
          return validation.downstream_task_id === dependent.task_id
            && edge !== undefined && validation.requested_at >= edge.created_at;
        }))
      ));
    if (dependents.length === 0) {
      return 0;
    }

    beforeRequest?.();
    const edgeGenerationTimes = dependents.flatMap((downstream) => {
      const edge = tx.listTaskDependencies(downstream.task_id)
        .find((dependency) => dependency.depends_on_task_id === upstream.task_id);
      return edge === undefined ? [] : [edge.created_at];
    });
    // The edge marker is monotonic even when the service wall clock rolls
    // backwards.  Use it as a lower bound for request timestamps so a fresh
    // cycle created after such a rollback is still recognized as current by
    // list/gate queries.
    const supersededAt = this.#maxIsoTimestamp(requestedAt, edgeGenerationTimes);
    if (!missingOnly) tx.supersedePendingDependencyValidations(upstream.task_id, supersededAt);
    const cycle = tx.nextDependencyValidationCycle(upstream.task_id);
    for (const downstream of dependents) {
      const edge = tx.listTaskDependencies(downstream.task_id)
        .find((dependency) => dependency.depends_on_task_id === upstream.task_id);
      const validationRequestedAt = this.#maxIsoTimestamp(
        requestedAt,
        edge === undefined ? [] : [edge.created_at]
      );
      const validation: DependencyValidationRecord = {
        ...(edge?.ctx_id === undefined ? {} : { ctx_id: edge.ctx_id }),
        validation_id: randomUUID(),
        upstream_task_id: upstream.task_id,
        downstream_task_id: downstream.task_id,
        cycle,
        status: "pending",
        requested_by_actor: requestedByActor,
        requested_by_owner: requestedByOwner,
        requested_at: validationRequestedAt,
        request_read_at: null,
        responded_by_owner: null,
        response_reason: null,
        responded_at: null,
        response_read_at: null,
        validation_spec: this.#buildDependencyValidationSpec(
          tx,
          upstream,
          downstream,
          cycle,
          upstreamVersion ?? tx.getTaskVersion(upstream.task_id) ?? 0
        )
      };
      tx.insertDependencyValidation(validation);
      this.#appendDependencyContextEvent(
        tx,
        edge?.ctx_id,
        "validation_requested",
        {
          validation_id: validation.validation_id,
          cycle,
          upstream_task_id: upstream.task_id,
          downstream_task_id: downstream.task_id
        },
        validationRequestedAt,
        "active",
        cycle
      );
      this.#emit(tx, {
        task_id: downstream.task_id,
        event_type: "dependency_validation_requested",
        payload: {
          actor: requestedByActor,
          validation_id: validation.validation_id,
          upstream_task_id: upstream.task_id,
          downstream_task_id: downstream.task_id,
          cycle
        }
      });
    }
    this.#emit(tx, {
      task_id: upstream.task_id,
      event_type: "dependency_validation_requested",
      payload: {
        actor: requestedByActor,
        ctx_ids: dependents.flatMap((dependent) => {
          const edge = tx.listTaskDependencies(dependent.task_id)
            .find((dependency) => dependency.depends_on_task_id === upstream.task_id);
          return edge?.ctx_id === undefined ? [] : [edge.ctx_id];
        }),
        cycle,
        dependent_task_ids: dependents.map((dependent) => dependent.task_id)
      }
    });
    return dependents.length;
  }

  #assertDependencyValidationGate(tx: ProgressTransaction, upstreamTaskId: string): void {
    const dependents = tx.listDependentsOf(upstreamTaskId)
      .map((dependency) => tx.getTask(dependency.task_id))
      .filter((dependent): dependent is TaskRecord => (
        dependent !== undefined
        && dependent.status !== "done"
        && dependent.status !== "cancelled"
        && (() => {
          const policy = tx.listTaskDependencies(dependent.task_id)
            .find((entry) => entry.depends_on_task_id === upstreamTaskId)?.policy;
          return policy !== "informational" && policy !== "validation_gate";
        })()
      ));
    if (dependents.length === 0) {
      return;
    }
    const validations = tx.listDependencyValidationsForUpstream(upstreamTaskId);
    const dependencyByTask = new Map(
      dependents.map((dependent) => [
        dependent.task_id,
        tx.listTaskDependencies(dependent.task_id)
          .find((entry) => entry.depends_on_task_id === upstreamTaskId)
      ] as const)
    );
    const latestCycle = validations.reduce(
      (latest, validation) => {
        const dependency = dependencyByTask.get(validation.downstream_task_id);
        return dependency !== undefined && validation.requested_at >= dependency.created_at
          ? Math.max(latest, validation.cycle)
          : latest;
      },
      0
    );
    const statusByTask = new Map<string, string>();
    for (const dependent of dependents) {
      const dependency = dependencyByTask.get(dependent.task_id);
      const latestForDependent = validations
        .filter((validation) => validation.downstream_task_id === dependent.task_id
          && dependency !== undefined
          && validation.requested_at >= dependency.created_at)
        .reduce((latest, validation) => Math.max(latest, validation.cycle), 0);
      const latestStatus = validations.find((validation) => (
        validation.downstream_task_id === dependent.task_id
        && validation.cycle === latestForDependent
        && dependency !== undefined
        && validation.requested_at >= dependency.created_at
      ))?.status;
      statusByTask.set(dependent.task_id, latestStatus ?? "not_requested");
    }
    const incomplete = dependents.filter((dependent) => (
      statusByTask.get(dependent.task_id) !== "passed"
    ));
    if (latestCycle === 0 || incomplete.length > 0) {
      throw new PlatformDomainError(
        "DEPENDENCY_VALIDATION_REQUIRED",
        `Task ${upstreamTaskId} requires downstream validation before acceptance`,
        {
          evidence: incomplete.map((dependent) => (
            `${dependent.task_id}:${statusByTask.get(dependent.task_id) ?? "not_requested"}`
          )),
          recovery_actions: [
            "Request downstream validation and wait until every open dependent passes."
          ]
        }
      );
    }
  }

  #dependencyValidationGate(tx: ProgressTransaction, upstreamTaskId: string): DependencyValidationGate {
    const dependents = tx.listDependentsOf(upstreamTaskId)
      .map((dependency) => tx.getTask(dependency.task_id))
      .filter((dependent): dependent is TaskRecord => dependent !== undefined
        && dependent.status !== "done" && dependent.status !== "cancelled"
        && tx.listTaskDependencies(dependent.task_id)
          .find((edge) => edge.depends_on_task_id === upstreamTaskId)?.policy !== "informational"
        && tx.listTaskDependencies(dependent.task_id)
          .find((edge) => edge.depends_on_task_id === upstreamTaskId)?.policy !== "validation_gate");
    const validations = tx.listDependencyValidationsForUpstream(upstreamTaskId);
    const dependencyByTask = new Map(
      dependents.map((dependent) => [
        dependent.task_id,
        tx.listTaskDependencies(dependent.task_id)
          .find((entry) => entry.depends_on_task_id === upstreamTaskId)
      ] as const)
    );
    const latestCycle = validations.reduce((latest, validation) => {
      const dependency = dependencyByTask.get(validation.downstream_task_id);
      return dependency !== undefined && validation.requested_at >= dependency.created_at
        ? Math.max(latest, validation.cycle)
        : latest;
    }, 0);
    const readyForAllDependents = dependents.every((dependent) => {
      const dependency = dependencyByTask.get(dependent.task_id);
      const latestForDependent = validations
        .filter((validation) => validation.downstream_task_id === dependent.task_id
          && dependency !== undefined
          && validation.requested_at >= dependency.created_at)
        .reduce((latest, validation) => Math.max(latest, validation.cycle), 0);
      return latestForDependent > 0 && validations.some((validation) => (
        validation.downstream_task_id === dependent.task_id
        && validation.cycle === latestForDependent
        && validation.status === "passed"
        && dependency !== undefined
        && validation.requested_at >= dependency.created_at
      ));
    });
    return {
      dependent_count: dependents.length,
      latest_cycle: latestCycle === 0 ? null : latestCycle,
      ready_for_acceptance: dependents.length === 0 || readyForAllDependents
    };
  }

  #assertHardBlockDependencies(tx: ProgressTransaction, taskId: string): void {
    const blockers = tx.listTaskDependencies(taskId).flatMap((dependency) => {
      if (dependency.policy !== "hard_block") {
        return [];
      }
      const upstream = tx.getTask(dependency.depends_on_task_id);
      if (upstream === undefined) {
        return [`${dependency.depends_on_task_id}:not_found`];
      }
      return upstream.status === "done" || upstream.status === "cancelled"
        ? []
        : [`${upstream.task_id}:${upstream.status}`];
    });
    if (blockers.length === 0) {
      return;
    }
    throw new PlatformDomainError(
      "ACTIVE_UPSTREAM_DEPENDENCY",
      `Task ${taskId} cannot be cancelled while upstream dependencies are active`,
      {
        evidence: blockers,
        recovery_actions: [
          "Wait until every direct upstream dependency is done or cancelled, then retry."
        ]
      }
    );
  }

  #notifyDependents(
    tx: ProgressTransaction,
    upstreamTaskId: string,
    upstreamStatus: "done" | "cancelled",
    upstreamTitle: string
  ): void {
    const dependents = tx.listDependentsOf(upstreamTaskId)
      .map((dep) => dep.task_id)
      .filter((taskId) => taskId !== upstreamTaskId);
    for (const dependentId of dependents) {
      const dependent = tx.getTask(dependentId);
      if (dependent === undefined) {
        continue;
      }
      // Closed dependents can no longer react to the upstream change, so a
      // notification for them would only be noise.
      if (dependent.status === "done" || dependent.status === "cancelled") {
        continue;
      }
      tx.insertNotification({
        notification_id: randomUUID(),
        owner: dependent.owner ?? null,
        task_id: dependentId,
        repository_id: dependent.repository_id,
        task_title: dependent.title,
        upstream_task_id: upstreamTaskId,
        upstream_title: upstreamTitle,
        upstream_status: upstreamStatus,
        read_at: null,
        created_at: this.#now()
      });
    }
  }

  #pauseConflictingLegacyTask(
    tx: ProgressTransaction,
    scope: ActiveTaskScope,
    worktreePath: string,
    conflictingTaskId: string,
    nowIso: string
  ): void {
    const other = tx.getTask(scope.task_id);
    if (other === undefined) {
      return;
    }
    // Only legacy-adopted lease holders reach this helper. in_progress pauses
    // through the state machine; verifying can only lose its lease because
    // verifying->paused is not an allowed transition for any actor.
    const action = other.status === "in_progress" ? "paused" : "lease_released";
    if (action === "paused") {
      assertTransition("agent", other.status, "paused");
      const version = this.#versionOf(other.task_id);
      tx.updateTask({ ...other, status: "paused", updated_at: nowIso }, version);
    }
    tx.deleteLeaseByTask(other.task_id);
    this.#emit(tx, {
      task_id: other.task_id,
      event_type: "legacy_worktree_conflict",
      payload: {
        actor: "agent",
        worktree_path: worktreePath,
        conflicting_task_id: conflictingTaskId,
        action
      }
    });
  }

  #isLegacyAdopted(task: TaskRecord): boolean {
    return task.checkpoint?.source?.source_type === "legacy_adoption";
  }

  #withInheritedSource(
    task: TaskRecord,
    payload: CheckpointPayload
  ): CheckpointPayload {
    const existingSource = task.checkpoint?.source;
    if (payload.source === undefined && existingSource !== undefined) {
      return { ...payload, source: existingSource };
    }
    return payload;
  }

  #materializeCheckpoint(
    tx: ProgressTransaction,
    task: TaskRecord,
    proposal: CheckpointWritePayload,
    draft: RepoSnapshotDraft | undefined,
    nowIso: string,
    sessionId: string
  ): CheckpointPayload {
    const previousAttempts = [...(task.checkpoint?.attempts ?? [])];
    const previousById = new Map(previousAttempts.map((attempt) => (
      [attempt.attempt_id, attempt] as const
    )));
    const appended: TaskAttempt[] = [];
    for (const candidate of proposal.attempts ?? []) {
      const historicalEvent = previousById.has(candidate.attempt_id)
        ? undefined
        : tx.findTaskAttemptEvent(task.task_id, candidate.attempt_id);
      const historicalPayload = historicalEvent?.payload;
      const historical = historicalPayload === undefined
        ? undefined
        : taskAttemptSchema.safeParse(historicalPayload);
      if (historicalEvent !== undefined && historical?.success !== true) {
        throw new PlatformDomainError(
          "INVALID_INPUT",
          `Attempt ${candidate.attempt_id} already exists in immutable task history`,
          {
            evidence: [candidate.attempt_id, historicalEvent.event_id],
            recovery_actions: ["Use a new attempt_id for a distinct failed approach."]
          }
        );
      }
      const existing = previousById.get(candidate.attempt_id)
        ?? (historical?.success === true ? historical.data : undefined);
      if (existing !== undefined) {
        if (!this.#sameAttempt(existing, candidate)) {
          throw new PlatformDomainError(
            "INVALID_INPUT",
            `Attempt ${candidate.attempt_id} cannot rewrite recorded task history`,
            {
              evidence: [candidate.attempt_id],
              recovery_actions: ["Use a new attempt_id for a distinct failed approach."]
            }
          );
        }
        continue;
      }
      const recorded: TaskAttempt = { ...candidate, recorded_at: nowIso };
      previousById.set(recorded.attempt_id, recorded);
      appended.push(recorded);
    }
    const attempts = [...previousAttempts, ...appended].slice(-20);
    const verification = proposal.verification.map((entry) => {
      if (draft?.content_digest !== undefined) {
        return {
          command: entry.command,
          outcome: entry.outcome,
          summary: entry.summary,
          code_fingerprint: {
            head_commit: draft.head_commit,
            worktree_path: draft.worktree_path,
            content_digest: draft.content_digest,
            captured_at: draft.captured_at,
            provenance: draft.provenance_source ?? "server_verified"
          }
        };
      }
      if (entry.code_fingerprint !== undefined) {
        return {
          ...entry,
          code_fingerprint: {
            ...entry.code_fingerprint,
            provenance: "client_reported" as const
          }
        };
      }
      return entry;
    });
    const materialized = checkpointPayloadSchema.parse({
      ...proposal,
      attempts,
      verification
    });
    for (const attempt of appended) {
      this.#emit(tx, {
        task_id: task.task_id,
        session_id: sessionId,
        event_type: "task_attempt_recorded",
        payload: {
          actor: "agent",
          attempt_id: attempt.attempt_id,
          summary: attempt.summary,
          outcome: attempt.outcome,
          evidence_refs: [...attempt.evidence_refs],
          recorded_at: attempt.recorded_at
        }
      });
    }
    return this.#withInheritedSource(task, materialized);
  }

  #assertFreshSubmissionEvidence(
    checkpoint: CheckpointPayload,
    submitted: readonly VerificationEntry[],
    draft: RepoSnapshotDraft | undefined
  ): void {
    const evidence = checkpoint.verification;
    const fingerprint = evidence[0]?.code_fingerprint;
    const comparable = (entries: readonly VerificationEntry[]) => entries
      .map((entry) => `${entry.command}\u0000${entry.outcome}\u0000${entry.summary}`)
      .sort();
    const evidenceComparable = comparable(evidence);
    const submittedComparable = comparable(submitted);
    const requestMatches = evidenceComparable.length === submittedComparable.length
      && evidenceComparable.every((value, index) => value === submittedComparable[index]);
    const allPassed = evidence.length > 0
      && evidence.every((entry) => entry.outcome === "passed");
    const allTrusted = evidence.length > 0 && evidence.every((entry) => (
      entry.code_fingerprint?.provenance === "server_verified"
      || entry.code_fingerprint?.provenance === "host_verified"
    ));
    const liveDigest = draft?.content_digest;
    const fingerprintMatches = draft !== undefined
      && liveDigest !== undefined
      && evidence.every((entry) => {
        const candidate = entry.code_fingerprint;
        return candidate !== undefined
          && candidate.head_commit === draft.head_commit
          && this.#normalizePath(candidate.worktree_path) === this.#normalizePath(draft.worktree_path)
          && candidate.content_digest === liveDigest;
      });
    if (allPassed && allTrusted && fingerprintMatches && requestMatches) {
      return;
    }
    throw new PlatformDomainError(
      "CHECKPOINT_REQUIRED",
      "task_submit requires fresh server-verified checkpoint evidence for the current code content",
      {
        evidence: [
          `checkpoint digest ${fingerprint?.content_digest ?? "missing"}`,
          `current digest ${liveDigest ?? "unverifiable"}`,
          `checkpoint outcomes ${evidence.map((entry) => entry.outcome).join(",") || "missing"}`,
          `submitted evidence matches ${requestMatches}`
        ],
        recovery_actions: [
          "Re-run verification against the current worktree and save it with task_checkpoint before submitting."
        ]
      }
    );
  }

  async #recoveryEvidenceState(
    task: TaskDetail,
    latestSnapshot: RepoSnapshotRecord | null
  ): Promise<TaskRecoveryView["evidence_state"]> {
    const verification = task.checkpoint?.verification ?? [];
    if (verification.length === 0) {
      return "missing";
    }
    const fingerprints = verification.flatMap((entry) => (
      entry.code_fingerprint === undefined ? [] : [entry.code_fingerprint]
    ));
    if (fingerprints.length === 0) {
      return "missing";
    }
    if (fingerprints.length !== verification.length
      || fingerprints.some((fingerprint) => fingerprint.provenance === "client_reported")) {
      return "unverifiable";
    }
    const allHostVerified = fingerprints.every((fingerprint) => (
      fingerprint.provenance === "host_verified"
    ));
    if (allHostVerified) {
      // Host-verified snapshots describe a worktree the server cannot reach;
      // freshness rests on the frozen submit-time fingerprint plus the stored
      // host evidence record, never on a live re-probe.
      const hostEvidenceId = latestSnapshot?.host_evidence_id;
      if (hostEvidenceId !== undefined
        && this.#store.getHostEvidence(hostEvidenceId) !== undefined) {
        return "fresh";
      }
      return "unverifiable";
    }
    const worktreePath = fingerprints[0]!.worktree_path
      || latestSnapshot?.worktree_path;
    if (worktreePath === undefined) {
      return "unverifiable";
    }
    let live: RepoSnapshotDraft;
    try {
      live = await this.#probeSessionWorktree(task.repository_id, worktreePath);
    } catch {
      return "unverifiable";
    }
    if (live.content_digest === undefined) {
      return "unverifiable";
    }
    return fingerprints.every((fingerprint) => (
      fingerprint.head_commit === live.head_commit
      && this.#normalizePath(fingerprint.worktree_path)
        === this.#normalizePath(live.worktree_path)
      && fingerprint.content_digest === live.content_digest
    )) ? "fresh" : "stale";
  }

  #recoveryNextAction(
    task: TaskDetail,
    evidenceState: TaskRecoveryView["evidence_state"],
    pendingDecisionCount: number,
    gate: DependencyValidationGate,
    activeRepair: DependencyRepairRequestRecord | null
  ): string {
    if (pendingDecisionCount > 0) {
      return "resolve pending human decisions";
    }
    if (activeRepair?.status === "pending") {
      return "claim the dependency repair and address the rejected validation";
    }
    if (activeRepair?.status === "claimed") {
      return "continue the claimed dependency repair";
    }
    if (task.status === "pending_acceptance") {
      return gate.ready_for_acceptance
        ? "await human acceptance"
        : "await current downstream dependency validation";
    }
    if (evidenceState === "stale" || evidenceState === "unverifiable") {
      return "rerun verification and checkpoint the current code content";
    }
    return task.checkpoint?.next_action
      ?? (task.status === "backlog" || task.status === "paused"
        ? "start or resume the task"
        : "continue task execution");
  }

  #sameAttempt(recorded: TaskAttempt, proposal: TaskAttemptDraft): boolean {
    return recorded.summary === proposal.summary
      && recorded.outcome === proposal.outcome
      && recorded.evidence_refs.length === proposal.evidence_refs.length
      && recorded.evidence_refs.every((value, index) => value === proposal.evidence_refs[index]);
  }

  /**
   * While a task holds an active lease, only the lease-holding session may
   * checkpoint or submit it; other sessions get the standard lease conflict.
   */
  #assertLeaseHolder(
    tx: ProgressTransaction,
    taskId: string,
    sessionId: string
  ): void {
    const lease = tx.getLeaseByTask(taskId);
    if (lease === undefined) {
      throw new PlatformDomainError(
        "LEASE_NOT_FOUND",
        `Task ${taskId} has no active execution lease`,
        {
          evidence: [taskId],
          recovery_actions: [
            "Start or resume the task to acquire its lease before checkpointing or submitting."
          ]
        }
      );
    }
    if (lease.session_id === sessionId) {
      return;
    }
    throw new PlatformDomainError(
      "TASK_LEASE_CONFLICT",
      `Task ${taskId} is leased by another session`,
      {
        evidence: [lease.session_id],
        recovery_actions: [
          "Let the leasing session checkpoint/submit, or have a human release the stale session on the board."
        ]
      }
    );
  }

  /**
   * A session may only write to tasks in the repository it is bound to.
   * Cross-repository writes (e.g. a frontend session starting a backend
   * task) are rejected regardless of role or scope claims.
   */
  #assertSameRepository(
    session: SessionRecord,
    taskRepositoryId: string
  ): void {
    if (session.repository_id !== taskRepositoryId) {
      throw new PlatformDomainError(
        "REPOSITORY_NOT_ALLOWED",
        `Session is bound to ${session.repository_id} but the task belongs to ${taskRepositoryId}`,
        {
          evidence: [session.repository_id, taskRepositoryId],
          recovery_actions: [
            "Call session_context with the task's repository, or use a session already bound to it."
          ]
        }
      );
    }
    if (this.#projectAccess !== undefined && session.owner !== undefined) {
      const repository = this.#store.getRepository(taskRepositoryId);
      if (repository !== undefined) {
        const project = this.#store.getProject(repository.project_id);
        // Projects created before the creator field was introduced remain
        // unassigned legacy records. Keep their existing task lifecycle
        // behavior until an explicit creator/share is established.
        if (project?.created_by !== undefined && project.created_by !== null) {
          this.#projectAccess.assertProjectViewer(repository.project_id, session.owner);
        }
      }
    }
  }

  #assertSameOwner(
    session: SessionRecord,
    taskOwner: string | undefined,
    taskId: string
  ): void {
    if (session.owner === taskOwner) {
      return;
    }
    throw new PlatformDomainError(
      "OWNER_MISMATCH",
      `Session owner cannot write to task ${taskId}`,
      {
        evidence: [session.owner ?? "unassigned", taskOwner ?? "unassigned"],
        recovery_actions: [
          "Use a session bound with the task owner's exact git config user.name."
        ]
      }
    );
  }

  #assertPendingDecisionsResolved(task: TaskRecord, target: TaskStatus): void {
    if (task.status === "waiting_human" && target === "in_progress") {
      const pending = task.checkpoint?.pending_decisions ?? [];
      if (pending.length > 0) {
        throw new PlatformDomainError(
          "HUMAN_CONFIRMATION_REQUIRED",
          "Pending decisions need human conclusions before the task can resume",
          {
            evidence: [...pending],
            recovery_actions: [
              "Record the human decisions via the web board, then retry."
            ]
          }
        );
      }
    }
  }

  #withOperation<T>(
    sessionId: string,
    operationId: string,
    toolName: string,
    semanticInput: unknown,
    mutate: (tx: ProgressTransaction) => T
  ): T {
    const requestHash = canonicalRequestHash(semanticInput);
    return this.#store.transaction((tx) => {
      this.#assertSessionWritable(this.#txSession(tx, sessionId));
      const previous = tx.getOperationResult(sessionId, operationId);
      if (previous !== undefined) {
        this.#assertOperationFingerprint(previous, toolName, requestHash);
        return previous.result as T;
      }
      const result = mutate(tx);
      tx.putOperationResult({
        session_id: sessionId,
        operation_id: operationId,
        tool_name: toolName,
        request_hash: requestHash,
        result: this.#jsonValue(result),
        created_at: this.#now()
      });
      return result;
    });
  }

  #cachedOperation<T>(
    sessionId: string,
    operationId: string,
    toolName: string,
    semanticInput: unknown
  ): T | undefined {
    const requestHash = canonicalRequestHash(semanticInput);
    const found = this.#store.transaction((tx) => {
      this.#assertSessionWritable(this.#txSession(tx, sessionId));
      return tx.getOperationResult(sessionId, operationId);
    });
    if (found === undefined) {
      return undefined;
    }
    this.#assertOperationFingerprint(found, toolName, requestHash);
    return found.result as T;
  }

  #assertOperationFingerprint(
    found: OperationResult,
    toolName: string,
    requestHash: string
  ): void {
    if (found.tool_name === toolName && found.request_hash === requestHash) {
      return;
    }
    throw new PlatformDomainError(
      "OPERATION_ID_CONFLICT",
      `Operation id ${found.operation_id} was already used for a different request`,
      {
        evidence: [
          `stored tool: ${found.tool_name ?? "legacy-unfingerprinted"}`,
          `requested tool: ${toolName}`
        ],
        recovery_actions: [
          "Use a fresh operation_id, or retry the exact original tool input."
        ]
      }
    );
  }

  #assertSessionWritable(session: SessionRecord): void {
    if (session.successor_session_id === undefined) {
      return;
    }
    throw new PlatformDomainError(
      "SESSION_SUPERSEDED",
      `Session ${session.session_id} was replaced by explicit successor ${session.successor_session_id}`,
      {
        evidence: [session.session_id, session.successor_session_id],
        recovery_actions: [
          "Continue from the explicit successor session; predecessor sessions are permanently fenced from writes."
        ]
      }
    );
  }

  #runTx<T>(work: () => T, taskId?: string): T {
    try {
      return work();
    } catch (error) {
      throw this.#translateStorageError(error, taskId);
    }
  }

  #translateStorageError(error: unknown, taskId?: string): unknown {
    if (!(error instanceof StorageError)) {
      return error;
    }
    if (error.code === "VERSION_CONFLICT") {
      const current = taskId === undefined
        ? undefined
        : this.#store.getTaskDetail(taskId)?.version;
      const options: PlatformDomainErrorOptions = {
        evidence: [taskId ?? "unknown task"],
        recovery_actions: ["Re-read the task and retry with its current version."]
      };
      if (current !== undefined) {
        options.current_version = String(current);
      }
      return new PlatformDomainError(
        "TASK_VERSION_CONFLICT",
        error.message,
        options
      );
    }
    if (error.code === "CONSTRAINT_VIOLATION") {
      return new PlatformDomainError(
        "TASK_LEASE_CONFLICT",
        error.message,
        {
          evidence: [error.message],
          recovery_actions: [
            "Wait for the conflicting lease to be released by its session or a human."
          ]
        }
      );
    }
    if (error.code === "STORAGE_BUSY") {
      return new PlatformDomainError("STORAGE_BUSY", error.message, {
        retryable: true,
        recovery_actions: ["Retry the operation once the store is idle."]
      });
    }
    return error;
  }

  #detail(taskId: string): TaskDetail | undefined {
    return this.#store.getTaskDetail(taskId);
  }

  #versionOf(taskId: string): number {
    return this.#detail(taskId)?.version ?? 0;
  }

  #assertVersion(taskId: string, expectedVersion: number): void {
    const current = this.#versionOf(taskId);
    if (current !== expectedVersion) {
      throw new PlatformDomainError(
        "TASK_VERSION_CONFLICT",
        `Task ${taskId} is not at expected version ${expectedVersion}`,
        {
          current_version: String(current),
          evidence: [`task ${taskId} is at version ${current}`],
          recovery_actions: ["Re-read the task and retry with its current version."]
        }
      );
    }
  }

  #assertOptionalVersion(taskId: string, expectedVersion: number | undefined): void {
    if (expectedVersion !== undefined) {
      this.#assertVersion(taskId, expectedVersion);
    }
  }

  #txTask(tx: ProgressTransaction, taskId: string): TaskRecord {
    const task = tx.getTask(taskId);
    if (task === undefined) {
      throw this.#taskNotFound(taskId);
    }
    return task;
  }

  #txSession(tx: ProgressTransaction, sessionId: string): SessionRecord {
    const session = tx.getSession(sessionId);
    if (session === undefined) {
      throw new PlatformDomainError(
        "SESSION_NOT_FOUND",
        `Session ${sessionId} is not registered`,
        {
          evidence: [sessionId],
          recovery_actions: ["Call session_context to register the session first."]
        }
      );
    }
    return session;
  }

  #session(sessionId: string): SessionRecord {
    return this.#store.transaction((tx) => this.#txSession(tx, sessionId));
  }

  #taskNotFound(taskId: string): PlatformDomainError {
    return new PlatformDomainError(
      "TASK_NOT_FOUND",
      `Task ${taskId} does not exist`,
      {
        evidence: [taskId],
        recovery_actions: ["Re-read the task list and retry with an existing task."]
      }
    );
  }

  #requireHuman(actor: TaskActor, action: string): void {
    if (actor !== "human") {
      throw new PlatformDomainError(
        "HUMAN_CONFIRMATION_REQUIRED",
        `Only a human can ${action}`,
        { evidence: [actor] }
      );
    }
  }

  #assertLegacyIdentity(existing: LegacyTaskImport, input: AdoptTaskInput): void {
    const mismatches: string[] = [];
    if (existing.source_session_label !== input.source_session_label) {
      mismatches.push(
        `source_session_label: ${existing.source_session_label} != ${input.source_session_label}`
      );
    }
    if (existing.project_id !== input.project_id) {
      mismatches.push(`project_id: ${existing.project_id} != ${input.project_id}`);
    }
    if (existing.repository_id !== input.repository_id) {
      mismatches.push(
        `repository_id: ${existing.repository_id} != ${input.repository_id}`
      );
    }
    if (this.#normalizePath(existing.worktree_path)
      !== this.#normalizePath(input.worktree_path)) {
      mismatches.push(
        `worktree_path: ${existing.worktree_path} != ${input.worktree_path}`
      );
    }
    if (existing.normalized_title !== input.normalized_title) {
      mismatches.push(
        `normalized_title: ${existing.normalized_title} != ${input.normalized_title}`
      );
    }
    if (mismatches.length > 0) {
      throw new PlatformDomainError(
        "TASK_ALREADY_ADOPTED",
        `legacy_import_key ${input.legacy_import_key} was already adopted with different identity fields`,
        {
          evidence: mismatches,
          recovery_actions: [
            "Reuse the originally adopted task or choose a new legacy_import_key."
          ]
        }
      );
    }
  }

  #assertLeasesAvailable(
    tx: ProgressTransaction,
    taskId: string,
    sessionId: string,
    worktreePath: string | undefined,
    nowIso = this.#now()
  ): void {
    const taskLease = tx.getLeaseByTask(taskId);
    if (taskLease !== undefined
      && taskLease.session_id !== sessionId
      && !this.#clearLeaseIfExpired(tx, taskLease, nowIso)) {
      throw this.#taskLeaseConflict(taskId, taskLease.session_id, worktreePath);
    }
    const sessionLease = tx.getLeaseBySession(sessionId);
    if (sessionLease !== undefined
      && sessionLease.task_id !== taskId
      && !this.#clearLeaseIfExpired(tx, sessionLease, nowIso)) {
      throw this.#sessionLeaseConflict(sessionId, sessionLease.task_id, worktreePath);
    }
  }

  /** Delete a lease row whose TTL already elapsed; false while it still holds. */
  #clearLeaseIfExpired(
    tx: ProgressTransaction,
    lease: ActiveTaskLease,
    nowIso?: string
  ): boolean {
    if (!this.#leaseExpired(lease, nowIso ?? this.#now())) {
      return false;
    }
    tx.deleteLeaseByTask(lease.task_id);
    return true;
  }

  #leaseExpired(lease: ActiveTaskLease, nowIso: string): boolean {
    return Date.parse(lease.expires_at) <= Date.parse(nowIso);
  }

  #taskLeaseConflict(
    taskId: string,
    holderSessionId: string,
    worktreePath: string | undefined
  ): PlatformDomainError {
    return new PlatformDomainError(
      "TASK_LEASE_CONFLICT",
      `Task ${taskId} is already leased by session ${holderSessionId}`,
      {
        evidence: [
          `task ${taskId} is leased by session ${holderSessionId}`,
          `worktree ${worktreePath ?? "unknown"}`
        ],
        recovery_actions: [
          "Wait for the lease to be released or to expire.",
          "Ask a human to release the holding session from the web board."
        ]
      }
    );
  }

  #sessionLeaseConflict(
    sessionId: string,
    heldTaskId: string,
    worktreePath: string | undefined
  ): PlatformDomainError {
    return new PlatformDomainError(
      "TASK_LEASE_CONFLICT",
      `Session ${sessionId} already holds the lease for task ${heldTaskId}`,
      {
        evidence: [
          `session ${sessionId} already holds the lease for task ${heldTaskId}`,
          `worktree ${worktreePath ?? "unknown"}`
        ],
        recovery_actions: [
          "Checkpoint and pause the current task with task_switch or task_checkpoint before starting another.",
          "Ask a human to release this session from the web board."
        ]
      }
    );
  }

  #assertWorktreeFreeInTx(
    tx: ProgressTransaction,
    worktreePath: string,
    excludeTaskIds: readonly string[]
  ): void {
    for (const scope of tx.listActiveScopesByWorktree(worktreePath)) {
      if (excludeTaskIds.includes(scope.task_id)) {
        continue;
      }
      const other = tx.getTask(scope.task_id);
      if (other === undefined || !statusHoldsLease(other.status)) {
        continue;
      }
      throw new PlatformDomainError(
        "WORKTREE_CONFLICT",
        `Worktree ${worktreePath} is already held by task ${other.task_id}`,
        {
          evidence: [
            worktreePath,
            `task ${other.task_id} is ${other.status}`
          ],
          recovery_actions: [
            "Move one of the tasks to a dedicated worktree.",
            "Pause or finish the conflicting task before starting this one."
          ]
        }
      );
    }
  }

  #setWorktreeScope(
    tx: ProgressTransaction,
    taskId: string,
    worktreePath: string
  ): void {
    tx.replaceTaskWorktreeScope({
      task_scope_id: randomUUID(),
      task_id: taskId,
      scope_type: "worktree_path",
      scope_value: worktreePath
    });
  }

  #declaredWorktreeScope(
    scopes: readonly TaskScopeSeed[] | undefined
  ): string | undefined {
    const worktrees = [...new Set((scopes ?? [])
      .filter((scope) => scope.scope_type === "worktree_path")
      .map((scope) => this.#normalizePath(scope.scope_value)))];
    if (worktrees.length > 1) {
      throw new PlatformDomainError(
        "WORKTREE_CONFLICT",
        "A task can declare only one worktree_path scope",
        {
          evidence: worktrees,
          recovery_actions: [
            "Keep exactly one worktree_path scope and retry."
          ]
        }
      );
    }
    return worktrees[0];
  }

  #evaluateAgainstActiveSides(input: {
    repositoryId: string;
    left: ConflictSide;
    excludeTaskIds: readonly string[];
    softDependencies: readonly SoftDependency[];
  }): ConflictReport {
    let worst = evaluateConflicts({
      left: input.left,
      right: {
        task_id: "",
        repository_id: input.repositoryId,
        worktree_path: "",
        changed_files: []
      },
      soft_dependencies: input.softDependencies
    });
    const scopes = this.#store.listActiveTaskScopes(input.repositoryId);
    for (const scope of scopes) {
      if (input.excludeTaskIds.includes(scope.task_id)
        || scope.scope_type !== "worktree_path") {
        continue;
      }
      const detail = this.#detail(scope.task_id);
      if (detail === undefined || !statusHoldsLease(detail.status)) {
        continue;
      }
      const modulePaths = scopes
        .filter((entry) => entry.task_id === scope.task_id
          && entry.scope_type === "module_path")
        .map((entry) => entry.scope_value);
      // The opposing side's real changed-file set comes from its latest
      // persisted snapshot on this worktree (migration v4), falling back
      // to an empty set for pre-v4 rows so FILE_CONFLICT never fires on
      // stale assumptions.
      const snapshot = this.#store.latestSnapshotsForWorktree(scope.scope_value)
        .find((entry) => entry.task_id === scope.task_id);
      const report = evaluateConflicts({
        left: input.left,
        right: {
          task_id: scope.task_id,
          repository_id: input.repositoryId,
          worktree_path: scope.scope_value,
          changed_files: snapshot?.changed_files ?? [],
          module_paths: modulePaths
        },
        soft_dependencies: input.softDependencies
      });
      if (report.level === "hard") {
        return report;
      }
      if (report.level === "warning" && worst.level !== "warning") {
        worst = report;
      }
    }
    return worst;
  }

  #leftSide(
    task: Pick<TaskRecord, "task_id" | "repository_id">,
    draft: RepoSnapshotDraft
  ): ConflictSide {
    return {
      task_id: task.task_id,
      repository_id: task.repository_id,
      worktree_path: draft.worktree_path,
      changed_files: draft.changed_files,
      module_paths: this.#store.listActiveTaskScopes(task.repository_id)
        .filter((scope) => scope.task_id === task.task_id
          && scope.scope_type === "module_path")
        .map((scope) => scope.scope_value)
    };
  }

  /**
   * Seed checkpoint written at task_create time so the checkpoint chain has a
   * next_action from the very beginning. `source` stays reserved for legacy
   * adoption checkpoints.
   */
  #initialCheckpoint(nextAction: string): CheckpointPayload {
    return {
      completed_items: [],
      current_state: "backlog",
      human_context: [],
      confirmed_decisions: [],
      pending_decisions: [],
      blockers: [],
      verification: [],
      next_action: nextAction
    };
  }

  /**
   * Read-only conflict check for a scope that has no task yet: the proposed
   * side (worktree, changed files, module scopes) is evaluated against every
   * active task side through the same conflict policy.
   */
  #checkProposedScope(proposed: ConflictProposedScope): ConflictReport {
    if (this.#store.getRepository(proposed.repository_id) === undefined) {
      throw new PlatformDomainError(
        "REPOSITORY_NOT_ALLOWED",
        `Repository ${proposed.repository_id} is not registered`,
        { evidence: [proposed.repository_id] }
      );
    }
    const left: ConflictSide = {
      repository_id: proposed.repository_id,
      worktree_path: proposed.worktree_path,
      changed_files: [...(proposed.changed_files ?? [])],
      module_paths: (proposed.scopes ?? [])
        .filter((scope) => scope.scope_type === "module_path")
        .map((scope) => scope.scope_value)
    };
    return this.#evaluateAgainstActiveSides({
      repositoryId: proposed.repository_id,
      left,
      excludeTaskIds: [],
      softDependencies: []
    });
  }

  #softDependenciesFor(taskId: string): SoftDependency[] {
    const dependencies = this.#store.transaction((tx) => (
      tx.listTaskDependencies(taskId)
    ));
    const softDependencies: SoftDependency[] = [];
    for (const dependency of dependencies) {
      const detail = this.#detail(dependency.depends_on_task_id);
      if (detail !== undefined) {
        softDependencies.push({ task_id: detail.task_id, status: detail.status });
      }
    }
    return softDependencies;
  }

  #worktreeScopeFor(task: TaskDetail): string | undefined {
    const worktrees = [...new Set(task.scopes
      .filter((scope) => scope.scope_type === "worktree_path")
      .map((scope) => this.#normalizePath(scope.scope_value)))];
    if (worktrees.length > 1) {
      throw new PlatformDomainError(
        "WORKTREE_CONFLICT",
        `Task ${task.task_id} declares multiple worktree scopes`,
        {
          evidence: worktrees,
          recovery_actions: [
            "Keep exactly one worktree_path scope on the target task before switching."
          ]
        }
      );
    }
    return worktrees[0];
  }

  #rejectHardConflict(report: ConflictReport): void {
    if (report.level === "hard") {
      throw new PlatformDomainError(
        report.code ?? "WORKTREE_CONFLICT",
        report.message,
        {
          evidence: [...report.evidence],
          recovery_actions: [...report.recovery_actions]
        }
      );
    }
  }

  #requireWarningAcknowledgement(
    report: ConflictReport,
    acknowledgedWarningCodes: readonly string[]
  ): void {
    if (report.level === "warning" && report.code !== undefined) {
      const missing = [report.code]
        .filter((code) => !acknowledgedWarningCodes.includes(code));
      if (missing.length > 0) {
        throw new PlatformDomainError(
          "HUMAN_CONFIRMATION_REQUIRED",
          "Conflict warnings must be acknowledged explicitly before starting or switching",
          {
            evidence: missing,
            recovery_actions: [
              "Acknowledge every warning code, or resolve the underlying conflict.",
              ...report.recovery_actions
            ]
          }
        );
      }
    }
  }

  async #probeWorktree(session: SessionRecord): Promise<RepoSnapshotDraft> {
    if (session.worktree_path === undefined) {
      throw new PlatformDomainError(
        "REPOSITORY_NOT_ALLOWED",
        `Session ${session.session_id} has no worktree to probe`,
        { evidence: [session.session_id] }
      );
    }
    return this.#probeSessionWorktree(
      session.repository_id,
      session.worktree_path
    );
  }

  async #probeSessionWorktree(
    repositoryId: string,
    worktreePath: string
  ): Promise<RepoSnapshotDraft> {
    try {
      return await this.#probePath(repositoryId, worktreePath);
    } catch (error) {
      if (error instanceof PlatformDomainError && error.code === "REPOSITORY_NOT_ALLOWED") {
        const evidence = this.#store.getLatestValidHostEvidence(
          repositoryId,
          normalizeWorktreePath(worktreePath),
          this.#now()
        );
        if (evidence !== undefined) {
          return {
            repository_id: evidence.repository_id,
            repository_path: this.#store.getRepository(repositoryId)?.path
              ?? evidence.worktree_path,
            worktree_path: evidence.worktree_path,
            head_commit: evidence.head_commit,
            branch: evidence.branch ?? "",
            changed_files: [...evidence.changed_files],
            content_digest: evidence.content_digest,
            captured_at: evidence.captured_at,
            provenance_source: "host_verified",
            host_evidence_id: evidence.evidence_id
          };
        }
        throw new PlatformDomainError(
          "REMOTE_WORKTREE_EVIDENCE_REQUIRED",
          `Worktree ${worktreePath} is not reachable from the server and no `
            + "trusted host evidence is on file; refusing to fabricate evidence",
          {
            retryable: true,
            evidence: [worktreePath],
            recovery_actions: [
              "On the developer machine, run "
                + "`cli-session-task-mcp evidence collect` to obtain "
                + "host-verified worktree evidence, then retry.",
              "If the worktree is meant to be server-direct, verify it is a "
                + "git worktree of the registered repository path."
            ]
          }
        );
      }
      throw error;
    }
  }

  async #probePath(
    repositoryId: string,
    worktreePath: string
  ): Promise<RepoSnapshotDraft> {
    const repository: RepositoryRecord | undefined = this.#store
      .getRepository(repositoryId);
    if (repository === undefined) {
      throw new PlatformDomainError(
        "REPOSITORY_NOT_ALLOWED",
        `Repository ${repositoryId} is not registered`,
        { evidence: [repositoryId] }
      );
    }
    try {
      return await this.#probe.inspect({ repository, worktree_path: worktreePath });
    } catch (error) {
      if (error instanceof PlatformDomainError) {
        throw error;
      }
      const code = (error as { code?: unknown }).code === "REPOSITORY_NOT_ALLOWED"
        ? "REPOSITORY_NOT_ALLOWED"
        : "REPO_PROBE_FAILED";
      throw new PlatformDomainError(
        code,
        error instanceof Error ? error.message : String(error),
        { evidence: [worktreePath] }
      );
    }
  }

  #lease(taskId: string, sessionId: string, nowIso: string, generation = 1) {
    return {
      task_id: taskId,
      session_id: sessionId,
      acquired_at: nowIso,
      heartbeat_at: nowIso,
      expires_at: new Date(Date.parse(nowIso) + this.#leaseTtlMs).toISOString(),
      generation
    };
  }

  #emit(
    tx: ProgressTransaction,
    event: {
      task_id: string;
      session_id?: string;
      event_type: string;
      payload: JsonValue;
    }
  ): void {
    const record: {
      event_id: string;
      task_id: string;
      event_type: string;
      payload: JsonValue;
      created_at: string;
      session_id?: string;
    } = {
      event_id: randomUUID(),
      task_id: event.task_id,
      event_type: event.event_type,
      payload: event.payload,
      created_at: this.#now()
    };
    if (event.session_id !== undefined) {
      record.session_id = event.session_id;
    }
    tx.appendTaskEvent(record);
  }

  #mutation(taskId: string, status: TaskStatus, version: number): TaskMutationResult {
    return { task_id: taskId, status, version };
  }

  #jsonValue(value: unknown): JsonValue {
    return value as JsonValue;
  }

  #normalizePath(path: string): string {
    return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  }

  #nextDependencyGenerationTimestamp(
    previousDependencies: readonly { created_at: string }[],
    taskUpdatedAt: string,
    nowIso: string,
    historicalValidationTimes: readonly string[] = []
  ): string {
    const nowMs = Date.parse(nowIso);
    const previousMaxMs = previousDependencies.reduce((max, dependency) => {
      const createdMs = Date.parse(dependency.created_at);
      return Number.isFinite(createdMs) ? Math.max(max, createdMs) : max;
    }, Number.NEGATIVE_INFINITY);
    const taskUpdatedMs = Date.parse(taskUpdatedAt);
    const historicalMaxMs = historicalValidationTimes.reduce((max, requestedAt) => {
      const requestedMs = Date.parse(requestedAt);
      return Number.isFinite(requestedMs) ? Math.max(max, requestedMs) : max;
    }, Number.NEGATIVE_INFINITY);
    const persistedMaxMs = [previousMaxMs, historicalMaxMs, taskUpdatedMs]
      .filter(Number.isFinite)
      .reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY);
    const nextMs = Number.isFinite(persistedMaxMs)
      ? Math.max(nowMs, persistedMaxMs + 1)
      : nowMs;
    return new Date(nextMs).toISOString();
  }

  #maxIsoTimestamp(base: string, candidates: readonly string[]): string {
    const baseMs = Date.parse(base);
    const maxMs = candidates.reduce((max, candidate) => {
      const candidateMs = Date.parse(candidate);
      return Number.isFinite(candidateMs) ? Math.max(max, candidateMs) : max;
    }, Number.isFinite(baseMs) ? baseMs : Number.NEGATIVE_INFINITY);
    return Number.isFinite(maxMs) ? new Date(maxMs).toISOString() : base;
  }
}
