import { DatabaseSync } from 'node:sqlite';
import { CoordinatorError } from '../errors.js';

export type ClaudeTurnStatus = 'inProgress' | 'completed' | 'failed' | 'interrupted' | 'unknown';
export interface ClaudeTurnRow { threadId: string; turnId: string; status: ClaudeTurnStatus; promptUuid: string | null; requestedModel: string; requestedEffort: string; initModel: string | null; apiKeySource: string | null; inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; costUsd: number | null; error: string | null; }

export class ClaudeTurnJournal {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS claude_threads(thread_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, materialized INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS claude_turns(turn_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, seq INTEGER NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL);');
  }
  close(): void { this.db.close(); }
  createThread(threadId: string, cwd: string): void {
    const existing = this.thread(threadId);
    if (existing && existing.cwd !== cwd) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Claude session belongs to another worktree.', 'Reconcile and rebind before switching worktrees.');
    this.db.prepare('INSERT OR IGNORE INTO claude_threads(thread_id,cwd,created_at) VALUES(?,?,?)').run(threadId, cwd, new Date().toISOString());
  }
  thread(threadId: string): { threadId: string; cwd: string; materialized: boolean } | undefined {
    const row = this.db.prepare('SELECT thread_id,cwd,materialized FROM claude_threads WHERE thread_id=?').get(threadId) as { thread_id: string; cwd: string; materialized: number } | undefined;
    return row ? { threadId: row.thread_id, cwd: row.cwd, materialized: row.materialized === 1 } : undefined;
  }
  markMaterialized(threadId: string): void { this.db.prepare('UPDATE claude_threads SET materialized=1 WHERE thread_id=?').run(threadId); }
  startTurn(input: { threadId: string; turnId: string; requestedModel: string; requestedEffort: string }): void {
    const row: ClaudeTurnRow = { ...input, status: 'inProgress', promptUuid: null, initModel: null, apiKeySource: null, inputTokens: null, outputTokens: null, cachedInputTokens: null, costUsd: null, error: null };
    const seq = (this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS next FROM claude_turns WHERE thread_id=?').get(input.threadId) as { next: number }).next;
    this.db.prepare('INSERT INTO claude_turns(turn_id,thread_id,seq,status,payload_json) VALUES(?,?,?,?,?)').run(input.turnId, input.threadId, seq, row.status, JSON.stringify(row));
  }
  update(turnId: string, patch: Partial<ClaudeTurnRow>): void {
    const current = this.turn(turnId);
    if (!current) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Claude turn is unknown.', 'Inspect the original turn before updating it.');
    const next = { ...current, ...patch, turnId: current.turnId, threadId: current.threadId };
    this.db.prepare('UPDATE claude_turns SET status=?,payload_json=? WHERE turn_id=?').run(next.status, JSON.stringify(next), turnId);
  }
  turn(turnId: string): ClaudeTurnRow | undefined {
    const row = this.db.prepare('SELECT payload_json FROM claude_turns WHERE turn_id=?').get(turnId) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as ClaudeTurnRow : undefined;
  }
  // 1-based position of the turn in its session; matches the n-th prompt line of the transcript.
  turnIndex(turnId: string): number | undefined {
    return (this.db.prepare('SELECT seq FROM claude_turns WHERE turn_id=?').get(turnId) as { seq: number } | undefined)?.seq;
  }
  turns(threadId: string): Array<{ id: string; status: ClaudeTurnStatus }> {
    return (this.db.prepare('SELECT turn_id,status FROM claude_turns WHERE thread_id=? ORDER BY seq').all(threadId) as Array<{ turn_id: string; status: ClaudeTurnStatus }>).map((row) => ({ id: row.turn_id, status: row.status }));
  }
  // A restarted daemon cannot still own a previous instance's in-progress turn.
  markOrphans(threadId: string, liveTurnIds: Set<string>): number {
    let count = 0;
    for (const turn of this.turns(threadId)) if (turn.status === 'inProgress' && !liveTurnIds.has(turn.id)) { this.update(turn.id, { status: 'unknown', error: 'Runtime restarted before a terminal result was observed.' }); count++; }
    return count;
  }
}
