import { CoordinatorError } from '../errors.js';

export interface TaskRecord { id: string; owner: string; repositoryId: string; worktreePath: string; version: number; status: string; lease: { active: boolean; owner: string }; conflicts: string[]; }
export interface TaskBinding { taskRef: string; owner: string; repositoryId: string; worktreePath: string; expectedVersion: number; }
export interface CliTaskClient { getTask(taskRef: string): Promise<TaskRecord>; checkpoint(taskRef: string, payload: unknown): Promise<unknown>; submit(taskRef: string, payload: unknown): Promise<{ ok: boolean; status: 'pending_acceptance' }>; }
export interface TaskAuthority { recover?(binding:TaskBinding,operationId:string):Promise<TaskRecord>; checkpointTask?(binding:TaskBinding,operationId:string,checkpoint:unknown):Promise<unknown>; operationResult?(binding:TaskBinding,operationId:string):Promise<unknown>; checkGate(binding: TaskBinding): Promise<TaskRecord>; submit?(binding: TaskBinding, payload: unknown): Promise<{ok:boolean;status:'pending_acceptance'}>; }

export class MockTaskAuthority implements TaskAuthority {
  constructor(private readonly resolveTask: (binding: TaskBinding) => Promise<TaskRecord>) {}
  checkGate(binding: TaskBinding): Promise<TaskRecord> { return this.resolveTask(binding); }
  async submit(binding: TaskBinding, _payload: unknown): Promise<{ok:boolean;status:'pending_acceptance'}> { await this.checkGate(binding); return {ok:true,status:'pending_acceptance'}; }
}

export class CliTaskAuthority implements TaskAuthority {
  constructor(private readonly client: CliTaskClient) {}

  async checkGate(binding: TaskBinding): Promise<TaskRecord> {
    const task = await this.client.getTask(binding.taskRef);
    if (task.owner !== binding.owner || task.repositoryId !== binding.repositoryId || task.worktreePath !== binding.worktreePath || task.version !== binding.expectedVersion || task.status !== 'in_progress' || !task.lease.active || task.lease.owner !== binding.owner || task.conflicts.length) {
      throw new CoordinatorError('TASK_GATE_CLOSED', 'Task owner, worktree, version, lease, status, or conflict check failed.', 'Refresh task state and restore the valid lease before dispatch.');
    }
    return task;
  }

  checkpoint(taskRef: string, payload: unknown): Promise<unknown> { return this.client.checkpoint(taskRef, payload); }
  submit(taskRef: string | TaskBinding, payload: unknown): Promise<{ ok: boolean; status: 'pending_acceptance' }> { return this.client.submit(typeof taskRef === 'string' ? taskRef : taskRef.taskRef, payload); }
  async accept(_taskRef: string): Promise<never> { throw new CoordinatorError('HUMAN_ACCEPTANCE_ONLY', 'Only a human may accept a submitted task.', 'Wait for human acceptance in the task system.'); }
  async retryUnknown(_operationId: string): Promise<never> { throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Unknown operation outcomes must be reconciled before retry.', 'Query operation_result_get before issuing another operation.'); }
}
