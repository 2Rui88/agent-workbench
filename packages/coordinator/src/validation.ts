import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { CoordinatorError } from './errors.js';
import type { Actor } from './protocol.js';

export type ValidationOutcome = 'passed' | 'rejected' | 'error';
export interface ValidationRun { validationId: string; groupId: string; contractRef: string; baselineRef: string; cycle: number; state: 'running' | ValidationOutcome; evidence: Array<{ command: string; outcome: string; summary: string }>; createdAt: string; }

export class ValidationRegistry {
  private readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS validation_runs(validation_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, contract_id TEXT, state TEXT NOT NULL, payload_json TEXT NOT NULL);`);
  }

  close(): void { this.db.close(); }

  create(actor: Actor, contractRef: string, baselineRef: string): ValidationRun {
    if (actor.roleId !== 'audit') throw new CoordinatorError('FORBIDDEN', 'Only the audit role can start a validation cycle.', 'Request an audit cycle from the audit role.');
    const prior = this.db.prepare(`SELECT payload_json FROM validation_runs WHERE group_id=? AND contract_id=? ORDER BY rowid DESC LIMIT 1`).get(actor.groupId, contractRef) as { payload_json: string } | undefined;
    const cycle = prior ? (JSON.parse(prior.payload_json) as ValidationRun).cycle + 1 : 1;
    const run: ValidationRun = { validationId: randomUUID(), groupId: actor.groupId, contractRef, baselineRef, cycle, state: 'running', evidence: [], createdAt: new Date().toISOString() };
    this.db.prepare(`INSERT INTO validation_runs(validation_id,group_id,contract_id,state,payload_json) VALUES (?,?,?,?,?)`).run(run.validationId, run.groupId, contractRef, run.state, JSON.stringify(run));
    return run;
  }

  record(actor: Actor, validationId: string, outcome: ValidationOutcome, evidence: ValidationRun['evidence']): ValidationRun {
    if (actor.roleId !== 'audit') throw new CoordinatorError('FORBIDDEN', 'Only the audit role can record validation results.', 'Submit evidence to the audit role.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const run = this.get(validationId);
      if (!run || run.groupId !== actor.groupId || run.state !== 'running') throw new CoordinatorError('VALIDATION_CYCLE_CLOSED', 'Validation cycle is missing or already closed.', 'Create a new validation cycle against the new baseline.');
      if (outcome === 'passed' && (evidence.length === 0 || evidence.some((item) => item.outcome !== 'passed'))) throw new CoordinatorError('INVALID_INPUT', 'Passing validation requires all-passed evidence.', 'Attach successful command evidence for this exact baseline.');
      const updated: ValidationRun = { ...run, state: outcome, evidence: [...evidence] };
      const result = this.db.prepare(`UPDATE validation_runs SET state=?,payload_json=? WHERE validation_id=? AND state='running'`).run(outcome, JSON.stringify(updated), validationId);
      if (result.changes !== 1) throw new CoordinatorError('VALIDATION_CYCLE_CLOSED', 'Validation cycle changed while recording evidence.', 'Read the cycle and start a new one if required.');
      this.db.exec('COMMIT');
      return updated;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  consecutiveRejections(groupId: string, contractRef: string): string[] {
    const rows = this.db.prepare('SELECT payload_json FROM validation_runs WHERE group_id=? AND contract_id=? ORDER BY rowid DESC LIMIT 50').all(groupId, contractRef) as Array<{ payload_json: string }>;
    const ids: string[] = [];
    for (const row of rows) { const run = JSON.parse(row.payload_json) as ValidationRun; if (run.state !== 'rejected') break; ids.push(run.validationId); }
    return ids;
  }

  latest(groupId: string, contractRef: string): ValidationRun | undefined {
    const row = this.db.prepare('SELECT payload_json FROM validation_runs WHERE group_id=? AND contract_id=? ORDER BY rowid DESC LIMIT 1').get(groupId,contractRef) as {payload_json:string}|undefined;
    return row ? JSON.parse(row.payload_json) as ValidationRun : undefined;
  }

  get(validationId: string): ValidationRun | undefined {
    const row = this.db.prepare(`SELECT payload_json FROM validation_runs WHERE validation_id=?`).get(validationId) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as ValidationRun : undefined;
  }
}
