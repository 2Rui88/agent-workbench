import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent
} from "react";
import { Badge, Button } from "./ui.js";
import type {
  DependencyValidationActivityItem,
  NotificationItem
} from "./api-client.js";
import { formatRelativeTime, shortTaskId } from "./board-view-model.js";
import { CopyIdButton } from "./copy-id-button.js";

export function notificationsForRepository(
  notifications: readonly NotificationItem[],
  repositoryId: string | null
): NotificationItem[] {
  if (repositoryId === null) {
    return [];
  }
  return notifications.filter((notification) => notification.repository_id === repositoryId);
}

export function unreadNotificationsForRepository(
  notifications: readonly NotificationItem[],
  repositoryId: string | null
): NotificationItem[] {
  return notificationsForRepository(notifications, repositoryId)
    .filter((notification) => notification.read_at === null);
}

export function validationActivitiesForRepository(
  activities: readonly DependencyValidationActivityItem[],
  repositoryId: string | null
): DependencyValidationActivityItem[] {
  if (repositoryId === null) {
    return [];
  }
  return activities.filter((activity) => activity.repository_id === repositoryId);
}

const validationLabels = {
  pending: "待验证",
  passed: "已通过",
  rejected: "已驳回",
  superseded: "已更新"
} as const;

type DependencyActivityEntry =
  | {
      kind: "validation";
      id: string;
      createdAt: string;
      readAt: string | null;
      item: DependencyValidationActivityItem;
    }
  | {
      kind: "notification";
      id: string;
      createdAt: string;
      readAt: string | null;
      item: NotificationItem;
    };

type DependencyActivityTab = "attention" | "read";

export interface DependencyActivityViewState {
  isExpanded: boolean;
  activeTab: DependencyActivityTab;
}

export function reconcileDependencyActivityView(
  current: DependencyActivityViewState,
  previousAttentionIds: readonly string[],
  nextAttentionIds: readonly string[]
): DependencyActivityViewState {
  const previousIds = new Set(previousAttentionIds);
  if (nextAttentionIds.some((id) => !previousIds.has(id))) {
    return { isExpanded: true, activeTab: "attention" };
  }
  if (previousAttentionIds.length > 0 && nextAttentionIds.length === 0) {
    return { ...current, isExpanded: false };
  }
  return current;
}

function byNewest(
  left: DependencyActivityEntry,
  right: DependencyActivityEntry
): number {
  const createdAtOrder = right.createdAt.localeCompare(left.createdAt);
  return createdAtOrder !== 0 ? createdAtOrder : left.id.localeCompare(right.id);
}

function groupDependencyActivities(
  notifications: readonly NotificationItem[],
  validationActivities: readonly DependencyValidationActivityItem[]
): {
  pending: DependencyActivityEntry[];
  unread: DependencyActivityEntry[];
  read: DependencyActivityEntry[];
} {
  const pending = validationActivities
    .filter((activity) => activity.status === "pending"
      || activity.dependency_repair?.status === "pending"
      || activity.dependency_repair?.status === "claimed")
    .map((activity): DependencyActivityEntry => ({
      kind: "validation",
      id: `validation:${activity.validation_id}:${activity.perspective}`,
      createdAt: activity.created_at,
      readAt: activity.read_at,
      item: activity
    }))
    .sort(byNewest);
  const remaining = [
    ...validationActivities
      .filter((activity) => activity.status !== "pending"
        && activity.dependency_repair?.status !== "pending"
        && activity.dependency_repair?.status !== "claimed")
      .map((activity): DependencyActivityEntry => ({
        kind: "validation",
        id: `validation:${activity.validation_id}:${activity.perspective}`,
        createdAt: activity.created_at,
        readAt: activity.read_at,
        item: activity
      })),
    ...notifications.map((notification): DependencyActivityEntry => ({
      kind: "notification",
      id: `notification:${notification.notification_id}`,
      createdAt: notification.created_at,
      readAt: notification.read_at,
      item: notification
    }))
  ];
  return {
    pending,
    unread: remaining.filter((entry) => entry.readAt === null).sort(byNewest),
    read: remaining.filter((entry) => entry.readAt !== null).sort(byNewest)
  };
}

export function DependencyNotifications({
  notifications,
  validationActivities,
  busyActivityId,
  onOpenTask,
  onMarkNotificationRead,
  onMarkValidationRead
}: {
  notifications: readonly NotificationItem[];
  validationActivities: readonly DependencyValidationActivityItem[];
  busyActivityId: string | null;
  onOpenTask: (taskId: string) => void;
  onMarkNotificationRead: (notificationId: string) => void;
  onMarkValidationRead: (activity: DependencyValidationActivityItem) => void;
}) {
  const groups = groupDependencyActivities(notifications, validationActivities);
  const attentionIds = [...groups.pending, ...groups.unread].map((entry) => entry.id);
  const attentionKey = JSON.stringify(attentionIds);
  const [activityView, setActivityView] = useState<DependencyActivityViewState>(() => ({
    isExpanded: attentionIds.length > 0,
    activeTab: "attention"
  }));
  const previousAttentionIds = useRef(attentionIds);
  const contentId = useId();
  const attentionTabId = useId();
  const attentionPanelId = useId();
  const readTabId = useId();
  const readPanelId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const unreadCount = notifications.filter((item) => item.read_at === null).length
    + validationActivities.filter((item) => item.read_at === null).length;
  const totalCount = notifications.length + validationActivities.length;
  const attentionCount = groups.pending.length + groups.unread.length;
  const { activeTab, isExpanded } = activityView;

  useEffect(() => {
    setActivityView((current) => reconcileDependencyActivityView(
      current,
      previousAttentionIds.current,
      attentionIds
    ));
    previousAttentionIds.current = attentionIds;
  }, [attentionKey]);

  if (totalCount === 0) {
    return null;
  }

  function activateTab(tab: DependencyActivityTab, index: number): void {
    setActivityView((current) => ({ ...current, activeTab: tab }));
    tabRefs.current[index]?.focus();
  }

  function handleTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number
  ): void {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % 2;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex + 1) % 2;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = 1;
    }
    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    activateTab(nextIndex === 0 ? "attention" : "read", nextIndex);
  }

  function renderActivity(entry: DependencyActivityEntry) {
    if (entry.kind === "validation") {
      const activity = entry.item;
      const latestRun = activity.latest_run ?? null;
      const runStatus = latestRun?.status ?? null;
      const runStatusLabel = latestRun !== null
        && (runStatus === "running" || runStatus === "claimed")
        ? `执行中（第 ${latestRun?.attempt ?? 1} 次，最近心跳 ${formatRelativeTime(latestRun.heartbeat_at)}）`
        : latestRun !== null && runStatus === "queued"
          ? "排队等待下游 Agent 领取"
          : latestRun !== null && runStatus === "passed"
            ? "验证执行完成"
            : latestRun !== null && runStatus === "cancelled"
              ? "验证运行已取消"
        : latestRun !== null && runStatus === "error"
          ? `执行失败：${latestRun.error_reason ?? latestRun.failure_reason ?? "未知错误"}；可由下游 Agent 重试`
          : latestRun !== null && runStatus === "rejected"
            ? `验证驳回：${latestRun.failure_reason ?? activity.response_reason ?? "未提供原因"}；修正后由 Agent 发起新一轮验证`
            : null;
      const repairStatusLabel = activity.dependency_repair?.status === "pending"
        ? "等待上游 Agent 认领修复"
        : activity.dependency_repair?.status === "claimed"
          ? "上游修复中"
          : activity.dependency_repair?.status === "resolved"
              || activity.dependency_repair?.status === "superseded"
            ? "已重新提交，等待新一轮验证"
            : null;
      const evidenceSummary = activity.status === "passed" && latestRun !== null
        ? latestRun.verification.map((entry) => (
          typeof entry.summary === "string" ? entry.summary : null
        )).filter((summary): summary is string => summary !== null).join("；")
        : null;
      const runs = activity.runs ?? (latestRun === null ? [] : [latestRun]);
      const spec = activity.validation_spec ?? latestRun?.validation_spec;
      return (
        <li
          key={entry.id}
          className={`dependency-notification dependency-notification-validation-${activity.status}${activity.read_at === null ? " is-unread" : " is-read"}`}
        >
          <div className="dependency-notification-main">
            <button
              type="button"
              className="dependency-notification-open"
              aria-label={`打开任务 ${activity.task_title}`}
              onClick={() => {
                onOpenTask(activity.task_id);
                if (activity.read_at === null) {
                  onMarkValidationRead(activity);
                }
              }}
            >
              <Badge
                variant={activity.status === "passed"
                  ? "success"
                  : activity.status === "rejected"
                    ? "destructive"
                    : activity.status === "pending"
                      ? "warning"
                      : "secondary"}
                size="sm"
              >
                {validationLabels[activity.status]}
              </Badge>
              <span className="dependency-notification-text">
                {activity.perspective === "request"
                  ? <>「{activity.upstream_title}」请求「{activity.downstream_title}」验证</>
                  : <>「{activity.downstream_title}」反馈「{activity.upstream_title}」{validationLabels[activity.status]}</>}
                {activity.response_reason !== null && (
                  <span className="dependency-validation-reason">
                    理由：{activity.response_reason}
                  </span>
                )}
                {activity.status === "pending" && activity.perspective === "request" && (
                  <span className="dependency-validation-run-summary">
                    {runStatusLabel ?? "等待下游 Agent 验证"}
                  </span>
                )}
                {runStatusLabel !== null && activity.status !== "pending" && (
                  <span className="dependency-validation-run-summary">{runStatusLabel}</span>
                )}
                {repairStatusLabel !== null && (
                  <span className="dependency-validation-run-summary">{repairStatusLabel}</span>
                )}
                {evidenceSummary !== null && evidenceSummary.length > 0 && (
                  <span className="dependency-validation-run-summary">证据：{evidenceSummary}</span>
                )}
                {spec !== undefined && (
                  <span className="dependency-validation-run-summary">
                    目标 revision：{spec.target_revision}；命令：{spec.command}；范围：{spec.scope.worktree_path}；超时：{spec.timeout_strategy.kind}
                  </span>
                )}
                {runs.map((run) => (
                  <span className="dependency-validation-evidence" key={run.run_id}>
                    第 {run.attempt} 次：{run.status}
                    {run.verification.map((evidence, index) => (
                      <span key={run.run_id + "-evidence-" + index}>
                        {" "}命令 {evidence.command} → {evidence.outcome}：{evidence.summary}
                        {evidence.revision === undefined ? "" : "；revision " + evidence.revision}
                        {evidence.target_revision === undefined ? "" : "；target " + evidence.target_revision}
                        {evidence.worktree_path === undefined ? "" : "；worktree " + evidence.worktree_path}
                      </span>
                    ))}
                    {run.verification.length === 0 && (
                      <span> 证据：暂无</span>
                    )}
                    {run.progress !== undefined && (
                      <span>；进度 {JSON.stringify(run.progress)}</span>
                    )}
                    {(run.error_reason ?? run.failure_reason) !== null && (
                      <span>；原因 {run.error_reason ?? run.failure_reason}</span>
                    )}
                  </span>
                ))}
              </span>
            </button>
            {entry.kind === "validation" && (
              <>
                <span
                  className="dependency-notification-task-id mono"
                  title={activity.downstream_task_id}
                >
                  {shortTaskId(activity.downstream_task_id)}
                </span>
                <CopyIdButton
                  id={activity.downstream_task_id}
                  label="下游任务 ID"
                />
              </>
            )}
            <span className="dependency-notification-time" title={activity.created_at}>
              {formatRelativeTime(activity.created_at)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={busyActivityId !== null || activity.read_at !== null}
              onClick={() => onMarkValidationRead(activity)}
            >
              {busyActivityId === entry.id ? "处理中…" : activity.read_at === null ? "标记已读" : "已读"}
            </Button>
          </div>
        </li>
      );
    }

    const notification = entry.item;
    return (
      <li
        key={entry.id}
        className={`dependency-notification dependency-notification-${notification.upstream_status}${notification.read_at === null ? " is-unread" : " is-read"}`}
      >
        <div className="dependency-notification-main">
          <button
            type="button"
            className="dependency-notification-open"
            aria-label={`打开任务 ${notification.task_title ?? notification.task_id}`}
            onClick={() => {
              onOpenTask(notification.task_id);
              if (notification.read_at === null) {
                onMarkNotificationRead(notification.notification_id);
              }
            }}
          >
            <Badge
              variant={notification.upstream_status === "done" ? "success" : "destructive"}
              size="sm"
            >
              {notification.upstream_status === "done" ? "完成" : "取消"}
            </Badge>
            <span className="dependency-notification-text">
              {notification.task_title !== null
                ? <>「{notification.task_title}」的依赖「{notification.upstream_title}」</>
                : <>「{notification.upstream_title}」</>}
              已{notification.upstream_status === "done" ? "完成" : "取消"}
            </span>
          </button>
          <span className="dependency-notification-time" title={notification.created_at}>
            {formatRelativeTime(notification.created_at)}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={busyActivityId !== null || notification.read_at !== null}
            onClick={() => onMarkNotificationRead(notification.notification_id)}
          >
            {busyActivityId === entry.id ? "处理中…" : notification.read_at === null ? "标记已读" : "已读"}
          </Button>
        </div>
      </li>
    );
  }

  return (
    <section
      className={`board-notifications${isExpanded ? "" : " is-collapsed"}`}
      aria-label="当前仓库依赖动态"
    >
      <header className="dependency-notification-header">
        <button
          type="button"
          className="dependency-notification-toggle"
          aria-expanded={isExpanded}
          aria-controls={contentId}
          aria-label={isExpanded ? "折叠依赖动态" : "展开依赖动态"}
          onClick={() => setActivityView((current) => ({
            ...current,
            isExpanded: !current.isExpanded
          }))}
        >
          <span>依赖动态</span>
          {unreadCount > 0 && <Badge variant="error" size="sm">{unreadCount} 未读</Badge>}
          <span className="dependency-notification-total">共 {totalCount} 条</span>
          <svg
            className={`dependency-notification-chevron${isExpanded ? " is-expanded" : ""}`}
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
      </header>
      <div id={contentId} hidden={!isExpanded}>
        <div
          className="dependency-notification-tabs"
          role="tablist"
          aria-label="依赖动态分类"
        >
          <button
            ref={(element) => {
              tabRefs.current[0] = element;
            }}
            type="button"
            id={attentionTabId}
            role="tab"
            aria-controls={attentionPanelId}
            aria-selected={activeTab === "attention"}
            tabIndex={activeTab === "attention" ? 0 : -1}
            onClick={() => activateTab("attention", 0)}
            onKeyDown={(event) => handleTabKeyDown(event, 0)}
          >
            待处理 {attentionCount}
          </button>
          <button
            ref={(element) => {
              tabRefs.current[1] = element;
            }}
            type="button"
            id={readTabId}
            role="tab"
            aria-controls={readPanelId}
            aria-selected={activeTab === "read"}
            tabIndex={activeTab === "read" ? 0 : -1}
            onClick={() => activateTab("read", 1)}
            onKeyDown={(event) => handleTabKeyDown(event, 1)}
          >
            已读 {groups.read.length}
          </button>
        </div>
        <ul
          id={attentionPanelId}
          role="tabpanel"
          aria-label="待处理依赖动态"
          aria-labelledby={attentionTabId}
          className="dependency-notification-list"
          hidden={!isExpanded || activeTab !== "attention"}
        >
          {groups.pending.length > 0 && (
            <li className="dependency-notification-group-label">
              待验证 {groups.pending.length}
            </li>
          )}
          {groups.pending.map(renderActivity)}
          {groups.unread.length > 0 && (
            <li className="dependency-notification-group-label">
              未读 {groups.unread.length}
            </li>
          )}
          {groups.unread.map(renderActivity)}
          {attentionCount === 0 && (
            <li className="dependency-notification-empty">暂无待处理动态。</li>
          )}
        </ul>
        <ul
          id={readPanelId}
          role="tabpanel"
          aria-label="已读依赖动态"
          aria-labelledby={readTabId}
          className="dependency-notification-list"
          hidden={!isExpanded || activeTab !== "read"}
        >
          {groups.read.map(renderActivity)}
          {groups.read.length === 0 && (
            <li className="dependency-notification-empty">暂无已读动态。</li>
          )}
        </ul>
      </div>
    </section>
  );
}
