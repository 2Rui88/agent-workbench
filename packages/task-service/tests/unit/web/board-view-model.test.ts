import { describe, expect, it } from "vitest";
import type { TaskStatus } from "../../../src/shared/task-contracts.js";
import type { TaskSummary } from "../../../src/storage/progress-store.js";
import {
  BOARD_COLUMNS,
  buildRepositoryNavigationContext,
  buildBoardColumns,
  canManageProjectArchive,
  canMutateTask,
  columnForStatus,
  describeArchiveRejection,
  partitionProjectsByArchive,
  resolveProjectDirectorySelection,
  filterBoardTasks,
  formatRelativeTime,
  isPossiblyStale,
  resolveRepositorySelection,
  resolveRepositoryNavigationOwner,
  resolveTargetOwner,
  shortTaskId,
  sortTasks,
  taskMatchesBoardFilter,
  urlForBoardView
} from "../../../src/web/board-view-model.js";

interface TaskOverrides {
  status?: TaskStatus;
  priority?: TaskSummary["priority"];
  updated_at?: string;
  title?: string;
  task_id?: string;
  repository_id?: string;
  owner?: string;
}

let taskCounter = 0;

function makeTask(overrides: TaskOverrides = {}): TaskSummary {
  taskCounter += 1;
  const id = overrides.task_id ?? `task-${String(taskCounter).padStart(3, "0")}`;
  return {
    task_id: id,
    repository_id: overrides.repository_id ?? "repo-main",
    ...(overrides.owner === undefined ? {} : { owner: overrides.owner }),
    title: overrides.title ?? `Task ${taskCounter}`,
    status: overrides.status ?? "backlog",
    priority: overrides.priority ?? "P2",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-08-01T00:00:00.000Z",
    version: 0
  };
}

describe("taskMatchesBoardFilter", () => {
  it("enforces both repository and owner filters for SSE task merges", () => {
    const alice = makeTask({ owner: "alice" });
    expect(taskMatchesBoardFilter(alice, "repo-main", "alice")).toBe(true);
    expect(taskMatchesBoardFilter(alice, "repo-main", "bob")).toBe(false);
    expect(taskMatchesBoardFilter(alice, "repo-other", "alice")).toBe(false);
  });

  it("treats null filters as unrestricted", () => {
    const task = makeTask({ repository_id: "repo-other", owner: "alice" });
    expect(taskMatchesBoardFilter(task, null, null)).toBe(true);
  });
});

describe("board owner model", () => {
  it("uses URL owner only as the read target", () => {
    expect(resolveTargetOwner("?owner=yorn", "jande")).toBe("yorn");
    expect(resolveTargetOwner("", "jande")).toBe("jande");
    expect(resolveTargetOwner("?owner=", "jande")).toBe("jande");
  });

  it("allows mutations only for the task's real owner", () => {
    const task = makeTask({ owner: "yorn" });
    expect(canMutateTask(task, "yorn")).toBe(true);
    expect(canMutateTask(task, "jande")).toBe(false);
  });
});

describe("resolveRepositorySelection", () => {
  const projects = [
    { repositories: [{ repository_id: "repo-one" }, { repository_id: "repo-two" }] },
    { repositories: [{ repository_id: "repo-other" }] }
  ];

  it("preserves an explicit repository when it is not in the visible directory", () => {
    expect(resolveRepositorySelection("repo-missing", projects)).toEqual({
      repositoryId: "repo-missing",
      explicitRepositoryVisible: false
    });
  });

  it("chooses the first repository only when no repository was requested", () => {
    expect(resolveRepositorySelection(null, projects)).toEqual({
      repositoryId: "repo-one",
      explicitRepositoryVisible: true
    });
  });
});

describe("project archive directory model", () => {
  const active = {
    project_id: "project-active",
    archived_at: null,
    repositories: [{ repository_id: "repo-active" }]
  };
  const archived = {
    project_id: "project-archived",
    archived_at: "2026-10-16T02:00:00.000Z",
    repositories: [{ repository_id: "repo-archived" }]
  };

  it("splits archived projects away from the switcher list", () => {
    expect(partitionProjectsByArchive([archived, active])).toEqual({
      active: [active],
      archived: [archived]
    });
  });

  it("never auto-selects a repository that belongs to an archived project", () => {
    expect(resolveProjectDirectorySelection(null, [archived, active])).toMatchObject({
      repositoryId: "repo-active",
      explicitRepositoryVisible: true,
      archivedProject: null,
      activeProjects: [active],
      archivedProjects: [archived]
    });
  });

  it("reports an explicit repository of an archived project instead of a missing one", () => {
    expect(resolveProjectDirectorySelection("repo-archived", [archived, active])).toMatchObject({
      repositoryId: null,
      explicitRepositoryVisible: true,
      archivedProject: archived
    });
  });

  it("keeps the existing not-visible error for an unknown explicit repository", () => {
    expect(resolveProjectDirectorySelection("repo-missing", [archived, active])).toMatchObject({
      repositoryId: "repo-missing",
      explicitRepositoryVisible: false,
      archivedProject: null
    });
  });

  it("lets only the creator, or any viewer of a legacy project, manage archive on their own dashboard", () => {
    const own = { actorOwner: "jande", targetOwner: "jande", overviewMode: false };
    expect(canManageProjectArchive({ created_by: "jande" }, own)).toBe(true);
    expect(canManageProjectArchive({ created_by: null }, own)).toBe(true);
    expect(canManageProjectArchive({}, own)).toBe(true);
    expect(canManageProjectArchive({ created_by: "yorn" }, own)).toBe(false);
    expect(canManageProjectArchive({ created_by: "jande" }, { ...own, targetOwner: "yorn" }))
      .toBe(false);
    expect(canManageProjectArchive({ created_by: null }, { ...own, targetOwner: "yorn" }))
      .toBe(false);
    expect(canManageProjectArchive({ created_by: "jande" }, { ...own, overviewMode: true }))
      .toBe(false);
  });

  it("formats the server's unfinished-task breakdown for the archive rejection", () => {
    expect(describeArchiveRejection({
      message: "Project project-a still has 2 unfinished task(s)",
      evidence: [],
      details: {
        open_task_counts: { in_progress: 1, pending_acceptance: 1 },
        open_tasks: [
          { task_id: "task-1", owner: "member", status: "in_progress", repository_id: "repo-a" },
          { task_id: "task-2", owner: null, status: "pending_acceptance", repository_id: "repo-a" }
        ]
      }
    })).toEqual({
      summary: "仍有 2 个未结束任务：进行中 1 · 待验收 1",
      lines: [
        "task-1（owner：member，进行中）",
        "task-2（owner：未分配，待验收）"
      ]
    });
  });

  it("falls back to evidence lines when the rejection has no structured details", () => {
    expect(describeArchiveRejection({
      message: "blocked",
      evidence: ["in_progress: 1"]
    })).toEqual({ summary: "blocked", lines: ["in_progress: 1"] });
  });
});

describe("repository navigation context", () => {
  it("keeps project creator separate from the repository task owner", () => {
    const context = buildRepositoryNavigationContext(
      {
        project_id: "project-recipe",
        created_by: "yorn",
        repositories: [{ repository_id: "recipe-pipeline" }]
      },
      "recipe-pipeline",
      [{
        owner: "jande",
        repositories: ["recipe-pipeline"],
        task_counts: { "recipe-pipeline": 2 }
      }]
    );

    expect(context).toEqual({
      projectId: "project-recipe",
      repositoryId: "recipe-pipeline",
      projectCreatedBy: "yorn",
      owners: ["jande"]
    });
    expect(resolveRepositoryNavigationOwner(context!, "yorn")).toBe("jande");
  });

  it("does not silently choose an owner when a repository has multiple owners", () => {
    const context = buildRepositoryNavigationContext(
      {
        project_id: "project-shared",
        created_by: "yorn",
        repositories: [{ repository_id: "repo-shared" }]
      },
      "repo-shared",
      [
        { owner: "alice", repositories: ["repo-shared"], task_counts: { "repo-shared": 1 } },
        { owner: "bob", repositories: ["repo-shared"], task_counts: { "repo-shared": 1 } }
      ]
    );

    expect(resolveRepositoryNavigationOwner(context!, "jande")).toBeNull();
    expect(resolveRepositoryNavigationOwner(context!, "alice")).toBe("alice");
  });
});

describe("urlForBoardView", () => {
  it("removes repository context from aggregate views", () => {
    const dashboard = urlForBoardView(
      "http://localhost:47321/board?repo=repo-main&owner=alice",
      "dashboard",
      "repo-main"
    );
    expect(dashboard.searchParams.get("view")).toBe("dashboard");
    expect(dashboard.searchParams.has("repo")).toBe(false);
    expect(dashboard.searchParams.get("owner")).toBe("alice");

    const overview = urlForBoardView(dashboard.toString(), "overview", "repo-main");
    expect(overview.searchParams.get("view")).toBe("overview");
    expect(overview.searchParams.has("repo")).toBe(false);
  });

  it("restores the selected repository when returning to the board", () => {
    const board = urlForBoardView(
      "http://localhost:47321/board?view=dashboard",
      "board",
      "repo-main"
    );
    expect(board.searchParams.has("view")).toBe(false);
    expect(board.searchParams.get("repo")).toBe("repo-main");
  });

  it("preserves an explicitly selected repository", () => {
    const board = urlForBoardView(
      "http://localhost:47321/board?repo=repo-next&view=dashboard",
      "board",
      "repo-previous"
    );
    expect(board.searchParams.has("view")).toBe(false);
    expect(board.searchParams.get("repo")).toBe("repo-next");
  });
});

describe("columnForStatus", () => {
  it("maps every status into exactly one of the four fixed columns", () => {
    expect(columnForStatus("backlog")).toBe("backlog");
    expect(columnForStatus("paused")).toBe("backlog");
    expect(columnForStatus("waiting_human")).toBe("attention");
    expect(columnForStatus("blocked")).toBe("attention");
    expect(columnForStatus("in_progress")).toBe("active");
    expect(columnForStatus("verifying")).toBe("active");
    expect(columnForStatus("pending_acceptance")).toBe("attention");
    expect(columnForStatus("done")).toBe("closed");
    expect(columnForStatus("cancelled")).toBe("closed");
  });

  it("exposes the four columns in order with their fixed titles", () => {
    expect(BOARD_COLUMNS.map((column) => column.key)).toEqual([
      "backlog",
      "active",
      "attention",
      "closed"
    ]);
    expect(BOARD_COLUMNS.map((column) => column.title)).toEqual([
      "待执行",
      "进行中",
      "待处理",
      "已结束"
    ]);
  });
});

describe("sortTasks", () => {
  it("puts P0 before a more recently updated P2 (brief assertion)", () => {
    const p2Recent = makeTask({ priority: "P2", updated_at: "2026-08-17T12:00:00.000Z" });
    const p0Old = makeTask({ priority: "P0", updated_at: "2026-08-01T12:00:00.000Z" });
    expect(sortTasks([p2Recent, p0Old])[0]?.priority).toBe("P0");
    expect(sortTasks([p2Recent, p0Old])[1]?.priority).toBe("P2");
  });

  it("sorts priorities ascending P0, P1, P2, P3", () => {
    const tasks = [
      makeTask({ priority: "P3" }),
      makeTask({ priority: "P1" }),
      makeTask({ priority: "P0" }),
      makeTask({ priority: "P2" })
    ];
    expect(sortTasks(tasks).map((task) => task.priority)).toEqual(["P0", "P1", "P2", "P3"]);
  });

  it("ranks waiting-human statuses first within the same priority", () => {
    const plainRecent = makeTask({
      status: "in_progress",
      updated_at: "2026-08-17T12:00:00.000Z"
    });
    const waitingOld = makeTask({
      status: "waiting_human",
      updated_at: "2026-08-01T12:00:00.000Z"
    });
    const acceptanceOld = makeTask({
      status: "pending_acceptance",
      updated_at: "2026-08-01T00:00:00.000Z"
    });
    const sorted = sortTasks([plainRecent, acceptanceOld, waitingOld]);
    // waiting_human and pending_acceptance outrank in_progress despite older
    // timestamps; between the two, the newer update wins.
    expect(sorted.map((task) => task.status)).toEqual([
      "waiting_human",
      "pending_acceptance",
      "in_progress"
    ]);
  });

  it("sorts equal priority and wait rank by updated_at newest first", () => {
    const older = makeTask({ updated_at: "2026-08-01T00:00:00.000Z", title: "older" });
    const newer = makeTask({ updated_at: "2026-08-16T00:00:00.000Z", title: "newer" });
    const newest = makeTask({ updated_at: "2026-08-17T00:00:00.000Z", title: "newest" });
    expect(sortTasks([older, newest, newer]).map((task) => task.title)).toEqual([
      "newest",
      "newer",
      "older"
    ]);
  });

  it("keeps waiting-human rank below a strictly higher priority", () => {
    const p0Plain = makeTask({ priority: "P0", status: "in_progress" });
    const p1Waiting = makeTask({ priority: "P1", status: "waiting_human" });
    expect(sortTasks([p1Waiting, p0Plain])[0]?.priority).toBe("P0");
  });

  it("does not mutate the input array", () => {
    const tasks = [
      makeTask({ priority: "P2", updated_at: "2026-08-17T00:00:00.000Z" }),
      makeTask({ priority: "P0", updated_at: "2026-08-01T00:00:00.000Z" })
    ];
    const snapshot = [...tasks];
    sortTasks(tasks);
    expect(tasks).toEqual(snapshot);
  });

  it("returns an empty array for empty input", () => {
    expect(sortTasks([])).toEqual([]);
  });
});

describe("buildBoardColumns", () => {
  it("always returns all four columns in fixed order, even when empty", () => {
    const columns = buildBoardColumns([]);
    expect(columns.map((column) => column.key)).toEqual([
      "backlog",
      "active",
      "attention",
      "closed"
    ]);
    expect(columns.map((column) => column.title)).toEqual([
      "待执行",
      "进行中",
      "待处理",
      "已结束"
    ]);
    for (const column of columns) {
      expect(column.tasks).toEqual([]);
    }
  });

  it("groups tasks by column and sorts within each column", () => {
    const columns = buildBoardColumns([
      makeTask({ status: "done", priority: "P1" }),
      makeTask({ status: "paused", priority: "P2", updated_at: "2026-08-01T00:00:00.000Z" }),
      makeTask({ status: "in_progress", priority: "P2", updated_at: "2026-08-16T00:00:00.000Z" }),
      makeTask({ status: "backlog", priority: "P0", updated_at: "2026-08-02T00:00:00.000Z" }),
      makeTask({ status: "verifying", priority: "P1" }),
      makeTask({ status: "pending_acceptance" }),
      makeTask({ status: "cancelled" })
    ]);
    const byKey = new Map(columns.map((column) => [column.key, column]));
    expect(byKey.get("backlog")?.tasks.map((task) => task.status)).toEqual([
      "backlog",
      "paused"
    ]);
    expect(byKey.get("active")?.tasks.map((task) => task.status)).toEqual([
      "verifying",
      "in_progress"
    ]);
    expect(byKey.get("attention")?.tasks.map((task) => task.status)).toEqual([
      "pending_acceptance"
    ]);
    expect(
      [...(byKey.get("closed")?.tasks ?? [])].sort((a, b) => a.title.localeCompare(b.title))
        .length
    ).toBe(2);
  });

  it("marks only the closed column as collapsed by default", () => {
    const columns = buildBoardColumns([makeTask({ status: "done" })]);
    expect(columns.map((column) => column.collapsedByDefault)).toEqual([
      false,
      false,
      false,
      true
    ]);
  });
});

describe("filterBoardTasks", () => {
  const now = Date.parse("2026-08-18T12:00:00.000Z");

  it("matches query text across task fields and owner", () => {
    const tasks = [
      makeTask({ title: "部署 Board", owner: "alice", task_id: "task-deploy" }),
      makeTask({ title: "修复通知", owner: "bob", task_id: "task-notify" })
    ];
    expect(filterBoardTasks(tasks, {
      query: "ALICE",
      priority: "all",
      attention: "all"
    }, now).map((task) => task.task_id)).toEqual(["task-deploy"]);
  });

  it("combines priority and attention filters", () => {
    const tasks = [
      makeTask({ status: "pending_acceptance", priority: "P1" }),
      makeTask({ status: "pending_acceptance", priority: "P2" }),
      makeTask({ status: "blocked", priority: "P1" })
    ];
    expect(filterBoardTasks(tasks, {
      query: "",
      priority: "P1",
      attention: "pending_acceptance"
    }, now)).toHaveLength(1);
  });

  it("finds only lease-holding tasks older than 30 minutes as stale", () => {
    const stale = makeTask({
      status: "in_progress",
      updated_at: "2026-08-18T11:29:59.000Z"
    });
    const fresh = makeTask({
      status: "verifying",
      updated_at: "2026-08-18T11:45:00.000Z"
    });
    const blocked = makeTask({
      status: "blocked",
      updated_at: "2026-08-18T10:00:00.000Z"
    });
    expect(isPossiblyStale(stale, now)).toBe(true);
    expect(isPossiblyStale(fresh, now)).toBe(false);
    expect(isPossiblyStale(blocked, now)).toBe(false);
    expect(filterBoardTasks([stale, fresh, blocked], {
      query: "",
      priority: "all",
      attention: "stale"
    }, now)).toEqual([stale]);
  });
});

describe("shortTaskId", () => {
  it("keeps short ids and compacts long ids while retaining both ends", () => {
    expect(shortTaskId("task-short")).toBe("task-short");
    expect(shortTaskId("474e0d74-9adf-48f7-b67d-0b4b7892fb38"))
      .toBe("474e0d74…fb38");
  });
});

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-08-18T12:00:00.000Z");

  it("labels fresh updates as just now", () => {
    expect(formatRelativeTime("2026-08-18T11:59:40.000Z", now)).toBe("刚刚");
    expect(formatRelativeTime("2026-08-18T12:00:00.000Z", now)).toBe("刚刚");
  });

  it("labels minutes, hours, and days", () => {
    expect(formatRelativeTime("2026-08-18T11:30:00.000Z", now)).toBe("30 分钟前");
    expect(formatRelativeTime("2026-08-18T09:00:00.000Z", now)).toBe("3 小时前");
    expect(formatRelativeTime("2026-08-16T12:00:00.000Z", now)).toBe("2 天前");
  });

  it("passes through values it cannot parse", () => {
    expect(formatRelativeTime("not-a-date", now)).toBe("not-a-date");
  });
});
