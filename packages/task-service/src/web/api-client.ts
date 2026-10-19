import type {
  TaskPriority,
  TaskStatus
} from "../shared/task-contracts.js";
import type {
  DependencyValidationEvidence,
  DependencyValidationSpec
} from "../shared/dependency-validation-contracts.js";
import type {
  DependencyRepairRequestRecord,
  TaskRecoveryView,
  TaskSummary
} from "../storage/progress-store.js";

/**
 * Fetch wrapper for the board REST API (`/api/tasks...`) plus the SSE
 * subscription on `/events`. Every human mutation carries the
 * `operation_id` + `expected_version` pair the server requires; operation ids
 * come from `newOperationId()` and a retry of the same logical action must
 * reuse the original id so the server-side replay cache stays idempotent.
 */

export interface TaskChangedEvent {
  task_id: string;
  version: number;
}

export interface DependencyValidationChangedEvent {
  validation_id: string;
  upstream_task_id: string;
  downstream_task_id: string;
  status?: string;
  attempt?: number;
}

export interface DependencyRepairChangedEvent {
  repair_id: string;
  validation_id: string;
  upstream_task_id: string;
  downstream_task_id: string;
  cycle: number;
  status: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly evidence: readonly string[];
  readonly recovery_actions: readonly string[];
  /** Optional structured context (e.g. PROJECT_HAS_OPEN_TASKS breakdown). */
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    options: {
      retryable?: boolean;
      evidence?: readonly string[];
      recovery_actions?: readonly string[];
      details?: Readonly<Record<string, unknown>>;
    } = {}
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.evidence = options.evidence ?? [];
    this.recovery_actions = options.recovery_actions ?? [];
    this.details = options.details;
  }
}

function generateId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for insecure contexts (HTTP on non-localhost origins where
  // the Web Crypto API's randomUUID is unavailable).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function newOperationId(): string {
  return generateId();
}

export const BOARD_AUTH_REQUIRED_EVENT = "board-auth-required";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  const headers = new Headers(init?.headers);
  try {
    response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  } catch (error) {
    throw new ApiError(0, "NETWORK_ERROR", error instanceof Error ? error.message : String(error), {
      retryable: true
    });
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const payload = (body ?? {}) as Record<string, unknown>;
    if (response.status === 401 && payload.code === "BOARD_AUTH_REQUIRED") {
      window.dispatchEvent(new Event(BOARD_AUTH_REQUIRED_EVENT));
    }
    throw new ApiError(
      response.status,
      typeof payload.code === "string" ? payload.code : `HTTP_${response.status}`,
      typeof payload.message === "string" ? payload.message : response.statusText,
      {
        retryable: payload.retryable === true,
        evidence: Array.isArray(payload.evidence)
          ? payload.evidence.filter((item): item is string => typeof item === "string")
          : [],
        recovery_actions: Array.isArray(payload.recovery_actions)
          ? payload.recovery_actions.filter((item): item is string => typeof item === "string")
          : [],
        ...(typeof payload.details === "object" && payload.details !== null
          && !Array.isArray(payload.details)
          ? { details: payload.details as Record<string, unknown> }
          : {})
      }
    );
  }
  return body as T;
}

function post<T>(
  path: string,
  operationId: string,
  expectedVersion: number,
  extraBody?: Record<string, unknown>
): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operation_id: operationId,
      expected_version: expectedVersion,
      ...(extraBody ?? {})
    })
  });
}



interface TaskEnvelope {
  task: TaskSummary;
}

export interface RepositorySummary {
  repository_id: string;
  project_id: string;
  path: string;
  label: string;
}

export function listTasks(
  repositoryId?: string,
  owner?: string,
  options: { scope?: "project" } = {}
): Promise<TaskSummary[]> {
  const params = new URLSearchParams();
  if (repositoryId !== undefined) {
    params.set("repository_id", repositoryId);
  }
  if (owner !== undefined) {
    params.set("owner", owner);
  }
  if (options.scope !== undefined) {
    params.set("scope", options.scope);
  }
  const query = params.size === 0 ? "" : `?${params.toString()}`;
  return request<{ tasks: TaskSummary[] }>(`/api/tasks${query}`).then((body) => body.tasks);
}

export interface ProjectRepositorySummary {
  repository_id: string;
  label: string;
  task_count: number;
  attention: {
    pending_acceptance: number;
    blocked: number;
    stale: number;
  };
}

export interface ProjectSummary {
  project_id: string;
  name: string;
  created_by?: string | null;
  /** Non-null while archived; archived projects stay out of the switcher. */
  archived_at?: string | null;
  archived_by?: string | null;
  repositories: ProjectRepositorySummary[];
}

export interface ProjectArchiveRecord {
  project_id: string;
  name: string;
  created_by?: string | null;
  archived_at?: string | null;
  archived_by?: string | null;
}

export interface ProjectShare {
  share_id: string;
  project_id: string;
  token: string;
  expires_at: string;
}

export interface ProjectMember {
  project_id: string;
  owner: string;
  role: "member";
  granted_by: string;
  created_at: string;
  revoked_at: string | null;
}

export interface PersonSummary {
  owner: string | null;
  task_count: number;
  repositories: string[];
  task_counts: Record<string, number>;
}

export type BoardSessionState =
  | { authenticated: false }
  | { authenticated: true; owner: string; expires_at: string };

export interface BoardPairingStart {
  challenge_id: string;
  pairing_code: string;
  expires_at: string;
}

export type BoardPairingStatus =
  | { status: "pending"; expires_at: string }
  | { status: "paired"; owner: string; expires_at: string };

export function fetchBoardSession(): Promise<BoardSessionState> {
  return request<BoardSessionState>("/api/board-auth/session");
}

export function startBoardPairing(): Promise<BoardPairingStart> {
  return request<BoardPairingStart>("/api/board-auth/pairings", { method: "POST" });
}

export function fetchBoardPairingStatus(challengeId: string): Promise<BoardPairingStatus> {
  return request<BoardPairingStatus>(
    `/api/board-auth/pairings/${encodeURIComponent(challengeId)}`
  );
}

export interface RegisterRepositoryInput {
  project_id: string;
  project_name: string;
  repository_id: string;
  repository_name: string;
  path: string;
}

/** Human registration of a repository; the path is declared by the operator,
 * the server cannot stat remote worktrees. */
export function registerRepository(
  input: RegisterRepositoryInput
): Promise<{ repository: { repository_id: string } }> {
  return request<{ repository: { repository_id: string } }>("/api/repositories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
}

export function fetchPeople(owner?: string): Promise<PersonSummary[]> {
  return request<{ people: PersonSummary[] }>(withOwner("/api/people", owner))
    .then((body) => body.people);
}

export function fetchOverviewPeople(): Promise<PersonSummary[]> {
  return request<{ people: PersonSummary[] }>("/api/overview/people")
    .then((body) => body.people);
}

export interface NotificationItem {
  notification_id: string;
  owner: string | null;
  task_id: string;
  repository_id: string;
  upstream_task_id: string;
  upstream_title: string;
  upstream_status: "done" | "cancelled";
  read_at: string | null;
  created_at: string;
  task_title: string | null;
}

export type DependencyValidationStatus = "pending" | "passed" | "rejected" | "superseded";
export type DependencyValidationPerspective = "request" | "response";
export type DependencyValidationRunStatus =
  | "queued" | "claimed" | "running" | "passed" | "rejected" | "error" | "cancelled";

export interface DependencyValidationRunView {
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
  verification: readonly DependencyValidationEvidence[];
  progress?: unknown;
  failure_reason: string | null;
  error_reason: string | null;
  operation_id: string;
  created_at: string;
  updated_at: string;
  validation_spec?: DependencyValidationSpec;
}

export interface DependencyValidationItem {
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
  upstream_owner: string | null;
  upstream_repository_id: string;
  upstream_title: string;
  downstream_owner: string | null;
  downstream_repository_id: string;
  downstream_title: string;
  latest_run?: DependencyValidationRunView | null;
  runs?: readonly DependencyValidationRunView[];
  validation_spec?: DependencyValidationSpec;
}

export interface DependencyValidationActivityItem extends DependencyValidationItem {
  perspective: DependencyValidationPerspective;
  repository_id: string;
  task_id: string;
  task_title: string;
  read_at: string | null;
  created_at: string;
  dependency_repair?: DependencyRepairRequestRecord | null;
}

export interface DependencyValidationGate {
  dependent_count: number;
  latest_cycle: number | null;
  ready_for_acceptance: boolean;
}

export function fetchNotifications(options: {
  repositoryId?: string;
  unreadOnly?: boolean;
} = {}): Promise<NotificationItem[]> {
  const params = new URLSearchParams();
  if (options.repositoryId !== undefined) {
    params.set("repository_id", options.repositoryId);
  }
  if (options.unreadOnly !== undefined) {
    params.set("unread", String(options.unreadOnly));
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return request<{ notifications: NotificationItem[] }>(`/api/notifications${query}`)
    .then((body) => body.notifications);
}

export function markNotificationRead(notificationId: string): Promise<void> {
  return request<void>(`/api/notifications/${encodeURIComponent(notificationId)}/read`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation_id: generateId() })
  }).then(() => undefined);
}

export function fetchDependencyValidationActivities(options: {
  repositoryId?: string;
  unreadOnly?: boolean;
} = {}): Promise<DependencyValidationActivityItem[]> {
  const params = new URLSearchParams();
  if (options.repositoryId !== undefined) {
    params.set("repository_id", options.repositoryId);
  }
  if (options.unreadOnly !== undefined) {
    params.set("unread", String(options.unreadOnly));
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return request<{ activities: DependencyValidationActivityItem[] }>(
    `/api/dependency-validation-activities${query}`
  ).then((body) => body.activities);
}

export function markDependencyValidationRead(
  validationId: string,
  perspective: DependencyValidationPerspective
): Promise<void> {
  return request<void>(
    `/api/dependency-validations/${encodeURIComponent(validationId)}/${perspective}/read`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation_id: generateId() })
    }
  ).then(() => undefined);
}

export function fetchProjects(
  owner?: string,
  options: { includeArchived?: boolean } = {}
): Promise<ProjectSummary[]> {
  const params = new URLSearchParams();
  if (owner !== undefined) {
    params.set("owner", owner);
  }
  if (options.includeArchived === true) {
    params.set("include_archived", "true");
  }
  const query = params.size === 0 ? "" : `?${params.toString()}`;
  return request<{ projects: ProjectSummary[] }>(`/api/projects${query}`)
    .then((body) => body.projects);
}

function postProjectArchiveAction(
  projectId: string,
  action: "archive" | "unarchive"
): Promise<ProjectArchiveRecord> {
  return request<{ project: ProjectArchiveRecord }>(
    `/api/projects/${encodeURIComponent(projectId)}/${action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation_id: generateId() })
    }
  ).then((body) => body.project);
}

export function archiveProject(projectId: string): Promise<ProjectArchiveRecord> {
  return postProjectArchiveAction(projectId, "archive");
}

export function unarchiveProject(projectId: string): Promise<ProjectArchiveRecord> {
  return postProjectArchiveAction(projectId, "unarchive");
}

export function createProjectShare(projectId: string): Promise<ProjectShare> {
  return request<{ share: ProjectShare }>(
    `/api/projects/${encodeURIComponent(projectId)}/shares`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation_id: generateId() })
    }
  ).then((body) => body.share);
}

export function acceptProjectInvite(token: string): Promise<ProjectMember> {
  return request<{ member: ProjectMember }>(
    `/api/project-invitations/${encodeURIComponent(token)}/accept`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation_id: generateId() })
    }
  ).then((body) => body.member);
}

export function fetchProjectMembers(projectId: string): Promise<{
  creator: string | null;
  members: ProjectMember[];
}> {
  return request<{
    creator: string | null;
    members: ProjectMember[];
  }>(`/api/projects/${encodeURIComponent(projectId)}/members`);
}

export function fetchOverviewProjects(): Promise<ProjectSummary[]> {
  return request<{ projects: ProjectSummary[] }>("/api/overview/projects")
    .then((body) => body.projects);
}

export function listRepositories(owner?: string): Promise<RepositorySummary[]> {
  return request<{ repositories: RepositorySummary[] }>(withOwner("/api/repositories", owner))
    .then((body) => body.repositories);
}

export interface DependencyView {
  task_id: string;
  depends_on_task_id: string;
  title: string;
  status: TaskSummary["status"];
  created_at: string;
  repository_id: string;
}

export interface EventView {
  event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface SnapshotView {
  snapshot_id: string;
  head_commit: string;
  captured_at: string;
}

export interface TaskDetailEnvelope {
  task: TaskSummary;
  recovery: TaskRecoveryView;
  dependency_repairs: DependencyRepairRequestRecord[];
  dependencies: DependencyView[];
  dependency_validations: DependencyValidationItem[];
  dependency_validation_gate: DependencyValidationGate;
  events: EventView[];
  snapshots: SnapshotView[];
}

export function getTask(taskId: string): Promise<TaskDetailEnvelope> {
  return request<TaskDetailEnvelope>(`/api/tasks/${encodeURIComponent(taskId)}`);
}

export function updateTask(
  taskId: string,
  changes: { title?: string; priority?: TaskPriority },
  expectedVersion: number,
  operationId: string
): Promise<TaskSummary> {
  return request<TaskEnvelope>(`/api/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operation_id: operationId,
      expected_version: expectedVersion,
      ...(changes.title !== undefined ? { title: changes.title } : {}),
      ...(changes.priority !== undefined ? { priority: changes.priority } : {})
    })
  }).then((body) => body.task);
}

export function acceptTask(
  taskId: string,
  expectedVersion: number,
  operationId: string
): Promise<TaskSummary> {
  return post<TaskEnvelope>(
    `/api/tasks/${encodeURIComponent(taskId)}/accept`,
    operationId,
    expectedVersion
  ).then((body) => body.task);
}

export function rejectTask(
  taskId: string,
  expectedVersion: number,
  operationId: string
): Promise<TaskSummary> {
  return post<TaskEnvelope>(
    `/api/tasks/${encodeURIComponent(taskId)}/reject`,
    operationId,
    expectedVersion
  ).then((body) => body.task);
}

export function resumeTask(
  taskId: string,
  expectedVersion: number,
  operationId: string
): Promise<TaskSummary> {
  return post<TaskEnvelope>(
    `/api/tasks/${encodeURIComponent(taskId)}/resume`,
    operationId,
    expectedVersion
  ).then((body) => body.task);
}

export function cancelTask(
  taskId: string,
  expectedVersion: number,
  operationId: string
): Promise<TaskSummary> {
  return post<TaskEnvelope>(
    `/api/tasks/${encodeURIComponent(taskId)}/cancel`,
    operationId,
    expectedVersion
  ).then((body) => body.task);
}

export function releaseSession(
  sessionId: string,
  expectedVersion: number,
  operationId: string
): Promise<TaskSummary> {
  return post<TaskEnvelope>(
    `/api/sessions/${encodeURIComponent(sessionId)}/release`,
    operationId,
    expectedVersion
  ).then((body) => body.task);
}

/**
 * Subscribes to `task.changed` frames on `GET /events`. Returns a cancel
 * function that closes the EventSource.
 */
export function subscribeTaskChanged(
  owner: string,
  onEvent: (event: TaskChangedEvent) => void,
  onConnectionChange?: (connected: boolean) => void,
  onOverviewChanged?: () => void,
  onDependencyValidationChanged?: (event: DependencyValidationChangedEvent) => void,
  onDependencyRepairChanged?: (event: DependencyRepairChangedEvent) => void
): () => void {
  const source = new EventSource(withOwner("/events", owner));
  // The browser reconnects on its own while CONNECTING; surface the state so
  // the board can warn that data may be stale and re-sync once it reopens.
  source.onopen = () => {
    onConnectionChange?.(true);
  };
  source.onerror = () => {
    onConnectionChange?.(false);
  };
  source.addEventListener("task.changed", (event) => {
    try {
      const parsed = JSON.parse((event as MessageEvent<string>).data) as TaskChangedEvent;
      if (typeof parsed.task_id === "string" && typeof parsed.version === "number") {
        onEvent(parsed);
      }
    } catch {
      // Ignore malformed frames; the next event or manual refresh recovers.
    }
  });
  source.addEventListener("overview.changed", () => {
    onOverviewChanged?.();
  });
  source.addEventListener("dependency_validation.changed", (event) => {
    try {
      const parsed = JSON.parse((event as MessageEvent<string>).data) as DependencyValidationChangedEvent;
      if (typeof parsed.validation_id === "string"
        && typeof parsed.upstream_task_id === "string"
        && typeof parsed.downstream_task_id === "string") {
        onDependencyValidationChanged?.(parsed);
      }
    } catch {
      // Ignore malformed frames; the next task.changed frame or refresh
      // recovers the board state.
    }
  });
  source.addEventListener("dependency_repair.changed", (event) => {
    try {
      const parsed = JSON.parse((event as MessageEvent<string>).data) as DependencyRepairChangedEvent;
      if (typeof parsed.repair_id === "string"
        && typeof parsed.validation_id === "string"
        && typeof parsed.upstream_task_id === "string"
        && typeof parsed.downstream_task_id === "string"
        && typeof parsed.cycle === "number"
        && typeof parsed.status === "string") {
        onDependencyRepairChanged?.(parsed);
      }
    } catch {
      // Ignore malformed frames and recover on the next task or overview refresh.
    }
  });
  return () => {
    source.close();
  };
}

function withOwner(path: string, owner?: string): string {
  if (owner === undefined) {
    return path;
  }
  const params = new URLSearchParams({ owner });
  return `${path}?${params.toString()}`;
}
