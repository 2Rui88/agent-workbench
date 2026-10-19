import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Actor } from './protocol.js';
import { CoordinatorError } from './errors.js';

export interface PendingApproval { id: string; groupId: string; roleId: string; runtimeId: string; runtimeRequestId: string | number; method: string; params: unknown; state: string; }
export class ApprovalBridge {
  private readonly db: DatabaseSync;
  private readonly humanHash: Buffer;
  constructor(path: string, humanCapability: string) {
    this.humanHash = this.hash(humanCapability); this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS approval_requests(id TEXT PRIMARY KEY, group_id TEXT NOT NULL, payload_json TEXT NOT NULL, state TEXT NOT NULL, decision_json TEXT);`);
  }
  close(): void { this.db.close(); }
  enqueue(actor: Actor, runtimeId: string, runtimeRequestId: string | number, method: string, params: unknown): PendingApproval {
    const approval: PendingApproval = { id: randomUUID(), groupId: actor.groupId, roleId: actor.roleId, runtimeId, runtimeRequestId, method, params, state: 'waiting_human' };
    this.db.prepare(`INSERT INTO approval_requests(id, group_id, payload_json, state) VALUES (?, ?, ?, 'waiting_human')`).run(approval.id, actor.groupId, JSON.stringify(approval));
    return approval;
  }
  list(groupId: string): PendingApproval[] {
    return (this.db.prepare(`SELECT payload_json, state FROM approval_requests WHERE group_id=? AND state NOT IN ('replied','stale')`).all(groupId) as Array<{ payload_json: string; state: string }>).map((row) => ({ ...JSON.parse(row.payload_json) as PendingApproval, state: row.state }));
  }
  authenticate(capability: string): void { if (!timingSafeEqual(this.hash(capability), this.humanHash)) throw new CoordinatorError('FORBIDDEN', 'Independent human capability is required.', 'Use the separate human control channel.'); }
  async respond(id: string, capability: string, decision: 'accept' | 'decline' | 'cancel', runtimeId: string, respond: (requestId: string | number, result: unknown) => Promise<void>): Promise<void> {
    this.authenticate(capability);
    const row = this.db.prepare('SELECT payload_json, state FROM approval_requests WHERE id=?').get(id) as { payload_json: string; state: string } | undefined;
    const approval = row ? JSON.parse(row.payload_json) as PendingApproval : undefined;
    if (!row || row.state !== 'waiting_human' || approval?.runtimeId !== runtimeId) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Approval is stale, replied, or tied to another runtime instance.', 'Inspect the current runtime request; never replay an approval blindly.');
    if (!['accept', 'decline', 'cancel'].includes(decision)) throw new CoordinatorError('INVALID_INPUT', 'Invalid approval decision.', 'Choose accept, decline, or cancel.');
    const elicitation = approval.method === 'mcpServer/elicitation/request';
    const params = approval.params as {mode?:string;_meta?:{codex_approval_kind?:string};requestedSchema?:{type?:string;properties?:Record<string,unknown>;required?:string[]}};
    const emptyToolForm = params?.mode === 'form' && params._meta?.codex_approval_kind === 'mcp_tool_call' && params.requestedSchema?.type === 'object' && params.requestedSchema.properties !== undefined && Object.keys(params.requestedSchema.properties).length === 0 && !(params.requestedSchema.required?.length);
    if ((!elicitation && !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'claude/canUseTool'].includes(approval.method)) || (elicitation && decision === 'accept' && !emptyToolForm)) throw new CoordinatorError('INVALID_INPUT', 'This approval needs structured input or an unsupported response.', 'Use native form or URL handling; this CLI accepts only empty MCP tool approval forms.');
    const result = elicitation ? {action:decision,...(decision === 'accept' ? {content:{}} : {})} : {decision};
    const claimed = this.db.prepare(`UPDATE approval_requests SET state='responding', decision_json=? WHERE id=? AND state='waiting_human'`).run(JSON.stringify(result), id);
    if (claimed.changes !== 1) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Approval is already being answered.', 'Inspect the recorded result before retrying.');
    try { await respond(approval.runtimeRequestId, result); this.db.prepare(`UPDATE approval_requests SET state='replied' WHERE id=?`).run(id); }
    catch (error) { this.db.prepare(`UPDATE approval_requests SET state='unknown' WHERE id=?`).run(id); throw error; }
  }
  private hash(value: string): Buffer { return createHash('sha256').update(value).digest(); }
}
