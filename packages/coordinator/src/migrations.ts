import type { DatabaseSync } from 'node:sqlite';

export function migrate(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS groups (
      group_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS roles (
      group_id TEXT NOT NULL REFERENCES groups(group_id), role_id TEXT NOT NULL,
      PRIMARY KEY(group_id, role_id)
    );
    CREATE TABLE IF NOT EXISTS runtime_bindings (
      group_id TEXT NOT NULL, role_id TEXT NOT NULL, thread_id TEXT, binding_generation INTEGER NOT NULL,
      PRIMARY KEY(group_id, role_id), FOREIGN KEY(group_id, role_id) REFERENCES roles(group_id, role_id)
    );
    CREATE TABLE IF NOT EXISTS role_capabilities (
      group_id TEXT NOT NULL, role_id TEXT NOT NULL, token_hash TEXT NOT NULL,
      PRIMARY KEY(group_id, role_id), FOREIGN KEY(group_id, role_id) REFERENCES roles(group_id, role_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      message_id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(group_id), sender_role TEXT NOT NULL,
      recipient_role TEXT NOT NULL, binding_generation INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL,
      operation_id TEXT NOT NULL, operation_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL, completed_at TEXT, result_json TEXT,
      UNIQUE(group_id, sender_role, operation_id)
    );
    CREATE INDEX IF NOT EXISTS messages_queue ON messages(group_id, recipient_role, status, created_at);
    CREATE TABLE IF NOT EXISTS processing_leases (
      message_id TEXT PRIMARY KEY REFERENCES messages(message_id), lease_token TEXT NOT NULL,
      role_id TEXT NOT NULL, binding_generation INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS delivery_attempts (
      attempt_id INTEGER PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(message_id),
      role_id TEXT NOT NULL, attempted_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dispatch_runs (
      run_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, role_id TEXT NOT NULL, state TEXT NOT NULL, detail_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scheduler_snapshots (
      group_id TEXT PRIMARY KEY REFERENCES groups(group_id), payload_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scheduled_work (
      dispatch_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, role_id TEXT NOT NULL,
      work_id TEXT NOT NULL, work_json TEXT NOT NULL, operation_hash TEXT NOT NULL,
      state TEXT NOT NULL, queued_at INTEGER NOT NULL, started_at INTEGER, turn_id TEXT,
      lease_token TEXT, binding_generation INTEGER, expires_at INTEGER, evidence_json TEXT,
      UNIQUE(group_id, role_id, work_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS scheduled_role_slot ON scheduled_work(group_id, role_id)
      WHERE state IN ('starting', 'active', 'needs_reconciliation');
    CREATE UNIQUE INDEX IF NOT EXISTS scheduled_replacement ON scheduled_work(group_id,json_extract(work_json,'$.replacesDispatchId')) WHERE json_extract(work_json,'$.replacesDispatchId') IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS message_replacement ON messages(group_id,json_extract(payload_json,'$.replacesDispatchId')) WHERE json_extract(payload_json,'$.kind')='execution_package' AND json_extract(payload_json,'$.replacesDispatchId') IS NOT NULL;
    CREATE TABLE IF NOT EXISTS runtime_models (
      dispatch_id TEXT PRIMARY KEY REFERENCES scheduled_work(dispatch_id), group_id TEXT NOT NULL, role_id TEXT NOT NULL,
      thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, source TEXT NOT NULL, observed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS role_presence (
      group_id TEXT NOT NULL, role_id TEXT NOT NULL, binding_generation INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      PRIMARY KEY(group_id, role_id)
    );
    CREATE TABLE IF NOT EXISTS role_controls (
      group_id TEXT NOT NULL, role_id TEXT NOT NULL, mode TEXT NOT NULL, evidence TEXT NOT NULL,
      PRIMARY KEY(group_id, role_id)
    );
    CREATE TABLE IF NOT EXISTS event_log (
      event_id INTEGER PRIMARY KEY, group_id TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_snapshots (
      snapshot_id INTEGER PRIMARY KEY, group_id TEXT NOT NULL, role_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contracts (
      contract_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, version INTEGER NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(group_id, version)
    );
    CREATE TABLE IF NOT EXISTS contract_acks (
      contract_id TEXT NOT NULL REFERENCES contracts(contract_id), role_id TEXT NOT NULL, acknowledged_at TEXT NOT NULL,
      PRIMARY KEY(contract_id, role_id)
    );
    CREATE TABLE IF NOT EXISTS validation_runs (
      validation_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, contract_id TEXT, state TEXT NOT NULL, payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS browser_requests (
      request_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, role_id TEXT NOT NULL, payload_json TEXT NOT NULL,
      operation_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS browser_lease (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), request_id TEXT NOT NULL UNIQUE, role_id TEXT NOT NULL,
      lease_token TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS browser_events (
      event_id INTEGER PRIMARY KEY, request_id TEXT NOT NULL, outcome TEXT NOT NULL, evidence TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS external_operations (
      operation_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, state TEXT NOT NULL, outcome_json TEXT, updated_at TEXT NOT NULL
    );
  `);
  const columns=db.prepare('PRAGMA table_info(scheduled_work)').all() as Array<{name:string}>;
  if(!columns.some(column=>column.name==='execution_thread_id'))db.exec('ALTER TABLE scheduled_work ADD COLUMN execution_thread_id TEXT');
  const bindings=db.prepare('PRAGMA table_info(runtime_bindings)').all() as Array<{name:string}>;
  if(!bindings.some((column)=>column.name==='worktree_path'))db.exec('ALTER TABLE runtime_bindings ADD COLUMN worktree_path TEXT');

}
