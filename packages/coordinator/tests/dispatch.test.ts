import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkDispatcher } from '../src/dispatch.js';
import type { ExecutionPackage } from '../src/scheduler.js';
import { CoordinatorStore } from '../src/store.js';
import { CooperativeScheduler } from '../src/scheduler.js';

const work: ExecutionPackage = { id: 'dispatch-1', roleId: 'backend', goal: 'Implement endpoint', taskRef: 'task-1', repository: 'repo-backend', worktree: '/repo/backend', allowedPaths: ['src/api'], baseline: 'commit-a', contractRef: 'contract-v1', acceptanceCriteria: ['route works'], verificationCommands: ['npm test'], dependencies: [], risk: 1, evidenceFailures: 0, paused: false };
const binding = { taskRef: 'task-1', owner: 'jande', repositoryId: 'repo-backend', worktreePath: '/repo/backend', expectedVersion: 7 };
const catalog = [{ model: 'gpt-6-luna', efforts: ['high'] }, { model: 'gpt-6.1-sol', efforts: ['high', 'xhigh'] }];

test('lead dispatch validates Task lease and passes explicit model plus effort to its queue', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coordinator-dispatch-'));
  const store = new CoordinatorStore(join(dir, 'state.sqlite'));
  store.createGroup('g1');
  const lead = { groupId: 'g1', roleId: 'lead' as const, bindingGeneration: 1, capabilityId: 'lead' };
  const backend = { groupId: 'g1', roleId: 'backend' as const, bindingGeneration: 1, capabilityId: 'backend' };
  store.setRoleCapability('g1', 'lead', 'dispatch-lead-capability-0123456789abc');
  store.bindRole(backend);
  const scheduler = new CooperativeScheduler(store);
  let checked = false;
  const dispatcher = new WorkDispatcher(store, { checkGate: async (candidate) => { checked = true; assert.deepEqual(candidate, binding); return { id: 'task-1', owner: 'jande', repositoryId: 'repo-backend', worktreePath: '/repo/backend', version: 7, status: 'in_progress', lease: { active: true, owner: 'jande' }, conflicts: [] }; } }, scheduler);
  try {
    const result = await dispatcher.dispatch(lead, binding, work, catalog, 'dispatch-op');
    assert.equal(checked, true);
    assert.equal(result.model.tier, 'execution');
    assert.equal(result.model.model, 'gpt-6-luna');
    assert.equal(result.model.effort, 'high');
    assert.ok(result.model.reason.length > 0);
    const claim = store.claim(backend, 'worker-lease', 30_000);
    assert.equal(claim?.payload.model && (claim.payload.model as { model: string }).model, 'gpt-6-luna');
    assert.equal((claim?.payload.model as { effort: string }).effort, 'high');
    assert.equal(scheduler.pending('backend'), 1);
    const scheduled = store.loadSchedulerSnapshot('g1') as { queues: Array<{ model?: { model: string; effort: string } }> };
    assert.deepEqual(scheduled.queues[0]?.model, { model: 'gpt-6-luna', effort: 'high', tier: 'execution', reason: 'Selected execution from declared risk, scope dependencies, and observed failure evidence.' });
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('closed Task lease prevents any queue write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coordinator-dispatch-block-'));
  const store = new CoordinatorStore(join(dir, 'state.sqlite'));
  store.createGroup('g1');
  const lead = { groupId: 'g1', roleId: 'lead' as const, bindingGeneration: 1, capabilityId: 'lead' };
  const dispatcher = new WorkDispatcher(store, { checkGate: async () => { throw Object.assign(new Error('task lease missing'), { code: 'TASK_GATE_CLOSED' }); } });
  try {
    await assert.rejects(dispatcher.dispatch(lead, binding, work, catalog, 'blocked-op'), { code: 'TASK_GATE_CLOSED' });
    assert.equal(store.groupSnapshot('g1')?.queue.backend, 0);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('repository identity mismatch is rejected before the Task adapter or queue is touched', async () => {
  const store = new CoordinatorStore(':memory:'); store.createGroup('g1');
  let checks = 0;
  const dispatcher = new WorkDispatcher(store, { checkGate: async () => { checks++; throw new Error('must not reach adapter'); } });
  try {
    await assert.rejects(dispatcher.dispatch({groupId:'g1',roleId:'lead',bindingGeneration:1,capabilityId:'lead'}, binding, {...work,repository:'another-repository'}, catalog, 'mismatch'), {code:'TASK_GATE_CLOSED'});
    assert.equal(checks, 0);
  } finally {store.close();}
});
