import type {
  CheckpointPayload,
  RepoSnapshot,
  SessionRecord,
  TaskRecord,
  TaskStatus
} from "../shared/task-contracts.js";
import type {
  DependencyValidationEvidence,
  DependencyValidationSpec
} from "../shared/dependency-validation-contracts.js";

export type { SessionRecord };

export type StorageErrorCode =
  | "ASYNC_TRANSACTION_UNSUPPORTED"
  | "CONSTRAINT_VIOLATION"
  | "DATABASE_CAPABILITY_REQUIRED"
  | "DATABASE_INTEGRITY_FAILED"
  | "MIGRATION_INVALID"
  | "SCHEMA_VERSION_UNSUPPORTED"
  | "STORE_CAPABILITY_REQUIRED"
  | "STORAGE_BUSY"
  | "TRANSACTION_CAPABILITY_REQUIRED"
  | "TRANSACTION_INACTIVE"
  | "VERSION_CONFLICT";

export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageError";
    this.code = code;
  }
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface TaskListFilter {
  repositoryId?: string;
  statuses?: readonly TaskStatus[];
  owner?: string;
}

export interface TaskSummary extends TaskRecord {
  version: number;
}

export interface TaskDetail extends TaskSummary {
  scopes: TaskScopeRecord[];
}

export interface ProjectRecord {
  project_id: string;
  name: string;
  /** Git owner that created the project; null for legacy projects. */
  created_by?: string | null;
  /** Set while the project is archived; archived projects reject writes. */
  archived_at?: string | null;
  archived_by?: string | null;
  created_at: string;
  updated_at: string;
}

/** A non-terminal task that blocks archiving its project. */
export interface ProjectOpenTask {
  task_id: string;
  owner: string | null;
  status: TaskStatus;
  repository_id: string;
}

export type ArchiveProjectOutcome =
  | { status: "archived"; changed: boolean; project: ProjectRecord }
  | { status: "open_tasks"; open_tasks: ProjectOpenTask[] }
  | { status: "not_found" };

export type UnarchiveProjectOutcome =
  | { status: "unarchived"; changed: boolean; project: ProjectRecord }
  | { status: "not_found" };

export interface ListProjectsOptions {
  /** Archived projects are excluded unless explicitly requested. */
  include_archived?: boolean;
}

export interface ProjectMemberRecord {
  project_id: string;
  owner: string;
  role: "member";
  granted_by: string;
  created_at: string;
  revoked_at: string | null;
}

export interface ProjectShareRecord {
  share_id: string;
  project_id: string;
  token_hash: string;
  created_by: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface RepositoryRecord {
  repository_id: string;
  project_id: string;
  path: string;
  label: string;
  created_at: string;
  updated_at: string;
}

export interface TaskScopeRecord {
  task_scope_id: string;
  task_id: string;
  scope_type: string;
  scope_value: string;
}

export interface ActiveTaskScope {
  task_id: string;
  scope_type: string;
  scope_value: string;
}

export interface TaskSessionLinkRecord {
  task_id: string;
  session_id: string;
  linked_at: string;
}

export interface HumanDecisionRecord {
  decision_id: string;
  task_id: string;
  session_id?: string;
  question: string;
  decision?: string;
  status: string;
  created_at: string;
  decided_at?: string;
}

export interface TaskDependencyRecord {
  task_id: string;
  depends_on_task_id: string;
  created_at: string;
  policy?: "informational" | "validation_gate" | "acceptance_gate" | "hard_block";
  ctx_id?: string;
  generation?: number;
}

export type DependencyContextStatus = "active" | "cancelled" | "superseded" | "closed";

export interface DependencyContextRecord {
  ctx_id: string;
  upstream_task_id: string;
  upstream_repository_id: string;
  downstream_task_id: string;
  downstream_repository_id: string;
  policy: NonNullable<TaskDependencyRecord["policy"]>;
  generation: number;
  status: DependencyContextStatus;
  current_cycle: number;
  created_at: string;
  updated_at: string;
}

export interface DependencyContextEventRecord {
  event_id: string;
  ctx_id: string;
  sequence: number;
  event_type: string;
  payload: JsonValue;
  created_at: string;
}

export interface ActiveTaskLease {
  task_id: string;
  session_id: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  /** Monotonic lease identity; absent only at legacy caller boundaries. */
  generation?: number;
}

export interface CheckpointRecord {
  checkpoint_id: string;
  task_id: string;
  session_id?: string;
  payload: CheckpointPayload;
  created_at: string;
}

export interface RepoSnapshotRecord extends RepoSnapshot {
  snapshot_id: string;
  task_id: string;
  checkpoint_id?: string;
  /** Conflict-evaluation fields (migration v4); absent on pre-v4 rows. */
  worktree_path?: string;
  branch?: string;
  changed_files?: readonly string[];
  content_digest?: string;
  /** Evidence source (migration v14); pre-v14 rows read as server_verified. */
  provenance?: "server_verified" | "host_verified";
  /** Set when provenance is host_verified; links back to the signed record. */
  host_evidence_id?: string;
}

export interface SnapshotConflictView {
  task_id: string;
  worktree_path: string | undefined;
  changed_files: readonly string[];
  captured_at: string;
}

export interface HostKeyRecord {
  host_key_id: string;
  owner: string;
  label: string;
  /** Ed25519 public key, SPKI DER, base64. */
  public_key_b64: string;
  client_family?: string;
  status: "active" | "revoked";
  rotated_to?: string;
  created_at: string;
  revoked_at?: string;
  last_used_at?: string;
}

export interface HostEvidenceChallengeRecord {
  challenge_id: string;
  nonce_b64: string;
  operation: "checkpoint" | "submit";
  session_id: string;
  repository_id: string;
  task_id?: string;
  lease_generation?: number;
  expected_worktree_path: string;
  host_key_id?: string;
  created_at: string;
  expires_at: string;
  consumed_at?: string;
}

export interface HostEvidenceRecord {
  evidence_id: string;
  host_key_id: string;
  challenge_id: string;
  session_id: string;
  task_id?: string;
  repository_id: string;
  worktree_path: string;
  head_commit: string;
  branch?: string;
  changed_files: readonly string[];
  content_digest: string;
  signature_b64: string;
  payload_json: string;
  captured_at: string;
  verified_at: string;
  expires_at: string;
}

export interface TaskEventRecord {
  event_id: string;
  task_id: string;
  session_id?: string;
  event_type: string;
  payload: JsonValue;
  created_at: string;
}

export interface SessionEventRecord {
  event_id: string;
  session_id: string;
  event_type: string;
  payload: JsonValue;
  created_at: string;
}

export interface OperationResult {
  session_id: string;
  operation_id: string;
  /** Null in SQLite for pre-v13 rows and omitted from the legacy read shape. */
  tool_name?: string;
  /** Stable SHA-256 fingerprint of the normalized semantic request input. */
  request_hash?: string;
  result: JsonValue;
  created_at: string;
}

export type DependencyRepairStatus =
  | "pending" | "claimed" | "resolved" | "superseded" | "cancelled";

export interface DependencyRepairRequestRecord {
  repair_id: string;
  validation_id: string;
  source_run_id: string;
  ctx_id: string | null;
  upstream_task_id: string;
  downstream_task_id: string;
  cycle: number;
  status: DependencyRepairStatus;
  rejection_reason: string;
  claimed_session_id: string | null;
  claimed_worktree_path: string | null;
  claimed_at: string | null;
  resolved_at: string | null;
  superseded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LegacyTaskImport {
  legacy_import_key: string;
  source_session_label: string;
  project_id: string;
  repository_id: string;
  worktree_path: string;
  normalized_title: string;
  task_id: string;
  created_at: string;
}

export interface RepositoryWithTaskCount {
  repository_id: string;
  label: string;
  task_count: number;
  attention: {
    pending_acceptance: number;
    blocked: number;
    stale: number;
  };
}

export interface ProjectWithRepositories {
  project_id: string;
  name: string;
  /** Git owner that created the project; null for legacy projects. */
  created_by?: string | null;
  archived_at?: string | null;
  archived_by?: string | null;
  repositories: RepositoryWithTaskCount[];
}

export interface TaskDependencyView extends TaskDependencyRecord {
  title: string;
  status: TaskStatus;
  repository_id: string;
}

export interface TaskEventView {
  event_id: string;
  event_type: string;
  payload: JsonValue;
  created_at: string;
}

export interface RepoSnapshotView {
  snapshot_id: string;
  head_commit: string;
  captured_at: string;
}

export interface NotificationRecord {
  notification_id: string;
  owner: string | null;
  task_id: string;
  /** Repository of the dependent task this notification is addressed to. */
  repository_id: string;
  upstream_task_id: string;
  upstream_title: string;
  upstream_status: "done" | "cancelled";
  read_at: string | null;
  created_at: string;
  /** Title of the dependent task the notification is addressed to; null if
   * the task row is gone (defensive — tasks are not deleted today). */
  task_title: string | null;
}

export interface NotificationListFilter {
  repositoryId?: string;
  unreadOnly?: boolean;
  limit?: number;
}

export type DependencyValidationStatus = "pending" | "passed" | "rejected" | "superseded";
export type DependencyValidationPerspective = "request" | "response";

export interface DependencyValidationRecord {
  ctx_id?: string;
  validation_id: string;
  upstream_task_id: string;
  downstream_task_id: string;
  cycle: number;
  status: DependencyValidationStatus;
  requested_by_actor: "agent" | "human";
  requested_by_owner: string | null;
  requested_at: string;
  request_read_at: string | null;
  responded_by_owner: string | null;
  response_reason: string | null;
  responded_at: string | null;
  response_read_at: string | null;
  validation_spec: JsonValue;
}

export type DependencyValidationRunStatus =
  | "queued" | "claimed" | "running" | "passed" | "rejected" | "error" | "cancelled";

export interface DependencyValidationRunRecord {
  run_id: string;
  validation_id: string;
  attempt: number;
  status: DependencyValidationRunStatus;
  owner: string;
  session_id: string;
  worktree_path: string;
  heartbeat_at: string;
  expires_at: string;
  started_at: string | null;
  completed_at: string | null;
  verification: DependencyValidationEvidence[];
  progress?: JsonValue;
  failure_reason: string | null;
  error_reason: string | null;
  operation_id: string;
  created_at: string;
  updated_at: string;
}

export interface DependencyValidationRunView extends DependencyValidationRunRecord {
  /** Sanitized immutable contract; never the upstream checkpoint. */
  validation_spec: DependencyValidationSpec;
}

export interface DependencyValidationView extends DependencyValidationRecord {
  /** Public views expose the strict sanitized contract, never raw JSON. */
  validation_spec: DependencyValidationSpec;
  upstream_owner: string | null;
  upstream_repository_id: string;
  upstream_title: string;
  downstream_owner: string | null;
  downstream_repository_id: string;
  downstream_title: string;
  /** Kept for clients that only need the current attempt. */
  latest_run: DependencyValidationRunView | null;
  /** All attempts, newest first, preserving retry evidence. */
  runs: readonly DependencyValidationRunView[];
}

export interface DependencyValidationActivity extends DependencyValidationView {
  perspective: DependencyValidationPerspective;
  repository_id: string;
  task_id: string;
  task_title: string;
  read_at: string | null;
  created_at: string;
}

export interface DependencyValidationListFilter {
  repositoryId?: string;
  unreadOnly?: boolean;
  limit?: number;
}

export interface DependencyValidationGate {
  dependent_count: number;
  latest_cycle: number | null;
  ready_for_acceptance: boolean;
}

export interface TaskRecoveryView {
  task: TaskDetail;
  checkpoint: CheckpointPayload | null;
  active_lease: ActiveTaskLease | null;
  lease_session: SessionRecord | null;
  latest_snapshot: RepoSnapshotRecord | null;
  evidence_state: "fresh" | "stale" | "unverifiable" | "missing";
  pending_decisions: HumanDecisionRecord[];
  dependency_validation_gate: DependencyValidationGate;
  active_repair: DependencyRepairRequestRecord | null;
  recent_events: TaskEventRecord[];
  next_action: string;
}

export interface PersonSummary {
  owner: string | null;
  task_count: number;
  repositories: string[];
  /** Per-repository task counts, keyed by repository_id. Projects render
   * per-project numbers from these instead of the person's global total. */
  task_counts: Record<string, number>;
}

export interface ProgressStore {
  transaction<T>(work: (tx: ProgressTransaction) => T): T;
  listTasks(filter: TaskListFilter): TaskSummary[];
  getTaskDetail(taskId: string): TaskDetail | undefined;
  listTaskDependencyViews(taskId: string): TaskDependencyView[];
  listTaskEventViews(taskId: string): TaskEventView[];
  listSessionEvents(sessionId: string): SessionEventRecord[];
  listRepoSnapshotViews(taskId: string): RepoSnapshotView[];
  latestSnapshotsForWorktree(worktreePath: string): SnapshotConflictView[];
  getRepository(repositoryId: string): RepositoryRecord | undefined;
  getHostKey(hostKeyId: string): HostKeyRecord | undefined;
  findHostKeyByPublicKey(publicKeyB64: string): HostKeyRecord | undefined;
  listHostKeys(owner?: string): HostKeyRecord[];
  getHostEvidenceChallenge(challengeId: string): HostEvidenceChallengeRecord | undefined;
  getHostEvidence(evidenceId: string): HostEvidenceRecord | undefined;
  getHostEvidenceByChallenge(challengeId: string): HostEvidenceRecord | undefined;
  /** Latest host evidence for the exact (repository, worktree) pair whose
   *  consumption window still covers `nowIso`. */
  getLatestValidHostEvidence(
    repositoryId: string,
    worktreePath: string,
    nowIso: string
  ): HostEvidenceRecord | undefined;
  getProject(projectId: string): ProjectRecord | undefined;
  listRepositories(owner?: string): RepositoryRecord[];
  listProjects(owner?: string, options?: ListProjectsOptions): ProjectWithRepositories[];
  getProjectMember(projectId: string, owner: string): ProjectMemberRecord | undefined;
  listProjectMembers(projectId: string, includeRevoked?: boolean): ProjectMemberRecord[];
  listPeople(owner?: string): PersonSummary[];
  insertNotification(notification: NotificationRecord): void;
  listDependentsOf(taskId: string): { task_id: string }[];
  listNotifications(owner: string, filter?: NotificationListFilter): NotificationRecord[];
  markNotificationRead(notificationId: string, owner: string): void;
  getDependencyValidation(validationId: string): DependencyValidationView | undefined;
  getDependencyRepairRequest(
    repairId: string,
    owner: string
  ): DependencyRepairRequestRecord | undefined;
  listDependencyRepairRequests(
    owner: string,
    repositoryId?: string
  ): DependencyRepairRequestRecord[];
  listDependencyValidationViews(taskId: string): DependencyValidationView[];
  listDependencyValidationActivities(
    owner: string,
    filter?: DependencyValidationListFilter
  ): DependencyValidationActivity[];
  getDependencyContext?: (ctxId: string) => DependencyContextRecord | undefined;
  listDependencyContextEvents?: (ctxId: string) => DependencyContextEventRecord[];
  getDependencyValidationGate(taskId: string): DependencyValidationGate;
  markDependencyValidationRead(
    validationId: string,
    owner: string,
    perspective: DependencyValidationPerspective
  ): void;
  listActiveTaskScopes(repositoryId: string): ActiveTaskScope[];
}

export interface ProgressTransaction {
  getTask(taskId: string): TaskRecord | undefined;
  /** Read the optimistic version inside the same transaction as a mutation. */
  getTaskVersion(taskId: string): number | undefined;
  insertTask(task: TaskRecord): void;
  updateTask(task: TaskRecord, expectedVersion: number): void;
  upsertProject(project: ProjectRecord): void;
  getProject(projectId: string): ProjectRecord | undefined;
  /** Check for non-terminal tasks (any owner) and archive in this transaction. */
  archiveProject(projectId: string, archivedBy: string, archivedAt: string): ArchiveProjectOutcome;
  unarchiveProject(projectId: string, updatedAt: string): UnarchiveProjectOutcome;
  getProjectMember(projectId: string, owner: string): ProjectMemberRecord | undefined;
  listProjectMembers(projectId: string, includeRevoked?: boolean): ProjectMemberRecord[];
  upsertProjectMember(member: ProjectMemberRecord): void;
  revokeProjectMember(projectId: string, owner: string, revokedAt: string): boolean;
  createProjectShare(share: ProjectShareRecord): void;
  getProjectShareByTokenHash(tokenHash: string): ProjectShareRecord | undefined;
  consumeProjectShare(shareId: string, tokenHash: string, consumedAt: string): boolean;
  revokeProjectShare(shareId: string, projectId: string, revokedAt: string): boolean;
  upsertRepository(repository: RepositoryRecord): void;
  getSessionByTransportId(transportSessionId: string): SessionRecord | undefined;
  getSession(sessionId: string): SessionRecord | undefined;
  getSessionBySuccessorId(successorSessionId: string): SessionRecord | undefined;
  insertSession(session: SessionRecord): void;
  updateSessionActivity(sessionId: string, lastActivityAt: string): void;
  updateSessionTransport(
    sessionId: string,
    transportSessionId: string,
    lastActivityAt: string
  ): void;
  setSessionResumeTokenHash(sessionId: string, resumeTokenHash: string): void;
  updateSessionContext(
    sessionId: string,
    workspacePath: string,
    worktreePath: string,
    lastActivityAt: string
  ): void;
  insertSessionEvent(event: SessionEventRecord): void;
  listSessionsInactiveBefore(cutoff: string): SessionRecord[];
  setSessionStaleAt(sessionId: string, staleAt: string): void;
  setSessionSuccessor(
    sessionId: string,
    successorSessionId: string,
    successorCtxId: string | undefined,
    staleAt: string
  ): void;
  getLeaseByTask(taskId: string): ActiveTaskLease | undefined;
  getLeaseBySession(sessionId: string): ActiveTaskLease | undefined;
  putLease(lease: ActiveTaskLease): void;
  deleteLeaseByTask(taskId: string): void;
  insertCheckpoint(checkpoint: CheckpointRecord): void;
  insertRepoSnapshot(snapshot: RepoSnapshotRecord): void;
  getLatestRepoSnapshot(taskId: string): RepoSnapshotRecord | undefined;
  insertHostKey(record: HostKeyRecord): void;
  updateHostKey(record: HostKeyRecord): void;
  insertHostEvidenceChallenge(record: HostEvidenceChallengeRecord): void;
  /** Single-use consumption guard; no-op when already consumed. */
  consumeHostEvidenceChallenge(challengeId: string, consumedAtIso: string): boolean;
  insertHostEvidence(record: HostEvidenceRecord): void;
  touchHostKeyUsed(hostKeyId: string, usedAtIso: string): void;
  appendTaskEvent(event: TaskEventRecord): void;
  findTaskAttemptEvent(taskId: string, attemptId: string): TaskEventRecord | undefined;
  getOperationResult(sessionId: string, operationId: string): OperationResult | undefined;
  putOperationResult(result: OperationResult): void;
  findLegacyImport(legacyImportKey: string): LegacyTaskImport | undefined;
  insertLegacyImport(record: LegacyTaskImport): void;
  insertTaskScope(scope: TaskScopeRecord): void;
  replaceTaskWorktreeScope(scope: TaskScopeRecord): void;
  upsertTaskSessionLink(link: TaskSessionLinkRecord): void;
  insertHumanDecision(decision: HumanDecisionRecord): void;
  listPendingHumanDecisions(taskId: string): HumanDecisionRecord[];
  listRecentTaskEvents(taskId: string, limit: number): TaskEventRecord[];
  insertTaskDependency(dependency: TaskDependencyRecord): void;
  replaceTaskDependencies(
    taskId: string,
    dependsOnTaskIds: readonly string[],
    created_at: string,
    policies?: Readonly<Record<string, TaskDependencyRecord["policy"]>>
  ): void;
  createDependencyContext?: (context: DependencyContextRecord) => void;
  getDependencyContext?: (ctxId: string) => DependencyContextRecord | undefined;
  updateDependencyContext?: (context: DependencyContextRecord, expectedUpdatedAt?: string) => void;
  appendDependencyContextEvent?: (event: DependencyContextEventRecord) => void;
  listDependencyContextEvents?: (ctxId: string) => DependencyContextEventRecord[];
  insertNotification(notification: NotificationRecord): void;
  listDependentsOf(taskId: string): { task_id: string }[];
  nextDependencyValidationCycle(taskId: string): number;
  insertDependencyValidation(validation: DependencyValidationRecord): void;
  getDependencyValidation(validationId: string): DependencyValidationRecord | undefined;
  listDependencyValidationsForUpstream(taskId: string): DependencyValidationRecord[];
  getDependencyRepairRequest(repairId: string): DependencyRepairRequestRecord | undefined;
  getDependencyRepairByValidation(validationId: string): DependencyRepairRequestRecord | undefined;
  listDependencyRepairsForUpstream(taskId: string): DependencyRepairRequestRecord[];
  listDependencyRepairsForDownstream(taskId: string): DependencyRepairRequestRecord[];
  insertDependencyRepairRequest(record: DependencyRepairRequestRecord): void;
  updateDependencyRepairRequest(
    record: DependencyRepairRequestRecord,
    expectedStatus: DependencyRepairStatus
  ): void;
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
  ): void;
  markDependencyValidationRequestRead(validationId: string, readAt: string): void;
  supersedePendingDependencyValidations(taskId: string, supersededAt: string): void;
  /** Invalidate every prior response when a downstream dependency edge changes. */
  supersedeDependencyValidationsForDownstream(taskId: string, supersededAt: string): void;
  getDependencyValidationRun(runId: string): DependencyValidationRunRecord | undefined;
  getActiveDependencyValidationRun(validationId: string): DependencyValidationRunRecord | undefined;
  listDependencyValidationRuns(validationId: string): DependencyValidationRunRecord[];
  insertDependencyValidationRun(run: DependencyValidationRunRecord): void;
  updateDependencyValidationRun(
    run: DependencyValidationRunRecord,
    expectedStatus?: DependencyValidationRunStatus
  ): void;
  renewDependencyValidationRunLease(
    runId: string,
    owner: string,
    sessionId: string,
    heartbeatAt: string,
    expiresAt: string,
    now: string
  ): void;
  listTaskDependencies(taskId: string): TaskDependencyRecord[];
  listActiveScopesByWorktree(worktreePath: string): ActiveTaskScope[];
}
