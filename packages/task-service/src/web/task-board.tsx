import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Select as AppSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Skeleton,
  StatusTag,
  toast,
  type Status
} from "./ui.js";
import type { TaskSummary } from "../storage/progress-store.js";
import {
  ApiError,
  fetchDependencyValidationActivities,
  fetchNotifications,
  fetchOverviewPeople,
  fetchOverviewProjects,
  fetchPeople,
  fetchProjects,
  createProjectShare,
  acceptProjectInvite,
  archiveProject,
  unarchiveProject,
  getTask,
  markDependencyValidationRead,
  markNotificationRead,
  type DependencyValidationActivityItem,
  listTasks,
  subscribeTaskChanged,
  type NotificationItem,
  type PersonSummary,
  type ProjectSummary
} from "./api-client.js";
import {
  BOARD_COLUMNS,
  buildBoardColumns,
  canMutateTask,
  describeArchiveRejection,
  filterBoardTasks,
  formatRelativeTime,
  isPossiblyStale,
  resolveProjectDirectorySelection,
  resolveRepositoryNavigationOwner,
  resolveTargetOwner,
  shortTaskId,
  taskMatchesBoardFilter,
  urlForBoardView,
  type BoardAttentionFilter,
  type BoardColumnKey,
  type BoardPriorityFilter,
  type BoardView,
  type RepositoryNavigationContext
} from "./board-view-model.js";
import { ProjectDashboard, type ProjectArchiveRejection } from "./project-dashboard.js";
import {
  DependencyNotifications,
  notificationsForRepository,
  validationActivitiesForRepository
} from "./dependency-notifications.js";
import { TaskDrawer, type TaskDrawerDetail } from "./task-drawer.js";

/**
 * Minimal four-column board: 待执行、进行中、待处理、已结束. The board is
 * per-repository: the header switcher selects which registered repository's
 * tasks are visible (persisted as ?repo= in the URL), so repositories never
 * mix in one view. The only task entry point is the top 新建任务 button;
 * mutations live in the single drawer. `task.changed` SSE frames trigger a
 * real detail re-fetch by task_id — no optimistic updates anywhere.
 */

interface DrawerState {
  task: TaskSummary;
}

type CollapsedState = Record<BoardColumnKey, boolean>;

const initialCollapsed: CollapsedState = Object.fromEntries(
  BOARD_COLUMNS.map((column) => [column.key, column.collapsedByDefault])
) as CollapsedState;

type BadgeVariant = NonNullable<Parameters<typeof Badge>[0]["variant"]>;

const priorityBadges: Readonly<Record<TaskSummary["priority"], BadgeVariant>> = {
  P0: "destructive",
  P1: "warning",
  P2: "info",
  P3: "secondary"
};

const statusTagByState: Readonly<Record<TaskSummary["status"], Status>> = {
  backlog: "pending",
  in_progress: "in-progress",
  waiting_human: "pending",
  blocked: "failed",
  paused: "disabled",
  verifying: "in-progress",
  pending_acceptance: "pending",
  done: "completed",
  cancelled: "cancelled"
};

const statusLabels: Readonly<Record<TaskSummary["status"], string>> = {
  backlog: "待执行",
  in_progress: "进行中",
  waiting_human: "等待人工",
  blocked: "受阻",
  paused: "已暂停",
  verifying: "验证中",
  pending_acceptance: "待处理",
  done: "已完成",
  cancelled: "已取消"
};

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return `加载失败（${error.code}）：${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function repositoryFromUrl(): string | null {
  const value = new URLSearchParams(window.location.search).get("repo");
  return value === null || value.length === 0 ? null : value;
}

function repositoryToUrl(repositoryId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("repo", repositoryId);
  url.searchParams.delete("view");
  window.history.replaceState(null, "", url);
}

function ownerToUrl(owner: string, actorOwner: string): void {
  const url = new URL(window.location.href);
  if (owner === actorOwner) {
    url.searchParams.delete("owner");
  } else {
    url.searchParams.set("owner", owner);
  }
  window.history.replaceState(null, "", url);
}

function viewToUrl(view: BoardView, repositoryId: string | null): void {
  window.history.replaceState(
    null,
    "",
    urlForBoardView(window.location.href, view, repositoryId)
  );
}

function statusLabelOf(task: TaskSummary): string {
  return statusLabels[task.status];
}

export function TaskBoard({ owner: actorOwner }: { owner: string }) {
  const [tasks, setTasks] = useState<readonly TaskSummary[]>([]);
  const [detail, setDetail] = useState<TaskDrawerDetail | null>(null);
  /** Active (non-archived) projects: the only ones the switcher offers. */
  const [projects, setProjects] = useState<readonly ProjectSummary[]>([]);
  const [archivedProjects, setArchivedProjects] = useState<readonly ProjectSummary[]>([]);
  const [archiveRejection, setArchiveRejection] = useState<ProjectArchiveRejection | null>(null);
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);
  const [overviewProjects, setOverviewProjects] = useState<readonly ProjectSummary[]>([]);
  const [view, setView] = useState<"board" | "dashboard" | "overview">(
    () => {
      const params = new URLSearchParams(window.location.search);
      const value = params.get("view");
      if (value === "dashboard" || value === "overview") return value;
      // Explicit repo selection goes straight to the board; otherwise the
      // dashboard is the landing page.
      return params.has("repo") ? "board" : "dashboard";
    }
  );
  const [repositoryId, setRepositoryId] = useState<string | null>(() => repositoryFromUrl());
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [repositoryDirectoryError, setRepositoryDirectoryError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  /** Per-repo, per-column explicit user overrides. Columns absent from a
   * repo's entry follow the dynamic default (empty → collapsed). */
  const [collapsedOverrides, setCollapsedOverrides] = useState<
    Record<string, Partial<CollapsedState>>
  >(() => {
    try {
      return JSON.parse(
        window.localStorage.getItem("board-collapsed") ?? "{}"
      ) as Record<string, Partial<CollapsedState>>;
    } catch {
      return {};
    }
  });
  const [live, setLive] = useState(true);
  const [people, setPeople] = useState<readonly PersonSummary[]>([]);
  const [overviewPeople, setOverviewPeople] = useState<readonly PersonSummary[]>([]);
  const [notifications, setNotifications] = useState<readonly NotificationItem[]>([]);
  const [validationActivities, setValidationActivities] = useState<
    readonly DependencyValidationActivityItem[]
  >([]);
  const [busyActivityId, setBusyActivityId] = useState<string | null>(null);
  const [taskQuery, setTaskQuery] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<BoardPriorityFilter>("all");
  const [attentionFilter, setAttentionFilter] = useState<BoardAttentionFilter>("all");
  const [targetOwner, setTargetOwner] = useState(() => (
    resolveTargetOwner(window.location.search, actorOwner)
  ));
  const [arrivals, setArrivals] = useState<Record<string, boolean>>({});
  const [nowTick, setNowTick] = useState(() => Date.now());
  const drawerTaskId = useRef<string | null>(null);
  const wasLive = useRef(true);
  const directoryGeneration = useRef(0);
  const directoryRefreshInFlight = useRef<Promise<void> | null>(null);
  const directoryRefreshPending = useRef(false);
  const targetOwnerRef = useRef(targetOwner);
  const viewRef = useRef(view);
  const taskGeneration = useRef(0);
  const taskContextRef = useRef({ repositoryId, targetOwner });
  const projectScopeRef = useRef(false);
  const componentActive = useRef(false);
  const arrivalTimers = useRef(new Set<number>());
  targetOwnerRef.current = targetOwner;
  viewRef.current = view;
  taskContextRef.current = { repositoryId, targetOwner };
  projectScopeRef.current = targetOwner === actorOwner
    && repositoryId !== null
    && projects.some((project) => project.created_by !== null
      && project.created_by !== undefined
      && project.repositories.some((repo) => repo.repository_id === repositoryId));

  useEffect(() => {
    componentActive.current = true;
    return () => {
      componentActive.current = false;
      for (const timer of arrivalTimers.current) {
        window.clearTimeout(timer);
      }
      arrivalTimers.current.clear();
    };
  }, []);

  useEffect(() => {
    drawerTaskId.current = drawer?.task.task_id ?? null;
  }, [drawer]);

  useEffect(() => {
    viewToUrl(view, repositoryId);
  }, [view, repositoryId]);

  function mergeTask(task: TaskSummary): void {
    const { repositoryId: activeRepositoryId, targetOwner: activeOwner } = taskContextRef.current;
    setTasks((previous) => {
      const index = previous.findIndex((entry) => entry.task_id === task.task_id);
      if (!taskMatchesBoardFilter(
        task,
        activeRepositoryId,
        projectScopeRef.current ? null : activeOwner
      )) {
        return index === -1
          ? previous
          : previous.filter((entry) => entry.task_id !== task.task_id);
      }
      if (index === -1) {
        setArrivals((current) => ({ ...current, [task.task_id]: true }));
        const timer = window.setTimeout(() => {
          arrivalTimers.current.delete(timer);
          setArrivals((current) => {
            const next = { ...current };
            delete next[task.task_id];
            return next;
          });
        }, 4_000);
        arrivalTimers.current.add(timer);
        return [...previous, task];
      }
      const next = [...previous];
      next[index] = task;
      return next;
    });
    setDrawer((previous) =>
      previous?.task.task_id === task.task_id
        ? taskMatchesBoardFilter(
          task,
          activeRepositoryId,
          projectScopeRef.current ? null : activeOwner
        )
          ? { task }
          : null
        : previous
    );
  }

  async function reloadDependencyActivities(): Promise<void> {
    try {
      const [nextNotifications, nextValidations] = await Promise.all([
        fetchNotifications(),
        fetchDependencyValidationActivities()
      ]);
      if (!componentActive.current) {
        return;
      }
      setNotifications(nextNotifications);
      setValidationActivities(nextValidations);
    } catch {
      // Task refresh still proceeds when notifications are temporarily unavailable.
    }
  }

  async function reloadOverview(): Promise<void> {
    try {
      const [availableProjects, availablePeople] = await Promise.all([
        fetchOverviewProjects(),
        fetchOverviewPeople()
      ]);
      if (!componentActive.current || viewRef.current !== "overview") {
        return;
      }
      setOverviewProjects(availableProjects);
      setOverviewPeople(availablePeople);
    } catch (error) {
      if (componentActive.current && viewRef.current === "overview") {
        setLoadError(describeError(error));
      }
    }
  }

  async function reloadProjectDirectory(
    generation = directoryGeneration.current
  ): Promise<void> {
    const requestedOwner = targetOwnerRef.current;
    // One request includes archived projects; they are split client-side so
    // the switcher, selection and project scope only ever see active ones.
    const [projectsResult, peopleResult] = await Promise.allSettled([
      fetchProjects(requestedOwner, { includeArchived: true }),
      fetchPeople(requestedOwner)
    ]);
    // Ignore responses that belong to a previous owner selection.
    if (generation !== directoryGeneration.current) {
      return;
    }
    if (!componentActive.current) {
      return;
    }
    if (peopleResult.status === "fulfilled") {
      setPeople(peopleResult.value);
    }
    if (projectsResult.status === "rejected") {
      setLoadError(describeError(projectsResult.reason));
      return;
    }
    const selection = resolveProjectDirectorySelection(
      taskContextRef.current.repositoryId,
      projectsResult.value
    );
    const availableProjects = selection.activeProjects;
    setProjects(availableProjects);
    setArchivedProjects(selection.archivedProjects);
    if (selection.archivedProject !== null) {
      // The selected repository's project was archived (URL ?repo=, a stale
      // selection, or an overview.changed refresh): say so and land on the
      // dashboard instead of silently jumping to another project.
      showArchivedProjectNotice(selection.archivedProject);
    }
    const activeRepositoryId = taskContextRef.current.repositoryId;
    projectScopeRef.current = targetOwnerRef.current === actorOwner
      && activeRepositoryId !== null
      && availableProjects.some((project) => project.created_by !== null
        && project.created_by !== undefined
        && project.repositories.some((repo) => repo.repository_id === activeRepositoryId));
    setLoadError(null);
    if (!selection.explicitRepositoryVisible && activeRepositoryId !== null) {
      setRepositoryDirectoryError(
        `仓库 ${activeRepositoryId} 不在当前身份可见的项目目录中，未自动切换。`
      );
    } else {
      setRepositoryDirectoryError(null);
      if (activeRepositoryId === null
        && selection.repositoryId !== null
        && viewRef.current === "board") {
        repositoryToUrl(selection.repositoryId);
      }
    }
    setRepositoryId(selection.repositoryId);
    if (projectScopeRef.current && activeRepositoryId !== null) {
      void reload(taskGeneration.current);
    }
  }

  function showArchivedProjectNotice(project: ProjectSummary): void {
    taskGeneration.current += 1;
    projectScopeRef.current = false;
    taskContextRef.current = { repositoryId: null, targetOwner: targetOwnerRef.current };
    setRepositoryId(null);
    setTasks([]);
    setDrawer(null);
    setDetail(null);
    setView("dashboard");
    toast.info(`项目「${project.name}」已归档，已切换到仪表盘；可在「已归档项目」中查看或还原。`);
  }

  function requestProjectDirectoryRefresh(): void {
    if (directoryRefreshInFlight.current !== null) {
      // Keep one trailing refresh when several catalog events arrive while a
      // request is in flight, instead of starting an unbounded request burst.
      directoryRefreshPending.current = true;
      return;
    }
    const request = reloadProjectDirectory();
    directoryRefreshInFlight.current = request;
    void request.finally(() => {
      directoryRefreshInFlight.current = null;
      if (componentActive.current && directoryRefreshPending.current) {
        directoryRefreshPending.current = false;
        requestProjectDirectoryRefresh();
      }
    });
  }

  async function reload(generation = taskGeneration.current): Promise<void> {
    const { repositoryId: activeRepositoryId, targetOwner: activeOwner } = taskContextRef.current;
    try {
      const nextTasks = await listTasks(
        activeRepositoryId ?? undefined,
        activeOwner,
        projectScopeRef.current
          ? { scope: "project" }
          : {}
      );
      if (!componentActive.current || generation !== taskGeneration.current) {
        return;
      }
      setTasks(nextTasks);
      setLoadError(null);
      setLoaded(true);
    } catch (error) {
      if (componentActive.current && generation === taskGeneration.current) {
        setLoadError(describeError(error));
      }
    }
  }

  /** SSE-driven refresh: re-fetches the real detail by task_id. */
  async function refreshTask(
    taskId: string,
    generation = taskGeneration.current
  ): Promise<void> {
    try {
      const envelope = await getTask(taskId);
      if (!componentActive.current || generation !== taskGeneration.current) {
        return;
      }
      const { repositoryId: activeRepositoryId, targetOwner: activeOwner } = taskContextRef.current;
      if (!taskMatchesBoardFilter(
        envelope.task,
        activeRepositoryId,
        projectScopeRef.current ? null : activeOwner
      )) {
        return;
      }
      mergeTask(envelope.task);
      if (drawerTaskId.current === taskId) {
        setDetail({
          recovery: envelope.recovery,
          dependency_repairs: envelope.dependency_repairs,
          dependencies: envelope.dependencies,
          dependency_validations: envelope.dependency_validations,
          dependency_validation_gate: envelope.dependency_validation_gate,
          events: envelope.events,
          snapshots: envelope.snapshots
        });
      }
    } catch {
      // 404 or transport failure: fall back to a full list reload.
      if (componentActive.current && generation === taskGeneration.current) {
        await reload(generation);
      }
    }
  }

  /** Called by the drawer after any mutation response: re-pull the data. */
  async function refreshAfterMutation(): Promise<void> {
    const generation = taskGeneration.current;
    await Promise.all([reload(generation), reloadDependencyActivities()]);
    if (!componentActive.current || generation !== taskGeneration.current) {
      return;
    }
    const openId = drawerTaskId.current;
    if (openId !== null) {
      try {
        const envelope = await getTask(openId);
        if (!componentActive.current || generation !== taskGeneration.current) {
          return;
        }
        mergeTask(envelope.task);
        setDetail({
          recovery: envelope.recovery,
          dependency_repairs: envelope.dependency_repairs,
          dependencies: envelope.dependencies,
          dependency_validations: envelope.dependency_validations,
          dependency_validation_gate: envelope.dependency_validation_gate,
          events: envelope.events,
          snapshots: envelope.snapshots
        });
      } catch {
        // The open task vanished; the reload above already refreshed columns.
      }
    }
  }

  useEffect(() => {
    taskGeneration.current += 1;
    const generation = taskGeneration.current;
    void reload(generation);
    const cancelSubscription = subscribeTaskChanged(
      targetOwner,
      (event) => {
        void Promise.all([
          refreshTask(event.task_id, generation),
          reloadDependencyActivities()
        ]);
      },
      (connected) => {
        if (!componentActive.current || generation !== taskGeneration.current) {
          return;
        }
        setLive(connected);
        if (connected) {
          // A connection can open after a catalog write happened, so always
          // perform one catch-up directory read on open (including first load).
          requestProjectDirectoryRefresh();
        }
        // After a reconnect the board may have missed frames; re-sync once.
        if (connected && !wasLive.current) {
          void reload(generation);
          void reloadDependencyActivities();
          if (view === "overview") {
            void reloadOverview();
          }
        }
        wasLive.current = connected;
      },
      () => {
        if (!componentActive.current || generation !== taskGeneration.current) {
          return;
        }
        void reloadDependencyActivities();
        requestProjectDirectoryRefresh();
        if (view === "overview") {
          void reloadOverview();
        }
      },
      (event) => {
        // Validation writes affect both sides of the dependency edge.  The
        // dedicated frame carries ids only; pull authenticated task details
        // to obtain the sanitized contract/evidence.
        void Promise.all([
          refreshTask(event.upstream_task_id, generation),
          refreshTask(event.downstream_task_id, generation),
          reloadDependencyActivities()
        ]);
      },
      (event) => {
        void Promise.all([
          refreshTask(event.upstream_task_id, generation),
          refreshTask(event.downstream_task_id, generation),
          reloadDependencyActivities()
        ]);
      }
    );
    return () => {
      cancelSubscription();
      taskGeneration.current += 1;
    };
  }, [repositoryId, targetOwner, view]);

  useEffect(() => {
    directoryGeneration.current += 1;
    requestProjectDirectoryRefresh();
    return () => {
      // Invalidate in-flight responses when switching owner or unmounting.
      directoryGeneration.current += 1;
      directoryRefreshPending.current = false;
    };
  }, [targetOwner]);

  useEffect(() => {
    const refreshAfterResume = (): void => {
      requestProjectDirectoryRefresh();
      if (view === "overview") {
        void reloadOverview();
      }
    };
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === "visible") {
        refreshAfterResume();
      }
    };
    window.addEventListener("focus", refreshAfterResume);
    window.addEventListener("pageshow", refreshAfterResume);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshAfterResume);
      window.removeEventListener("pageshow", refreshAfterResume);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [view]);

  useEffect(() => {
    void reloadDependencyActivities();
  }, [actorOwner]);

  useEffect(() => {
    const invite = new URLSearchParams(window.location.search).get("invite");
    if (invite === null || invite.length === 0) {
      return;
    }
    void acceptProjectInvite(invite).then(() => {
      const url = new URL(window.location.href);
      url.searchParams.delete("invite");
      window.history.replaceState(null, "", url);
      toast.success("已加入项目，项目列表和任务已刷新");
      requestProjectDirectoryRefresh();
    }).catch((error: unknown) => {
      toast.error(describeError(error));
    });
  }, [actorOwner]);

  useEffect(() => {
    if (view === "overview") {
      void reloadOverview();
    }
  }, [view]);

  // Keep relative timestamps ("3 分钟前") fresh without data churn.
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowTick(Date.now());
    }, 30_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const filteredTasks = useMemo(() => filterBoardTasks(tasks, {
    query: taskQuery,
    priority: priorityFilter,
    attention: attentionFilter
  }, nowTick), [tasks, taskQuery, priorityFilter, attentionFilter, nowTick]);
  const boardNotifications = useMemo(
    () => targetOwner === actorOwner
      ? notificationsForRepository(notifications, repositoryId)
      : [],
    [notifications, repositoryId, targetOwner, actorOwner]
  );
  const boardValidationActivities = useMemo(
    () => targetOwner === actorOwner
      ? validationActivitiesForRepository(validationActivities, repositoryId)
      : [],
    [validationActivities, repositoryId, targetOwner, actorOwner]
  );
  const columns = useMemo(() => buildBoardColumns(filteredTasks), [filteredTasks]);
  // Dynamic defaults: 已结束 always collapsed; other columns collapsed when
  // empty and expanded when they hold tasks. Explicit user toggles (stored
  // per column) take precedence over the dynamic rule.
  const collapsed = useMemo(() => {
    if (!loaded) {
      return initialCollapsed;
    }
    const overrides = repositoryId !== null
      ? collapsedOverrides[repositoryId]
      : undefined;
    const state = {} as CollapsedState;
    for (const column of columns) {
      const override = overrides?.[column.key];
      state[column.key] = override !== undefined
        ? override
        : column.key === "closed" || column.tasks.length === 0;
    }
    return state;
  }, [loaded, repositoryId, collapsedOverrides, columns]);
  const currentProject = useMemo(
    () => projects.find((project) => (
      project.repositories.some((repo) => repo.repository_id === repositoryId)
    )),
    [projects, repositoryId]
  );
  // The repository dropdown cascades with the selected project; before any
  // repository is known (initial load) it falls back to the flat list.
  const repositories = useMemo(
    () => currentProject !== undefined
      ? currentProject.repositories
      : repositoryId === null
        ? projects.flatMap((project) => project.repositories)
        : [],
    [projects, currentProject, repositoryId]
  );

  function switchView(next: BoardView): void {
    if (next === view) {
      return;
    }
    setView(next);
  }

  function switchRepository(nextId: string): void {
    if (nextId === repositoryId) {
      return;
    }
    taskGeneration.current += 1;
    projectScopeRef.current = false;
    taskContextRef.current = {
      repositoryId: nextId,
      targetOwner: targetOwnerRef.current
    };
    setRepositoryId(nextId);
    setTasks([]);
    setDrawer(null);
    setDetail(null);
    setLoaded(false);
    repositoryToUrl(nextId);
  }

  function openRepository(context: RepositoryNavigationContext): void {
    const nextOwner = resolveRepositoryNavigationOwner(context, targetOwnerRef.current);
    const actorHasProjectAccess = context.projectCreatedBy === actorOwner
      || projects.some((project) => project.project_id === context.projectId);
    if (context.owners.length > 1 && nextOwner === null && !actorHasProjectAccess) {
      setRepositoryDirectoryError(
        `仓库 ${context.repositoryId} 有多个任务 owner（${context.owners.join("、")}），请先选择具体 owner。`
      );
      return;
    }
    const resolvedOwner = nextOwner ?? (actorHasProjectAccess ? actorOwner : targetOwnerRef.current);
    const ownerChanged = resolvedOwner !== targetOwnerRef.current;
    taskGeneration.current += 1;
    projectScopeRef.current = false;
    taskContextRef.current = {
      repositoryId: context.repositoryId,
      targetOwner: resolvedOwner
    };
    targetOwnerRef.current = resolvedOwner;
    if (ownerChanged) {
      directoryGeneration.current += 1;
      setTargetOwner(resolvedOwner);
      setProjects([]);
      setArchivedProjects([]);
      setPeople([]);
      ownerToUrl(resolvedOwner, actorOwner);
    }
    setRepositoryId(context.repositoryId);
    setTasks([]);
    setDrawer(null);
    setDetail(null);
    setLoaded(false);
    repositoryToUrl(context.repositoryId);
    setView("board");
  }

  function openTask(task: TaskSummary): void {
    setDrawer({ task });
    setDetail(null);
    void refreshTask(task.task_id);
  }

  async function markNotificationAsRead(notificationId: string): Promise<void> {
    const activityId = `notification:${notificationId}`;
    setBusyActivityId(activityId);
    try {
      await markNotificationRead(notificationId);
      const readAt = new Date().toISOString();
      setNotifications((previous) => previous.map((notification) => (
        notification.notification_id === notificationId
          ? { ...notification, read_at: notification.read_at ?? readAt }
          : notification
      )));
    } catch (error) {
      const message = error instanceof ApiError
        ? `标记已读失败（${error.code}）：${error.message}`
        : `标记已读失败：${error instanceof Error ? error.message : String(error)}`;
      toast.error(message);
    } finally {
      setBusyActivityId(null);
    }
  }

  async function markValidationAsRead(
    activity: DependencyValidationActivityItem
  ): Promise<void> {
    const activityId = `validation:${activity.validation_id}:${activity.perspective}`;
    setBusyActivityId(activityId);
    try {
      await markDependencyValidationRead(activity.validation_id, activity.perspective);
      const readAt = new Date().toISOString();
      setValidationActivities((previous) => previous.map((candidate) => (
        candidate.validation_id === activity.validation_id
          && candidate.perspective === activity.perspective
          ? { ...candidate, read_at: candidate.read_at ?? readAt }
          : candidate
      )));
    } catch (error) {
      toast.error(error instanceof ApiError
        ? `标记已读失败（${error.code}）：${error.message}`
        : `标记已读失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusyActivityId(null);
    }
  }

  function openNotificationTask(taskId: string): void {
    const task = tasks.find((candidate) => candidate.task_id === taskId);
    if (task !== undefined) {
      openTask(task);
    } else {
      const generation = taskGeneration.current;
      void getTask(taskId).then((envelope) => {
        if (!componentActive.current || generation !== taskGeneration.current) {
          return;
        }
        const { repositoryId: activeRepositoryId, targetOwner: activeOwner } = taskContextRef.current;
        if (!taskMatchesBoardFilter(
          envelope.task,
          activeRepositoryId,
          projectScopeRef.current ? null : activeOwner
        )) {
          return;
        }
        setDrawer({ task: envelope.task });
        setDetail({
          recovery: envelope.recovery,
          dependency_repairs: envelope.dependency_repairs,
          dependencies: envelope.dependencies,
          dependency_validations: envelope.dependency_validations,
          dependency_validation_gate: envelope.dependency_validation_gate,
          events: envelope.events,
          snapshots: envelope.snapshots
        });
      }).catch((error: unknown) => {
        if (componentActive.current && generation === taskGeneration.current) {
          toast.error(describeError(error));
        }
      });
    }
  }

  function selectTargetOwner(nextOwner: string): void {
    if (nextOwner !== targetOwner) {
      setTasks([]);
      setProjects([]);
      setArchivedProjects([]);
      setArchiveRejection(null);
      setPeople([]);
      setRepositoryId(null);
      setDetail(null);
    }
    setTargetOwner(nextOwner);
    setLoaded(false);
    setDrawer(null);
    ownerToUrl(nextOwner, actorOwner);
  }

  async function shareProject(project: ProjectSummary): Promise<void> {
    try {
      const share = await createProjectShare(project.project_id);
      const inviteUrl = `${window.location.origin}/board?invite=${encodeURIComponent(share.token)}`;
      try {
        await navigator.clipboard?.writeText(inviteUrl);
      } catch {
        // Clipboard permission is optional; the URL remains visible in the toast.
      }
      toast.success(`已生成 ${project.name} 邀请链接（24 小时有效）：${inviteUrl}`);
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  async function archiveProjectFromDashboard(project: ProjectSummary): Promise<void> {
    const confirmed = window.confirm(
      `确认归档项目「${project.name}」？\n归档后项目从项目切换器中移除、不可再写入，数据全部保留，`
        + "可在仪表盘「已归档项目」中还原。"
    );
    if (!confirmed) {
      return;
    }
    setArchiveRejection(null);
    setBusyProjectId(project.project_id);
    try {
      await archiveProject(project.project_id);
      if (project.repositories.some((repo) => repo.repository_id === repositoryId)) {
        taskContextRef.current = { repositoryId: null, targetOwner: targetOwnerRef.current };
        setRepositoryId(null);
        setTasks([]);
      }
      setView("dashboard");
      toast.success(`项目「${project.name}」已归档`);
      requestProjectDirectoryRefresh();
    } catch (error) {
      if (error instanceof ApiError && error.code === "PROJECT_HAS_OPEN_TASKS") {
        setArchiveRejection({ projectId: project.project_id, ...describeArchiveRejection(error) });
      } else {
        toast.error(describeError(error));
      }
    } finally {
      setBusyProjectId(null);
    }
  }

  async function unarchiveProjectFromDashboard(project: ProjectSummary): Promise<void> {
    setBusyProjectId(project.project_id);
    try {
      await unarchiveProject(project.project_id);
      toast.success(`项目「${project.name}」已还原`);
      requestProjectDirectoryRefresh();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusyProjectId(null);
    }
  }

  async function acceptProjectInviteFromPrompt(): Promise<void> {
    const token = window.prompt("粘贴项目邀请 token 或链接");
    if (token === null || token.trim().length === 0) {
      return;
    }
    try {
      const parsedToken = token.includes("invite=")
        ? new URL(token, window.location.origin).searchParams.get("invite") ?? token
        : token.trim();
      await acceptProjectInvite(parsedToken);
      toast.success("已加入项目，项目列表和任务已刷新");
      requestProjectDirectoryRefresh();
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  function showPersonalDashboard(): void {
    selectTargetOwner(actorOwner);
    setView("dashboard");
  }

  function showOverview(): void {
    selectTargetOwner(actorOwner);
    setView("overview");
  }

  return (
    <div className="board-page">
      <header className="board-header">
        <div className="board-context">
          {view === "board" && (
            <div className="repository-switcher">
              <AppSelect
                value={repositoryId ?? null}
                onValueChange={(value) => {
                  if (typeof value === "string") {
                    switchRepository(value);
                  }
                }}
              >
                <SelectTrigger aria-label="仓库" placeholder="选择仓库" className="w-56" />
                <SelectContent>
                  {repositories.map((repository) => (
                    <SelectItem key={repository.repository_id} value={repository.repository_id}>
                      <span className="repository-option">
                        <span
                          className="repository-option-label dashboard-text-truncate"
                          title={repository.label}
                        >
                          {repository.label}
                        </span>
                        <span
                          className="repository-option-id mono dashboard-text-truncate"
                          title={repository.repository_id}
                        >
                          （{repository.repository_id}）
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </AppSelect>
            </div>
          )}
          <Badge
            variant="info"
            className="identity-chip"
            title={targetOwner === actorOwner
              ? "当前配对身份"
              : `当前配对身份：${actorOwner}；正在只读查看`}
          >
            👤 {targetOwner}{targetOwner === actorOwner ? "" : "（只读）"}
          </Badge>
          {targetOwner !== actorOwner && view === "board" && (
            <Badge variant="secondary" className="readonly-chip">跨 owner 只读</Badge>
          )}
        </div>
        {view === "board" && (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="切换项目"
              className="project-switch-trigger"
            >
              <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16">
                <path
                  d="M2 5h10M9 2.5 11.5 5 9 7.5M14 11H4M7 8.5 4.5 11 7 13.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="project-switch-label">项目</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem onClick={showPersonalDashboard}>
                📊 项目仪表盘
              </DropdownMenuItem>
              <DropdownMenuItem onClick={showOverview}>
                🌐 全局总览
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>项目切换</DropdownMenuLabel>
                {projects.map((project) => (
                  <DropdownMenuItem
                    key={project.project_id}
                    onClick={() => {
                      const first = project.repositories[0]?.repository_id;
                      if (first !== undefined) {
                        switchRepository(first);
                        switchView("board");
                      }
                    }}
                  >
                    <span className="project-menu-name dashboard-text-truncate" title={project.name}>
                      {project.name}
                    </span>
                    <span className="project-menu-count">
                      {project.repositories.length} 仓库
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>

      {loadError !== null && (
        <p role="alert" className="board-error">
          {loadError}
        </p>
      )}

      {repositoryDirectoryError !== null && (
        <p role="alert" className="board-error">
          {repositoryDirectoryError}
        </p>
      )}

      {!live && (
        <div role="status" className="board-live-banner">
          实时连接已断开，正在自动重连——列表可能不是最新，重连后将自动刷新。
        </div>
      )}

      {(view === "dashboard" || view === "overview") ? (
        <ProjectDashboard
          projects={view === "overview" ? overviewProjects : projects}
          archivedProjects={view === "overview" ? [] : archivedProjects}
          people={view === "overview" ? overviewPeople : people}
          notifications={targetOwner === actorOwner ? notifications : []}
          validationActivities={targetOwner === actorOwner ? validationActivities : []}
          activeOwner={targetOwner}
          actorOwner={actorOwner}
          overviewMode={view === "overview"}
          onOpenRepository={openRepository}
          onFilterOwner={(selectedOwner) => {
            selectTargetOwner(selectedOwner);
            setView("dashboard");
          }}
          onToggleOverview={() => {
            if (view === "overview") {
              showPersonalDashboard();
            } else {
              showOverview();
            }
          }}
          onBackToBoard={() => switchView("board")}
          onShareProject={(project) => {
            void shareProject(project);
          }}
          onAcceptProjectInvite={() => {
            void acceptProjectInviteFromPrompt();
          }}
          onArchiveProject={(project) => {
            void archiveProjectFromDashboard(project);
          }}
          onUnarchiveProject={(project) => {
            void unarchiveProjectFromDashboard(project);
          }}
          archiveRejection={archiveRejection}
          busyProjectId={busyProjectId}
        />
      ) : (
        <>
          <DependencyNotifications
            notifications={boardNotifications}
            validationActivities={boardValidationActivities}
            busyActivityId={busyActivityId}
            onOpenTask={openNotificationTask}
            onMarkNotificationRead={(notificationId) => {
              void markNotificationAsRead(notificationId);
            }}
            onMarkValidationRead={(activity) => {
              void markValidationAsRead(activity);
            }}
          />
          <div className="board-filters" aria-label="任务筛选">
            <label className="board-search-field">
              <span>搜索</span>
              <input
                type="search"
                value={taskQuery}
                placeholder="标题、ID、负责人或下一步"
                onChange={(event) => setTaskQuery(event.target.value)}
              />
            </label>
            <label className="board-filter-field">
              <span>优先级</span>
              <AppSelect
                value={priorityFilter}
                onValueChange={(value) => {
                  if (typeof value === "string") {
                    setPriorityFilter(value as BoardPriorityFilter);
                  }
                }}
              >
                <SelectTrigger aria-label="优先级" placeholder="全部" />
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="P0">P0</SelectItem>
                  <SelectItem value="P1">P1</SelectItem>
                  <SelectItem value="P2">P2</SelectItem>
                  <SelectItem value="P3">P3</SelectItem>
                </SelectContent>
              </AppSelect>
            </label>
            <label className="board-filter-field">
              <span>关注状态</span>
              <AppSelect
                value={attentionFilter}
                onValueChange={(value) => {
                  if (typeof value === "string") {
                    setAttentionFilter(value as BoardAttentionFilter);
                  }
                }}
              >
                <SelectTrigger aria-label="关注状态" placeholder="全部" />
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="pending_acceptance">待验收</SelectItem>
                  <SelectItem value="blocked">受阻</SelectItem>
                  <SelectItem value="stale">久未更新</SelectItem>
                </SelectContent>
              </AppSelect>
            </label>
            <span className="board-filter-result">显示 {filteredTasks.length} / {tasks.length}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={taskQuery.length === 0 && priorityFilter === "all" && attentionFilter === "all"}
              onClick={() => {
                setTaskQuery("");
                setPriorityFilter("all");
                setAttentionFilter("all");
              }}
            >
              清除筛选
            </Button>
          </div>
          <div className="board-columns">
        {columns.map((column) => {
          const isCollapsed = collapsed[column.key];
          return (
            <section
              key={column.key}
              className={`board-column column-${column.key}`}
              aria-label={column.title}
            >
              <button
                type="button"
                className="column-header"
                aria-expanded={!isCollapsed}
                aria-label={isCollapsed ? "展开" : "折叠"}
                onClick={() => {
                  const repoKey = repositoryId ?? "_default";
                  setCollapsedOverrides((previous) => {
                    const next = {
                      ...previous,
                      [repoKey]: {
                        ...previous[repoKey],
                        [column.key]: !collapsed[column.key]
                      }
                    };
                    try {
                      window.localStorage.setItem(
                        "board-collapsed",
                        JSON.stringify(next)
                      );
                    } catch {
                      // Storage full or blocked; per-session state still works.
                    }
                    return next;
                  });
                }}
              >
                <span className="column-title">{column.title}</span>
                <Badge variant="secondary" size="sm">{column.tasks.length}</Badge>
                <svg
                  className={`chevron${isCollapsed ? "" : " chevron-open"}`}
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  width="14"
                  height="14"
                >
                  <path
                    d="M6 4l4 4-4 4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              {!isCollapsed && (
                <ul className="column-tasks">
                  {!loaded && column.tasks.length === 0 && (
                    <>
                      <li><Skeleton className="task-card-skeleton" /></li>
                      <li><Skeleton className="task-card-skeleton" /></li>
                    </>
                  )}
                  {loaded && column.tasks.map((task) => (
                    <li key={task.task_id}>
                      <button
                        type="button"
                        data-task-id={task.task_id}
                        className={`task-card${arrivals[task.task_id] === true ? " task-card-arrived" : ""}`}
                        onClick={() => openTask(task)}
                      >
                        <span className="task-card-top">
                          <Badge variant={priorityBadges[task.priority]} size="sm">
                            {task.priority}
                          </Badge>
                          <StatusTag
                            status={statusTagByState[task.status]}
                            label={statusLabelOf(task)}
                          />
                        </span>
                        <span className="task-card-title" title={task.title}>{task.title}</span>
                        <span className="task-card-meta mono" title={task.task_id}>
                          {shortTaskId(task.task_id)}
                        </span>
                        <span
                          className="task-card-meta"
                          title={`更新时间：${task.updated_at}`}
                        >
                          {formatRelativeTime(task.updated_at)}更新
                        </span>
                        <span className="task-card-last-row">
                          {task.checkpoint?.next_action !== undefined && (
                            <span className="task-card-next">
                              <span title={`下一步：${task.checkpoint.next_action}`}>
                                下一步：{task.checkpoint.next_action}
                              </span>
                            </span>
                          )}
                          {task.owner !== undefined && (
                            <Badge variant="accent" size="sm">{task.owner}</Badge>
                          )}
                        </span>
                        {isPossiblyStale(task, nowTick) && (
                          <span
                            className="badge badge-stale"
                            title="任务记录超过 30 分钟未更新；请在详情中核对活动租约及其到期时间。"
                          >
                            任务久未更新（超过 30 分钟）
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                  {loaded && column.tasks.length === 0 && (
                    <li className="column-empty">
                      <EmptyState
                        size="sm"
                        title={taskQuery.length > 0 || priorityFilter !== "all" || attentionFilter !== "all"
                          ? "无匹配任务"
                          : "暂无任务"}
                      />
                    </li>
                  )}
                </ul>
              )}
            </section>
          );
        })}
          </div>
        </>
      )}

      {drawer !== null && (
        <TaskDrawer
          mode="detail"
          canMutate={canMutateTask(drawer.task, actorOwner)}
          task={drawer.task}
          detail={detail}
          onClose={() => {
            setDrawer(null);
          }}
          onChanged={refreshAfterMutation}
        />
      )}
    </div>
  );
}
