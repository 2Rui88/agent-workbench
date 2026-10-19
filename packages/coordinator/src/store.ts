import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { CoordinatorError } from './errors.js';
import { migrate } from './migrations.js';
import type { Actor, RoleId } from './protocol.js';
import { ROLE_IDS, type CoreRoleId } from './roles.js';
import { createMessageSubmission } from './auth.js';

interface StoredMessage extends Record<string, unknown> {
  message_id: string;
  group_id: string;
  sender_role: string;
  recipient_role: string;
  binding_generation: number;
  type: string;
  payload_json: string;
  operation_id: string;
  created_at: string;
  status: string;
}

export interface QueueMessage {
  messageId: string;
  groupId: string;
  senderRole: RoleId;
  recipientRole: RoleId;
  bindingGeneration: number;
  type: string;
  payload: Record<string, unknown>;
  operationId: string;
  createdAt: string;
  status: string;
}

export interface ClaimedMessage extends QueueMessage {
  leaseToken: string;
  leaseExpiresAt: number;
}

interface Submission {
  type: 'assistance_request' | 'contract_update' | 'test_debug' | 'dispute' | 'arbitration_suggested';
  recipientRole: RoleId;
  payload: Record<string, unknown>;
}

export class CoordinatorStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.now = now;
    this.db = new DatabaseSync(path);
    migrate(this.db);
  }

  close(): void { this.db.close(); }

  loadSchedulerSnapshot(groupId: string): unknown | undefined {
    const row = this.db.prepare('SELECT payload_json FROM scheduler_snapshots WHERE group_id=?').get(groupId) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as unknown : undefined;
  }

  saveSchedulerSnapshot(groupId: string, payload: unknown): void {
    this.createGroup(groupId);
    this.db.prepare(`INSERT INTO scheduler_snapshots(group_id, payload_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(group_id) DO UPDATE SET payload_json=excluded.payload_json, updated_at=excluded.updated_at`)
      .run(groupId, JSON.stringify(payload), new Date(this.now()).toISOString());
  }

  createGroup(groupId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO groups(group_id, created_at) VALUES (?, ?)`).run(groupId, now);
    for (const roleId of ROLE_IDS) {
      this.db.prepare(`INSERT OR IGNORE INTO roles(group_id, role_id) VALUES (?, ?)`).run(groupId, roleId);
      this.db.prepare(`INSERT OR IGNORE INTO runtime_bindings(group_id, role_id, binding_generation) VALUES (?, ?, 1)`).run(groupId, roleId);
    }
  }

  initializeGroup(groupId: string, capabilities: Record<CoreRoleId, string> & Partial<Record<'advisor', string>>): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.createGroup(groupId);
      for (const roleId of ROLE_IDS) { const token = (capabilities as Partial<Record<RoleId, string>>)[roleId]; if (token) this.setRoleCapability(groupId, roleId, token); }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  addRoleCapability(groupId: string, roleId: 'advisor', token: string): void {
    this.createGroup(groupId);
    if (this.db.prepare('SELECT 1 FROM role_capabilities WHERE group_id=? AND role_id=?').get(groupId, roleId)) throw new CoordinatorError('CONFLICT', 'Role capability already exists.', 'Reuse the existing role credential; never overwrite it.');
    this.setRoleCapability(groupId, roleId, token);
  }

  rotateBinding(groupId: string, roleId: RoleId): number {
    this.db.prepare('UPDATE runtime_bindings SET binding_generation=binding_generation+1 WHERE group_id=? AND role_id=?').run(groupId, roleId);
    return (this.db.prepare('SELECT binding_generation FROM runtime_bindings WHERE group_id=? AND role_id=?').get(groupId, roleId) as { binding_generation: number }).binding_generation;
  }

  setRoleCapability(groupId: string, roleId: RoleId, token: string): void {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    this.db.prepare(`INSERT INTO role_capabilities(group_id, role_id, token_hash) VALUES (?, ?, ?)
      ON CONFLICT(group_id, role_id) DO UPDATE SET token_hash=excluded.token_hash`).run(groupId, roleId, tokenHash);
  }

  assertAuthorized(actor: Actor, token: string): void {
    const row = this.db.prepare(`SELECT c.token_hash, b.binding_generation FROM role_capabilities c
      JOIN runtime_bindings b ON b.group_id=c.group_id AND b.role_id=c.role_id WHERE c.group_id=? AND c.role_id=?`)
      .get(actor.groupId, actor.roleId) as { token_hash: string; binding_generation: number } | undefined;
    const receivedHash = createHash('sha256').update(token).digest('hex');
    const expected = Buffer.from(row?.token_hash ?? '0'.repeat(64));
    const actual = Buffer.from(receivedHash);
    if (!row || row.binding_generation !== actor.bindingGeneration || !timingSafeEqual(expected, actual)) {
      throw new CoordinatorError('FORBIDDEN', 'Role capability or binding generation is invalid.', 'Load the matching local role capability and current generation.');
    }
  }

  groupSnapshot(groupId: string): { groupId: string; status: string; roles: Array<{ roleId: RoleId; threadId: string | null; worktreePath: string | null; bindingGeneration: number }>; queue: Record<string, number> } | undefined {
    const group = this.db.prepare(`SELECT group_id, status FROM groups WHERE group_id=?`).get(groupId) as { group_id: string; status: string } | undefined;
    if (!group) return undefined;
    const roleRows = this.db.prepare(`SELECT role_id, thread_id, worktree_path, binding_generation FROM runtime_bindings WHERE group_id=? ORDER BY role_id`).all(groupId) as Array<{ role_id: RoleId; thread_id: string | null; worktree_path: string | null; binding_generation: number }>;
    const counts = this.db.prepare(`SELECT recipient_role, status, count(*) AS count FROM messages WHERE group_id=? GROUP BY recipient_role, status`).all(groupId) as Array<{ recipient_role: RoleId; status: string; count: number }>;
    const queue: Record<string, number> = {};
    for (const role of ROLE_IDS) queue[role] = counts.filter((row) => row.recipient_role === role && row.status === 'queued').reduce((sum, row) => sum + row.count, 0);
    return { groupId: group.group_id, status: group.status, roles: roleRows.map((row) => ({ roleId: row.role_id, threadId: row.thread_id, worktreePath: row.worktree_path, bindingGeneration: row.binding_generation })), queue };
  }

  bindRole(actor: Actor, threadId?: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO groups(group_id, created_at) VALUES (?, ?)`)
      .run(actor.groupId, now);
    this.db.prepare(`INSERT OR IGNORE INTO roles(group_id, role_id) VALUES (?, ?)`)
      .run(actor.groupId, actor.roleId);
    this.db.prepare(`INSERT INTO runtime_bindings(group_id, role_id, thread_id, binding_generation) VALUES (?, ?, ?, ?)
      ON CONFLICT(group_id, role_id) DO UPDATE SET thread_id = excluded.thread_id, binding_generation = excluded.binding_generation`)
      .run(actor.groupId, actor.roleId, threadId ?? null, actor.bindingGeneration);
  }

  setRoleThread(actor: Actor, threadId: string, worktree?: string): void {
    this.assertCurrentBinding(actor);
    this.db.prepare(`UPDATE runtime_bindings SET thread_id=?,worktree_path=COALESCE(?,worktree_path) WHERE group_id=? AND role_id=? AND binding_generation=?`)
      .run(threadId, worktree??null, actor.groupId, actor.roleId, actor.bindingGeneration);
  }

  send(actor: Actor, input: Submission, operationId: string): QueueMessage {
    this.assertCurrentBinding(actor);
    const envelope = createMessageSubmission(actor, input);
    const operationHash = createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
    const now = new Date().toISOString();
    const messageId = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare(`SELECT * FROM messages WHERE group_id = ? AND sender_role = ? AND operation_id = ?`)
        .get(actor.groupId, actor.roleId, operationId) as StoredMessage | undefined;
      if (existing) {
        if (existing.operation_hash !== operationHash) {
          throw new CoordinatorError('IDEMPOTENCY_CONFLICT', 'Operation ID was already used with a different request.', 'Use a new operation ID for a changed request.');
        }
        this.db.exec('COMMIT');
        return this.toMessage(existing);
      }
      if (envelope.payload.replacesDispatchId !== undefined) {
        const payload = envelope.payload;
        const predecessor = this.db.prepare('SELECT group_id,state,work_json FROM scheduled_work WHERE dispatch_id=?').get(String(payload.replacesDispatchId)) as {group_id:string;state:string;work_json:string}|undefined;
        const old = predecessor ? JSON.parse(predecessor.work_json) as Record<string,unknown> : undefined;
        if (actor.roleId !== 'lead' || payload.kind !== 'execution_package' || predecessor?.group_id !== actor.groupId || predecessor.state !== 'failed' || !old || ['roleId','taskRef','repository','worktree'].some(key => old[key] !== payload[key]) || old.id === payload.id) throw new CoordinatorError('TASK_GATE_CLOSED', 'Replacement lineage does not match the failed package.', 'Use the same task and role with a new package ID.');
        if (this.db.prepare('SELECT 1 FROM scheduled_work WHERE group_id=? AND role_id=? AND work_id=?').get(actor.groupId,envelope.recipientRole,String(payload.id))) throw new CoordinatorError('IDEMPOTENCY_CONFLICT', 'Replacement work ID is already used.', 'Use a distinct package ID.');
        if (this.db.prepare("SELECT 1 FROM messages WHERE group_id=? AND json_extract(payload_json,'$.replacesDispatchId')=?").get(actor.groupId,String(payload.replacesDispatchId))) throw new CoordinatorError('IDEMPOTENCY_CONFLICT', 'Replacement already emitted.', 'Resume its original operation.');
      }
      this.db.prepare(`INSERT OR IGNORE INTO groups(group_id, created_at) VALUES (?, ?)`)
        .run(actor.groupId, now);
      this.db.prepare(`INSERT OR IGNORE INTO roles(group_id, role_id) VALUES (?, ?), (?, ?)`)
        .run(actor.groupId, actor.roleId, actor.groupId, envelope.recipientRole);
      this.db.prepare(`INSERT OR IGNORE INTO runtime_bindings(group_id, role_id, binding_generation) VALUES (?, ?, ?)`)
        .run(actor.groupId, actor.roleId, actor.bindingGeneration);
      this.db.prepare(`INSERT INTO messages(message_id, group_id, sender_role, recipient_role, binding_generation, type, payload_json, operation_id, operation_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(messageId, actor.groupId, actor.roleId, envelope.recipientRole, actor.bindingGeneration, envelope.type,
          JSON.stringify(envelope.payload), operationId, operationHash, now);
      this.db.prepare(`INSERT INTO event_log(group_id, event_type, payload_json, created_at) VALUES (?, 'message.queued', ?, ?)`)
        .run(actor.groupId, JSON.stringify({ messageId, recipientRole: envelope.recipientRole }), now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getMessage(messageId)!;
  }

  getMessage(messageId: string): QueueMessage | undefined {
    const row = this.db.prepare(`SELECT * FROM messages WHERE message_id = ?`).get(messageId) as StoredMessage | undefined;
    return row ? this.toMessage(row) : undefined;
  }

  configureLeadWake(actor:Actor,template:unknown):void{
    this.assertCurrentBinding(actor);
    if(actor.roleId!=='lead')throw new CoordinatorError('FORBIDDEN','Only lead can configure its automatic wake template.','Use the authorized lead connection.');
    this.db.exec('CREATE TABLE IF NOT EXISTS lead_wake_config(group_id TEXT PRIMARY KEY,template_json TEXT NOT NULL)');
    this.db.prepare('INSERT INTO lead_wake_config VALUES(?,?) ON CONFLICT(group_id) DO UPDATE SET template_json=excluded.template_json').run(actor.groupId,JSON.stringify(template));
  }
  leadWakeTemplate(groupId:string):unknown|undefined{
    this.db.exec('CREATE TABLE IF NOT EXISTS lead_wake_config(group_id TEXT PRIMARY KEY,template_json TEXT NOT NULL)');
    const row=this.db.prepare('SELECT template_json FROM lead_wake_config WHERE group_id=?').get(groupId) as {template_json:string}|undefined;
    return row?JSON.parse(row.template_json):undefined;
  }
  leadInbox(groupId:string):QueueMessage[]{
    const rows=this.db.prepare("SELECT * FROM messages WHERE group_id=? AND recipient_role='lead' AND sender_role!='lead' AND status='queued' ORDER BY rowid").all(groupId) as unknown as StoredMessage[];
    return rows.map((row)=>this.toMessage(row));
  }

  executionOutbox(groupId: string): QueueMessage[] {
    const rows = this.db.prepare(`SELECT * FROM messages WHERE group_id=? AND status='queued' AND sender_role='lead' ORDER BY rowid`).all(groupId) as unknown as StoredMessage[];
    return rows.map((row) => this.toMessage(row)).filter((message) => message.payload.kind === 'execution_package');
  }

  claimSpecific(actor: Actor, messageId: string, leaseToken: string, leaseMs: number): ClaimedMessage {
    this.assertCurrentBinding(actor);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`SELECT * FROM messages WHERE message_id=? AND group_id=? AND recipient_role=? AND status='queued'`).get(messageId, actor.groupId, actor.roleId) as StoredMessage | undefined;
      if (!row) throw new CoordinatorError('STALE_LEASE', 'Dispatch message is not queued for this role.', 'Read and reconcile its delivery state.');
      const expiresAt = this.now() + leaseMs;
      this.db.prepare('INSERT INTO processing_leases(message_id, lease_token, role_id, binding_generation, expires_at) VALUES (?, ?, ?, ?, ?)').run(messageId, leaseToken, actor.roleId, actor.bindingGeneration, expiresAt);
      this.db.prepare(`UPDATE messages SET status='processing' WHERE message_id=?`).run(messageId);
      this.db.prepare('INSERT INTO delivery_attempts(message_id, role_id, attempted_at) VALUES (?, ?, ?)').run(messageId, actor.roleId, new Date(this.now()).toISOString());
      this.db.exec('COMMIT');
      return { ...this.toMessage({ ...row, status: 'processing' }), leaseToken, leaseExpiresAt: expiresAt };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  releaseExecutionBeforeStart(actor: Actor, messageId: string, token: string): void {
    this.assertCurrentBinding(actor);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const lease = this.db.prepare('SELECT l.message_id FROM processing_leases l JOIN messages m ON m.message_id=l.message_id WHERE l.message_id=? AND l.lease_token=? AND l.role_id=? AND l.binding_generation=? AND m.group_id=? AND m.status=?').get(messageId, token, actor.roleId, actor.bindingGeneration, actor.groupId, 'processing');
      if (!lease) throw new CoordinatorError('STALE_LEASE', 'Pre-start message claim changed.', 'Reconcile the dispatch claim.');
      this.db.prepare("UPDATE messages SET status='queued' WHERE message_id=?").run(messageId);
      this.db.prepare('DELETE FROM processing_leases WHERE message_id=? AND lease_token=?').run(messageId, token);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  claim(actor: Actor, leaseId: string, leaseMs: number, excludeExecution = false): ClaimedMessage | undefined {
    this.assertCurrentBinding(actor);
    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE messages SET status = 'needs_reconciliation' WHERE status='processing' AND message_id IN (SELECT message_id FROM processing_leases WHERE expires_at <= ?)`)
        .run(now);
      const row = this.db.prepare(`SELECT m.* FROM messages m JOIN roles r ON r.group_id = m.group_id AND r.role_id = ?
        JOIN runtime_bindings b ON b.group_id = r.group_id AND b.role_id = r.role_id
        WHERE m.group_id = ? AND m.recipient_role = ? AND m.status = 'queued' AND b.binding_generation = ?
        AND (? = 0 OR COALESCE(json_extract(m.payload_json, '$.kind'), '') <> 'execution_package')
        ORDER BY m.rowid LIMIT 1`)
        .get(actor.roleId, actor.groupId, actor.roleId, actor.bindingGeneration, excludeExecution ? 1 : 0) as StoredMessage | undefined;
      if (!row) { this.db.exec('COMMIT'); return undefined; }
      const expiresAt = now + leaseMs;
      this.db.prepare(`INSERT INTO processing_leases(message_id, lease_token, role_id, binding_generation, expires_at) VALUES (?, ?, ?, ?, ?)`)
        .run(row.message_id, leaseId, actor.roleId, actor.bindingGeneration, expiresAt);
      this.db.prepare(`UPDATE messages SET status = 'processing' WHERE message_id = ?`).run(row.message_id);
      this.db.prepare(`INSERT INTO delivery_attempts(message_id, role_id, attempted_at) VALUES (?, ?, ?)`)
        .run(row.message_id, actor.roleId, new Date(now).toISOString());
      this.db.exec('COMMIT');
      return { ...this.toMessage({ ...row, status: 'processing' }), leaseToken: leaseId, leaseExpiresAt: expiresAt };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  complete(actor: Actor, messageId: string, leaseToken: string, result: unknown): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const lease = this.db.prepare(`SELECT l.*, m.group_id, m.status, b.binding_generation AS current_binding_generation
        FROM processing_leases l JOIN messages m ON m.message_id = l.message_id
        JOIN runtime_bindings b ON b.group_id = m.group_id AND b.role_id = l.role_id WHERE l.message_id = ?`)
        .get(messageId) as (Record<string, unknown> & { lease_token: string; role_id: string; binding_generation: number; current_binding_generation: number; expires_at: number; group_id: string; status: string }) | undefined;
      if (!lease || lease.lease_token !== leaseToken || lease.group_id !== actor.groupId || lease.role_id !== actor.roleId || lease.binding_generation !== actor.bindingGeneration || lease.current_binding_generation !== actor.bindingGeneration || lease.expires_at <= this.now() || lease.status !== 'processing') {
        throw new CoordinatorError('STALE_LEASE', 'Claim lease is missing, expired, or belongs to a stale role binding.', 'Reconcile the request state and claim it again if it remains queued.');
      }
      this.db.prepare(`UPDATE messages SET status = 'completed', completed_at = ?, result_json = ? WHERE message_id = ?`)
        .run(new Date().toISOString(), JSON.stringify(result), messageId);
      this.db.prepare(`DELETE FROM processing_leases WHERE message_id = ?`).run(messageId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  renew(actor: Actor, messageId: string, leaseToken: string, leaseMs: number): number {
    this.assertCurrentBinding(actor);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const lease = this.db.prepare(`SELECT l.expires_at, l.binding_generation, m.group_id, m.status FROM processing_leases l
        JOIN messages m ON m.message_id=l.message_id WHERE l.message_id=? AND l.lease_token=? AND l.role_id=?`)
        .get(messageId, leaseToken, actor.roleId) as { expires_at: number; binding_generation: number; group_id: string; status: string } | undefined;
      if (!lease || lease.group_id !== actor.groupId || lease.binding_generation !== actor.bindingGeneration || lease.expires_at <= this.now() || lease.status !== 'processing') {
        throw new CoordinatorError('STALE_LEASE', 'Processing lease cannot be renewed.', 'Reconcile the current message state before continuing.');
      }
      const expiresAt = this.now() + leaseMs;
      this.db.prepare(`UPDATE processing_leases SET expires_at=? WHERE message_id=? AND lease_token=?`).run(expiresAt, messageId, leaseToken);
      this.db.exec('COMMIT');
      return expiresAt;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  events(groupId: string, afterSequence: number, limit: number): Array<{ sequence: number; type: string; payload: unknown; createdAt: string }> {
    const rows = this.db.prepare('SELECT rowid AS sequence,event_type,payload_json,created_at FROM event_log WHERE group_id=? AND rowid>? ORDER BY rowid LIMIT ?').all(groupId,afterSequence,limit) as Array<{ sequence: number; event_type: string; payload_json: string; created_at: string }>;
    return rows.map((row) => ({ sequence: row.sequence, type: row.event_type, payload: JSON.parse(row.payload_json), createdAt: row.created_at }));
  }

  fenceExecutionGroup(groupId: string): void {
    this.db.prepare("UPDATE messages SET status='needs_reconciliation' WHERE group_id=? AND status='processing' AND json_extract(payload_json,'$.kind')='execution_package'").run(groupId);
  }

  flagUncertain(actor: Actor, messageId: string): void {
    this.assertCurrentBinding(actor);
    const message = this.getMessage(messageId);
    if (!message || message.groupId !== actor.groupId || (actor.roleId !== 'lead' && actor.roleId !== message.recipientRole)) throw new CoordinatorError('FORBIDDEN', 'Only the owning role or lead can fence this message.', 'Use the bound role identity.');
    this.db.prepare("UPDATE messages SET status='needs_reconciliation' WHERE message_id=? AND status='processing'").run(messageId);
  }

  reconcile(actor: Actor, messageId: string, outcome: 'completed' | 'not_started' | 'unknown', evidence: string, result?: unknown): void {
    if (actor.roleId !== 'lead') throw new CoordinatorError('FORBIDDEN', 'Only the lead can reconcile an expired worker operation.', 'Submit the reconciliation evidence to the lead.');
    if (!evidence.trim()) throw new CoordinatorError('INVALID_INPUT', 'Reconciliation requires evidence.', 'Record the observed runtime or worker outcome.');
    const message = this.db.prepare(`SELECT group_id, status FROM messages WHERE message_id=?`).get(messageId) as { group_id: string; status: string } | undefined;
    if (!message || message.group_id !== actor.groupId || message.status !== 'needs_reconciliation') {
      throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Message is not in this group awaiting reconciliation.', 'Read the current message state before reconciliation.');
    }
    if (outcome === 'unknown') return;
    const status = outcome === 'completed' ? 'completed' : 'queued';
    this.db.prepare(`UPDATE messages SET status=?, completed_at=?, result_json=? WHERE message_id=?`)
      .run(status, outcome === 'completed' ? new Date(this.now()).toISOString() : null, outcome === 'completed' ? JSON.stringify(result) : null, messageId);
    this.db.prepare(`DELETE FROM processing_leases WHERE message_id=?`).run(messageId);
    this.db.prepare(`INSERT INTO event_log(group_id, event_type, payload_json, created_at) VALUES (?, 'message.reconciled', ?, ?)`)
      .run(actor.groupId, JSON.stringify({ messageId, outcome, evidence }), new Date(this.now()).toISOString());
  }

  private toMessage(row: StoredMessage): QueueMessage {
    return {
      messageId: row.message_id,
      groupId: row.group_id,
      senderRole: row.sender_role as RoleId,
      recipientRole: row.recipient_role as RoleId,
      bindingGeneration: row.binding_generation,
      type: row.type,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      operationId: row.operation_id,
      createdAt: row.created_at,
      status: row.status
    };
  }

  private assertCurrentBinding(actor: Actor): void {
    const row = this.db.prepare(`SELECT binding_generation FROM runtime_bindings WHERE group_id=? AND role_id=?`)
      .get(actor.groupId, actor.roleId) as { binding_generation: number } | undefined;
    if (!row || row.binding_generation !== actor.bindingGeneration) {
      throw new CoordinatorError('FORBIDDEN', 'Role binding generation is stale.', 'Refresh the role binding before sending or claiming messages.');
    }
  }
}
