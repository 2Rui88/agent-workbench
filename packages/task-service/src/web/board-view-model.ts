import { statusHoldsLease } from "../core/task-state.js";
import type { TaskPriority, TaskStatus } from "../shared/task-contracts.js";
import type { TaskSummary } from "../storage/progress-store.js";

/**
 * Pure view model for the four-column board. Column keys come straight from
 * the plan's Step 1 assertions (`backlog`/`active`/`attention`/`closed`); the
 * Chinese titles are the fixed column names: 待执行、进行中、待处理、已结束.
 * The closed column collapses by default so finished work stays out of the way.
 */

export const BOARD_COLUMN_KEYS = ["backlog", "active", "attention", "closed"] as const;

export type BoardColumnKey = (typeof BOARD_COLUMN_KEYS)[number];

export interface BoardColumnDefinition {
  key: BoardColumnKey;
  title: string;
  collapsedByDefault: boolean;
}

export interface BoardColumn extends BoardColumnDefinition {
  tasks: TaskSummary[];
}

export type BoardPriorityFilter = TaskPriority | "all";
export type BoardAttentionFilter = "all" | "pending_acceptance" | "blocked" | "stale";
export type BoardView = "board" | "dashboard" | "overview";

export interface BoardTaskFilters {
  query: string;
  priority: BoardPriorityFilter;
  attention: BoardAttentionFilter;
}

export interface BoardProjectDirectoryEntry {
  repositories: readonly { repository_id: string }[];
}

export interface RepositorySelection {
  repositoryId: string | null;
  explicitRepositoryVisible: boolean;
}

export interface RepositoryNavigationContext {
  projectId: string;
  repositoryId: string;
  projectCreatedBy: string | null | undefined;
  owners: readonly string[];
}

interface RepositoryNavigationProject {
  project_id: string;
  created_by?: string | null;
  repositories: readonly { repository_id: string }[];
}

interface RepositoryNavigationPerson {
  owner: string | null;
  repositories: readonly string[];
  task_counts?: Readonly<Record<string, number>>;
}

export function buildRepositoryNavigationContext(
  project: RepositoryNavigationProject,
  repositoryId: string,
  people: readonly RepositoryNavigationPerson[]
): RepositoryNavigationContext | null {
  const repository = project.repositories.find((entry) => entry.repository_id === repositoryId);
  if (repository === undefined) {
    return null;
  }
  const owners = people
    .filter((person) => person.owner !== null && (
      person.repositories.includes(repository.repository_id)
      || (person.task_counts?.[repository.repository_id] ?? 0) > 0
    ))
    .map((person) => person.owner as string);
  return {
    projectId: project.project_id,
    repositoryId: repository.repository_id,
    projectCreatedBy: project.created_by,
    owners: [...new Set(owners)]
  };
}

export function resolveRepositoryNavigationOwner(
  context: RepositoryNavigationContext,
  currentOwner: string
): string | null {
  if (context.owners.length === 1) {
    return context.owners[0] ?? null;
  }
  return context.owners.includes(currentOwner) ? currentOwner : null;
}

export function resolveRepositorySelection(
  currentRepositoryId: string | null,
  projects: readonly BoardProjectDirectoryEntry[]
): RepositorySelection {
  if (currentRepositoryId !== null) {
    return {
      repositoryId: currentRepositoryId,
      explicitRepositoryVisible: projects.some((project) => (
        project.repositories.some((repository) => (
          repository.repository_id === currentRepositoryId
        ))
      ))
    };
  }
  return {
    repositoryId: projects[0]?.repositories[0]?.repository_id ?? null,
    explicitRepositoryVisible: true
  };
}

interface ArchivableDirectoryEntry extends BoardProjectDirectoryEntry {
  archived_at?: string | null;
}

export function isArchivedProject(project: { archived_at?: string | null }): boolean {
  return project.archived_at !== null && project.archived_at !== undefined;
}

/** Archived projects never enter the switcher; they get their own section. */
export function partitionProjectsByArchive<P extends ArchivableDirectoryEntry>(
  projects: readonly P[]
): { active: P[]; archived: P[] } {
  return {
    active: projects.filter((project) => !isArchivedProject(project)),
    archived: projects.filter(isArchivedProject)
  };
}

export interface ProjectDirectorySelection<P> extends RepositorySelection {
  activeProjects: P[];
  archivedProjects: P[];
  /** Set when the explicitly requested repository belongs to an archived project. */
  archivedProject: P | null;
}

/**
 * Selection over a directory that includes archived projects: only active
 * projects can be selected; an explicit repository of an archived project is
 * reported so the board can say "项目已归档" and fall back to the dashboard.
 */
export function resolveProjectDirectorySelection<P extends ArchivableDirectoryEntry>(
  currentRepositoryId: string | null,
  projects: readonly P[]
): ProjectDirectorySelection<P> {
  const { active, archived } = partitionProjectsByArchive(projects);
  const selection = resolveRepositorySelection(currentRepositoryId, active);
  const archivedProject = currentRepositoryId === null || selection.explicitRepositoryVisible
    ? undefined
    : archived.find((project) => project.repositories.some((repository) => (
      repository.repository_id === currentRepositoryId
    )));
  if (archivedProject !== undefined) {
    return {
      repositoryId: null,
      explicitRepositoryVisible: true,
      activeProjects: active,
      archivedProjects: archived,
      archivedProject
    };
  }
  return { ...selection, activeProjects: active, archivedProjects: archived, archivedProject: null };
}

/**
 * Archive/restore controls show only on the actor's own personal dashboard,
 * for projects the actor created or legacy projects without a creator (which
 * are in this list only because the actor can see them).
 */
export function canManageProjectArchive(
  project: { created_by?: string | null },
  context: { actorOwner: string; targetOwner: string; overviewMode: boolean }
): boolean {
  if (context.overviewMode || context.targetOwner !== context.actorOwner) {
    return false;
  }
  return project.created_by === null
    || project.created_by === undefined
    || project.created_by === context.actorOwner;
}

const archiveStatusLabels: Readonly<Record<string, string>> = {
  backlog: "待执行",
  in_progress: "进行中",
  waiting_human: "等待人工",
  blocked: "受阻",
  paused: "已暂停",
  verifying: "验证中",
  pending_acceptance: "待验收"
};

export interface ArchiveRejection {
  summary: string;
  lines: string[];
}

/** Human-readable breakdown of a PROJECT_HAS_OPEN_TASKS rejection. */
export function describeArchiveRejection(error: {
  message: string;
  evidence: readonly string[];
  details?: Readonly<Record<string, unknown>> | undefined;
}): ArchiveRejection {
  const openTasks = error.details?.open_tasks;
  const counts = error.details?.open_task_counts;
  if (!Array.isArray(openTasks) || typeof counts !== "object" || counts === null) {
    return { summary: error.message, lines: [...error.evidence] };
  }
  const label = (status: unknown): string => (
    archiveStatusLabels[String(status)] ?? String(status)
  );
  const countText = Object.entries(counts as Record<string, unknown>)
    .map(([status, count]) => `${label(status)} ${String(count)}`)
    .join(" · ");
  return {
    summary: `仍有 ${openTasks.length} 个未结束任务：${countText}`,
    lines: openTasks.map((task: Record<string, unknown>) => (
      `${String(task.task_id)}（owner：${task.owner === null || task.owner === undefined
        ? "未分配"
        : String(task.owner)}，${label(task.status)}）`
    ))
  };
}

export function urlForBoardView(
  currentUrl: string,
  view: BoardView,
  repositoryId: string | null
): URL {
  const url = new URL(currentUrl);
  if (view === "board") {
    url.searchParams.delete("view");
    if (!url.searchParams.has("repo") && repositoryId !== null) {
      url.searchParams.set("repo", repositoryId);
    }
  } else {
    url.searchParams.set("view", view);
    url.searchParams.delete("repo");
  }
  return url;
}

export const BOARD_COLUMNS: readonly BoardColumnDefinition[] = [
  { key: "backlog", title: "待执行", collapsedByDefault: false },
  { key: "active", title: "进行中", collapsedByDefault: false },
  { key: "attention", title: "待处理", collapsedByDefault: false },
  { key: "closed", title: "已结束", collapsedByDefault: true }
];

const columnByStatus: Readonly<Record<TaskStatus, BoardColumnKey>> = {
  backlog: "backlog",
  paused: "backlog",
  waiting_human: "attention",
  blocked: "attention",
  in_progress: "active",
  verifying: "active",
  pending_acceptance: "attention",
  done: "closed",
  cancelled: "closed"
};

export function columnForStatus(status: TaskStatus): BoardColumnKey {
  return columnByStatus[status];
}

const priorityRank: Readonly<Record<TaskSummary["priority"], number>> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3
};

const waitingHumanStatuses: ReadonlySet<TaskStatus> = new Set([
  "waiting_human",
  "pending_acceptance"
]);

function waitingHumanRank(task: TaskSummary): number {
  return waitingHumanStatuses.has(task.status) ? 0 : 1;
}

/**
 * Sort keys, in order: priority ascending (P0 first), then waiting-human
 * statuses (waiting_human / pending_acceptance) first, then updated_at newest
 * first. Pure: returns a new array and never mutates the input.
 */
export function sortTasks(tasks: readonly TaskSummary[]): TaskSummary[] {
  return [...tasks].sort((left, right) => {
    const byPriority = priorityRank[left.priority] - priorityRank[right.priority];
    if (byPriority !== 0) {
      return byPriority;
    }
    const byWaiting = waitingHumanRank(left) - waitingHumanRank(right);
    if (byWaiting !== 0) {
      return byWaiting;
    }
    return Date.parse(right.updated_at) - Date.parse(left.updated_at);
  });
}

/**
 * Groups tasks into the four fixed columns (always all four, in order), each
 * column sorted by `sortTasks`, with the closed column flagged collapsed by
 * default.
 */
export function buildBoardColumns(tasks: readonly TaskSummary[]): BoardColumn[] {
  const grouped = new Map<BoardColumnKey, TaskSummary[]>(BOARD_COLUMN_KEYS.map((key) => [key, []]));
  for (const task of tasks) {
    grouped.get(columnForStatus(task.status))?.push(task);
  }
  return BOARD_COLUMNS.map((column) => ({
    ...column,
    tasks: sortTasks(grouped.get(column.key) ?? [])
  }));
}

export function taskMatchesBoardFilter(
  task: TaskSummary,
  repositoryId: string | null,
  owner: string | null
): boolean {
  return (repositoryId === null || task.repository_id === repositoryId)
    && (owner === null || task.owner === owner);
}

/** Mirrors the server lease TTL (30 minutes) for attention hints and filters. */
const leaseTtlMs = 1_800_000;

export function isPossiblyStale(task: TaskSummary, now: number = Date.now()): boolean {
  if (!statusHoldsLease(task.status)) {
    return false;
  }
  const updatedAt = Date.parse(task.updated_at);
  return Number.isFinite(updatedAt) && now - updatedAt > leaseTtlMs;
}

export function filterBoardTasks(
  tasks: readonly TaskSummary[],
  filters: BoardTaskFilters,
  now: number = Date.now()
): TaskSummary[] {
  const query = filters.query.trim().toLowerCase();
  return tasks.filter((task) => {
    if (filters.priority !== "all" && task.priority !== filters.priority) {
      return false;
    }
    if (filters.attention === "pending_acceptance" && task.status !== "pending_acceptance") {
      return false;
    }
    if (filters.attention === "blocked" && task.status !== "blocked") {
      return false;
    }
    if (filters.attention === "stale" && !isPossiblyStale(task, now)) {
      return false;
    }
    if (query.length === 0) {
      return true;
    }
    const searchable = [
      task.title,
      task.task_id,
      task.owner,
      task.goal,
      task.checkpoint?.current_state,
      task.checkpoint?.next_action
    ].filter((value): value is string => typeof value === "string").join("\n").toLowerCase();
    return searchable.includes(query);
  });
}

export function shortTaskId(taskId: string): string {
  return taskId.length <= 12 ? taskId : `${taskId.slice(0, 8)}…${taskId.slice(-4)}`;
}

export function resolveTargetOwner(search: string, actorOwner: string): string {
  const value = new URLSearchParams(search).get("owner");
  return value === null || value.length === 0 ? actorOwner : value;
}

export function canMutateTask(task: TaskSummary, actorOwner: string): boolean {
  return task.owner === actorOwner;
}

/**
 * Compact relative label for card timestamps ("3 分钟前"); unparseable
 * input passes through unchanged so callers can render it verbatim.
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) {
    return iso;
  }
  const elapsedMs = now - at;
  if (elapsedMs < 60_000) {
    return "刚刚";
  }
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时前`;
  }
  return `${Math.floor(hours / 24)} 天前`;
}
