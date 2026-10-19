import { createElement, type PropsWithChildren } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TaskSummary } from "../../../src/storage/progress-store.js";
import {
  TaskDrawer,
  type TaskDrawerDetail
} from "../../../src/web/task-drawer.js";

vi.mock("@leke/components", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@leke/components")>();
  const PortalWrapper = ({ children }: PropsWithChildren) => (
    createElement("div", null, children)
  );
  return {
    ...actual,
    Modal: PortalWrapper,
    ModalBody: PortalWrapper,
    ModalContent: PortalWrapper,
    ModalHeader: PortalWrapper,
    ModalTitle: PortalWrapper
  };
});

const task: TaskSummary = {
  task_id: "task-downstream",
  repository_id: "repo-1",
  owner: "jande",
  title: "Blocked downstream",
  status: "backlog",
  priority: "P1",
  created_at: "2026-08-26T00:00:00.000Z",
  updated_at: "2026-08-26T00:00:00.000Z",
  version: 1
};

const activeDependencyDetail: TaskDrawerDetail = {
  dependencies: [{
    depends_on_task_id: "task-upstream",
    title: "Active upstream",
    status: "in_progress",
    created_at: "2026-08-26T00:00:00.000Z",
    repository_id: "repo-1"
  }],
  dependency_validations: [],
  dependency_validation_gate: {
    dependent_count: 0,
    latest_cycle: null,
    ready_for_acceptance: true
  },
  events: [],
  snapshots: []
};

function renderDrawer(detail: TaskDrawerDetail | null | undefined): string {
  return renderToStaticMarkup(
    <TaskDrawer
      mode="detail"
      task={task}
      canMutate
      detail={detail}
      onClose={vi.fn()}
      onChanged={vi.fn()}
    />
  );
}

describe("TaskDrawer cancellation flow", () => {
  it("keeps cancellation available and shows dependency evidence separately", () => {
    const html = renderDrawer(activeDependencyDetail);

    expect(html).toContain("Active upstream");
    expect(html).not.toContain("等待以下直接上游完成或取消后，才能取消当前任务");
    expect(html).toMatch(/<button[^>]*>取消任务<\/button>/);
  });

  it("keeps cancellation available while dependency details load", () => {
    const html = renderDrawer(undefined);

    expect(html).not.toContain("正在检查直接上游依赖");
    expect(html).toMatch(/<button[^>]*>取消任务<\/button>/);
  });
});

describe("TaskDrawer form controls", () => {
  it("labels an expired-lease recovery event for the owner", () => {
    const html = renderDrawer({
      ...activeDependencyDetail,
      events: [{
        event_id: "event-recovered",
        event_type: "task_lease_recovered",
        payload: { actor: "agent", reason: "expired_lease" },
        created_at: task.updated_at
      }]
    });

    expect(html).toContain("恢复任务租约");
  });

  it("renders compact recovery and upstream repair state as read-only evidence", () => {
    const html = renderDrawer({
      ...activeDependencyDetail,
      recovery: {
        task: { ...task, scopes: [] },
        checkpoint: null,
        active_lease: {
          task_id: task.task_id,
          session_id: "session-upstream",
          acquired_at: task.created_at,
          heartbeat_at: task.created_at,
          expires_at: task.updated_at,
          generation: 4
        },
        lease_session: null,
        latest_snapshot: null,
        evidence_state: "stale",
        pending_decisions: [],
        dependency_validation_gate: activeDependencyDetail.dependency_validation_gate,
        active_repair: null,
        recent_events: [],
        next_action: "rerun verification and checkpoint the current code content"
      },
      dependency_repairs: [{
        repair_id: "repair-1",
        validation_id: "validation-1",
        source_run_id: "run-1",
        ctx_id: null,
        upstream_task_id: task.task_id,
        downstream_task_id: "task-downstream-target",
        cycle: 2,
        status: "pending",
        rejection_reason: "contract mismatch",
        claimed_session_id: null,
        claimed_worktree_path: null,
        claimed_at: null,
        resolved_at: null,
        superseded_at: null,
        created_at: task.created_at,
        updated_at: task.updated_at
      }]
    });

    expect(html).toContain("任务恢复");
    expect(html).toContain("rerun verification");
    expect(html).toContain("generation 4");
    expect(html).toContain("contract mismatch");
    expect(html).toContain("Board 仅展示");
  });

  it("uses the canonical authored select for priority editing", () => {
    const html = renderDrawer(activeDependencyDetail);

    expect(html).toContain('data-slot="select-trigger"');
    expect(html).toContain('aria-label="优先级"');
    expect(html).not.toContain("<select");
  });

  it("offers accept and reject only at the acceptance gate", () => {
    const html = renderToStaticMarkup(
      <TaskDrawer
        mode="detail"
        task={{ ...task, status: "pending_acceptance" }}
        canMutate
        detail={activeDependencyDetail}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />
    );

    expect(html).toMatch(/<button[^>]*>验收通过<\/button>/);
    expect(html).toMatch(/<button[^>]*>驳回<\/button>/);
    expect(html).not.toContain("允许继续");
  });

  it("renders copy controls for the current and downstream task ids", () => {
    const html = renderDrawer({
      ...activeDependencyDetail,
      dependency_validations: [{
        validation_id: "validation-copy-id",
        upstream_task_id: "task-upstream",
        downstream_task_id: "task-downstream-target",
        cycle: 1,
        status: "pending",
        requested_by_actor: "agent",
        requested_by_owner: "agent-owner",
        requested_at: task.created_at,
        request_read_at: null,
        responded_by_owner: null,
        response_reason: null,
        responded_at: null,
        response_read_at: null,
        upstream_owner: "agent-owner",
        upstream_repository_id: "repo-upstream",
        upstream_title: "Active upstream",
        downstream_owner: task.owner,
        downstream_repository_id: task.repository_id,
        downstream_title: "Downstream target",
        validation_spec: {
          schema_version: "dependency-validation.v1",
          upstream_task_id: "task-upstream",
          upstream_task_version: 3,
          upstream_repository_id: "repo-upstream",
          downstream_task_id: "task-downstream-target",
          downstream_repository_id: task.repository_id,
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
    });

    expect(html).toContain('aria-label="复制当前任务 ID"');
    expect(html).toContain('aria-label="复制下游任务 ID"');
    expect(html).toContain('data-copy-id="task-downstream"');
    expect(html).toContain('data-copy-id="task-downstream-target"');
  });

  it("renders dependency validation as read-only", () => {
    const html = renderDrawer({
      ...activeDependencyDetail,
      dependency_validations: [{
        validation_id: "validation-1",
        upstream_task_id: "task-upstream",
        downstream_task_id: task.task_id,
        cycle: 1,
        status: "pending",
        requested_by_actor: "agent",
        requested_by_owner: "agent-owner",
        requested_at: task.created_at,
        request_read_at: null,
        responded_by_owner: null,
        response_reason: null,
        responded_at: null,
        response_read_at: null,
        upstream_owner: "agent-owner",
        upstream_repository_id: "repo-upstream",
        upstream_title: "Active upstream",
        downstream_owner: task.owner,
        downstream_repository_id: task.repository_id,
        downstream_title: task.title,
        validation_spec: {
          schema_version: "dependency-validation.v1",
          upstream_task_id: "task-upstream",
          upstream_task_version: 3,
          upstream_repository_id: "repo-upstream",
          downstream_task_id: task.task_id,
          downstream_repository_id: task.repository_id,
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
        latest_run: {
          run_id: "run-attempt-2",
          validation_id: "validation-1",
          attempt: 2,
          status: "running",
          owner: task.owner,
          session_id: "session-downstream",
          worktree_path: "/tmp/downstream",
          heartbeat_at: task.updated_at,
          expires_at: "2026-08-26T01:00:00.000Z",
          started_at: task.updated_at,
          completed_at: null,
          verification: [{
            command: "npm test",
            outcome: "not_run",
            summary: "running",
            revision: "agent-revision",
            target_revision: "target-revision",
            worktree_path: "/tmp/downstream"
          }],
          progress: { stage: "integration" },
          failure_reason: null,
          error_reason: null,
          operation_id: "op-run-2",
          created_at: task.created_at,
          updated_at: task.updated_at,
          validation_spec: {
            schema_version: "dependency-validation.v1",
            upstream_task_id: "task-upstream",
            upstream_task_version: 3,
            upstream_repository_id: "repo-upstream",
            downstream_task_id: task.task_id,
            downstream_repository_id: task.repository_id,
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
        },
        runs: [{
          run_id: "run-attempt-1",
          validation_id: "validation-1",
          attempt: 1,
          status: "error",
          owner: task.owner,
          session_id: "session-downstream",
          worktree_path: "/tmp/downstream",
          heartbeat_at: task.created_at,
          expires_at: task.created_at,
          started_at: task.created_at,
          completed_at: task.updated_at,
          verification: [{
            command: "npm test",
            outcome: "failed",
            summary: "provider unavailable",
            revision: "agent-revision-1",
            target_revision: "target-revision",
            worktree_path: "/tmp/downstream"
          }],
          progress: { stage: "provider" },
          failure_reason: null,
          error_reason: "provider unavailable",
          operation_id: "op-run-1",
          created_at: task.created_at,
          updated_at: task.updated_at,
          validation_spec: {
            schema_version: "dependency-validation.v1",
            upstream_task_id: "task-upstream",
            upstream_task_version: 3,
            upstream_repository_id: "repo-upstream",
            downstream_task_id: task.task_id,
            downstream_repository_id: task.repository_id,
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
        }, {
          run_id: "run-attempt-2",
          validation_id: "validation-1",
          attempt: 2,
          status: "running",
          owner: task.owner,
          session_id: "session-downstream",
          worktree_path: "/tmp/downstream",
          heartbeat_at: task.updated_at,
          expires_at: "2026-08-26T01:00:00.000Z",
          started_at: task.updated_at,
          completed_at: null,
          verification: [{
            command: "npm test",
            outcome: "not_run",
            summary: "running",
            revision: "agent-revision-2",
            target_revision: "target-revision",
            worktree_path: "/tmp/downstream"
          }],
          progress: { stage: "integration" },
          failure_reason: null,
          error_reason: null,
          operation_id: "op-run-2",
          created_at: task.created_at,
          updated_at: task.updated_at
        }]
      }]
    });

    expect(html).toContain("下游验证记录");
    expect(html).toContain("target-revision");
    expect(html).toContain("provider unavailable");
    expect(html).toContain("run-attempt-1");
    expect(html).toContain("run-attempt-2");
    expect(html).not.toContain("请求下游验证");
  });
});
