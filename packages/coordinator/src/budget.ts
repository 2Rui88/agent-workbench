import { DatabaseSync } from 'node:sqlite';
import { CoordinatorError } from './errors.js';

export type BudgetPool = 'mock' | 'app_server' | 'mock_advisor' | 'advisor';
export interface MockBudget { maxCalls: number; maxConcurrent: number; }
// Call quota belongs to one human grant (grantRef); concurrency and unknown outcomes are group-wide.
export class ExecutionBudget {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly groupId: string, private readonly limit: MockBudget, private readonly source: BudgetPool = 'mock', private readonly grantRef?: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS execution_reservations(token TEXT PRIMARY KEY,group_id TEXT NOT NULL,dispatch_id TEXT NOT NULL,source TEXT NOT NULL,state TEXT NOT NULL,evidence TEXT);");
    const columns = this.db.prepare('PRAGMA table_info(execution_reservations)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'grant_ref')) this.db.exec('ALTER TABLE execution_reservations ADD COLUMN grant_ref TEXT');
  }
  close(): void { this.db.close(); }
  cancelBeforeStart(token: string): void { this.db.prepare("UPDATE execution_reservations SET state='cancelled',evidence='Confirmed no turn/start was sent' WHERE token=? AND group_id=? AND state='reserved'").run(token,this.groupId); }
  reserve(dispatchId: string, token: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const status = this.status();
      if (status.unknown > 0) throw new CoordinatorError('RECONCILIATION_REQUIRED','An execution budget reservation has an unknown outcome.','Reconcile the runtime before starting more work.');
      if (status.callsUsed >= this.limit.maxCalls || status.inFlight >= this.limit.maxConcurrent) throw new CoordinatorError('BUDGET_EXHAUSTED','Invocation quota or concurrency limit reached.','Keep work queued; complete active work or configure a new approved limit.');
      this.db.prepare("INSERT INTO execution_reservations(token,group_id,dispatch_id,source,state,grant_ref) VALUES(?,?,?,?,'reserved',?)").run(token,this.groupId,dispatchId,this.source,this.grantRef??null);
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  mark(token: string, state: 'started'|'completed'|'unknown', evidence?: string): void { this.db.prepare('UPDATE execution_reservations SET state=?,evidence=? WHERE group_id=? AND token=?').run(state,evidence??null,this.groupId,token); }
  reconcile(dispatchId: string, outcome: 'not_started'|'completed'|'started'|'unknown', evidence: string): void { this.db.prepare("UPDATE execution_reservations SET state=?,evidence=? WHERE group_id=? AND dispatch_id=? AND state IN ('reserved','started','unknown')").run(outcome==='completed'||outcome==='not_started'?'completed':'unknown',evidence,this.groupId,dispatchId); }
  recover(): void { this.db.prepare("UPDATE execution_reservations SET state='unknown' WHERE group_id=? AND state IN ('reserved','started')").run(this.groupId); }
  status(): { source: BudgetPool; callsUsed: number; inFlight: number; unknown: number; limits: MockBudget } {
    const row=this.db.prepare("SELECT COALESCE(sum(state!='cancelled' AND (? IS NULL OR grant_ref IS ?)),0) AS calls_used,COALESCE(sum(state IN ('reserved','started','unknown')),0) AS in_flight,COALESCE(sum(state='unknown'),0) AS unknown FROM execution_reservations WHERE group_id=? AND source=?").get(this.grantRef??null,this.grantRef??null,this.groupId,this.source) as {calls_used:number;in_flight:number;unknown:number};
    return {source:this.source,callsUsed:row.calls_used,inFlight:row.in_flight,unknown:row.unknown,limits:this.limit};
  }
}
