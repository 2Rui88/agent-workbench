import { useEffect, useState, type FormEvent } from "react";
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Modal,
  ModalBody,
  ModalContent,
  ModalHeader,
  ModalTitle,
  Select as AppSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  toast
} from "@leke/components";
import { statusHoldsLease } from "../core/task-state.js";
import { formatRelativeTime, shortTaskId } from "./board-view-model.js";
import { CopyIdButton } from "./copy-id-button.js";
import type { TaskPriority, TaskStatus } from "../shared/task-contracts.js";
import type {
  DependencyRepairRequestRecord,
  TaskRecoveryView,
  TaskSummary
} from "../storage/progress-store.js";
import {
  ApiError,
  acceptTask,
  cancelTask,
  newOperationId,
  rejectTask,
  releaseSession,
  type DependencyValidationGate,
  type DependencyValidationItem,
  updateTask
} from "./api-client.js";

/**
 * The board's single drawer. In create mode it holds the one and only task
 * entry point, switching between 新建 and 导入存量 with a radio group. In
 * detail mode it centralizes the checkpoint, session, and snapshot facts plus
 * every Board action (accept, reject, resume, cancel, priority edit, and release stale
 * session). Dependency validation is displayed as read-only evidence.
 *
 * Data boundary: dependency and event facts come from the task detail API and
 * remain read-only evidence for Board actions.
 */

export type DrawerMode = "create" | "detail";

export interface TaskDrawerDetail {
  recovery?: TaskRecoveryView;
  dependency_repairs?: readonly DependencyRepairRequestRecord[];
  dependencies: readonly {
    depends_on_task_id: string;
    title: string;
    status: TaskStatus;
    created_at: string;
    repository_id: string;
    policy?: "informational" | "validation_gate" | "acceptance_gate" | "hard_block";
    ctx_id?: string;
    generation?: number;
  }[];
  dependency_validations: readonly DependencyValidationItem[];
  dependency_validation_gate: DependencyValidationGate;
  events: readonly {
    event_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    created_at: string;
  }[];
  snapshots: readonly {
    snapshot_id: string;
    head_commit: string;
    captured_at: string;
  }[];
}

export interface TaskDrawerProps {
  mode: DrawerMode;
  task: TaskSummary | undefined;
  /** Server authorization still decides writes; this hides controls unless
   * the paired actor is the task's real owner. */
  canMutate: boolean;
  detail?: TaskDrawerDetail | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
}

const priorities: readonly TaskPriority[] = ["P0", "P1", "P2", "P3"];

const legacyStatuses: readonly Exclude<TaskStatus, "done" | "cancelled">[] = [
  "backlog",
  "in_progress",
  "waiting_human",
  "blocked",
  "paused",
  "verifying",
  "pending_acceptance"
];

const statusLabels: Readonly<Record<TaskStatus, string>> = {
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
    const evidence = error.evidence.length > 0 ? `（${error.evidence.join("；")}）` : "";
    return `${error.code}：${error.message}${evidence}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function Field({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

const eventTypeLabels: Readonly<Record<string, string>> = {
  task_created: "创建",
  task_started: "开始",
  task_checkpointed: "记录检查点",
  task_submitted: "提交验收",
  task_accepted: "验收通过",
  task_rejected: "驳回",
  task_cancelled: "取消",
  task_released: "释放租约",
  task_lease_recovered: "恢复任务租约",
  task_updated: "更新",
  task_attached: "挂接会话",
  task_paused: "暂停",
  human_decision_recorded: "人工决定",
  task_decision_confirmed: "对话确认决定",
  legacy_task_adopted: "存量接管",
  legacy_worktree_conflict: "存量冲突",
  dependency_validation_requested: "请求下游验证",
  dependency_validation_responded: "下游验证反馈",
  dependency_repair_requested: "请求上游修复",
  dependency_repair_claimed: "认领上游修复",
  dependency_repair_resolved: "完成上游修复",
  dependency_repair_superseded: "修复请求已更新",
  task_repair_started: "开始修复"
};

function eventLabel(eventType: string): string {
  return eventTypeLabels[eventType] ?? eventType;
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="empty-note">{children}</p>;
}

interface ConfirmationRequest {
  title: string;
  description: string;
  confirmLabel: string;
  action: () => Promise<boolean>;
}

function scrollDrawerSection(sectionId: string): void {
  document.getElementById(sectionId)?.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}

export function TaskDrawer({ mode, task, canMutate, detail, onClose, onChanged }: TaskDrawerProps) {

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; retry: (() => void) | null } | null>(null);
  const [priorityDraft, setPriorityDraft] = useState<TaskPriority>(task?.priority ?? "P2");
  const [eventsExpanded, setEventsExpanded] = useState(false);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);

  useEffect(() => {
    if (task !== undefined) {
      setPriorityDraft(task.priority);
    }
  }, [task]);

  /**
   * Runs one human mutation. A fresh operation id is generated per attempt and
   * a retry of the same attempt reuses the original id, so the server replay
   * cache keeps retries idempotent. Resolves to true when the action landed.
   */
  async function runAction(
    perform: (operationId: string) => Promise<unknown>,
    reuseOperationId?: string,
    successMessage?: string
  ): Promise<boolean> {
    setBusy(true);
    const operationId = reuseOperationId ?? newOperationId();
    try {
      await perform(operationId);
      setError(null);
      if (successMessage !== undefined) {
        toast.success(successMessage);
      }
      await onChanged();
      return true;
    } catch (caught) {
      const isLeaseGone = caught instanceof Error && caught.message.includes("LEASE_NOT_FOUND");
      setError({
        message: isLeaseGone
          ? "该会话已不持有租约（可能已由新会话继承）。当前持有租约的会话可直接继续 checkpoint，无需释放。"
          : describeError(caught),
        retry: isLeaseGone ? null : () => {
          void runAction(perform, operationId);
        }
      });
      return false;
    } finally {
      setBusy(false);
    }
  }

  const sections
    = detail === undefined || detail === null ? null : detail;
  const validationGate = sections?.dependency_validation_gate;
  const latestValidationCycle = validationGate?.latest_cycle ?? null;
  const latestValidations = sections?.dependency_validations.filter((validation) => (
    validation.cycle === latestValidationCycle
  )) ?? [];
  const hasPendingValidation = latestValidations.some((validation) => (
    validation.status === "pending"
  ));

  return (
    <>
      <Modal open size="xl" onOpenChange={(open) => { if (!open) onClose(); }}>
        <ModalContent className="drawer-modal" aria-labelledby="drawer-title">
          <ModalHeader className="drawer-modal-header" showClose={false}>
            <ModalTitle id="drawer-title">
              {mode === "create" ? "新建任务" : task?.title ?? "任务详情"}
            </ModalTitle>
            <Button
              className="drawer-close"
              variant="ghost"
              aria-label="关闭抽屉"
              onClick={onClose}
            >
              关闭
            </Button>
          </ModalHeader>
          <ModalBody className="drawer-panel">

        {error !== null && (
          <Alert severity="error" className="drawer-error" role="alert">
            {error.message}
            {error.retry !== null && (
              <>
                {" "}
                <Button variant="outline" size="sm" disabled={busy} onClick={error.retry}>
                  重试
                </Button>
              </>
            )}
          </Alert>
        )}

        {task === undefined ? (
          <div className="drawer-body">
            <EmptyNote>正在加载任务详情……</EmptyNote>
          </div>
        ) : (
          <>
            <nav className="drawer-nav" aria-label="任务详情分区">
              <Button variant="ghost" size="sm" onClick={() => scrollDrawerSection("drawer-summary")}>概要</Button>
              <Button variant="ghost" size="sm" onClick={() => scrollDrawerSection("drawer-recovery")}>恢复</Button>
              {canMutate && (
                <Button variant="ghost" size="sm" onClick={() => scrollDrawerSection("drawer-actions")}>审批与管理</Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => scrollDrawerSection("drawer-checkpoint")}>Checkpoint</Button>
              <Button variant="ghost" size="sm" onClick={() => scrollDrawerSection("drawer-lease")}>Session</Button>
              <Button variant="ghost" size="sm" onClick={() => scrollDrawerSection("drawer-dependencies")}>依赖</Button>
              <Button variant="ghost" size="sm" onClick={() => scrollDrawerSection("drawer-events")}>事件</Button>
            </nav>
            <div className="drawer-body">
            <section id="drawer-summary" className="drawer-section">
              <h3>概要</h3>
              <dl className="fact-list">
                <div className="fact">
                  <dt>任务 ID</dt>
                  <dd className="task-id-value">
                    <span className="mono">{task.task_id}</span>
                    <CopyIdButton id={task.task_id} label="当前任务 ID" />
                  </dd>
                </div>
                <div className="fact">
                  <dt>状态</dt>
                  <dd>{statusLabels[task.status]}（{task.status}）</dd>
                </div>
                <div className="fact">
                  <dt>优先级</dt>
                  <dd>{task.priority}</dd>
                </div>
                <div className="fact">
                  <dt>版本</dt>
                  <dd>v{task.version}</dd>
                </div>
                <div className="fact">
                  <dt>仓库</dt>
                  <dd
                    className="mono fact-value-truncate"
                    title={task.repository_id}
                  >
                    {task.repository_id}
                  </dd>
                </div>
                <div className="fact">
                  <dt>负责人</dt>
                  <dd>
                    {task.owner !== undefined
                      ? <Badge variant="accent" size="sm">{task.owner}</Badge>
                      : <span className="bd-muted">未分配</span>}
                  </dd>
                </div>
                <div className="fact">
                  <dt>创建时间</dt>
                  <dd>{task.created_at}</dd>
                </div>
                <div className="fact">
                  <dt>更新时间</dt>
                  <dd title={task.updated_at}>
                    {formatRelativeTime(task.updated_at)}
                  </dd>
                </div>
              </dl>
              {task.goal !== undefined && <p className="fact-paragraph">目标：{task.goal}</p>}
              {task.acceptance_criteria !== undefined
                && task.acceptance_criteria.length > 0 && (
                <div>
                  <h4>验收标准</h4>
                  <ul>
                    {task.acceptance_criteria.map((criterion) => (
                      <li key={criterion}>{criterion}</li>
                    ))}
                  </ul>
                </div>
              )}
            </section>

            <section id="drawer-recovery" className="drawer-section">
              <h3>任务恢复</h3>
              {sections === null || sections.recovery === undefined ? (
                <EmptyNote>加载中……</EmptyNote>
              ) : (
                <>
                  <dl className="fact-list">
                    <div className="fact">
                      <dt>下一步</dt>
                      <dd>{sections.recovery.next_action}</dd>
                    </div>
                    <div className="fact">
                      <dt>证据状态</dt>
                      <dd>{sections.recovery.evidence_state}</dd>
                    </div>
                    <div className="fact">
                      <dt>租约</dt>
                      <dd>
                        {sections.recovery.active_lease === null
                          ? "无"
                          : `${sections.recovery.active_lease.session_id} · generation ${sections.recovery.active_lease.generation ?? 1} · ${sections.recovery.active_lease.expires_at}`}
                      </dd>
                    </div>
                  </dl>
                  {(sections.recovery.checkpoint?.attempts?.length ?? 0) === 0 ? (
                    <EmptyNote>暂无失败或放弃的尝试记录。</EmptyNote>
                  ) : (
                    <div>
                      <h4>近期尝试</h4>
                      <ul>
                        {(sections.recovery.checkpoint?.attempts ?? []).map((attempt) => (
                          <li key={attempt.attempt_id}>
                            <Badge variant="warning" size="sm">{attempt.outcome}</Badge>{" "}
                            {attempt.summary} · {attempt.recorded_at}
                            {attempt.evidence_refs.length === 0
                              ? ""
                              : ` · ${attempt.evidence_refs.join("、")}`}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {(sections.dependency_repairs ?? [])
                    .filter((repair) => repair.status === "pending" || repair.status === "claimed")
                    .map((repair) => (
                      <Alert severity="warning" key={repair.repair_id}>
                        下游第 {repair.cycle} 轮验证未通过：{repair.rejection_reason}。修复状态：{repair.status}；来源 validation：{repair.validation_id}。修复由上游 Agent 认领，Board 仅展示。
                      </Alert>
                    ))}
                </>
              )}
            </section>

            {!canMutate && (
              <section id="drawer-actions" className="drawer-section">
                <EmptyNote>只读查看：只有任务真实 owner 可以修改、验收或管理租约。</EmptyNote>
              </section>
            )}

            {canMutate && (
              <section id="drawer-actions" className="drawer-section">
                <div className="section-header">
                  <h3>审批与管理</h3>
                </div>
                <div className="action-row">
                  <label className="inline-field">
                    <span>优先级</span>
                    <AppSelect
                      value={priorityDraft}
                      onValueChange={(value) => {
                        if (typeof value === "string") {
                          setPriorityDraft(value as TaskPriority);
                        }
                      }}
                    >
                      <SelectTrigger
                        aria-label="优先级"
                        placeholder="选择优先级"
                        className="priority-select-trigger"
                      />
                      <SelectContent>
                        {priorities.map((priority) => (
                          <SelectItem key={priority} value={priority}>{priority}</SelectItem>
                        ))}
                      </SelectContent>
                    </AppSelect>
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || priorityDraft === task.priority}
                    onClick={() =>
                      void runAction((operationId) =>
                        updateTask(
                          task.task_id,
                          { priority: priorityDraft },
                          task.version,
                          operationId
                        ), undefined, "优先级已更新")}
                  >
                    保存优先级
                  </Button>
                </div>
                {task.status === "pending_acceptance" && (
                  <div className="acceptance-actions">
                    {validationGate !== undefined && validationGate.dependent_count > 0 && (
                      <div className="dependency-validation-gate">
                        <span>
                          下游验证：{validationGate.ready_for_acceptance
                            ? "全部通过，可进行最终验收"
                            : hasPendingValidation
                              ? "等待下游反馈"
                              : "尚未通过，需要重新发起验证"}
                        </span>
                        <span className="dependency-validation-readonly-note">
                          验证请求由下游 Agent 领取和反馈，Board 仅展示状态与证据。
                        </span>
                      </div>
                    )}
                    <div className="acceptance-buttons">
                      <Button
                        variant="default"
                        size="sm"
                        disabled={
                          busy
                          || sections === null
                          || (validationGate !== undefined
                            && !validationGate.ready_for_acceptance)
                        }
                        onClick={() =>
                          void runAction((operationId) =>
                            acceptTask(task.task_id, task.version, operationId),
                            undefined,
                            "任务已验收通过")}
                      >
                        验收通过
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={busy}
                        onClick={() => setConfirmation({
                          title: "确认驳回任务？",
                          description: `“${task.title}”将退出待验收状态并返回执行流程。`,
                          confirmLabel: "确认驳回",
                          action: () => runAction((operationId) =>
                            rejectTask(task.task_id, task.version, operationId),
                          undefined,
                          "任务已驳回")
                        })}
                      >
                        驳回
                      </Button>
                    </div>
                  </div>
                )}
              </section>


            )}

            <section id="drawer-checkpoint" className="drawer-section">
              <h3>Checkpoint</h3>
              {task.checkpoint === undefined ? (
                <EmptyNote>暂无 checkpoint。</EmptyNote>
              ) : (
                <>
                  <dl className="fact-list">
                    <div className="fact">
                      <dt>当前状态</dt>
                      <dd>{task.checkpoint.current_state}</dd>
                    </div>
                    <div className="fact">
                      <dt>下一步动作</dt>
                      <dd>{task.checkpoint.next_action}</dd>
                    </div>
                  </dl>
                  <FactList title="已完成事项" items={task.checkpoint.completed_items} />
                  <FactList title="人工上下文" items={task.checkpoint.human_context} />
                  <FactList title="阻塞项" items={task.checkpoint.blockers} />
                  <div>
                    <h4>决定</h4>
                    <FactList title="已确认" items={task.checkpoint.confirmed_decisions} />
                    <FactList title="待决定" items={task.checkpoint.pending_decisions} />
                  </div>
                  <div>
                    <h4>验证证据</h4>
                    {task.checkpoint.verification.length === 0 ? (
                      <EmptyNote>暂无验证证据。</EmptyNote>
                    ) : (
                      <ul className="verification-list">
                        {task.checkpoint.verification.map((entry) => (
                          <li key={`${entry.command}:${entry.summary}`}>
                            <span className={`outcome outcome-${entry.outcome}`}>{entry.outcome}</span>
                            <span className="mono">{entry.command}</span>
                            <span>{entry.summary}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  {task.checkpoint.source !== undefined && (
                    <p className="fact-paragraph">
                      来源：{task.checkpoint.source.source_type}
                      （{task.checkpoint.source.source_session_label}，
                      {task.checkpoint.source.adoption_method}，
                      {task.checkpoint.source.adopted_at}）
                    </p>
                  )}
                </>
              )}
            </section>

            <section id="drawer-lease" className="drawer-section">
              <h3>Session 租约</h3>
              {task.session_id === undefined ? (
                <EmptyNote>当前无关联 Session。</EmptyNote>
              ) : (
                <>
                  <p className="mono lease-session">{task.session_id}</p>
                  {statusHoldsLease(task.status) && canMutate ? (
                    <div className="action-row lease-action">
                      <span className="lease-note">
                        该会话持有本任务的唯一租约；确认失联后可人工释放，任务将暂停并可供其他会话接管。
                      </span>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={busy}
                        onClick={() => setConfirmation({
                          title: "确认释放 Session？",
                          description: `“${task.title}”的当前执行租约将被释放，任务会暂停并允许其他会话接管。`,
                          confirmLabel: "确认释放 Session",
                          action: () => runAction((operationId) =>
                            releaseSession(task.session_id as string, task.version, operationId),
                          undefined,
                          "Session 租约已释放")
                        })}
                      >
                        释放 Session
                      </Button>
                    </div>
                  ) : (
                    <EmptyNote>
                      {!canMutate
                        ? "只读查看：只有任务真实 owner 可以管理租约。"
                        : "当前状态不持有活动租约（如状态为进行中/验证中，租约可能已由新会话继承，可直接继续 checkpoint）。"}
                    </EmptyNote>
                  )}
                </>
              )}
            </section>

            <section id="drawer-snapshots" className="drawer-section">
              <h3>Repo Snapshot</h3>
              {sections === null ? (
                <EmptyNote>加载中……</EmptyNote>
              ) : sections.snapshots.length === 0 ? (
                <EmptyNote>暂无仓库快照。</EmptyNote>
              ) : (
                <ul className="snapshot-list">
                  {sections.snapshots.map((snapshot) => (
                    <li key={snapshot.snapshot_id}>
                      <span className="mono" title={snapshot.head_commit}>
                        {snapshot.head_commit.slice(0, 10)}
                      </span>
                      <span title={snapshot.captured_at}>
                        {formatRelativeTime(snapshot.captured_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section id="drawer-dependencies" className="drawer-section">
              <h3>依赖</h3>
              {sections === null ? (
                <EmptyNote>加载中……</EmptyNote>
              ) : sections.dependencies.length === 0 ? (
                <EmptyNote>暂无依赖任务。</EmptyNote>
              ) : (
                <ul className="dependency-list">
                  {sections.dependencies.map((dependency) => (
                    <li key={dependency.depends_on_task_id}>
                      <span className="dependency-title">{dependency.title}</span>
                      <Badge
                        variant={dependency.repository_id === task.repository_id ? "secondary" : "info"}
                        size="sm"
                      >
                        {dependency.repository_id === task.repository_id
                          ? "仓内"
                          : dependency.repository_id}
                      </Badge>
                      <span className="dependency-status">{dependency.status}</span>
                    </li>
                  ))}
                </ul>
              )}
              {sections !== null && sections.dependency_validations.length > 0 && (
                <div className="dependency-validation-history">
                  <h4>下游验证记录</h4>
                  <ul>
                    {sections.dependency_validations.map((validation) => (
                      <li key={validation.validation_id}>
                        <Badge
                          variant={validation.status === "passed"
                            ? "success"
                            : validation.status === "rejected"
                              ? "destructive"
                              : validation.status === "pending"
                                ? "warning"
                                : "secondary"}
                          size="sm"
                        >
                          {validation.status === "passed"
                            ? "通过"
                            : validation.status === "rejected"
                              ? "驳回"
                              : validation.status === "pending"
                                ? "待验证"
                                : "已更新"}
                        </Badge>
                        <span>{validation.downstream_title}</span>
                        <span
                          className="dependency-validation-task-id mono"
                          title={validation.downstream_task_id}
                        >
                          {shortTaskId(validation.downstream_task_id)}
                        </span>
                        <CopyIdButton
                          id={validation.downstream_task_id}
                          label="下游任务 ID"
                        />
                        <span className="mono">{validation.downstream_repository_id}</span>
                        <span>第 {validation.cycle} 轮</span>
                        {validation.response_reason !== null && (
                          <span className="dependency-validation-reason">
                            理由：{validation.response_reason}
                          </span>
                        )}
                        {(() => {
                          const latestRun = validation.latest_run ?? null;
                          const runs = validation.runs
                            ?? (latestRun === null ? [] : [latestRun]);
                          const spec = validation.validation_spec
                            ?? latestRun?.validation_spec;
                          return (
                            <>
                              {spec !== undefined && (
                                <span className="dependency-validation-spec">
                                  目标 revision：{spec.target_revision}；head：{spec.target_head_commit}；命令：{spec.command}；范围：{spec.scope.worktree_path}；超时：{spec.timeout_strategy.kind}
                                </span>
                              )}
                              {runs.map((run) => (
                                <span className="dependency-validation-run" key={run.run_id}>
                                  <span>Run {run.run_id} · 第 {run.attempt} 次 · 运行状态：{run.status}</span>
                                  {run.progress !== undefined && (
                                    <span>进度：{JSON.stringify(run.progress)}</span>
                                  )}
                                  {run.verification.length === 0 && (
                                    <span>证据：暂无</span>
                                  )}
                                  {run.verification.map((evidence, index) => (
                                    <span key={run.run_id + "-evidence-" + index}>
                                      命令：{evidence.command} · 结果：{evidence.outcome} · {evidence.summary}
                                      {evidence.revision === undefined ? "" : " · revision " + evidence.revision}
                                      {evidence.target_revision === undefined ? "" : " · target " + evidence.target_revision}
                                      {evidence.worktree_path === undefined ? "" : " · worktree " + evidence.worktree_path}
                                    </span>
                                  ))}
                                  {(run.error_reason ?? run.failure_reason) !== null && (
                                    <span className="dependency-validation-reason">
                                      原因：{run.error_reason ?? run.failure_reason}
                                    </span>
                                  )}
                                  <span>租约：{run.expires_at}</span>
                                </span>
                              ))}
                            </>
                          );
                        })()}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>

            <section id="drawer-events" className="drawer-section">
              <h3>事件{sections !== null && sections.events.length > 5 && !eventsExpanded
                ? `（最近 5 / 共 ${sections.events.length} 条）`
                : ""}</h3>
              {sections === null ? (
                <EmptyNote>加载中……</EmptyNote>
              ) : sections.events.length === 0 ? (
                <EmptyNote>暂无事件。</EmptyNote>
              ) : (
                <>
                  <ul className="event-list">
                    {(eventsExpanded
                      ? sections.events
                      : sections.events.slice(0, 5)
                    ).map((event) => (
                      <li key={event.event_id}>
                        <span className="event-type">{eventLabel(event.event_type)}</span>
                        {typeof event.payload?.actor === "string" && (
                          <span className="event-actor">{event.payload.actor}</span>
                        )}
                        <span title={event.created_at}>
                          {formatRelativeTime(event.created_at)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {sections.events.length > 5 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="event-toggle"
                      onClick={() => {
                        setEventsExpanded((expanded) => !expanded);
                      }}
                    >
                      {eventsExpanded
                        ? "收起"
                        : `展开全部 ${sections.events.length} 条事件`}
                    </Button>
                  )}
                </>
              )}
            </section>
            {canMutate && task.status !== "done" && task.status !== "cancelled" && (
              <div className="drawer-terminal-actions">
                <Button
                  variant="outline"
                  size="sm"
                  className="cancel-task-button"
                  disabled={busy}
                  onClick={() => setConfirmation({
                    title: "确认取消任务？",
                    description: `“${task.title}”将进入已取消状态；跨任务依赖会保留并同步取消状态。`,
                    confirmLabel: "确认取消任务",
                    action: () => runAction((operationId) =>
                      cancelTask(task.task_id, task.version, operationId),
                    undefined,
                    "任务已取消")
                  })}
                >
                  取消任务
                </Button>
              </div>
            )}
            </div>
          </>
        )}
          </ModalBody>
        </ModalContent>
      </Modal>
      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setConfirmation(null);
          }
        }}
      >
        <DialogContent showCloseButton={false} className="confirmation-dialog">
          <DialogHeader>
            <DialogTitle>{confirmation?.title}</DialogTitle>
            <DialogDescription>{confirmation?.description}</DialogDescription>
          </DialogHeader>
          <DialogBody>操作成功后会立即更新任务状态，无法通过本页面撤销。</DialogBody>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>
              返回检查
            </Button>
            <Button
              variant="destructive"
              disabled={busy || confirmation === null}
              onClick={() => {
                if (confirmation !== null) {
                  void confirmation.action().then((succeeded) => {
                    if (succeeded) setConfirmation(null);
                  });
                }
              }}
            >
              {busy ? "处理中…" : confirmation?.confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function FactList({ title, items }: { title: string; items: readonly string[] }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div>
      <h4>{title}</h4>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
