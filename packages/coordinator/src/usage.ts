import { DatabaseSync } from 'node:sqlite';

export interface UsageCounters { inputTokens: number; outputTokens: number; cachedInputTokens?: number; }
export interface UsageSnapshot { snapshotId: string; groupId: string; roleId: string; threadId: string; capturedAt: string; totals: UsageCounters; }

export class UsageLedger {
  private readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS usage_snapshot_events(snapshot_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, role_id TEXT NOT NULL, thread_id TEXT NOT NULL, captured_at TEXT NOT NULL, payload_json TEXT NOT NULL);`);
  }

  close(): void { this.db.close(); }

  record(snapshot: UsageSnapshot): boolean {
    const existing = this.db.prepare(`SELECT payload_json FROM usage_snapshot_events WHERE snapshot_id=?`).get(snapshot.snapshotId) as { payload_json: string } | undefined;
    if (existing) {
      if (existing.payload_json !== JSON.stringify(snapshot)) throw new Error('Usage snapshot ID was reused with changed contents.');
      return false;
    }
    const previous = this.current(snapshot.groupId, snapshot.roleId, snapshot.threadId);
    this.db.prepare(`INSERT INTO usage_snapshot_events(snapshot_id,group_id,role_id,thread_id,captured_at,payload_json) VALUES (?,?,?,?,?,?)`)
      .run(snapshot.snapshotId, snapshot.groupId, snapshot.roleId, snapshot.threadId, snapshot.capturedAt, JSON.stringify(snapshot));
    return !previous || Date.parse(snapshot.capturedAt) > Date.parse(previous.capturedAt);
  }

  current(groupId: string, roleId: string, threadId: string): UsageSnapshot | undefined {
    const row = this.db.prepare(`SELECT payload_json FROM usage_snapshot_events WHERE group_id=? AND role_id=? AND thread_id=? ORDER BY captured_at DESC, rowid DESC LIMIT 1`)
      .get(groupId, roleId, threadId) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as UsageSnapshot : undefined;
  }
}
