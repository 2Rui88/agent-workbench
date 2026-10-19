import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { engineFixture } from './fixtures/engine-fixture.js';
import { DashboardProjection } from '../src/dashboard/projection.js';
import { startDashboard } from '../src/dashboard/http-server.js';
import { request } from 'node:http';
// @ts-expect-error browser module has no declaration file
import { runtimeModelLabel, modelCell, statusBadge, auditBadge, durationLabel, sortDispatches, shortId, tailPath, workLabel, budgetLabel, formatTime } from '../web/dashboard.js';

test('dashboard formatting keeps provenance, unknowns and semantic badge tones', () => {
  const confirmed = { turnId: 'turn-123', actualModel: 'gpt-6-sol', actualEffort: 'medium', actualModelSource: 'claude_transcript', requestedModel: 'gpt-6-sol', requestedEffort: 'medium' };
  assert.match(runtimeModelLabel(confirmed), /运行时已确认/);
  assert.deepEqual(modelCell(confirmed), { text: 'gpt-6-sol · medium ✓', tone: 'good', title: '证据来源：claude_transcript' });
  assert.equal(modelCell({ ...confirmed, actualEffort: 'high' }).tone, 'warn');
  assert.match(modelCell({ ...confirmed, actualEffort: 'high' }).text, /不一致/);
  assert.match(modelCell({ ...confirmed, actualEffort: null }).text, /强度未知/);
  assert.match(modelCell({ ...confirmed, actualModelSource: null }).text, /实际未确认/);
  assert.match(modelCell({ ...confirmed, turnId: null }).text, /未执行/);
  assert.equal(statusBadge('completed').tone, 'good');
  assert.deepEqual(statusBadge('surprise'), { text: 'surprise', tone: 'muted' });
  assert.deepEqual(auditBadge('passed'), { text: '通过', tone: 'good' });
  assert.deepEqual(auditBadge('surprise'), { text: 'surprise', tone: 'muted' });
});

test('duration distinguishes completed, running, reconciled and old snapshots', () => {
  assert.equal(durationLabel({ durationMs: 725000 }, 1000000).text, '12分05秒');
  assert.equal(durationLabel({ durationMs: 48000 }, 1000000).text, '48秒');
  assert.equal(durationLabel({ durationMs: 3780000 }, 1000000).text, '1小时03分');
  assert.equal(durationLabel({ state: 'active', startedAt: '1970-01-01T00:01:40Z' }, '1970-01-01T00:03:40Z').text, '进行中 2分');
  assert.equal(durationLabel({ state: 'completed', startedAt: 100000, durationMs: null }, 220000).text, '—');
  assert.match(durationLabel({ state: 'completed', startedAt: 100000, durationMs: null }, 220000).title, /对账完成/);
  assert.equal(durationLabel({ state: 'completed' }, 220000).text, '未知');
  assert.equal(durationLabel({ state: 'completed', startedAt: '1970-01-01T00:01:00Z', durationMs: null }, 220000).text, '—');
  assert.match(durationLabel({ state: 'completed', startedAt: '1970-01-01T00:01:00Z', durationMs: null }, 220000).title, /对账完成/);
  // Only a dispatch with every time field absent is an old snapshot; one present field makes it a new snapshot.
  assert.equal(durationLabel({ state: 'completed', startedAt: '1970-01-01T00:01:00Z', durationMs: undefined }, 220000).text, '—');
  assert.deepEqual(durationLabel({ state: 'active' }, 220000), { text: '未知', title: '旧快照缺少耗时字段' });
  assert.equal(durationLabel({ state: 'active', startedAt: null, durationMs: null }, 220000).text, '—');
  assert.equal(durationLabel({ state: 'needs_reconciliation', startedAt: '1970-01-01T00:01:00Z', durationMs: null }, 220000).text, '—');
  assert.match(durationLabel({ state: 'needs_reconciliation', startedAt: '1970-01-01T00:01:00Z', durationMs: null }, 220000).title, /待核对/);
  assert.equal(durationLabel({ state: 'completed', startedAt: null, completedAt: null, durationMs: null }, 220000).text, '—');
  assert.match(durationLabel({ state: 'completed', startedAt: null, completedAt: null, durationMs: null }, 220000).title, /缺少开始时间/);
  assert.equal(durationLabel({ state: 'failed', startedAt: '2026-10-09T00:00:00Z' }, Date.parse('2026-10-09T00:02:00Z')).text, '—');
  assert.match(durationLabel({ state: 'failed', startedAt: '2026-10-09T00:00:00Z' }, Date.now()).title, /未完成/);
});

test('dispatch ordering is stable, missing queuedAt is last and identifiers stay compact', () => {
  const roles = [{ roleId: 'frontend', dispatches: [{ workId: 'a', queuedAt: '2026-10-09T00:00:10Z' }, { workId: 'b' }] }, { roleId: 'backend', dispatches: [{ workId: 'c', queuedAt: '2026-10-09T00:00:20Z' }, { workId: 'd', queuedAt: '2026-10-09T00:00:10Z' }] }];
  assert.deepEqual(sortDispatches(roles).map((row: { dispatch: { workId: string } }) => row.dispatch.workId), ['c', 'a', 'd', 'b']);
  const sameTime = [{ roleId: 'a', dispatches: [{ workId: 'a1', queuedAt: '2026-10-09T00:00:10Z' }, { workId: 'a2', queuedAt: '2026-10-09T00:00:10Z' }] }, { roleId: 'b', dispatches: [{ workId: 'b1', queuedAt: '2026-10-09T00:00:10Z' }] }];
  assert.deepEqual(sortDispatches(sameTime).map((row: { dispatch: { workId: string } }) => row.dispatch.workId), ['a1', 'a2', 'b1']);
  assert.equal(shortId('123456789'), '12345678');
  assert.equal(shortId(null), '未知');
  assert.equal(tailPath('/one/two/three/'), 'two/three');
  assert.equal(tailPath(null), '未知');
  assert.equal(workLabel('dashboard queue work item'), 'dashboard queue work item');
  assert.equal(budgetLabel({ callsUsed: 2 }, { maxCalls: 6 }), '2 / 6');
  assert.equal(budgetLabel({}, {}), '未知');
});

test('times render on the Asia/Taipei clock (UTC+8) regardless of the host zone', () => {
  assert.equal(formatTime('2026-10-09T02:53:20.876Z'), '2026年10月9日 10:53:20');
  assert.equal(formatTime('2026-10-08T16:30:00Z'), '2026年10月9日 00:30:00');
  assert.equal(formatTime('not a time'), '时间未知');
});


test('bounded coherent projection omits raw work, receipts and capabilities', async () => {
  const f = await engineFixture();
  const db = new DatabaseSync(f.db);
  try {
    for (let i = 0; i < 101; i++) db.prepare('INSERT INTO scheduled_work(dispatch_id,group_id,role_id,work_id,work_json,operation_hash,state,queued_at) VALUES(?,?,?,?,?,?,?,?)').run(`d${i}`, 'g', 'backend', `w${i}`, JSON.stringify({ id: `w${i}`, secret: 'SECRET_RAW_WORK', model: { model: 'gpt-6-luna', effort: 'medium' } }), 'hash', 'completed', i);
    db.prepare('UPDATE runtime_observation SET payload_json=? WHERE group_id=?').run(JSON.stringify({observedAt:new Date().toISOString(),source:'mock',leadMode:'managed',blocks:{backend:'TASK_GATE_CLOSED'},limits:{maxCalls:8,maxConcurrent:2},grantExpiresAt:null,projectAccess:[{roleId:'backend',scopeId:'LEGACY_SCOPE',principalId:'p',verifiedAt:null}],capability:'SECRET_CAPABILITY'}),'g');
    const projection = new DashboardProjection(f.db);
    try {
      const snapshot = projection.snapshot('g')!;
      assert.equal(snapshot.totals.dispatches, 101);
      assert.equal(snapshot.roles.flatMap((role) => role.dispatches).length, 100);
      assert.equal(snapshot.truncated, true);
      assert.equal(snapshot.runtime?.limits.maxCalls,8);
      assert.equal(snapshot.runtime?.blocks.backend,'TASK_GATE_CLOSED');
      assert.equal(JSON.stringify(snapshot).includes('SECRET_CAPABILITY'), false);
      assert.equal(JSON.stringify(snapshot).includes('SECRET_RAW_WORK'), false);
      assert.equal(JSON.stringify(snapshot).includes(f.credentials.backend), false);
      assert.equal(snapshot.roles[2]?.dispatches[0]?.actualModel, null);
    } finally { projection.close(); }
  } finally { db.close(); await f.cleanup(); }
});

test('HTTP rejects foreign Host/Origin and writes, exposes missing group and DB failure honestly', async () => {
  const f = await engineFixture();
  const service = await startDashboard({ databasePath: f.db, groupId: 'g', port: 0, webRoot: new URL('../web', import.meta.url).pathname });
  try {
    assert.equal((await fetch(service.url + 'health')).status, 200);
    assert.equal((await fetch(service.url + 'api/snapshot')).status, 200);
    assert.equal((await fetch(service.url + 'api/snapshot', { method: 'POST' })).status, 405);
    assert.equal((await fetch(service.url + 'api/snapshot', { headers: { Origin: 'http://evil.example' } })).status, 403);
    assert.equal(await new Promise<number>((resolve) => { const r = request(service.url + 'health', { headers: { Host: 'evil.example' } }, (response) => { response.resume(); resolve(response.statusCode!); }); r.end(); }), 403);
    assert.equal((await fetch(service.url + '%2e%2e/package.json')).status, 404);
    const db = new DatabaseSync(f.db); db.exec('PRAGMA foreign_keys=OFF; DROP TABLE contracts'); db.close();
    assert.equal((await fetch(service.url + 'api/snapshot')).status, 503);
  } finally { await service.close(); await f.cleanup(); }
});
