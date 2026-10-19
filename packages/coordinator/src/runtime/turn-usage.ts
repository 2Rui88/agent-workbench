import { DatabaseSync } from 'node:sqlite';
import { CoordinatorError } from '../errors.js';
import type { AgentKind, RoleId } from '../roles.js';
import type { TurnUsage } from './types.js';

export const CODEX_USAGE_METHOD = 'thread/tokenUsage/updated';
export interface UsageCounters { inputTokens: number; cachedInputTokens: number; outputTokens: number; }
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
function counters(value: unknown): UsageCounters | undefined {
  const raw = value as { inputTokens?: unknown; cachedInputTokens?: unknown; outputTokens?: unknown } | undefined;
  const inputTokens = count(raw?.inputTokens), cachedInputTokens = count(raw?.cachedInputTokens), outputTokens = count(raw?.outputTokens);
  return inputTokens === undefined || cachedInputTokens === undefined || outputTokens === undefined ? undefined : { inputTokens, cachedInputTokens, outputTokens };
}

export function codexUsageFromNotification(params: unknown): { threadId: string; turnId: string; last: UsageCounters; total: UsageCounters } | undefined {
  const value = params as { threadId?: unknown; turnId?: unknown; tokenUsage?: { last?: unknown; total?: unknown } } | undefined;
  const last = counters(value?.tokenUsage?.last), total = counters(value?.tokenUsage?.total);
  if (typeof value?.threadId !== 'string' || typeof value.turnId !== 'string' || !last || !total) return undefined;
  return { threadId: value.threadId, turnId: value.turnId, last, total };
}

export class TurnUsageLedger {
  private readonly db: DatabaseSync;
  constructor(path: string) { this.db = new DatabaseSync(path); this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS turn_usage(dispatch_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, role_id TEXT NOT NULL, agent TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, payload_json TEXT NOT NULL, recorded_at TEXT NOT NULL)'); }
  close(): void { this.db.close(); }
  record(input: { groupId: string; roleId: RoleId; agent: AgentKind; dispatchId: string; threadId: string; turnId: string; usage: TurnUsage }): void {
    const payload = JSON.stringify({ ...input.usage, agent: input.agent });
    const existing = this.db.prepare('SELECT payload_json,turn_id FROM turn_usage WHERE dispatch_id=?').get(input.dispatchId) as { payload_json: string; turn_id: string } | undefined;
    if (existing) { if (existing.payload_json !== payload || existing.turn_id !== input.turnId) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Recorded turn usage conflicts with new evidence.', 'Keep the original usage record and inspect the runtime.'); return; }
    this.db.prepare('INSERT INTO turn_usage VALUES(?,?,?,?,?,?,?,?)').run(input.dispatchId, input.groupId, input.roleId, input.agent, input.threadId, input.turnId, payload, new Date().toISOString());
  }
  get(dispatchId: string): (TurnUsage & { agent: AgentKind }) | undefined {
    const row = this.db.prepare('SELECT payload_json FROM turn_usage WHERE dispatch_id=?').get(dispatchId) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as TurnUsage & { agent: AgentKind } : undefined;
  }
}
