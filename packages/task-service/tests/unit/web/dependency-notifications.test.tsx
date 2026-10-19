import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  DependencyValidationActivityItem,
  NotificationItem
} from "../../../src/web/api-client.js";
import {
  DependencyNotifications,
  notificationsForRepository,
  reconcileDependencyActivityView,
  unreadNotificationsForRepository,
  validationActivitiesForRepository
} from "../../../src/web/dependency-notifications.js";

const notifications: NotificationItem[] = [
  {
    notification_id: "notification-done",
    owner: "jande",
    task_id: "task-repo-one",
    repository_id: "repo-1",
    upstream_task_id: "upstream-done",
    upstream_title: "接口实现",
    upstream_status: "done",
    read_at: null,
    created_at: "2026-08-24T01:00:00.000Z",
    task_title: "前端联调"
  },
  {
    notification_id: "notification-read",
    owner: "jande",
    task_id: "task-read",
    repository_id: "repo-1",
    upstream_task_id: "upstream-read",
    upstream_title: "已处理依赖",
    upstream_status: "done",
    read_at: "2026-08-24T02:00:00.000Z",
    created_at: "2026-08-24T01:30:00.000Z",
    task_title: "已处理任务"
  },
  {
    notification_id: "notification-cancelled",
    owner: "jande",
    task_id: "task-repo-two",
    repository_id: "repo-2",
    upstream_task_id: "upstream-cancelled",
    upstream_title: "废弃方案",
    upstream_status: "cancelled",
    read_at: null,
    created_at: "2026-08-24T02:30:00.000Z",
    task_title: "替代实现"
  }
];

const validationActivity: DependencyValidationActivityItem = {
  validation_id: "validation-1",
  upstream_task_id: "upstream-validation",
  downstream_task_id: "task-repo-one",
  cycle: 1,
  status: "pending",
  requested_by_actor: "agent",
  requested_by_owner: "upstream-owner",
  requested_at: "2026-08-24T03:00:00.000Z",
  request_read_at: null,
  responded_by_owner: null,
  response_reason: null,
  responded_at: null,
  response_read_at: null,
  upstream_owner: "upstream-owner",
  upstream_repository_id: "repo-upstream",
  upstream_title: "后端接口",
  downstream_owner: "jande",
  downstream_repository_id: "repo-1",
  downstream_title: "前端联调",
  perspective: "request",
  repository_id: "repo-1",
  task_id: "task-repo-one",
  task_title: "前端联调",
  read_at: null,
  created_at: "2026-08-24T03:00:00.000Z",
  validation_spec: {
    schema_version: "dependency-validation.v1",
    upstream_task_id: "upstream-validation",
    upstream_task_version: 2,
    upstream_repository_id: "repo-upstream",
    downstream_task_id: "task-repo-one",
    downstream_repository_id: "repo-1",
    cycle: 1,
    target_revision: "target-revision",
    target_head_commit: "target-head",
    scope: {
      worktree_path: "/tmp/downstream",
      changed_files: ["src/feature.ts"],
      module_paths: ["src"]
    },
    command: "npm test",
    commands: ["npm test"],
    timeout_strategy: {
      kind: "rolling_lease",
      lease_ttl_ms: 1_800_000,
      max_attempts: 2
    }
  },
  runs: [{
    run_id: "run-notification-1",
    validation_id: "validation-1",
    attempt: 1,
    status: "error",
    owner: "jande",
    session_id: "session-downstream",
    worktree_path: "/tmp/downstream",
    heartbeat_at: "2026-08-24T03:00:00.000Z",
    expires_at: "2026-08-24T03:00:00.000Z",
    started_at: "2026-08-24T03:00:00.000Z",
    completed_at: "2026-08-24T03:01:00.000Z",
    verification: [{
      command: "npm test",
      outcome: "failed",
      summary: "provider unavailable",
      revision: "agent-revision",
      target_revision: "target-revision",
      worktree_path: "/tmp/downstream"
    }],
    progress: { stage: "provider" },
    failure_reason: null,
    error_reason: "provider unavailable",
    operation_id: "op-notification-1",
    created_at: "2026-08-24T03:00:00.000Z",
    updated_at: "2026-08-24T03:01:00.000Z",
    validation_spec: {
      schema_version: "dependency-validation.v1",
      upstream_task_id: "upstream-validation",
      upstream_task_version: 2,
      upstream_repository_id: "repo-upstream",
      downstream_task_id: "task-repo-one",
      downstream_repository_id: "repo-1",
      cycle: 1,
      target_revision: "target-revision",
      target_head_commit: "target-head",
      scope: {
        worktree_path: "/tmp/downstream",
        changed_files: ["src/feature.ts"],
        module_paths: ["src"]
      },
      command: "npm test",
      commands: ["npm test"],
      timeout_strategy: {
        kind: "rolling_lease",
        lease_ttl_ms: 1_800_000,
        max_attempts: 2
      }
    }
  }]
};

describe("DependencyNotifications", () => {
  it("keeps only unread notifications for the active repository", () => {
    expect(unreadNotificationsForRepository(notifications, "repo-1")).toEqual([
      notifications[0]
    ]);
    expect(unreadNotificationsForRepository(notifications, null)).toEqual([]);
    expect(notificationsForRepository(notifications, "repo-1")).toEqual([
      notifications[0],
      notifications[1]
    ]);
    expect(validationActivitiesForRepository([validationActivity], "repo-1")).toEqual([
      validationActivity
    ]);
  });

  it("keeps read history and renders dependency validation as read-only", () => {
    const html = renderToStaticMarkup(
      <DependencyNotifications
        notifications={[notifications[0]!, notifications[1]!, notifications[2]!]}
        validationActivities={[validationActivity]}
        busyActivityId="notification:notification-cancelled"
        onOpenTask={vi.fn()}
        onMarkNotificationRead={vi.fn()}
        onMarkValidationRead={vi.fn()}
      />
    );

    expect(html).toContain("当前仓库依赖动态");
    expect(html).toContain('aria-label="折叠依赖动态"');
    expect(html).toContain('aria-expanded="true"');
    const controlledListId = html.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controlledListId).toBeDefined();
    expect(html).toContain(`id="${controlledListId}"`);
    expect(html).toMatch(
      /aria-label="待处理依赖动态"[^>]*class="dependency-notification-list">/
    );
    expect(html).toMatch(
      /aria-label="已读依赖动态"[^>]*class="dependency-notification-list" hidden=""/
    );
    const headerToggleStart = html.indexOf('aria-label="折叠依赖动态"');
    const headerToggleEnd = html.indexOf("</button>", headerToggleStart);
    expect(html.indexOf("3 未读")).toBeGreaterThan(headerToggleStart);
    expect(html.indexOf("3 未读")).toBeLessThan(headerToggleEnd);
    expect(html.indexOf("共 4 条")).toBeGreaterThan(headerToggleStart);
    expect(html.indexOf("共 4 条")).toBeLessThan(headerToggleEnd);
    expect(html).toContain("3 未读");
    expect(html).toContain("共 4 条");
    expect(html).toContain("前端联调");
    expect(html).toContain("替代实现");
    expect(html).toContain("打开任务 前端联调");
    expect(html).toContain("处理中…");
    expect(html).toContain("dependency-notification-cancelled");
    expect(html).toContain("待验证");
    expect(html).toContain("等待下游 Agent 验证");
    expect(html).toContain('aria-label="复制下游任务 ID"');
    expect(html).toContain('data-copy-id="task-repo-one"');
    expect(html).toContain("target-revision");
    expect(html).toContain("provider unavailable");
    expect(html).toContain("第 1 次：error");
    expect(html).toContain("agent-revision");
    expect(html).not.toContain("验证通过");
    expect(html).not.toContain("驳回理由（驳回时必填）");
    expect(html).toContain("dependency-notification-validation-pending");
    expect(html).toContain("is-read");
  });

  it("defaults to collapsed when only read history remains", () => {
    const html = renderToStaticMarkup(
      <DependencyNotifications
        notifications={[notifications[1]!]}
        validationActivities={[]}
        busyActivityId={null}
        onOpenTask={vi.fn()}
        onMarkNotificationRead={vi.fn()}
        onMarkValidationRead={vi.fn()}
      />
    );

    expect(html).toContain('aria-label="展开依赖动态"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/id="[^"]+" hidden=""/);
  });

  it("keeps rejected repair work in attention and distinguishes claim state", () => {
    const rejected: DependencyValidationActivityItem = {
      ...validationActivity,
      status: "rejected",
      perspective: "response",
      response_reason: "contract mismatch",
      read_at: "2026-08-24T04:00:00.000Z",
      dependency_repair: {
        repair_id: "repair-1",
        validation_id: validationActivity.validation_id,
        source_run_id: "run-notification-1",
        ctx_id: null,
        upstream_task_id: validationActivity.upstream_task_id,
        downstream_task_id: validationActivity.downstream_task_id,
        cycle: 1,
        status: "claimed",
        rejection_reason: "contract mismatch",
        claimed_session_id: "session-upstream",
        claimed_worktree_path: "/tmp/upstream",
        claimed_at: "2026-08-24T04:00:00.000Z",
        resolved_at: null,
        superseded_at: null,
        created_at: "2026-08-24T04:00:00.000Z",
        updated_at: "2026-08-24T04:00:00.000Z"
      }
    };
    const html = renderToStaticMarkup(
      <DependencyNotifications
        notifications={[]}
        validationActivities={[rejected]}
        busyActivityId={null}
        onOpenTask={vi.fn()}
        onMarkNotificationRead={vi.fn()}
        onMarkValidationRead={vi.fn()}
      />
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("上游修复中");
    expect(html).toContain("contract mismatch");
  });

  it("reopens only for a genuinely new attention item", () => {
    expect(reconcileDependencyActivityView(
      { isExpanded: false, activeTab: "read" },
      ["validation:one:request"],
      ["validation:one:request"]
    )).toEqual({ isExpanded: false, activeTab: "read" });

    expect(reconcileDependencyActivityView(
      { isExpanded: false, activeTab: "read" },
      ["validation:one:request"],
      ["validation:one:request", "notification:two"]
    )).toEqual({ isExpanded: true, activeTab: "attention" });
  });

  it("collapses when attention clears and preserves manual read-history disclosure", () => {
    expect(reconcileDependencyActivityView(
      { isExpanded: true, activeTab: "attention" },
      ["validation:one:request"],
      []
    )).toEqual({ isExpanded: false, activeTab: "attention" });

    expect(reconcileDependencyActivityView(
      { isExpanded: true, activeTab: "read" },
      [],
      []
    )).toEqual({ isExpanded: true, activeTab: "read" });
  });

  it("pins pending validations, then merges unread activity, and archives read items", () => {
    const pendingRead: DependencyValidationActivityItem = {
      ...validationActivity,
      validation_id: "validation-pending-read",
      downstream_title: "已查看但待验证",
      task_title: "已查看但待验证",
      request_read_at: "2026-08-24T00:40:00.000Z",
      read_at: "2026-08-24T00:40:00.000Z",
      created_at: "2026-08-24T00:30:00.000Z"
    };
    const unreadValidation: DependencyValidationActivityItem = {
      ...validationActivity,
      validation_id: "validation-unread-passed",
      status: "passed",
      downstream_title: "较新的未读验证",
      task_title: "较新的未读验证",
      responded_by_owner: "jande",
      responded_at: "2026-08-24T04:00:00.000Z",
      created_at: "2026-08-24T04:00:00.000Z"
    };
    const readValidation: DependencyValidationActivityItem = {
      ...unreadValidation,
      validation_id: "validation-read-passed",
      downstream_title: "较早的已读验证",
      task_title: "较早的已读验证",
      request_read_at: "2026-08-24T05:10:00.000Z",
      read_at: "2026-08-24T05:10:00.000Z",
      created_at: "2026-08-24T05:00:00.000Z"
    };
    const unreadNotification: NotificationItem = {
      ...notifications[0]!,
      notification_id: "notification-unread-older",
      task_title: "较早的未读提醒",
      created_at: "2026-08-24T03:00:00.000Z"
    };
    const readNotification: NotificationItem = {
      ...notifications[1]!,
      notification_id: "notification-read-newer",
      task_title: "较新的已读提醒",
      read_at: "2026-08-24T06:10:00.000Z",
      created_at: "2026-08-24T06:00:00.000Z"
    };

    const html = renderToStaticMarkup(
      <DependencyNotifications
        notifications={[unreadNotification, readNotification]}
        validationActivities={[unreadValidation, readValidation, pendingRead]}
        busyActivityId={null}
        onOpenTask={vi.fn()}
        onMarkNotificationRead={vi.fn()}
        onMarkValidationRead={vi.fn()}
        onRespondValidation={vi.fn()}
      />
    );

    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="待处理依赖动态"');
    expect(html).toContain('aria-label="已读依赖动态"');
    const pendingPanelStart = html.indexOf('aria-label="待处理依赖动态"');
    const readPanelStart = html.indexOf('aria-label="已读依赖动态"');
    expect(pendingPanelStart).toBeGreaterThan(-1);
    expect(readPanelStart).toBeGreaterThan(pendingPanelStart);
    const pendingPanel = html.slice(pendingPanelStart, readPanelStart);
    const readPanel = html.slice(readPanelStart);

    expect(pendingPanel).toContain("待验证 1");
    expect(pendingPanel).toContain("未读 2");
    expect(pendingPanel.indexOf("已查看但待验证"))
      .toBeLessThan(pendingPanel.indexOf("较新的未读验证"));
    expect(pendingPanel.indexOf("较新的未读验证"))
      .toBeLessThan(pendingPanel.indexOf("较早的未读提醒"));
    expect(readPanel).not.toContain("已查看但待验证");
    expect(readPanel.indexOf("较新的已读提醒"))
      .toBeLessThan(readPanel.indexOf("较早的已读验证"));
  });
});
