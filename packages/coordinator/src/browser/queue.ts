import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { CoordinatorError } from '../errors.js';
import type { Actor, RoleId } from '../protocol.js';

export interface BrowserRequest { requestId: string; groupId: string; roleId: RoleId; payload: unknown; operationId: string; state: 'queued' | 'claimed' | 'running' | 'needs_reconciliation' | 'completed' | 'failed'; createdAt: string; }
export interface BrowserClaim { requestId: string; leaseToken: string; roleId: RoleId; expiresAt: number; payload: unknown; }

export class BrowserQueue {
  private readonly db: DatabaseSync;
  private clockOffset = 0;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS browser_requests(request_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, role_id TEXT NOT NULL, payload_json TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS browser_lease(singleton INTEGER PRIMARY KEY CHECK(singleton=1), request_id TEXT NOT NULL UNIQUE, role_id TEXT NOT NULL, lease_token TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS browser_events(event_id INTEGER PRIMARY KEY, request_id TEXT NOT NULL, outcome TEXT NOT NULL, evidence TEXT NOT NULL, created_at TEXT NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS browser_resources(request_id TEXT NOT NULL,target_id TEXT NOT NULL,resource_json TEXT NOT NULL,cleared INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(request_id,target_id))');
    const columns=this.db.prepare('PRAGMA table_info(browser_lease)').all() as Array<{name:string}>;
    if(!columns.some((column)=>column.name==='binding_generation'))this.db.exec('ALTER TABLE browser_lease ADD COLUMN binding_generation INTEGER NOT NULL DEFAULT 1');
  }

  close(): void { this.db.close(); }
  advanceClock(ms: number): void { this.clockOffset += ms; }

  enqueue(groupId: string, roleId: RoleId, payload: unknown, operationId: string): BrowserRequest {
    const payloadJson = JSON.stringify(payload);
    if (payloadJson === undefined) throw new CoordinatorError('INVALID_INPUT', 'Browser request payload must be JSON serializable.', 'Send a JSON object payload.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare(`SELECT * FROM browser_requests WHERE operation_id = ?`).get(operationId) as Record<string, unknown> | undefined;
      if (existing) {
        if (existing.group_id !== groupId || existing.role_id !== roleId || existing.payload_json !== payloadJson) throw new CoordinatorError('IDEMPOTENCY_CONFLICT', 'Browser operation ID is already used for another request.', 'Use a new operation ID for changed browser work.');
        this.db.exec('COMMIT');
        return this.toRequest(existing);
      }
      const requestId = randomUUID();
      this.db.prepare(`INSERT INTO browser_requests(request_id, group_id, role_id, payload_json, operation_id, state, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)`)
        .run(requestId, groupId, roleId, payloadJson, operationId, new Date(this.now()).toISOString());
      this.db.exec('COMMIT');
      return this.get(requestId)!;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  claim(roleId: RoleId, leaseToken: string = randomUUID(), leaseMs = 30_000, groupId?: string, generation = 1): BrowserClaim | undefined {
    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const active = this.db.prepare(`SELECT l.*, r.state FROM browser_lease l JOIN browser_requests r ON r.request_id=l.request_id WHERE l.singleton=1`).get() as (Record<string, unknown> & { expires_at: number; request_id: string; state: string }) | undefined;
      if (active) {
        if (active.expires_at > now) { this.db.exec('COMMIT'); return undefined; }
        if (active.state === 'running' || active.state === 'needs_reconciliation') {
          this.db.prepare(`UPDATE browser_requests SET state='needs_reconciliation' WHERE request_id=?`).run(active.request_id);
          this.db.exec('COMMIT');
          return undefined;
        }
        this.db.prepare(`UPDATE browser_requests SET state='queued' WHERE request_id=? AND state='claimed'`).run(active.request_id);
        this.db.prepare(`DELETE FROM browser_lease WHERE singleton=1`).run();
      }
      const request = this.db.prepare(`SELECT * FROM browser_requests WHERE state='queued' AND (? IS NULL OR group_id=?) ORDER BY rowid LIMIT 1`).get(groupId ?? null, groupId ?? null) as Record<string, unknown> | undefined;
      if (!request) { this.db.exec('COMMIT'); return undefined; }
      const expiresAt = now + leaseMs;
      this.db.prepare(`INSERT INTO browser_lease(singleton, request_id, role_id, lease_token, expires_at, binding_generation) VALUES (1, ?, ?, ?, ?, ?)`)
        .run(String(request.request_id), roleId, leaseToken, expiresAt, generation);
      this.db.prepare(`UPDATE browser_requests SET state='claimed' WHERE request_id=?`).run(String(request.request_id));
      this.db.exec('COMMIT');
      return { requestId: String(request.request_id), leaseToken, roleId, expiresAt, payload: JSON.parse(String(request.payload_json)) as unknown };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  resourceCreated(requestId:string,token:string,resource:{targetId:string;contextId?:string}):void{
    if(!this.currentLease(requestId,token))throw new CoordinatorError('STALE_LEASE','Resource registration lost its browser lease.','Retain the request for reconciliation.');
    this.db.prepare('INSERT OR IGNORE INTO browser_resources(request_id,target_id,resource_json) VALUES(?,?,?)').run(requestId,resource.targetId,JSON.stringify(resource));
  }
  resourceClosed(requestId:string,resource:{targetId:string}):void{this.db.prepare('UPDATE browser_resources SET cleared=1 WHERE request_id=? AND target_id=?').run(requestId,resource.targetId);}
  resources(requestId:string):Array<{targetId:string;contextId?:string;cleared:boolean}>{
    return(this.db.prepare('SELECT resource_json,cleared FROM browser_resources WHERE request_id=?').all(requestId) as Array<{resource_json:string;cleared:number}>).map((row)=>({...JSON.parse(row.resource_json),cleared:Boolean(row.cleared)}));
  }

  assertActorLease(actor: Actor, requestId: string, token: string): void {
    const lease=this.currentLease(requestId,token);
    if(!lease||lease.expires_at<=this.now()||lease.role_id!==actor.roleId||lease.binding_generation!==actor.bindingGeneration||this.get(requestId)?.groupId!==actor.groupId)throw new CoordinatorError('STALE_LEASE','Browser lease does not belong to this role binding.','Claim or reconcile the browser request with its current identity.');
  }
  flagUncertain(requestId:string,token:string):void{
    if(this.currentLease(requestId,token))this.db.prepare("UPDATE browser_requests SET state='needs_reconciliation' WHERE request_id=? AND state='running'").run(requestId);
  }
  recover(groupId:string):void{
    this.db.prepare("UPDATE browser_requests SET state='needs_reconciliation' WHERE group_id=? AND state='running'").run(groupId);
  }

  markStarted(requestId: string, leaseToken: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const lease = this.currentLease(requestId, leaseToken);
      if (!lease || lease.expires_at <= this.now()) throw new CoordinatorError('STALE_LEASE', 'Browser lease is stale.', 'Reconcile current browser activity before retrying.');
      const updated = this.db.prepare(`UPDATE browser_requests SET state='running' WHERE request_id=? AND state='claimed'`).run(requestId);
      if (updated.changes !== 1) throw new CoordinatorError('STALE_LEASE', 'Browser request is no longer claimable.', 'Reconcile current browser activity before retrying.');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  release(requestId: string, leaseToken: string): boolean {
    return this.releaseBeforeStart(requestId, leaseToken);
  }

  releaseBeforeStart(requestId: string, leaseToken: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const lease = this.currentLease(requestId, leaseToken);
      if (!lease || lease.expires_at <= this.now()) { this.db.exec('COMMIT'); return false; }
      const updated = this.db.prepare(`UPDATE browser_requests SET state='queued' WHERE request_id=? AND state='claimed'`).run(requestId);
      if (updated.changes !== 1) { this.db.exec('COMMIT'); return false; }
      this.db.prepare(`DELETE FROM browser_lease WHERE singleton=1 AND request_id=? AND lease_token=?`).run(requestId, leaseToken);
      this.db.exec('COMMIT');
      return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  finish(requestId: string, leaseToken: string, state: 'completed' | 'failed'): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const lease = this.currentLease(requestId, leaseToken);
      if (!lease || lease.expires_at <= this.now()) throw new CoordinatorError('STALE_LEASE', 'Browser lease is stale.', 'Reconcile browser state before writing a result.');
      const updated = this.db.prepare(`UPDATE browser_requests SET state=? WHERE request_id=? AND state='running'`).run(state, requestId);
      if (updated.changes !== 1) throw new CoordinatorError('STALE_LEASE', 'Browser request is no longer running.', 'Reconcile browser state before writing a result.');
      this.db.prepare(`DELETE FROM browser_lease WHERE singleton=1 AND request_id=? AND lease_token=?`).run(requestId, leaseToken);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  reconcile(requestId: string, outcome: 'completed' | 'not_started' | 'unknown', evidence: string): void {
    if (!evidence.trim()) throw new CoordinatorError('INVALID_INPUT', 'Browser reconciliation requires observed evidence.', 'Inspect current Edge state and record what was observed.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const request = this.get(requestId);
      if (!request || request.state !== 'needs_reconciliation') throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Browser request is not awaiting reconciliation.', 'Inspect current Edge state before claiming more work.');
      if (outcome !== 'unknown') {
        this.db.prepare(`UPDATE browser_requests SET state=? WHERE request_id=?`).run(outcome === 'completed' ? 'completed' : 'queued', requestId);
        this.db.prepare(`DELETE FROM browser_lease WHERE singleton=1 AND request_id=?`).run(requestId);
      }
      this.db.prepare(`INSERT INTO browser_events(request_id,outcome,evidence,created_at) VALUES (?,?,?,?)`).run(requestId, outcome, evidence, new Date(this.now()).toISOString());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  get(requestId: string): BrowserRequest | undefined {
    const row = this.db.prepare(`SELECT * FROM browser_requests WHERE request_id=?`).get(requestId) as Record<string, unknown> | undefined;
    return row ? this.toRequest(row) : undefined;
  }

  private currentLease(requestId: string, leaseToken: string): (Record<string, unknown> & { expires_at: number }) | undefined {
    return this.db.prepare(`SELECT * FROM browser_lease WHERE singleton=1 AND request_id=? AND lease_token=?`).get(requestId, leaseToken) as (Record<string, unknown> & { expires_at: number }) | undefined;
  }

  private now(): number { return Date.now() + this.clockOffset; }
  private toRequest(row: Record<string, unknown>): BrowserRequest {
    return { requestId: String(row.request_id), groupId: String(row.group_id), roleId: row.role_id as RoleId, payload: JSON.parse(String(row.payload_json)) as unknown, operationId: String(row.operation_id), state: row.state as BrowserRequest['state'], createdAt: String(row.created_at) };
  }
}
