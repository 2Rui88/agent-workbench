import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseModelTier, ModelPolicy } from '../src/model-policy.js';
import { CooperativeScheduler } from '../src/scheduler.js';
import { CoordinatorError } from '../src/errors.js';
import type { ExecutionPackage } from '../src/scheduler.js';
import { CoordinatorStore } from '../src/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pkg = (id: string, roleId: 'frontend' | 'backend' | 'audit' = 'frontend'): ExecutionPackage => ({
  id, roleId, goal: 'Implement a small isolated change', taskRef: `task-${id}`, repository: '/repo', worktree: '/repo',
  allowedPaths: ['src/'], baseline: 'abc', contractRef: 'contract-1', acceptanceCriteria: ['tests pass'],
  verificationCommands: ['npm test'], dependencies: [], risk: 1, evidenceFailures: 0, paused: false
});

test('execution package uses explicit model and effort from policy', () => {
  const tier = chooseModelTier(pkg('a'), [{ model: 'gpt-6-luna', efforts: ['high'] }, { model: 'gpt-6.1-sol', efforts: ['high', 'xhigh'] }]);
  assert.deepEqual(tier.choice, { model: 'gpt-6-luna', effort: 'high' });
});

test('busy role queues work while other roles can run concurrently', async () => {
  const scheduler = new CooperativeScheduler();
  scheduler.setOnline('lead', true);
  scheduler.setOnline('frontend', true); scheduler.setOnline('backend', true);
  const started: string[] = [];
  const frontend = scheduler.enqueue(pkg('f1', 'frontend'), 'g1');
  const backend = scheduler.enqueue(pkg('b1', 'backend'), 'g1');
  await scheduler.tick('g1', async (work) => { started.push(work.id); return { turnId: work.id }; });
  assert.deepEqual(started.sort(), [frontend.id, backend.id].sort());
  scheduler.enqueue(pkg('f2', 'frontend'), 'g1');
  assert.equal(scheduler.pending('frontend'), 1);
});

test('lead offline blocks new dispatch', async () => {
  const scheduler = new CooperativeScheduler();
  scheduler.setOnline('frontend', true);
  scheduler.enqueue(pkg('f1'), 'g1');
  await assert.rejects(scheduler.tick('g1', async () => ({ turnId: 't' })), { code: 'LEAD_OFFLINE' });
});

test('higher complexity audit returns to its role default on the next choice', () => {
  const policy = new ModelPolicy();
  const catalog = [{ model: 'gpt-6-luna', efforts: ['high'] }, { model: 'gpt-6.1-sol', efforts: ['high', 'xhigh'] }];
  assert.equal(policy.defaultFor('backend', catalog).model, 'gpt-6-luna');
  assert.equal(policy.defaultFor('audit', catalog).model, 'gpt-6.1-sol');
  const difficult = { ...pkg('hard', 'audit'), risk: 5, evidenceFailures: 1 };
  assert.equal(chooseModelTier(difficult, catalog).choice.effort, 'xhigh');
  assert.equal(policy.defaultFor('audit', catalog).effort, 'high');
});

test('concurrent scheduler ticks reserve one turn slot per role', async () => {
  const scheduler = new CooperativeScheduler();
  scheduler.setOnline('lead', true); scheduler.setOnline('frontend', true);
  scheduler.enqueue(pkg('first', 'frontend'), 'g1');
  scheduler.enqueue(pkg('second', 'frontend'), 'g1');
  let calls = 0;
  let releaseStart!: () => void;
  const pendingStart = new Promise<void>((resolve) => { releaseStart = resolve; });
  const firstTick = scheduler.tick('g1', async () => { calls += 1; await pendingStart; return { turnId: 'turn-first' }; });
  await new Promise((resolve) => setImmediate(resolve));
  const secondTick = await scheduler.tick('g1', async () => { calls += 1; return { turnId: 'turn-duplicate' }; });
  assert.deepEqual(secondTick, []);
  assert.equal(calls, 1);
  releaseStart();
  await firstTick;
});

test('unknown turn start remains blocked until explicit reconciliation', async () => {
  const scheduler = new CooperativeScheduler();
  scheduler.setOnline('lead', true); scheduler.setOnline('frontend', true);
  scheduler.enqueue(pkg('uncertain', 'frontend'), 'g1');
  await assert.rejects(scheduler.tick('g1', async () => { throw new CoordinatorError('RUNTIME_TIMEOUT', 'turn/start timed out', 'reconcile'); }), { code: 'RUNTIME_TIMEOUT' });
  assert.equal(scheduler.pending('frontend'), 0);
  assert.equal(scheduler.reconciliationNeeded('frontend')?.id, 'uncertain');
  await scheduler.tick('g1', async () => ({ turnId: 'must-not-start' }));
  assert.equal(scheduler.reconciliationNeeded('frontend')?.id, 'uncertain');
  scheduler.reconcile('frontend', 'not_started', 'thread/read confirmed no active turn');
  assert.equal(scheduler.pending('frontend'), 1);
  await scheduler.tick('g1', async () => ({ turnId: 'safe-retry' }));
  assert.equal(scheduler.activeWork('frontend')?.turnId, 'safe-retry');
});

test('scheduler restores durable queue, active work, and uncertain starts without redelivery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coordinator-scheduler-'));
  const path = join(dir, 'state.sqlite');
  try {
    const store = new CoordinatorStore(path);
    const scheduler = new CooperativeScheduler(store);
    scheduler.setOnline('lead', true); scheduler.setOnline('frontend', true);
    scheduler.enqueue(pkg('active', 'frontend'), 'g1');
    scheduler.enqueue(pkg('queued', 'frontend'), 'g1');
    await scheduler.tick('g1', async () => ({ turnId: 'turn-active' }));
    store.close();

    const reopenedStore = new CoordinatorStore(path);
    const recovered = new CooperativeScheduler(reopenedStore);
    recovered.setOnline('lead', true); recovered.setOnline('frontend', true);
    assert.equal(recovered.pending('frontend'), 0); // Pending state is loaded when a group is first accessed.
    await recovered.tick('g1', async () => ({ turnId: 'must-not-start-while-active' }));
    assert.equal(recovered.activeWork('frontend')?.turnId, 'turn-active');
    assert.equal(recovered.pending('frontend'), 1);
    recovered.complete('frontend', 'turn-active');
    await recovered.tick('g1', async (work) => ({ turnId: `turn-${work.id}` }));
    assert.equal(recovered.activeWork('frontend')?.turnId, 'turn-queued');
    reopenedStore.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scheduler restart fences a crash during turn start for explicit reconciliation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coordinator-scheduler-'));
  const path = join(dir, 'state.sqlite');
  try {
    const store = new CoordinatorStore(path);
    const scheduler = new CooperativeScheduler(store);
    scheduler.setOnline('lead', true); scheduler.setOnline('frontend', true);
    scheduler.enqueue(pkg('crash-window'), 'g1');
    void scheduler.tick('g1', async () => new Promise<{ turnId: string }>(() => {})).catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    store.close();

    const reopenedStore = new CoordinatorStore(path);
    const recovered = new CooperativeScheduler(reopenedStore);
    recovered.setOnline('lead', true); recovered.setOnline('frontend', true);
    await recovered.tick('g1', async () => ({ turnId: 'must-not-retry' }));
    assert.equal(recovered.reconciliationNeeded('frontend')?.id, 'crash-window');
    recovered.reconcile('frontend', 'started', 'thread/read found the accepted turn', 'turn-unknown');
    assert.equal(recovered.activeWork('frontend')?.turnId, 'turn-unknown');
    reopenedStore.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('audit dispatch retains analysis model even for a low-risk execution package', () => {
  const selected = chooseModelTier(pkg('audit-small', 'audit'), [{ model: 'gpt-6-luna', efforts: ['high'] }, { model: 'gpt-6.1-sol', efforts: ['high', 'xhigh'] }]);
  assert.deepEqual(selected.choice, { model: 'gpt-6.1-sol', effort: 'high' });
});
