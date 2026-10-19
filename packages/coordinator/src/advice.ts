import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { bindingSchema } from './bindings.js';
import { CoordinatorError } from './errors.js';
import type { AgentKind } from './roles.js';
import type { ExecutionPackage } from './scheduler.js';
import type { TaskBinding } from './integrations/adapters.js';

const id = z.string().min(1).max(200);
const refsSchema = z.object({ contractRef: id, contractRevision: id, dispatchIds: z.array(id).max(20).default([]), validationIds: z.array(id).max(20).default([]), paths: z.array(z.string().min(1).max(500)).max(20).default([]) }).strict();
export const adviceSchemas = {
  automation_advice_request: z.object({ binding: bindingSchema, kind: z.enum(['consult', 'arbitration']), question: z.string().min(1).max(4000), refs: refsSchema, operationId: id }).strict(),
  automation_advice_complete: z.object({ adviceId: id, recommendation: z.string().min(1).max(8000), rationale: z.string().min(1).max(8000), risks: z.array(z.string().min(1).max(1000)).max(20), confidence: z.enum(['low', 'medium', 'high']), evidenceRefs: z.array(z.string().min(1).max(500)).min(1).max(20), verdict: z.enum(['uphold_rejection', 'overturn', 'needs_more_evidence']).optional() }).strict(),
  automation_advice_get: z.object({ adviceId: id }).strict(),
  automation_advice_resolve: z.object({ adviceId: id, decision: z.enum(['adopted', 'rejected', 'partial']), note: z.string().min(1).max(4000), operationId: id }).strict()
};
export type AdviceRefs = z.infer<typeof refsSchema>;
export type AdviceResult = Omit<z.infer<typeof adviceSchemas.automation_advice_complete>, 'adviceId'> & { completedAt: string };
export interface AdviceRecord { adviceId: string; groupId: string; dispatchId: string; kind: 'consult' | 'arbitration'; question: string; refs: AdviceRefs; state: 'requested' | 'completed' | 'resolved'; agents: { advisor: AgentKind; worker: AgentKind[]; audit: AgentKind[] }; sameSource: boolean; result?: AdviceResult; resolution?: { decision: 'adopted' | 'rejected' | 'partial'; note: string; resolvedAt: string }; createdAt: string; }

export function buildAdvicePackage(input: { adviceId: string; kind: 'consult' | 'arbitration'; question: string; refs: AdviceRefs; binding: TaskBinding }): ExecutionPackage {
  return {
    id: `advice:${input.adviceId}`, roleId: 'advisor', taskRef: input.binding.taskRef, repository: input.binding.repositoryId, worktree: input.binding.worktreePath,
    goal: `Advisor ${input.kind} request ${input.adviceId}. Question: ${input.question}\nEvidence references: ${JSON.stringify(input.refs)}\nWork read-only. Reply exactly once through automation_advice_complete with adviceId ${input.adviceId}${input.kind === 'arbitration' ? ' and a verdict' : ''}.`,
    allowedPaths: input.refs.paths.length ? input.refs.paths : ['.'], baseline: 'advice', contractRef: input.refs.contractRef, contractRevision: input.refs.contractRevision,
    acceptanceCriteria: ['Structured advice recorded through automation_advice_complete'], verificationCommands: ['read-only review'], dependencies: [], risk: 0, evidenceFailures: 0, paused: false
  };
}

const sameResult = (left: AdviceResult | undefined, right: AdviceResult): boolean => JSON.stringify({ ...left, completedAt: '' }) === JSON.stringify({ ...right, completedAt: '' });

export class AdviceRegistry {
  private readonly db: DatabaseSync;
  constructor(path: string) { this.db = new DatabaseSync(path); this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS advice_requests(advice_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, dispatch_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, payload_json TEXT NOT NULL)'); }
  close(): void { this.db.close(); }
  create(record: AdviceRecord): void { this.db.prepare('INSERT INTO advice_requests VALUES(?,?,?,?,?)').run(record.adviceId, record.groupId, record.dispatchId, record.state, JSON.stringify(record)); }
  get(adviceId: string): AdviceRecord | undefined { const row = this.db.prepare('SELECT payload_json FROM advice_requests WHERE advice_id=?').get(adviceId) as { payload_json: string } | undefined; return row ? JSON.parse(row.payload_json) as AdviceRecord : undefined; }
  byDispatch(dispatchId: string): AdviceRecord | undefined { const row = this.db.prepare('SELECT payload_json FROM advice_requests WHERE dispatch_id=?').get(dispatchId) as { payload_json: string } | undefined; return row ? JSON.parse(row.payload_json) as AdviceRecord : undefined; }
  complete(adviceId: string, result: AdviceResult): AdviceRecord {
    const record = this.get(adviceId);
    if (!record) throw new CoordinatorError('INVALID_INPUT', 'Advice request is unknown.', 'Use the adviceId from the execution package.');
    if (record.state !== 'requested') { if (sameResult(record.result, result)) return record; throw new CoordinatorError('IDEMPOTENCY_CONFLICT', 'Advice was already completed with different content.', 'Retry the original advice payload.'); }
    if ((record.kind === 'arbitration') !== Boolean(result.verdict)) throw new CoordinatorError('INVALID_INPUT', 'Arbitration advice needs a verdict; consultation advice must not include one.', 'Match the request kind.');
    const next: AdviceRecord = { ...record, state: 'completed', result };
    this.db.prepare("UPDATE advice_requests SET state='completed',payload_json=? WHERE advice_id=? AND state='requested'").run(JSON.stringify(next), adviceId);
    return next;
  }
  resolve(adviceId: string, resolution: NonNullable<AdviceRecord['resolution']>): AdviceRecord {
    const record = this.get(adviceId);
    if (!record || record.state === 'requested') throw new CoordinatorError('TASK_GATE_CLOSED', 'Advice is not ready for a decision.', 'Wait for the advisor result.');
    if (record.state === 'resolved') throw new CoordinatorError('CONFLICT', 'Advice decision was already recorded.', 'Keep the original decision; record follow-up as a new request.');
    const next: AdviceRecord = { ...record, state: 'resolved', resolution };
    this.db.prepare("UPDATE advice_requests SET state='resolved',payload_json=? WHERE advice_id=? AND state='completed'").run(JSON.stringify(next), adviceId);
    return next;
  }
}
