import { DatabaseSync } from 'node:sqlite';
import type { Actor } from './protocol.js';
import type { AgentKind } from './roles.js';
import { CoordinatorError } from './errors.js';

export interface LeadSuccession { at: string; fromSession: string; fromAgent: string | null; toSession: string; toAgent: string | null; generation: number; }
export class ExternalLead {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly groupId: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS external_lead(group_id TEXT PRIMARY KEY, session_ref TEXT NOT NULL, worktree_path TEXT NOT NULL, generation INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
    try { this.db.exec('ALTER TABLE external_lead ADD COLUMN agent TEXT'); } catch { /* column already exists */ }
    this.db.exec('CREATE TABLE IF NOT EXISTS lead_successions(id INTEGER PRIMARY KEY, group_id TEXT NOT NULL, at TEXT NOT NULL, from_session TEXT NOT NULL, from_agent TEXT, to_session TEXT NOT NULL, to_agent TEXT, generation INTEGER NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS runtime_observation(group_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL)');
  }
  heartbeat(actor: Actor, sessionRef: string, cwd: string, agent: AgentKind | null = null): void {
    if (actor.roleId !== 'lead' || actor.groupId !== this.groupId) throw new CoordinatorError('FORBIDDEN', 'Only the external lead can register presence.', 'Use the lead connection.');
    const existing = this.snapshot();
    const changed = existing && (existing.session_ref !== sessionRef || existing.worktree_path !== cwd || (existing.agent !== null && agent !== null && existing.agent !== agent));
    if (changed) {
      // A different lead may take over once the previous presence has expired; human rotation stays available as an override.
      if (existing.expires_at > Date.now()) throw new CoordinatorError('LEAD_CONFLICT', 'Another lead session is registered for this group.', 'Wait for the previous lead to exit (presence expires after 60s) or stop it, then attach again.');
      this.db.prepare('INSERT INTO lead_successions(group_id,at,from_session,from_agent,to_session,to_agent,generation) VALUES(?,?,?,?,?,?,?)').run(this.groupId, new Date().toISOString(), existing.session_ref, existing.agent, sessionRef, agent, actor.bindingGeneration);
      this.db.prepare('DELETE FROM external_lead WHERE group_id=?').run(this.groupId);
    }
    this.db.prepare('INSERT INTO external_lead(group_id,session_ref,worktree_path,generation,expires_at,agent) VALUES(?,?,?,?,?,?) ON CONFLICT(group_id) DO UPDATE SET generation=excluded.generation,expires_at=excluded.expires_at,agent=COALESCE(external_lead.agent,excluded.agent)').run(this.groupId, sessionRef, cwd, actor.bindingGeneration, Date.now() + 60_000, agent);
  }
  // A lead leaving normally expires its own presence so the next session need not wait 60s; other sessions are untouched.
  release(actor: Actor, sessionRef: string): boolean {
    if (actor.roleId !== 'lead' || actor.groupId !== this.groupId) throw new CoordinatorError('FORBIDDEN', 'Only the external lead can release presence.', 'Use the lead connection.');
    return this.db.prepare('UPDATE external_lead SET expires_at=0 WHERE group_id=? AND session_ref=?').run(this.groupId, sessionRef).changes > 0;
  }
  snapshot(): { session_ref: string; worktree_path: string; generation: number; expires_at: number; agent: string | null } | undefined {
    return this.db.prepare('SELECT session_ref,worktree_path,generation,expires_at,agent FROM external_lead WHERE group_id=?').get(this.groupId) as ReturnType<ExternalLead['snapshot']>;
  }
  successions(): LeadSuccession[] {
    return (this.db.prepare('SELECT at,from_session,from_agent,to_session,to_agent,generation FROM lead_successions WHERE group_id=? ORDER BY id').all(this.groupId) as Array<{ at: string; from_session: string; from_agent: string | null; to_session: string; to_agent: string | null; generation: number }>).map((row) => ({ at: row.at, fromSession: row.from_session, fromAgent: row.from_agent, toSession: row.to_session, toAgent: row.to_agent, generation: row.generation }));
  }
  expireForTest(): void { this.db.prepare('UPDATE external_lead SET expires_at=0 WHERE group_id=?').run(this.groupId); }
  close(): void { this.db.close(); }
  observe(value: unknown): void { this.db.prepare('INSERT INTO runtime_observation VALUES(?,?) ON CONFLICT(group_id) DO UPDATE SET payload_json=excluded.payload_json').run(this.groupId, JSON.stringify(value)); }
}
