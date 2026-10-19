import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ROLE_IDS, roleEnum } from '../roles.js';
import type { DashboardSnapshot } from './contracts.js';

const observationSchema = z.object({
  observedAt: z.string().datetime(), source: z.enum(['mock','app_server']), leadMode: z.enum(['managed','external']),
  blocks: z.partialRecord(roleEnum, z.string().regex(/^[A-Z_]{1,64}$/)),
  limits: z.object({maxCalls:z.number().int().nonnegative(),maxConcurrent:z.number().int().min(1).max(4)}), grantExpiresAt:z.string().datetime().nullable()
}).passthrough().transform(({ observedAt, source, leadMode, blocks, limits, grantExpiresAt }) => ({ observedAt, source, leadMode, blocks, limits, grantExpiresAt }));
export class DashboardProjection {
  private readonly db: DatabaseSync;
  constructor(path: string) { this.db = new DatabaseSync(path, { readOnly: true }); this.db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000'); }
  close(): void { this.db.close(); }
  snapshot(groupId: string): DashboardSnapshot | undefined {
    this.db.exec('BEGIN');
    try {
      const group = this.db.prepare('SELECT status FROM groups WHERE group_id=?').get(groupId) as { status: string } | undefined;
      if (!group) { this.db.exec('COMMIT'); return undefined; }
      const has = (table: string) => Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
      const total = (table: string) => (this.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE group_id=?`).get(groupId) as { n: number }).n;
      const bindings = this.db.prepare('SELECT role_id,thread_id,worktree_path,binding_generation FROM runtime_bindings WHERE group_id=?').all(groupId) as Array<{ role_id: string; thread_id: string | null; worktree_path: string | null; binding_generation: number }>;
      const counts = this.db.prepare('SELECT recipient_role,status,count(*) AS n FROM messages WHERE group_id=? GROUP BY recipient_role,status').all(groupId) as Array<{ recipient_role: string; status: string; n: number }>;
      const dispatches = this.db.prepare('SELECT dispatch_id,role_id,work_id,state,turn_id,work_json,queued_at,started_at,evidence_json FROM scheduled_work WHERE group_id=? ORDER BY queued_at DESC,rowid DESC LIMIT 100').all(groupId) as Array<{ dispatch_id: string; role_id: string; work_id: string; state: string; turn_id: string | null; work_json: string; queued_at: number; started_at: number | null; evidence_json: string | null }>;
      const completedMessages = this.db.prepare('SELECT message_id,completed_at FROM messages WHERE group_id=? AND completed_at IS NOT NULL').all(groupId) as Array<{ message_id: string; completed_at: string | null }>;
      const epochIso = (value: unknown): string | null => { if (typeof value !== 'number' || !Number.isFinite(value)) return null; const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : null; };
      const parsedDate = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
      const modelRows=this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='runtime_models'").get()?this.db.prepare('SELECT dispatch_id,model,effort,source FROM runtime_models WHERE group_id=?').all(groupId) as Array<{dispatch_id:string;model:string;effort:string|null;source:string}>:[];
      const presence = this.db.prepare('SELECT role_id,binding_generation,expires_at FROM role_presence WHERE group_id=?').all(groupId) as Array<{ role_id: string; binding_generation: number; expires_at: number }>;
      const controls = this.db.prepare('SELECT role_id,mode FROM role_controls WHERE group_id=?').all(groupId) as Array<{ role_id: string; mode: 'human' | 'automatic' }>;
      const approvals = has('approval_requests') ? this.db.prepare("SELECT json_extract(payload_json,'$.roleId') AS role_id,count(*) AS n FROM approval_requests WHERE group_id=? AND state NOT IN ('replied','stale') GROUP BY role_id").all(groupId) as Array<{ role_id: string; n: number }> : [];
      const stale = has('approval_requests') ? this.db.prepare("SELECT json_extract(payload_json,'$.roleId') AS role_id,count(*) AS n FROM approval_requests WHERE group_id=? AND state='stale' GROUP BY role_id").all(groupId) as Array<{role_id:string;n:number}> : [];
      const contractRows = this.db.prepare('SELECT payload_json FROM contracts WHERE group_id=? ORDER BY version DESC LIMIT 100').all(groupId) as Array<{ payload_json: string }>;
      const auditRows = this.db.prepare('SELECT validation_id,state,payload_json FROM validation_runs WHERE group_id=? ORDER BY rowid DESC LIMIT 100').all(groupId) as Array<{ validation_id: string; state: string; payload_json: string }>;
      let textTruncated = false;
      const text = (value: unknown): string | null => { if (typeof value !== 'string') return null; if (value.length > 1024) { textTruncated = true; return value.slice(0,1024) + '…'; } return value; };
      const leadRow = has('external_lead') ? this.db.prepare('SELECT session_ref,expires_at FROM external_lead WHERE group_id=?').get(groupId) as { session_ref: string; expires_at: number } | undefined : undefined;
      const reservations = has('execution_reservations') ? this.db.prepare("SELECT source,COALESCE(sum(state!='cancelled'),0) AS used,COALESCE(sum(state IN ('reserved','started','unknown')),0) AS active,COALESCE(sum(state='unknown'),0) AS unknown FROM execution_reservations WHERE group_id=? GROUP BY source").all(groupId) as Array<{ source: string; used: number; active: number; unknown: number }> : [];
      const totals = { dispatches: total('scheduled_work'), contracts: total('contracts'), audits: total('validation_runs') };
      const snapshot: DashboardSnapshot = {
        runtime: has('runtime_observation') ? (() => { const row = this.db.prepare('SELECT payload_json FROM runtime_observation WHERE group_id=?').get(groupId) as { payload_json: string } | undefined; if (!row) return null; const parsed = observationSchema.safeParse(JSON.parse(row.payload_json)); return parsed.success ? parsed.data : null; })() : null,
        schemaVersion: 1, capturedAt: new Date().toISOString(), source: 'coordinator_sqlite', groupId, groupStatus: text(group.status) ?? 'unknown',
        roles: [...ROLE_IDS].map((roleId) => {
          const binding = bindings.find((row) => row.role_id === roleId);
          return { roleId, threadId: text(binding?.thread_id), worktreePath: text(binding?.worktree_path), bindingGeneration: binding?.binding_generation ?? 0,
            queued: counts.find((row) => row.recipient_role === roleId && row.status === 'queued')?.n ?? 0,
            online: presence.some((row) => row.role_id === roleId && row.binding_generation === binding?.binding_generation && row.expires_at > Date.now()),
            staleApprovals: stale.find(row=>row.role_id===roleId)?.n??0, controlOwner: controls.find((row) => row.role_id === roleId)?.mode ?? 'automatic', waitingHuman: approvals.find((row) => row.role_id === roleId)?.n ?? 0,
            dispatches: dispatches.filter((row) => row.role_id === roleId).map((row) => { const work = JSON.parse(row.work_json) as { replacesDispatchId?: unknown; model?: { model?: unknown; effort?: unknown } }; const queuedAt = epochIso(row.queued_at); const startedAt = epochIso(row.started_at); const completedAt = parsedDate(completedMessages.find(message => message.message_id === row.dispatch_id)?.completed_at); let reconciled = false; if (row.evidence_json) { try { reconciled = (JSON.parse(row.evidence_json) as { outcome?: unknown }).outcome === 'completed'; } catch { /* malformed evidence is treated as a normal receipt */ } } const durationMs = row.state === 'completed' && !reconciled && startedAt && completedAt ? Date.parse(completedAt) - Date.parse(startedAt) : null; return { dispatchId: text(row.dispatch_id)!, workId: text(row.work_id)!, state: text(row.state)!, requestedModel: text(work.model?.model), requestedEffort: text(work.model?.effort), actualModel: text(modelRows.find(m=>m.dispatch_id===row.dispatch_id)?.model), actualEffort:text(modelRows.find(m=>m.dispatch_id===row.dispatch_id)?.effort), actualModelSource:text(modelRows.find(m=>m.dispatch_id===row.dispatch_id)?.source), replacesDispatchId: text(work.replacesDispatchId), turnId: text(row.turn_id), queuedAt, startedAt, completedAt, durationMs: durationMs !== null && durationMs >= 0 ? durationMs : null }; }) };
        }),
        messageCounts: Object.fromEntries(counts.map((row) => [`${row.recipient_role}:${row.status}`, row.n])),
        contracts: contractRows.map((row) => { const value = JSON.parse(row.payload_json) as Record<string, unknown>; return { artifactRef: text(value.artifactRef) ?? 'unknown', revision: text(value.revision) ?? 'unknown', baselineRef: text(value.baselineRef) ?? 'unknown', compatibility: text(value.compatibility) ?? 'unknown' }; }),
        audits: auditRows.map((row) => { const value = JSON.parse(row.payload_json) as Record<string, unknown>; return { validationId: text(row.validation_id)!, contractRef: text(value.contractRef) ?? 'unknown', baselineRef: text(value.baselineRef) ?? 'unknown', cycle: typeof value.cycle === 'number' ? value.cycle : 0, state: text(row.state)! }; }),
        budget: reservations.length ? { source: reservations.length === 1 ? reservations[0]!.source : 'mixed', callsUsed: reservations.reduce((n, row) => n + row.used, 0), inFlight: reservations.reduce((n, row) => n + row.active, 0), unknown: reservations.reduce((n, row) => n + row.unknown, 0) } : null,
        lead: leadRow ? { mode: 'external', sessionRef: text(leadRow.session_ref), expiresAt: new Date(leadRow.expires_at).toISOString() } : { mode: bindings.some((row) => row.role_id === 'lead' && row.thread_id) ? 'managed' : 'unknown', sessionRef: null, expiresAt: null },
        totals, truncated: textTruncated || totals.dispatches > dispatches.length || totals.contracts > contractRows.length || totals.audits > auditRows.length
      };
      this.db.exec('COMMIT'); return snapshot;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
