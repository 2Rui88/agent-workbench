import { z } from 'zod';
import { CoordinatorError } from './errors.js';
import type { ExecutionPackage } from './scheduler.js';

const choice = z.object({ model: z.string().min(1), effort: z.string().min(1) }).strict();
export const realExecutionSchema = z.object({
  authorizationRef: z.string().min(1), expiresAt: z.string().datetime(),
  taskRefs: z.array(z.string().min(1)).min(1),
  maxCalls: z.number().int().min(1).max(8), maxConcurrent: z.number().int().min(1).max(2),
  maxInputCharacters: z.number().int().min(1000).max(24000),
  maxTurnMs: z.number().int().min(1000).max(3_600_000),
  choices: z.object({ frontend: choice, backend: choice, audit: choice, advisor: choice.optional() }).strict(),
  advisor: z.object({ maxCalls: z.number().int().min(1).max(8), maxInputCharacters: z.number().int().min(1000).max(24000) }).strict().optional()
}).strict().refine((grant) => Boolean(grant.choices.advisor) === Boolean(grant.advisor), { message: 'Advisor choice and advisor limits must be granted together.' });
export type RealExecutionGrant = z.infer<typeof realExecutionSchema>;
export function assertRealExecution(grant: RealExecutionGrant | undefined, work: ExecutionPackage): void {
  if (!grant || Date.parse(grant.expiresAt) <= Date.now() || !grant.taskRefs.includes(work.taskRef) || work.roleId === 'lead') throw new CoordinatorError('TASK_GATE_CLOSED', 'Real invocation authorization is absent, expired or outside this task.', 'Keep work queued until the host provides scoped authorization.');
  const advisor = work.roleId === 'advisor';
  if (advisor && (!grant.advisor || !grant.choices.advisor)) throw new CoordinatorError('TASK_GATE_CLOSED', 'Advisor invocation is not authorized.', 'Request a scoped advisor grant before asking for advice.');
  const choice = advisor ? grant.choices.advisor! : grant.choices[work.roleId as 'frontend' | 'backend' | 'audit'];
  if (work.model?.model !== choice.model || work.model.effort !== choice.effort) throw new CoordinatorError('TASK_GATE_CLOSED', 'Model choice is outside this invocation grant.', 'Record failure evidence before requesting a different model grant.');
  const limit = advisor ? grant.advisor!.maxInputCharacters : grant.maxInputCharacters;
  if (JSON.stringify(work).length > limit) throw new CoordinatorError('BUDGET_EXHAUSTED', 'Execution package exceeds the authorized input size.', 'Reduce the package to goal, contract, evidence and blockers.');
}

// The business receipt deadline never undercuts the granted turn; a longer configured value still applies.
export function receiptDeadlineMs(grant: RealExecutionGrant | undefined, configured?: number): number {
  return Math.max(configured ?? 300_000, grant ? grant.maxTurnMs + 60_000 : 0);
}
