import { CoordinatorError } from './errors.js';
import { chooseModelTier } from './model-policy.js';
import type { ExecutionPackage } from './scheduler.js';
import type { CooperativeScheduler } from './scheduler.js';
import { assertSupportedModelChoice, type ModelCapability, type ModelChoice } from './config.js';
import type { Actor } from './protocol.js';
import type { TaskAuthority, TaskBinding } from './integrations/adapters.js';
import type { CoordinatorStore, QueueMessage } from './store.js';

export interface WorkDispatchResult { message: QueueMessage; model: { tier: string; model: string; effort: string; reason: string }; taskVersion: number; }

export class WorkDispatcher {
  constructor(private readonly store: CoordinatorStore, private readonly taskAuthority: TaskAuthority, private readonly scheduler?: Pick<CooperativeScheduler, 'enqueue'>, private readonly approvedChoice?: ModelChoice) {}

  async dispatch(lead: Actor, binding: TaskBinding, work: ExecutionPackage, catalog: ModelCapability[], operationId: string): Promise<WorkDispatchResult> {
    if (lead.roleId !== 'lead') throw new CoordinatorError('FORBIDDEN', 'Only the lead may dispatch execution packages.', 'Submit the request to the lead role.');
    if (work.repository !== binding.repositoryId || work.taskRef !== binding.taskRef || work.worktree !== binding.worktreePath) throw new CoordinatorError('TASK_GATE_CLOSED', 'Dispatch package does not match its task and worktree binding.', 'Refresh the task binding and rebuild the execution package.');
    const task = await this.taskAuthority.checkGate(binding);
    const selection = this.approvedChoice ? { choice: this.approvedChoice, tier: work.roleId === 'audit' ? 'analysis' : 'execution', reason: 'Explicit scoped economical invocation grant; automatic upgrades disabled.' } : chooseModelTier(work, catalog);
    assertSupportedModelChoice(selection.choice, catalog);
    const payload = { kind: 'execution_package', ...work, taskBinding: binding, model: selection.choice, modelTier: selection.tier, modelReason: selection.reason, taskVersion: task.version };
    const message = this.store.send(lead, { type: 'assistance_request', recipientRole: work.roleId, payload }, operationId);
    this.scheduler?.enqueue({ ...work, taskBinding: binding, model: { ...selection.choice, tier: selection.tier, reason: selection.reason } }, lead.groupId, message.messageId);
    return { message, model: { tier: selection.tier, ...selection.choice, reason: selection.reason }, taskVersion: task.version };
  }
}
