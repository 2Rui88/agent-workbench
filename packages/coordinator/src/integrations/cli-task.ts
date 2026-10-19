import { CoordinatorError } from '../errors.js';
import type { GitContext } from '../git-context.js';
import type { CliTaskClient, TaskRecord } from './adapters.js';
import type { ToolInvoker } from './mcp-client.js';

interface Envelope { ok: boolean; data?: Record<string, unknown>; error?: { code?: string }; }
interface Recovery { task: { task_id: string; repository_id: string; owner: string; status: string; version: number; scopes?: Array<{ scope_type: string; scope_value: string }> }; active_lease?: { session_id: string; expires_at: string }; lease_session?: { owner: string; worktree_path: string }; }
interface Mutation { expectedVersion: number; operationId: string; checkpoint?: unknown; verification?: unknown; }
export interface ExternalTaskObservation { taskRef: string; sessionId: string; expiresAt: string; }

export class RepositoryTaskClient implements CliTaskClient {
  private sessionId?: string;
  private readonly lastEvidenceAt=new Map<string,number>();
  private readonly unknownOperations = new Set<string>();
  constructor(private readonly tools: ToolInvoker, readonly repositoryId: string, readonly git: GitContext, private readonly now: () => number = Date.now, private readonly refreshEvidence?: (session:string,task:string,operation:'checkpoint'|'submit')=>Promise<void>, private readonly externalObservation?: ExternalTaskObservation) {}

  async bind(): Promise<string> {
    const data = await this.invoke('session_context', { repository_id: this.repositoryId, workspace_path: this.git.worktreePath, worktree_path: this.git.worktreePath, owner: this.git.owner });
    if (typeof data.session_id !== 'string' || data.repository_id !== this.repositoryId || data.worktree_path !== this.git.worktreePath) throw new CoordinatorError('TASK_GATE_CLOSED', 'Task service bound an unexpected repository or worktree.', 'Bind this repository using its actual Git identity.');
    this.sessionId = data.session_id;
    return this.sessionId;
  }

  async getTask(taskRef: string): Promise<TaskRecord> {
    if (this.externalObservation && (this.externalObservation.taskRef !== taskRef || Date.parse(this.externalObservation.expiresAt) <= this.now())) throw new CoordinatorError('TASK_GATE_CLOSED', 'External observation is expired or outside this task.', 'Use the specific host task reference.');
    const session = this.requireSession();
    if(this.refreshEvidence&&this.now()-(this.lastEvidenceAt.get(taskRef)??0)>30000){await this.refreshEvidence(session,taskRef,'checkpoint');this.lastEvidenceAt.set(taskRef,this.now());}
    const data = await this.invoke('task_recovery_get', { session_id: session, task_id: taskRef });
    const recovery = data.recovery as Recovery;
    if (!recovery?.task || recovery.task.repository_id !== this.repositoryId || recovery.task.owner !== this.git.owner) throw new CoordinatorError('TASK_GATE_CLOSED', 'Task is not owned by this Git identity in this repository.', 'Select an existing task in the bound repository.');
    const conflicts = await this.invoke('task_conflicts', { task_id: taskRef });
    const conflict = conflicts.conflict as { level?: string; evidence?: string[] } | undefined;
    const holder = this.externalObservation?.sessionId ?? session;
    const active = recovery.active_lease?.session_id === holder && Date.parse(recovery.active_lease.expires_at) > this.now() && recovery.lease_session?.worktree_path === this.git.worktreePath;
    const worktree = recovery.task.scopes?.find((scope) => scope.scope_type === 'worktree_path')?.scope_value ?? recovery.lease_session?.worktree_path ?? this.git.worktreePath;
    return { id: taskRef, repositoryId: this.repositoryId, owner: recovery.task.owner, status: recovery.task.status, version: recovery.task.version, worktreePath: worktree, lease: { active, owner: recovery.lease_session?.owner ?? '' }, conflicts: conflict?.level === 'none' ? [] : conflict?.evidence?.length ? conflict.evidence : ['Conflict result was not clear.'] };
  }

  async recoverAndStart(taskRef: string, role: string, operationId: string): Promise<TaskRecord> {
    this.assertWritable();
    const task = await this.getTask(taskRef);
    if(task.worktreePath!==this.git.worktreePath)throw new CoordinatorError('TASK_GATE_CLOSED','Task recovery belongs to another worktree.','Use explicit worktree succession before taking this task.');
    if (task.conflicts.length) throw new CoordinatorError('TASK_GATE_CLOSED', 'Repository task has conflicts.', 'Resolve conflicts before taking the task.');
    if (task.lease.active) return task;
    const data = await this.invoke('task_recovery_get', { session_id: this.requireSession(), task_id: taskRef });
    const recovery = data.recovery as Recovery;
    if (recovery.active_lease && Date.parse(recovery.active_lease.expires_at) > this.now()) throw new CoordinatorError('TASK_GATE_CLOSED', 'Another session holds the task lease.', 'Establish explicit session succession instead of inferring takeover from owner.');
    await this.invoke('task_attach', { session_id: this.requireSession(), task_id: taskRef, role, expected_version: task.version, operation_id: `${operationId}:attach` });
    const fresh = await this.getTask(taskRef);
    await this.mutate('task_start', taskRef, { expectedVersion: fresh.version, operationId });
    return this.getTask(taskRef);
  }

  async checkpoint(taskRef: string, payload: unknown): Promise<unknown> {
    const input = payload as Mutation;
    return this.mutate('task_checkpoint', taskRef, input, { checkpoint: input.checkpoint });
  }
  async submit(taskRef: string, payload: unknown): Promise<{ ok: boolean; status: 'pending_acceptance' }> {
    const input = payload as Mutation;
    const data = await this.mutate('task_submit', taskRef, input, { verification: input.verification });
    if (data.status !== 'pending_acceptance') throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Task submission did not return pending acceptance.', 'Read task state; agents cannot mark a task done.');
    return { ok: true, status: 'pending_acceptance' };
  }

  async reconcileOperation(operationId: string): Promise<Record<string, unknown>> {
    return this.invoke('operation_result_get', { session_id: this.requireSession(), operation_id: operationId });
  }
  private async mutate(name: string, taskRef: string, input: Mutation, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.assertWritable();
    if (!input?.operationId || !Number.isInteger(input.expectedVersion)) throw new CoordinatorError('INVALID_INPUT', 'Task mutation requires an operation ID and expected version.', 'Supply the current task version and stable operation ID.');
    if (this.unknownOperations.has(input.operationId)) {
      await this.reconcileOperation(input.operationId);
      throw new CoordinatorError('RECONCILIATION_REQUIRED', 'An earlier mutation outcome remains awaiting reconciliation.', 'Interpret the durable operation result before any new write.');
    }
    if(this.refreshEvidence){await this.refreshEvidence(this.requireSession(),taskRef,name==='task_submit'?'submit':'checkpoint');this.lastEvidenceAt.set(taskRef,this.now());}
    try { return await this.invoke(name, { task_id: taskRef, session_id: this.requireSession(), expected_version: input.expectedVersion, operation_id: input.operationId, ...extra }); }
    catch (error) { if (!(error instanceof CoordinatorError)) this.unknownOperations.add(input.operationId); throw error; }
  }
  private requireSession(): string { if (!this.sessionId) throw new CoordinatorError('TASK_GATE_CLOSED', 'Repository Task client is not bound.', 'Bind the actual repository first.'); return this.sessionId; }
  private assertWritable(): void { if (this.externalObservation) throw new CoordinatorError('FORBIDDEN', 'External host task observation cannot mutate or acquire its lease.', 'The host session performs all Task mutations.'); }
  private async invoke(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.tools.call(name, args) as Envelope;
    if (!result?.ok || !result.data) throw new CoordinatorError('TASK_GATE_CLOSED', `Task service rejected ${name}: ${result?.error?.code ?? 'INVALID_RESPONSE'}`, 'Follow the service recovery action with the current session.');
    return result.data;
  }
}
