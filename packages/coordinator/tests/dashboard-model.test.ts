import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { engineFixture } from './fixtures/engine-fixture.js';
import { DashboardProjection } from '../src/dashboard/projection.js';
// The dashboard is browser JavaScript and is intentionally outside the TypeScript build.
// @ts-expect-error no declaration file is emitted for this browser module
import { runtimeModelLabel } from '../web/dashboard.js';

test('confirms runtime model only from codex turn context and reports actual effort', () => {
  assert.equal(runtimeModelLabel({
    turnId: 'turn-1',
    actualModel: 'gpt-6-luna',
    actualModelSource: 'codex_turn_context',
    actualEffort: 'medium',
  }), 'gpt-6-luna / 实际 medium · 运行时已确认');
});

test('does not confirm when the runtime model source is missing', () => {
  assert.equal(runtimeModelLabel({ turnId: 'turn-1', actualModel: 'gpt-6-luna' }), '未确认');
});

test('does not confirm when the runtime model is missing', () => {
  assert.equal(runtimeModelLabel({ turnId: 'turn-1', actualModelSource: 'codex_turn_context' }), '未确认');
});

test('treats a whitespace-only runtime model as missing', () => {
  assert.equal(runtimeModelLabel({
    turnId: 'turn-1',
    actualModel: '  \t ',
    actualModelSource: 'codex_turn_context',
  }), '未确认');
});

test('reports no turn as not executed and keeps missing actual effort unknown', () => {
  assert.equal(runtimeModelLabel({ actualModel: 'gpt-6-luna', actualModelSource: 'codex_turn_context' }), '未执行');
  assert.equal(runtimeModelLabel({
    turnId: 'turn-1',
    actualModel: 'gpt-6-luna',
    actualModelSource: 'codex_turn_context',
    requestedEffort: 'high',
  }), 'gpt-6-luna / 实际 未知 · 运行时已确认');
});

test('projects dispatch snapshot timestamps and duration rules', async () => {
  const fixture = await engineFixture();
  const db = new DatabaseSync(fixture.db);
  const queued = 1_700_000_000_000;
  const started = queued + 1_000;
  const completed = new Date(started + 2_500).toISOString();
  const insert = db.prepare('INSERT INTO scheduled_work(dispatch_id,group_id,role_id,work_id,work_json,operation_hash,state,queued_at,started_at,evidence_json) VALUES(?,?,?,?,?,?,?,?,?,?)');
  const message = db.prepare('INSERT INTO messages(message_id,group_id,sender_role,recipient_role,binding_generation,type,payload_json,operation_id,operation_hash,status,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  const work = (id: string) => JSON.stringify({ id, roleId: 'backend', model: { model: 'gpt-6-sol', effort: 'medium' } });
  insert.run('normal', 'g', 'backend', 'normal-work', work('normal-work'), 'hash-normal', 'completed', queued, started, null);
  message.run('normal', 'g', 'backend', 'backend', 1, 'execution_package', '{}', 'op-normal', 'hash-normal', 'completed', new Date(queued).toISOString(), completed);
  insert.run('missing', 'g', 'backend', 'missing-work', work('missing-work'), 'hash-missing', 'queued', queued + 1, null, null);
  insert.run('reconciled', 'g', 'backend', 'reconciled-work', work('reconciled-work'), 'hash-reconciled', 'completed', queued + 2, started, JSON.stringify({ outcome: 'completed', marker: 'SECRET_EVIDENCE_MARKER' }));
  message.run('reconciled', 'g', 'backend', 'backend', 1, 'execution_package', '{}', 'op-reconciled', 'hash-reconciled', 'completed', new Date(queued).toISOString(), completed);
  insert.run('failed', 'g', 'backend', 'failed-work', work('failed-work'), 'hash-failed', 'failed', queued + 3, started, JSON.stringify({ marker: 'SECRET_FAILED_MARKER' }));
  message.run('failed', 'g', 'backend', 'backend', 1, 'execution_package', '{}', 'op-failed', 'hash-failed', 'failed', new Date(queued).toISOString(), completed);
  db.close();
  const projection = new DashboardProjection(fixture.db);
  try {
    const snapshot = projection.snapshot('g')!;
    const dispatches = snapshot.roles.find(role => role.roleId === 'backend')!.dispatches;
    const byId = (id: string) => dispatches.find(dispatch => dispatch.dispatchId === id)!;
    assert.deepEqual(byId('normal'), { ...byId('normal'), queuedAt: new Date(queued).toISOString(), startedAt: new Date(started).toISOString(), completedAt: completed, durationMs: 2_500 });
    assert.equal(byId('missing').queuedAt, new Date(queued + 1).toISOString());
    assert.equal(byId('missing').startedAt, null);
    assert.equal(byId('missing').completedAt, null);
    assert.equal(byId('missing').durationMs, null);
    assert.equal(byId('reconciled').completedAt, completed);
    assert.equal(byId('reconciled').durationMs, null);
    assert.equal(byId('failed').durationMs, null);
    assert.equal(JSON.stringify(snapshot).includes('SECRET_EVIDENCE_MARKER'), false);
    assert.equal(JSON.stringify(snapshot).includes('SECRET_FAILED_MARKER'), false);
    assert.equal(snapshot.schemaVersion, 1);
  } finally {
    projection.close();
    await fixture.cleanup();
  }
});
