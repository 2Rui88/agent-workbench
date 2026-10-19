import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {TurnModelEvidence} from './runtime/model-evidence.js';
import { migrate } from './migrations.js';
import { CoordinatorError } from './errors.js';
import type { Actor, RoleId } from './protocol.js';
import type { ExecutionPackage, ScheduledWork } from './scheduler.js';

export type DispatchState = 'queued' | 'starting' | 'active' | 'needs_reconciliation' | 'completed' | 'cancelled' | 'failed';
export interface DurableWork extends ScheduledWork { state: DispatchState; turnId?: string; startedAt?: number; }
export interface DispatchLease extends DurableWork { leaseToken: string; expiresAt: number; bindingGeneration: number; }
interface Row { dispatch_id: string; group_id: string; role_id: RoleId; work_json: string; operation_hash: string; state: DispatchState; queued_at: number; started_at: number | null; turn_id: string | null; lease_token: string | null; expires_at: number | null; binding_generation: number | null; }

export class DurableScheduler {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly now: () => number = Date.now) { this.db = new DatabaseSync(path); migrate(this.db); this.db.exec('CREATE TABLE IF NOT EXISTS dispatch_observations(dispatch_id TEXT PRIMARY KEY,turn_ids_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS work_receipts(dispatch_id TEXT PRIMARY KEY,group_id TEXT NOT NULL,role_id TEXT NOT NULL,generation INTEGER NOT NULL,receipt_json TEXT NOT NULL)'); }
  close(): void { this.db.close(); }

  enqueue(work: ExecutionPackage, groupId = 'default', dispatchId: string = randomUUID()): DurableWork {
    const json = JSON.stringify(work);
    const hash = createHash('sha256').update(JSON.stringify({ groupId, work })).digest('hex');
    return this.transaction(() => {
      const existing = this.row(dispatchId);
      if (existing) {
        if (existing.operation_hash !== hash) throw new CoordinatorError('IDEMPOTENCY_CONFLICT', 'Dispatch ID refers to a different package.', 'Use a new operation ID for changed work.');
        return this.decode(existing);
      }
      this.assertReplacement(work, groupId, dispatchId);
      const duplicate = this.db.prepare('SELECT dispatch_id FROM scheduled_work WHERE group_id=? AND role_id=? AND work_id=?').get(groupId, work.roleId, work.id);
      if (duplicate) throw new CoordinatorError('IDEMPOTENCY_CONFLICT', 'Work ID already has a durable dispatch.', 'Reuse its original operation ID.');
      this.db.prepare(`INSERT INTO scheduled_work(dispatch_id, group_id, role_id, work_id, work_json, operation_hash, state, queued_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`)
        .run(dispatchId, groupId, work.roleId, work.id, json, hash, this.now());
      return this.decode(this.row(dispatchId)!);
    });
  }

  recordReceipt(actor: Actor, dispatchId: string, token: string, receipt: unknown): void {
    this.assertLease(actor,dispatchId,token,['active']);
    const previous=this.receipt(actor,dispatchId);
    if(previous!==undefined&&JSON.stringify(previous)!==JSON.stringify(receipt))throw new CoordinatorError('IDEMPOTENCY_CONFLICT','Business receipt differs from its recorded contents.','Use the original verified receipt.');
    this.db.prepare('INSERT OR IGNORE INTO work_receipts VALUES(?,?,?,?,?)').run(dispatchId,actor.groupId,actor.roleId,actor.bindingGeneration,JSON.stringify(receipt));
  }
  receipt(actor: Actor,dispatchId:string): {dispatchId:string;summary:string;evidence:string[]} | undefined {
    this.assertBinding(actor);
    const row=this.db.prepare('SELECT * FROM work_receipts WHERE dispatch_id=?').get(dispatchId) as {group_id:string;role_id:string;generation:number;receipt_json:string}|undefined;
    if(!row||row.group_id!==actor.groupId||row.role_id!==actor.roleId||row.generation!==actor.bindingGeneration)return undefined;
    return JSON.parse(row.receipt_json) as {dispatchId:string;summary:string;evidence:string[]};
  }

  recordObservedTurns(actor: Actor, dispatchId: string, token: string, turnIds: string[]): void {
    this.assertLease(actor, dispatchId, token, ['starting']);
    this.db.prepare('INSERT INTO dispatch_observations(dispatch_id,turn_ids_json) VALUES(?,?) ON CONFLICT(dispatch_id) DO UPDATE SET turn_ids_json=excluded.turn_ids_json').run(dispatchId,JSON.stringify(turnIds));
  }
  recordModel(actor:Actor,dispatchId:string,threadId:string,turnId:string,evidence:TurnModelEvidence):void {
    this.assertBinding(actor);
    const row=this.row(dispatchId);
    if(!row||row.group_id!==actor.groupId||row.role_id!==actor.roleId||row.turn_id!==turnId||this.executionThread(dispatchId)!==threadId)throw new CoordinatorError('RECONCILIATION_REQUIRED','Model evidence does not match original execution.','Use the owning runtime and original turn.');
    const existing=this.db.prepare('SELECT model,effort,source FROM runtime_models WHERE dispatch_id=?').get(dispatchId) as {model:string;effort:string|null;source:string}|undefined;
    if(existing&&(existing.model!==evidence.model||existing.effort!==evidence.effort||existing.source!==evidence.source))throw new CoordinatorError('RECONCILIATION_REQUIRED','Runtime model evidence conflicts with its recorded value.','Inspect rerouting evidence; never replace historical facts.');
    this.db.prepare('INSERT OR IGNORE INTO runtime_models VALUES(?,?,?,?,?,?,?,?,?)').run(dispatchId,actor.groupId,actor.roleId,threadId,turnId,evidence.model,evidence.effort,evidence.source,new Date(this.now()).toISOString());
  }

  executionThread(dispatchId: string): string | undefined {
    const row = this.db.prepare('SELECT execution_thread_id FROM scheduled_work WHERE dispatch_id=?').get(dispatchId) as {execution_thread_id:string|null}|undefined;
    if (row?.execution_thread_id) return row.execution_thread_id;
    const dispatch = this.row(dispatchId);
    if (!dispatch?.turn_id) return undefined;
    // Legacy executions have runtime-origin approval evidence, never guessed current bindings.
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='approval_requests'").get()) return undefined;
    const refs = this.db.prepare("SELECT DISTINCT json_extract(payload_json,'$.params.threadId') AS thread FROM approval_requests WHERE group_id=? AND json_extract(payload_json,'$.roleId')=? AND json_extract(payload_json,'$.params.turnId')=?").all(dispatch.group_id,dispatch.role_id,dispatch.turn_id) as Array<{thread:string|null}>;
    return refs.length === 1 && refs[0]?.thread ? refs[0].thread : undefined;
  }
  observedTurns(dispatchId: string): string[] | undefined {
    const row=this.db.prepare('SELECT turn_ids_json FROM dispatch_observations WHERE dispatch_id=?').get(dispatchId) as {turn_ids_json:string}|undefined;
    return row ? JSON.parse(row.turn_ids_json) as string[] : undefined;
  }

  get(dispatchId: string): DurableWork | undefined { const row = this.row(dispatchId); return row ? this.decode(row) : undefined; }
  // Conservative: work that left the queue without a recorded thread may have reached this thread.
  threadStartedWork(groupId: string, roleId: string, threadId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM scheduled_work WHERE group_id=? AND role_id=? AND (execution_thread_id=? OR (execution_thread_id IS NULL AND state NOT IN ('queued','cancelled'))) LIMIT 1").get(groupId, roleId, threadId));
  }
  list(groupId: string): DurableWork[] {
    return (this.db.prepare('SELECT * FROM scheduled_work WHERE group_id=? ORDER BY queued_at, rowid').all(groupId) as unknown as Row[]).map((row) => this.decode(row));
  }

  nextReady(groupId:string,roleId:RoleId):DurableWork|undefined{
    return this.list(groupId).find((work)=>work.roleId===roleId&&work.state==='queued'&&!work.paused&&this.dependenciesReady(work));
  }
  private dependenciesReady(work:ExecutionPackage&{groupId:string}):boolean{
    return work.dependencies.every((ref)=>Boolean(this.db.prepare("SELECT 1 FROM scheduled_work WHERE group_id=? AND (dispatch_id=? OR work_id=?) AND state='completed'").get(work.groupId,ref,ref)));
  }

  recoverAfterRestart(groupId: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE scheduled_work SET state='needs_reconciliation' WHERE group_id=? AND state IN ('starting','active')").run(groupId);
      this.db.prepare('DELETE FROM role_presence WHERE group_id=?').run(groupId);
    });
  }

  heartbeat(actor: Actor, ttlMs = 60_000): void {
    this.assertBinding(actor);
    this.db.prepare(`INSERT INTO role_presence(group_id, role_id, binding_generation, expires_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(group_id, role_id) DO UPDATE SET binding_generation=excluded.binding_generation, expires_at=excluded.expires_at`)
      .run(actor.groupId, actor.roleId, actor.bindingGeneration, this.now() + ttlMs);
  }

  isPaused(groupId: string): boolean { return (this.db.prepare('SELECT status FROM groups WHERE group_id=?').get(groupId) as { status?: string } | undefined)?.status === 'paused'; }
  pause(actor: Actor, paused: boolean): void {
    this.assertLead(actor);
    this.db.prepare('UPDATE groups SET status=? WHERE group_id=?').run(paused ? 'paused' : 'active', actor.groupId);
  }

  cancelQueued(actor: Actor, dispatchId: string, evidence: string): void {
    this.assertLead(actor);
    if (!evidence.trim()) throw new CoordinatorError('INVALID_INPUT', 'Cancellation requires evidence.', 'Record why this unstarted package is obsolete.');
    this.transaction(() => {
      const row = this.row(dispatchId);
      const message = this.db.prepare('SELECT group_id,status FROM messages WHERE message_id=?').get(dispatchId) as {group_id:string;status:string}|undefined;
      const saved = this.db.prepare('SELECT evidence_json FROM scheduled_work WHERE dispatch_id=?').get(dispatchId) as {evidence_json:string|null}|undefined;
      if (row?.group_id === actor.groupId && row.state === 'cancelled' && message?.status === 'cancelled') {
        if (saved?.evidence_json !== JSON.stringify({evidence})) throw new CoordinatorError('IDEMPOTENCY_CONFLICT', 'Cancellation evidence changed.', 'Use the recorded cancellation reason.');
        return;
      }
      const hasBudget = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_reservations'").get();
      const reservation = hasBudget && this.db.prepare("SELECT 1 FROM execution_reservations WHERE dispatch_id=? AND state!='cancelled' LIMIT 1").get(dispatchId);
      const processing = this.db.prepare('SELECT 1 FROM processing_leases WHERE message_id=?').get(dispatchId);
      if (!row || row.group_id !== actor.groupId || row.state !== 'queued' || row.turn_id !== null || row.started_at !== null || row.lease_token !== null || reservation || processing || message?.group_id !== actor.groupId || message.status !== 'queued') {
        throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Only a confirmed unstarted queued dispatch can be cancelled.', 'Reconcile active, uncertain, or mismatched execution first.');
      }
      this.db.prepare("UPDATE scheduled_work SET state='cancelled',evidence_json=? WHERE dispatch_id=?").run(JSON.stringify({evidence}),dispatchId);
      this.db.prepare("UPDATE messages SET status='cancelled' WHERE message_id=?").run(dispatchId);
      this.db.prepare("INSERT INTO event_log(group_id,event_type,payload_json,created_at) VALUES(?,'dispatch.cancelled',?,?)").run(actor.groupId,JSON.stringify({dispatchId,evidence}),new Date(this.now()).toISOString());
    });
  }

  archiveFailure(actor: Actor, dispatchId: string, reason: 'interrupted' | 'runtime_failed', evidence: string, turnId: string): void {
    this.assertLead(actor);
    if (!evidence.trim() || !turnId.trim()) throw new CoordinatorError('INVALID_INPUT', 'Failure archive needs evidence and a turn.', 'Verify the original runtime.');
    const savedEvidence = JSON.stringify({reason,evidence,turnId});
    this.transaction(() => {
      const row = this.row(dispatchId);
      const saved = this.db.prepare('SELECT evidence_json FROM scheduled_work WHERE dispatch_id=?').get(dispatchId) as {evidence_json:string|null}|undefined;
      if (row?.group_id === actor.groupId && row.state === 'failed') {
        if (saved?.evidence_json !== savedEvidence) throw new CoordinatorError('IDEMPOTENCY_CONFLICT', 'Failure evidence changed.', 'Reuse the original archive.');
        return;
      }
      const message = this.db.prepare('SELECT group_id,recipient_role,status FROM messages WHERE message_id=?').get(dispatchId) as {group_id:string;recipient_role:string;status:string}|undefined;
      if (!row || row.group_id !== actor.groupId || row.state !== 'needs_reconciliation' || row.turn_id !== turnId || message?.group_id !== actor.groupId || message.recipient_role !== row.role_id || !['queued','processing','needs_reconciliation'].includes(message.status)) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Failure archive does not match the fenced execution.', 'Verify the original turn and message.');
      this.db.prepare("UPDATE scheduled_work SET state='failed',evidence_json=?,lease_token=NULL,expires_at=NULL WHERE dispatch_id=?").run(savedEvidence,dispatchId);
      this.db.prepare("UPDATE messages SET status='failed',completed_at=? WHERE message_id=?").run(new Date(this.now()).toISOString(),dispatchId);
      this.db.prepare('DELETE FROM processing_leases WHERE message_id=?').run(dispatchId);
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='execution_reservations'").get()) this.db.prepare("UPDATE execution_reservations SET state='failed',evidence=? WHERE group_id=? AND dispatch_id=? AND state IN ('reserved','started','unknown')").run(savedEvidence,actor.groupId,dispatchId);
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='approval_requests'").get()) this.db.prepare("UPDATE approval_requests SET state='stale' WHERE group_id=? AND json_extract(payload_json,'$.roleId')=? AND json_extract(payload_json,'$.params.turnId')=? AND state IN ('waiting_human','responding','unknown')").run(actor.groupId,row.role_id,turnId);
      this.db.prepare("INSERT INTO event_log(group_id,event_type,payload_json,created_at) VALUES(?,'dispatch.failed',?,?)").run(actor.groupId,JSON.stringify({dispatchId,reason,turnId}),new Date(this.now()).toISOString());
    });
  }

  assertReplacement(work: ExecutionPackage, groupId: string, dispatchId?: string): void {
    if (!work.replacesDispatchId) return;
    const previous = this.get(work.replacesDispatchId);
    if (!previous || previous.state !== 'failed' || previous.groupId !== groupId || previous.roleId !== work.roleId || previous.taskRef !== work.taskRef || previous.repository !== work.repository || previous.worktree !== work.worktree || previous.dispatchId === dispatchId || previous.id === work.id) throw new CoordinatorError('TASK_GATE_CLOSED', 'Replacement must name a failed package in the same role and task worktree.', 'Create a distinct package with current gates.');
    const successor = this.db.prepare("SELECT dispatch_id FROM scheduled_work WHERE group_id=? AND json_extract(work_json,'$.replacesDispatchId')=? AND dispatch_id<>?").get(groupId,work.replacesDispatchId,dispatchId??'');
    if (successor) throw new CoordinatorError('IDEMPOTENCY_CONFLICT', 'Failed package already has a direct successor.', 'Resume the existing successor.');
  }

  controlRole(groupId: string, roleId: RoleId, manual: boolean, evidence: string): void {
    this.db.prepare(`INSERT INTO role_controls(group_id, role_id, mode, evidence) VALUES (?, ?, ?, ?)
      ON CONFLICT(group_id, role_id) DO UPDATE SET mode=excluded.mode, evidence=excluded.evidence`)
      .run(groupId, roleId, manual ? 'human' : 'automatic', evidence);
  }

  claim(actor: Actor, leaseMs = 60_000, allowLead = false, dispatchId?:string): DispatchLease | undefined {
    this.assertBinding(actor);
    if (actor.roleId === 'lead' && !allowLead) throw new CoordinatorError('FORBIDDEN', 'Lead cannot claim worker dispatches.', 'Use a configured worker role.');
    return this.transaction(() => {
      this.expire();
      if (!this.online(actor.groupId, 'lead')) throw new CoordinatorError('LEAD_OFFLINE', 'Lead heartbeat has expired.', 'Restore lead presence before new turns.');
      const group = this.db.prepare('SELECT status FROM groups WHERE group_id=?').get(actor.groupId) as { status: string } | undefined;
      const control = this.db.prepare("SELECT mode FROM role_controls WHERE group_id=? AND role_id IN (?, 'lead') AND mode='human' LIMIT 1").get(actor.groupId, actor.roleId) as { mode: string } | undefined;
      if (control?.mode === 'human' || group?.status !== 'active' || !this.online(actor.groupId, actor.roleId)) return undefined;
      const busy = this.db.prepare(`SELECT dispatch_id FROM scheduled_work WHERE group_id=? AND role_id=? AND state IN ('starting', 'active', 'needs_reconciliation')`).get(actor.groupId, actor.roleId);
      if (busy) return undefined;
      const rows = this.db.prepare(`SELECT * FROM scheduled_work WHERE group_id=? AND role_id=? AND state='queued' ORDER BY queued_at, rowid`).all(actor.groupId, actor.roleId) as unknown as Row[];
      const row = rows.find((item) => (!dispatchId||item.dispatch_id===dispatchId)&&!(JSON.parse(item.work_json) as ExecutionPackage).paused&&this.dependenciesReady(this.decode(item)));
      if (!row) return undefined;
      const token = randomUUID(); const expiresAt = this.now() + leaseMs;
      this.db.prepare(`UPDATE scheduled_work SET state='starting', lease_token=?, binding_generation=?, expires_at=? WHERE dispatch_id=? AND state='queued'`)
        .run(token, actor.bindingGeneration, expiresAt, row.dispatch_id);
      return { ...this.decode(this.row(row.dispatch_id)!), leaseToken: token, expiresAt, bindingGeneration: actor.bindingGeneration };
    });
  }

  releaseBeforeStart(actor: Actor, dispatchId: string, token: string): void {
    this.transaction(() => { this.assertLease(actor,dispatchId,token,['starting']); this.db.prepare("UPDATE scheduled_work SET state='queued',lease_token=NULL,expires_at=NULL WHERE dispatch_id=?").run(dispatchId); });
  }

  started(actor: Actor, dispatchId: string, token: string, turnId: string): void {
    if (!turnId.trim()) throw new CoordinatorError('INVALID_INPUT', 'Turn ID is required.', 'Use the executor turn receipt.');
    this.transaction(() => {
      this.assertLease(actor, dispatchId, token, ['starting']);
      this.db.prepare(`UPDATE scheduled_work SET state='active', turn_id=?, started_at=?, execution_thread_id=(SELECT thread_id FROM runtime_bindings WHERE group_id=scheduled_work.group_id AND role_id=scheduled_work.role_id) WHERE dispatch_id=?`).run(turnId, this.now(), dispatchId);
    });
  }

  renew(actor: Actor, dispatchId: string, token: string, leaseMs = 60_000): void {
    this.transaction(() => { this.assertLease(actor, dispatchId, token, ['starting', 'active']); this.db.prepare('UPDATE scheduled_work SET expires_at=? WHERE dispatch_id=?').run(this.now() + leaseMs, dispatchId); });
  }

  complete(actor: Actor, dispatchId: string, token: string, receipt: { summary?: string; evidence: string[] }): void {
    if (!receipt.evidence?.length || receipt.evidence.some((item) => !item.trim())) throw new CoordinatorError('INVALID_INPUT', 'Business completion needs nonempty evidence.', 'Submit a structured business receipt.');
    this.transaction(() => {
      this.assertLease(actor, dispatchId, token, ['active']);
      this.db.prepare(`UPDATE scheduled_work SET state='completed', evidence_json=?, lease_token=NULL, expires_at=NULL WHERE dispatch_id=?`).run(JSON.stringify(receipt), dispatchId);
    });
  }

  uncertain(actor: Actor, dispatchId: string, token: string, evidence: string): void {
    this.transaction(() => {
      this.assertLease(actor, dispatchId, token, ['starting', 'active']);
      this.db.prepare(`UPDATE scheduled_work SET state='needs_reconciliation', evidence_json=? WHERE dispatch_id=?`).run(JSON.stringify({ evidence }), dispatchId);
    });
  }

  reconcile(actor: Actor, dispatchId: string, outcome: 'not_started' | 'started' | 'completed' | 'unknown', evidence: string, turnId?: string): void {
    this.assertLead(actor);
    if (!evidence.trim()) throw new CoordinatorError('INVALID_INPUT', 'Reconciliation needs evidence.', 'Read runtime state before changing dispatch status.');
    this.transaction(() => {
      this.expire(); const row = this.row(dispatchId);
      if (!row || row.group_id !== actor.groupId || row.state !== 'needs_reconciliation') throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Dispatch is not awaiting reconciliation in this group.', 'Read the current dispatch state.');
      if (outcome === 'started' && !turnId?.trim()) throw new CoordinatorError('INVALID_INPUT', 'Started reconciliation needs a turn ID.', 'Read the runtime turn ID.');
      const state = outcome === 'not_started' ? 'queued' : outcome === 'completed' ? 'completed' : 'needs_reconciliation';
      // Old worker tokens never regain authority after reconciliation.
      this.db.prepare(`UPDATE scheduled_work SET state=?, turn_id=?, lease_token=NULL, expires_at=NULL, evidence_json=? WHERE dispatch_id=?`)
        .run(state, turnId ?? row.turn_id, JSON.stringify({ outcome, evidence }), dispatchId);
    });
  }

  private expire(): void {
    this.db.prepare(`UPDATE scheduled_work SET state='needs_reconciliation' WHERE state IN ('starting', 'active') AND expires_at<=?`).run(this.now());
  }
  private online(groupId: string, role: RoleId): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM role_presence p JOIN runtime_bindings b ON b.group_id=p.group_id AND b.role_id=p.role_id
      WHERE p.group_id=? AND p.role_id=? AND p.binding_generation=b.binding_generation AND p.expires_at>?`).get(groupId, role, this.now()));
  }
  private assertBinding(actor: Actor): void {
    const row = this.db.prepare('SELECT binding_generation FROM runtime_bindings WHERE group_id=? AND role_id=?').get(actor.groupId, actor.roleId) as { binding_generation: number } | undefined;
    if (!row || row.binding_generation !== actor.bindingGeneration) throw new CoordinatorError('FORBIDDEN', 'Role binding is stale.', 'Refresh the authenticated role binding.');
  }
  private assertLead(actor: Actor): void { this.assertBinding(actor); if (actor.roleId !== 'lead') throw new CoordinatorError('FORBIDDEN', 'Only lead may control or reconcile dispatches.', 'Send evidence to lead.'); }
  private assertLease(actor: Actor, dispatchId: string, token: string, states: DispatchState[]): Row {
    this.assertBinding(actor); const row = this.row(dispatchId);
    if (!row || row.group_id !== actor.groupId || row.role_id !== actor.roleId || row.binding_generation !== actor.bindingGeneration || row.lease_token !== token || !row.expires_at || row.expires_at <= this.now() || !states.includes(row.state)) throw new CoordinatorError('STALE_LEASE', 'Dispatch lease is stale, expired, or not owned by this role.', 'Reconcile before submitting a new receipt.');
    return row;
  }
  private row(dispatchId: string): Row | undefined { return this.db.prepare('SELECT * FROM scheduled_work WHERE dispatch_id=?').get(dispatchId) as unknown as Row | undefined; }
  private decode(row: Row): DurableWork { return { ...JSON.parse(row.work_json) as ExecutionPackage, groupId: row.group_id, dispatchId: row.dispatch_id, queuedAt: row.queued_at, state: row.state, ...(row.turn_id ? { turnId: row.turn_id } : {}), ...(row.started_at !== null ? { startedAt: row.started_at } : {}) }; }
  private transaction<T>(run: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = run(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
}
