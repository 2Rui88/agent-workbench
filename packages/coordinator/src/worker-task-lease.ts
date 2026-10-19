import { CoordinatorError } from './errors.js';
import type { ToolInvoker } from './integrations/mcp-client.js';

// The lead holds each worker Task lease through a dedicated CLI Task session bound to that worker's worktree.
export interface WorkerLeaseState { role: 'frontend' | 'backend'; taskId: string; sessionId: string; resumeToken: string; version: number; worktreePath: string; owner: string; repositoryId: string; leaseExpiresAt: string; }
export interface WorkerTaskSpec { role: 'frontend' | 'backend'; owner: string; repositoryId: string; worktreePath: string; title: string; goal: string; acceptanceCriteria: string[]; nextAction: string; operationPrefix: string; }
export interface WorkerTaskSpecContent { title: string; goal: string; acceptanceCriteria: string[]; nextAction: string; }
export interface LeaseDeps { tools: ToolInvoker; collect(sessionId: string, taskId: string): Promise<void>; }

async function invoke(tools: ToolInvoker, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const envelope = await tools.call(name, args) as { ok?: boolean; data?: Record<string, unknown>; error?: { code?: string } };
  if (!envelope?.ok || !envelope.data) throw new CoordinatorError('TASK_GATE_CLOSED', `Task service rejected ${name}${envelope?.error?.code ? ` (${envelope.error.code})` : ''}.`, 'Inspect the task service response before retrying.');
  return envelope.data;
}

async function leaseOf(tools: ToolInvoker, sessionId: string, taskId: string): Promise<{ version: number; expiresAt: string }> {
  const data = await invoke(tools, 'task_recovery_get', { session_id: sessionId, task_id: taskId });
  const recovery = data.recovery as { task?: { version?: number }; active_lease?: { session_id?: string; expires_at?: string } } | undefined;
  if (recovery?.active_lease?.session_id !== sessionId || typeof recovery.active_lease.expires_at !== 'string' || typeof recovery.task?.version !== 'number') throw new CoordinatorError('TASK_GATE_CLOSED', 'Worker Task lease is not held by its worker session.', 'Inspect the task lease; do not take over another session.');
  return { version: recovery.task.version, expiresAt: recovery.active_lease.expires_at };
}

export async function initWorkerTask(deps: LeaseDeps, spec: WorkerTaskSpec): Promise<WorkerLeaseState> {
  const session = await invoke(deps.tools, 'session_context', { owner: spec.owner, repository_id: spec.repositoryId, workspace_path: spec.worktreePath, worktree_path: spec.worktreePath });
  if (typeof session.session_id !== 'string' || typeof session.resume_token !== 'string' || session.worktree_path !== spec.worktreePath) throw new CoordinatorError('TASK_GATE_CLOSED', 'Task service bound an unexpected worktree.', 'Bind the actual worker worktree.');
  const sessionId = session.session_id;
  const created = await invoke(deps.tools, 'task_create', { session_id: sessionId, operation_id: `${spec.operationPrefix}-create`, expected_version: 0, repository_id: spec.repositoryId, owner: spec.owner, title: spec.title, goal: spec.goal, acceptance_criteria: spec.acceptanceCriteria, next_action: spec.nextAction, priority: 'P1', scopes: [{ scope_type: 'worktree_path', scope_value: spec.worktreePath }] });
  const taskId = created.task_id as string;
  await deps.collect(sessionId, taskId);
  const conflicts = await invoke(deps.tools, 'task_conflicts', { task_id: taskId });
  if ((conflicts.conflict as { level?: string } | undefined)?.level !== 'none') throw new CoordinatorError('TASK_GATE_CLOSED', 'Worker Task has repository conflicts.', 'Resolve conflicts before starting the worker Task.');
  await invoke(deps.tools, 'task_start', { session_id: sessionId, operation_id: `${spec.operationPrefix}-start`, task_id: taskId, expected_version: 0 });
  const lease = await leaseOf(deps.tools, sessionId, taskId);
  return { role: spec.role, taskId, sessionId, resumeToken: session.resume_token, version: lease.version, worktreePath: spec.worktreePath, owner: spec.owner, repositoryId: spec.repositoryId, leaseExpiresAt: lease.expiresAt };
}

export async function checkpointLease(deps: LeaseDeps, state: WorkerLeaseState, operationId: string): Promise<WorkerLeaseState> {
  await deps.collect(state.sessionId, state.taskId);
  await invoke(deps.tools, 'task_checkpoint', { session_id: state.sessionId, operation_id: operationId, task_id: state.taskId, expected_version: state.version, checkpoint: { completed_items: [], current_state: 'in_progress: lease held by lead for coordinator dispatch', confirmed_decisions: [], pending_decisions: [], blockers: [], verification: [], next_action: 'Wait for the coordinator dispatch' } });
  const lease = await leaseOf(deps.tools, state.sessionId, state.taskId);
  return { ...state, version: lease.version, leaseExpiresAt: lease.expiresAt };
}

export async function renewWorkerTask(deps: LeaseDeps, state: WorkerLeaseState, operationId: string): Promise<WorkerLeaseState> {
  const session = await invoke(deps.tools, 'session_context', { owner: state.owner, repository_id: state.repositoryId, workspace_path: state.worktreePath, worktree_path: state.worktreePath, resume_session_id: state.sessionId, resume_token: state.resumeToken });
  if (session.session_id !== state.sessionId || typeof session.resume_token !== 'string') throw new CoordinatorError('TASK_GATE_CLOSED', 'Worker session could not be reattached.', 'Inspect the worker session before creating a successor.');
  return checkpointLease(deps, { ...state, resumeToken: session.resume_token }, operationId);
}

// Re-acquire a known worker Task from a fresh session, only after the previous lease has expired.
export async function acquireLease(deps: LeaseDeps, state: WorkerLeaseState): Promise<WorkerLeaseState> {
  const session = await invoke(deps.tools, 'session_context', { owner: state.owner, repository_id: state.repositoryId, workspace_path: state.worktreePath, worktree_path: state.worktreePath });
  if (typeof session.session_id !== 'string' || typeof session.resume_token !== 'string' || session.worktree_path !== state.worktreePath) throw new CoordinatorError('TASK_GATE_CLOSED', 'Task service bound an unexpected worktree.', 'Bind the actual worker worktree.');
  const sessionId = session.session_id;
  const data = await invoke(deps.tools, 'task_recovery_get', { session_id: sessionId, task_id: state.taskId });
  const recovery = data.recovery as { task?: { version?: number }; active_lease?: { session_id?: string; expires_at?: string } | null } | undefined;
  const lease = recovery?.active_lease;
  if (lease?.session_id && lease.session_id !== sessionId && Date.parse(lease.expires_at ?? '') > Date.now()) throw new CoordinatorError('RECONCILIATION_REQUIRED', `Previous worker lease is still active until ${lease.expires_at}.`, 'Wait for the previous lease to expire; never take over an active lease.');
  if (typeof recovery?.task?.version !== 'number') throw new CoordinatorError('TASK_GATE_CLOSED', 'Worker Task recovery is unavailable.', 'Inspect the worker Task.');
  await deps.collect(sessionId, state.taskId);
  const conflicts = await invoke(deps.tools, 'task_conflicts', { task_id: state.taskId });
  if ((conflicts.conflict as { level?: string } | undefined)?.level !== 'none') throw new CoordinatorError('TASK_GATE_CLOSED', 'Worker Task has repository conflicts.', 'Resolve conflicts before re-acquiring the worker Task.');
  await invoke(deps.tools, 'task_start', { session_id: sessionId, operation_id: `${state.taskId}-reacquire-${recovery.task.version}`, task_id: state.taskId, expected_version: recovery.task.version });
  const acquired = await leaseOf(deps.tools, sessionId, state.taskId);
  return { ...state, sessionId, resumeToken: session.resume_token, version: acquired.version, leaseExpiresAt: acquired.expiresAt };
}

export function workerTaskManifest(states: WorkerLeaseState[], authorizedUntil: string): Array<{ role: 'frontend' | 'backend'; binding: { taskRef: string; owner: string; repositoryId: string; worktreePath: string; expectedVersion: number }; sessionId: string; expiresAt: string }> {
  return states.map((state) => ({ role: state.role, binding: { taskRef: state.taskId, owner: state.owner, repositoryId: state.repositoryId, worktreePath: state.worktreePath, expectedVersion: state.version }, sessionId: state.sessionId, expiresAt: authorizedUntil }));
}

// New projects describe their worker Tasks in runtime.json; there is no built-in default.
export function workerTaskSpec(config: { workerTaskSpecs?: Partial<Record<'frontend' | 'backend', WorkerTaskSpecContent>> | undefined }, role: 'frontend' | 'backend'): WorkerTaskSpecContent {
  const spec = config.workerTaskSpecs?.[role];
  if (!spec) throw new CoordinatorError('INVALID_INPUT', `runtime.json has no workerTaskSpecs.${role}.`, 'Describe the worker Task (title, goal, acceptanceCriteria, nextAction) before creating it.');
  return spec;
}
