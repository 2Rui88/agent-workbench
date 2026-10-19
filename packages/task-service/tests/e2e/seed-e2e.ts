/// <reference types="node" />

import { realpathSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { createRuntimeConfig } from "../../src/config/runtime-config.js";
import { SqliteDatabase } from "../../src/storage/database.js";
import type { JsonValue, ProgressStore } from "../../src/storage/progress-store.js";

/**
 * Seeds the isolated E2E database for the board smoke flow:
 *  - two project/repository pairs for dashboard and repository switching,
 *  - one active owned session for temporary Board pairing,
 *  - one unread terminal dependency notification per repository,
 *  - pending/running, passed, and rejected dependency-validation history;
 *    the running request retains an error attempt followed by a retry,
 *    while passed/rejected runs provide terminal evidence for read-only labels,
 *  - one session/task/lease trio whose last activity is 31 minutes old
 *    (the stale-session case the smoke script releases through the drawer),
 *  - one backlog task so the board renders initial content.
 *
 * Only writes when TASK_MCP_DATA_DIR (after realpath) starts with
 * /private/tmp/cli-session-task-mcp-e2e. — anything else is refused.
 */

const allowedPrefix = "/private/tmp/cli-session-task-mcp-e2e.";
const staleAgoMs = 31 * 60 * 1000;
const boardOwner = process.env.E2E_BOARD_OWNER?.trim() || "jande";

function isoAgo(now: Date, millisecondsAgo: number): string {
  return new Date(now.getTime() - millisecondsAgo).toISOString();
}

function validationSpec(
  upstreamTaskId: string,
  upstreamRepositoryId: string,
  downstreamTaskId: string,
  downstreamRepositoryId: string,
  cycle: number,
  worktreePath: string,
  targetRevision: string,
  command = "npm test"
): JsonValue {
  return {
    schema_version: "dependency-validation.v1",
    upstream_task_id: upstreamTaskId,
    upstream_task_version: 0,
    upstream_repository_id: upstreamRepositoryId,
    downstream_task_id: downstreamTaskId,
    downstream_repository_id: downstreamRepositoryId,
    cycle,
    target_revision: targetRevision,
    target_head_commit: targetRevision,
    scope: {
      worktree_path: worktreePath,
      changed_files: ["src/dependency-validation.ts"],
      module_paths: ["src"]
    },
    command,
    commands: [command],
    timeout_strategy: {
      kind: "rolling_lease",
      lease_ttl_ms: 1_800_000,
      max_attempts: 2
    }
  };
}

function main(): void {
  const rawDir = process.env.TASK_MCP_DATA_DIR;
  if (rawDir === undefined || rawDir.trim().length === 0) {
    console.error("seed-e2e: TASK_MCP_DATA_DIR is required.");
    process.exit(1);
  }
  let dataDir: string;
  try {
    dataDir = realpathSync(rawDir);
  } catch {
    console.error(
      `seed-e2e: TASK_MCP_DATA_DIR does not exist: ${rawDir}. `
      + `Create it with mktemp -d /private/tmp/cli-session-task-mcp-e2e.XXXXXX first.`
    );
    process.exit(1);
  }
  if (!dataDir.startsWith(allowedPrefix)) {
    console.error(
      `seed-e2e: refusing to write outside the isolated E2E data directory; `
      + `TASK_MCP_DATA_DIR must resolve under ${allowedPrefix} (got ${dataDir}).`
    );
    process.exit(1);
  }

  const now = new Date();
  const staleTime = isoAgo(now, staleAgoMs);
  const config = createRuntimeConfig(dataDir);
  const database = SqliteDatabase.open(config);
  const store: ProgressStore = database.createProgressStore();

  store.transaction((tx) => {
    tx.upsertProject({
      project_id: "project-e2e",
      name: "E2E Project",
      created_at: staleTime,
      updated_at: staleTime
    });
    tx.upsertRepository({
      repository_id: "repo-e2e",
      project_id: "project-e2e",
      path: join(dataDir, "repo"),
      label: "E2E Repository",
      created_at: staleTime,
      updated_at: staleTime
    });

    tx.upsertProject({
      project_id: "project-e2e-2",
      name: "E2E Second Project",
      created_at: staleTime,
      updated_at: staleTime
    });
    tx.upsertRepository({
      repository_id: "repo-e2e-2",
      project_id: "project-e2e-2",
      path: join(dataDir, "repo-2"),
      label: "Second Repo",
      created_at: staleTime,
      updated_at: staleTime
    });
    tx.insertTask({
      task_id: "task-e2e-second-project",
      repository_id: "repo-e2e-2",
      owner: boardOwner,
      title: "第二项目任务",
      status: "backlog",
      priority: "P2",
      goal: "多项目切换验证",
      acceptance_criteria: ["出现在所属仓库"],
      checkpoint: {
        completed_items: ["完成首轮实现"],
        current_state: "下游验证驳回，等待修复",
        human_context: [],
        confirmed_decisions: [],
        pending_decisions: [],
        blockers: [],
        attempts: [{
          attempt_id: "e2e-attempt-legacy-contract",
          summary: "沿用旧合同导致下游验证失败",
          outcome: "failed",
          evidence_refs: ["validation-e2e-rejected"],
          recorded_at: staleTime
        }],
        verification: [{
          command: "npm test",
          outcome: "passed",
          summary: "旧 revision 上通过",
          code_fingerprint: {
            head_commit: "e2e-second-head-2",
            worktree_path: join(dataDir, "repo-2", "worktrees", "feature"),
            content_digest: `sha256:${"a".repeat(64)}`,
            captured_at: staleTime,
            provenance: "server_verified"
          }
        }],
        next_action: "认领下游驳回并修复合同"
      },
      created_at: staleTime,
      updated_at: staleTime
    });
    tx.insertSession({
      session_id: "session-e2e-stale",
      repository_id: "repo-e2e",
      label: "E2E stale session",
      started_at: staleTime,
      transport_session_id: "transport-e2e-stale",
      client_name: "codex-cli",
      client_version: "0.147.0",
      client_family: "codex",
      protocol_version: "2025-06-18",
      workspace_path: join(dataDir, "repo"),
      worktree_path: join(dataDir, "repo", "worktrees", "e2e"),
      last_activity_at: staleTime
    });
    tx.insertSession({
      session_id: "session-e2e-board",
      repository_id: "repo-e2e",
      label: "E2E Board pairing session",
      started_at: now.toISOString(),
      transport_session_id: "transport-e2e-board",
      client_name: "codex-cli",
      client_version: "0.147.0",
      client_family: "codex",
      protocol_version: "2025-06-18",
      workspace_path: join(dataDir, "repo"),
      worktree_path: join(dataDir, "repo", "worktrees", "board"),
      last_activity_at: now.toISOString(),
      owner: boardOwner
    });

    tx.insertTask({
      task_id: "task-e2e-stale",
      repository_id: "repo-e2e",
      session_id: "session-e2e-stale",
      owner: boardOwner,
      title: "E2E 失联任务",
      status: "in_progress",
      priority: "P1",
      goal: "供人工释放 stale Session 的验收任务",
      acceptance_criteria: ["释放 Session 后租约消失"],
      checkpoint: {
        completed_items: ["已开始"],
        current_state: "31 分钟未活动",
        human_context: [],
        confirmed_decisions: [],
        pending_decisions: [],
        blockers: [],
        verification: [],
        next_action: "等待人工释放"
      },
      created_at: staleTime,
      updated_at: staleTime
    });
    tx.putLease({
      task_id: "task-e2e-stale",
      session_id: "session-e2e-stale",
      acquired_at: staleTime,
      heartbeat_at: staleTime,
      expires_at: new Date(now.getTime() + staleAgoMs).toISOString()
    });

    tx.insertTask({
      task_id: "task-e2e-smoke-create",
      repository_id: "repo-e2e",
      owner: boardOwner,
      title: "冒烟新建任务",
      status: "backlog",
      priority: "P1",
      goal: "由 CLI 流程创建的冒烟任务",
      acceptance_criteria: ["出现在待执行列"],
      checkpoint: {
        completed_items: [],
        current_state: "等待开始",
        human_context: [],
        confirmed_decisions: [],
        pending_decisions: [],
        blockers: [],
        verification: [],
        next_action: "等待开始"
      },
      created_at: staleTime,
      updated_at: staleTime
    });
    tx.insertTask({
      task_id: "task-e2e-legacy-paused",
      repository_id: "repo-e2e",
      owner: boardOwner,
      title: "存量导入-已暂停",
      status: "paused",
      priority: "P2",
      goal: "验证存量接管（已暂停）",
      acceptance_criteria: ["出现在待执行列"],
      checkpoint: {
        completed_items: ["迁移前的工作"],
        current_state: "迁移前挂起",
        human_context: [],
        confirmed_decisions: [],
        pending_decisions: [],
        blockers: [],
        verification: [],
        next_action: "恢复执行",
        source: {
          source_type: "legacy_adoption",
          source_session_label: "旧 CLI 会话",
          adoption_method: "mcp",
          adopted_at: staleTime
        }
      },
      created_at: staleTime,
      updated_at: staleTime
    });
    tx.insertTask({
      task_id: "task-e2e-legacy-acceptance",
      repository_id: "repo-e2e",
      owner: boardOwner,
      title: "存量导入-待验收",
      status: "pending_acceptance",
      priority: "P1",
      goal: "验证人工验收",
      acceptance_criteria: ["验收后进入已结束"],
      checkpoint: {
        completed_items: ["全部完成"],
        current_state: "等待验收",
        human_context: [],
        confirmed_decisions: [],
        pending_decisions: [],
        blockers: [],
        verification: [{
          command: "npm test",
          outcome: "passed",
          summary: "全部通过"
        }],
        next_action: "人工验收",
        source: {
          source_type: "legacy_adoption",
          source_session_label: "旧 CLI 会话",
          adoption_method: "mcp",
          adopted_at: staleTime
        }
      },
      created_at: staleTime,
      updated_at: staleTime
    });
    tx.insertTask({
      task_id: "task-e2e-backlog",
      repository_id: "repo-e2e",
      owner: boardOwner,
      title: "E2E 初始待执行任务",
      status: "backlog",
      priority: "P2",
      goal: "看板初始内容",
      acceptance_criteria: ["出现在待执行列"],
      checkpoint: {
        completed_items: [],
        current_state: "尚未开始",
        human_context: [],
        confirmed_decisions: [],
        pending_decisions: [],
        blockers: [],
        verification: [],
        next_action: "等待开始"
      },
      created_at: staleTime,
      updated_at: staleTime
    });
    tx.insertTask({
      task_id: "task-e2e-waiting-decision",
      repository_id: "repo-e2e",
      owner: boardOwner,
      title: "E2E 待对话确认任务",
      status: "waiting_human",
      priority: "P1",
      goal: "验证看板只读展示待决定内容",
      acceptance_criteria: ["决定只能在 Agent 对话中确认"],
      checkpoint: {
        completed_items: ["已提出问题"],
        current_state: "等待用户在 Agent 对话中确认",
        human_context: [],
        confirmed_decisions: [],
        pending_decisions: ["是否使用 SQLite？"],
        blockers: [],
        verification: [],
        next_action: "在 Agent 对话中核对确认"
      },
      created_at: staleTime,
      updated_at: staleTime
    });
    tx.insertNotification({
      notification_id: "notification-e2e-main",
      owner: boardOwner,
      task_id: "task-e2e-smoke-create",
      repository_id: "repo-e2e",
      upstream_task_id: "task-e2e-legacy-acceptance",
      upstream_title: "上游验收任务",
      upstream_status: "done",
      read_at: null,
      created_at: now.toISOString(),
      task_title: "冒烟新建任务"
    });
    tx.insertNotification({
      notification_id: "notification-e2e-second",
      owner: boardOwner,
      task_id: "task-e2e-second-project",
      repository_id: "repo-e2e-2",
      upstream_task_id: "task-e2e-stale",
      upstream_title: "跨仓库上游任务",
      upstream_status: "cancelled",
      read_at: null,
      created_at: now.toISOString(),
      task_title: "第二项目任务"
    });
    tx.insertTaskDependency({
      task_id: "task-e2e-smoke-create",
      depends_on_task_id: "task-e2e-second-project",
      created_at: now.toISOString()
    });
    tx.insertTaskDependency({
      task_id: "task-e2e-smoke-create",
      depends_on_task_id: "task-e2e-legacy-acceptance",
      created_at: now.toISOString()
    });
    tx.insertDependencyValidation({
      validation_id: "validation-e2e-main",
      upstream_task_id: "task-e2e-second-project",
      downstream_task_id: "task-e2e-smoke-create",
      cycle: 1,
      status: "pending",
      requested_by_actor: "agent",
      requested_by_owner: boardOwner,
      requested_at: now.toISOString(),
      request_read_at: null,
      responded_by_owner: null,
      response_reason: null,
      responded_at: null,
      response_read_at: null,
      validation_spec: validationSpec(
        "task-e2e-second-project",
        "repo-e2e-2",
        "task-e2e-smoke-create",
        "repo-e2e",
        1,
        join(dataDir, "repo", "worktrees", "board"),
        "e2e-second-head-1"
      )
    });
    tx.insertDependencyValidation({
      validation_id: "validation-e2e-acceptance-layout",
      upstream_task_id: "task-e2e-legacy-acceptance",
      downstream_task_id: "task-e2e-smoke-create",
      cycle: 1,
      status: "passed",
      requested_by_actor: "agent",
      requested_by_owner: boardOwner,
      requested_at: now.toISOString(),
      request_read_at: now.toISOString(),
      responded_by_owner: boardOwner,
      response_reason: "E2E 下游验证通过",
      responded_at: now.toISOString(),
      response_read_at: now.toISOString(),
      validation_spec: validationSpec(
        "task-e2e-legacy-acceptance",
        "repo-e2e",
        "task-e2e-smoke-create",
        "repo-e2e",
        1,
        join(dataDir, "repo", "worktrees", "board"),
        "e2e-acceptance-head-1"
      )
    });
    tx.insertDependencyValidation({
      validation_id: "validation-e2e-rejected",
      upstream_task_id: "task-e2e-second-project",
      downstream_task_id: "task-e2e-smoke-create",
      cycle: 2,
      status: "rejected",
      requested_by_actor: "agent",
      requested_by_owner: boardOwner,
      requested_at: new Date(now.getTime() - 60_000).toISOString(),
      request_read_at: new Date(now.getTime() - 60_000).toISOString(),
      responded_by_owner: boardOwner,
      response_reason: "验证证据不完整",
      responded_at: new Date(now.getTime() - 30_000).toISOString(),
      response_read_at: now.toISOString(),
      validation_spec: validationSpec(
        "task-e2e-second-project",
        "repo-e2e-2",
        "task-e2e-smoke-create",
        "repo-e2e",
        2,
        join(dataDir, "repo", "worktrees", "board"),
        "e2e-second-head-2"
      )
    });
    tx.insertDependencyValidationRun({
      run_id: "run-e2e-main-error",
      validation_id: "validation-e2e-main",
      attempt: 1,
      status: "error",
      owner: boardOwner,
      session_id: "session-e2e-board",
      worktree_path: join(dataDir, "repo", "worktrees", "board"),
      heartbeat_at: new Date(now.getTime() - 120_000).toISOString(),
      expires_at: new Date(now.getTime() - 60_000).toISOString(),
      started_at: new Date(now.getTime() - 120_000).toISOString(),
      completed_at: new Date(now.getTime() - 90_000).toISOString(),
      verification: [],
      progress: { step: "provider" },
      failure_reason: null,
      error_reason: "暂时无法连接下游环境",
      operation_id: "op-e2e-main-error",
      created_at: new Date(now.getTime() - 120_000).toISOString(),
      updated_at: new Date(now.getTime() - 90_000).toISOString()
    });
    tx.insertDependencyValidationRun({
      run_id: "run-e2e-main-running",
      validation_id: "validation-e2e-main",
      attempt: 2,
      status: "running",
      owner: boardOwner,
      session_id: "session-e2e-board",
      worktree_path: join(dataDir, "repo", "worktrees", "board"),
      heartbeat_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 10 * 60_000).toISOString(),
      started_at: new Date(now.getTime() - 30_000).toISOString(),
      completed_at: null,
      verification: [{ command: "npm test", outcome: "not_run", summary: "正在执行" }],
      progress: { step: "integration", completed: 1 },
      failure_reason: null,
      error_reason: null,
      operation_id: "op-e2e-main-running",
      created_at: new Date(now.getTime() - 30_000).toISOString(),
      updated_at: now.toISOString()
    });
    tx.insertDependencyValidationRun({
      run_id: "run-e2e-passed",
      validation_id: "validation-e2e-acceptance-layout",
      attempt: 1,
      status: "passed",
      owner: boardOwner,
      session_id: "session-e2e-board",
      worktree_path: join(dataDir, "repo", "worktrees", "board"),
      heartbeat_at: now.toISOString(),
      expires_at: now.toISOString(),
      started_at: new Date(now.getTime() - 90_000).toISOString(),
      completed_at: now.toISOString(),
      verification: [{ command: "npm test", outcome: "passed", summary: "全部通过" }],
      progress: { step: "complete" },
      failure_reason: null,
      error_reason: null,
      operation_id: "op-e2e-passed",
      created_at: new Date(now.getTime() - 90_000).toISOString(),
      updated_at: now.toISOString()
    });
    tx.insertDependencyValidationRun({
      run_id: "run-e2e-rejected",
      validation_id: "validation-e2e-rejected",
      attempt: 1,
      status: "rejected",
      owner: boardOwner,
      session_id: "session-e2e-board",
      worktree_path: join(dataDir, "repo", "worktrees", "board"),
      heartbeat_at: new Date(now.getTime() - 30_000).toISOString(),
      expires_at: new Date(now.getTime() - 30_000).toISOString(),
      started_at: new Date(now.getTime() - 90_000).toISOString(),
      completed_at: new Date(now.getTime() - 30_000).toISOString(),
      verification: [{
        command: "npm test -- validation",
        outcome: "failed",
        summary: "验证证据不完整",
        revision: "e2e-agent-revision",
        target_revision: "e2e-second-head-2",
        worktree_path: join(dataDir, "repo", "worktrees", "board")
      }],
      progress: { step: "review" },
      failure_reason: "验证证据不完整",
      error_reason: null,
      operation_id: "op-e2e-rejected",
      created_at: new Date(now.getTime() - 90_000).toISOString(),
      updated_at: new Date(now.getTime() - 30_000).toISOString()
    });
    tx.insertDependencyRepairRequest({
      repair_id: "repair-e2e-rejected",
      validation_id: "validation-e2e-rejected",
      source_run_id: "run-e2e-rejected",
      ctx_id: null,
      upstream_task_id: "task-e2e-second-project",
      downstream_task_id: "task-e2e-smoke-create",
      cycle: 2,
      status: "pending",
      rejection_reason: "验证证据不完整",
      claimed_session_id: null,
      claimed_worktree_path: null,
      claimed_at: null,
      resolved_at: null,
      superseded_at: null,
      created_at: new Date(now.getTime() - 30_000).toISOString(),
      updated_at: new Date(now.getTime() - 30_000).toISOString()
    });
  });

  database.close();
  console.log(`seed-e2e: seeded ${config.databasePath}`);
  console.log(
    `seed-e2e: 2 projects, active Board owner ${boardOwner}, `
    + "2 terminal dependency notifications, pending/running, passed, rejected "
    + "validation requests with error/retry history and an upstream repair, "
    + "stale trio, backlog, waiting-decision, smoke-create, legacy paused/acceptance"
  );
}

main();
