import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { CoordinatorError } from './errors.js';
import type { Actor } from './protocol.js';

export class OperationLedger {
  private readonly db: DatabaseSync;
  constructor(path: string) { this.db = new DatabaseSync(path); this.db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS coordination_operations(group_id TEXT NOT NULL,role_id TEXT NOT NULL,operation_id TEXT NOT NULL,command TEXT NOT NULL,input_hash TEXT NOT NULL,state TEXT NOT NULL,result_json TEXT,PRIMARY KEY(group_id,role_id,operation_id));"); }
  close(): void { this.db.close(); }
  replay(actor:Actor,command:string,operationId:string,input:unknown):{found:boolean;result?:unknown}{
    const previous=this.get(actor,operationId);
    if(!previous)return{found:false};
    const hash=createHash('sha256').update(JSON.stringify({command,input})).digest('hex');
    if(previous.input_hash!==hash)throw new CoordinatorError('IDEMPOTENCY_CONFLICT','Operation ID has different command contents.','Use the original request.');
    if(previous.state!=='completed')throw new CoordinatorError('RECONCILIATION_REQUIRED','Previous operation has an unknown result.','Inspect the durable authority before repeating.');
    return{found:true,result:JSON.parse(previous.result_json!)};
  }
  async run(actor: Actor, command: string, operationId: string, input: unknown, execute: () => unknown | Promise<unknown>): Promise<unknown> {
    const hash = createHash('sha256').update(JSON.stringify({ command, input })).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.get(actor, operationId);
      if (previous) {
        if (previous.input_hash !== hash) throw new CoordinatorError('IDEMPOTENCY_CONFLICT', 'Operation ID has different command contents.', 'Use the original request or a new operation ID for new work.');
        if (previous.state !== 'completed') throw new CoordinatorError('RECONCILIATION_REQUIRED', 'An earlier operation has no confirmed receipt.', 'Inspect its durable and external results before repeating any write.');
        this.db.exec('COMMIT'); return JSON.parse(previous.result_json!);
      }
      this.db.prepare("INSERT INTO coordination_operations(group_id,role_id,operation_id,command,input_hash,state) VALUES(?,?,?,?,?,'unknown')").run(actor.groupId, actor.roleId, operationId, command, hash);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    const result = await execute();
    this.db.prepare("UPDATE coordination_operations SET state='completed',result_json=? WHERE group_id=? AND role_id=? AND operation_id=?").run(JSON.stringify(result), actor.groupId, actor.roleId, operationId);
    return result;
  }
  get(actor: Actor, operationId: string): { state: string; command: string; input_hash: string; result_json: string | null } | undefined {
    return this.db.prepare('SELECT state,command,input_hash,result_json FROM coordination_operations WHERE group_id=? AND role_id=? AND operation_id=?').get(actor.groupId, actor.roleId, operationId) as { state: string; command: string; input_hash: string; result_json: string | null } | undefined;
  }
}
