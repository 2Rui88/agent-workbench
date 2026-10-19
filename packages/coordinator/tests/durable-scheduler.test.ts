import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoordinatorStore } from '../src/store.js';
import { DurableScheduler } from '../src/durable-scheduler.js';
import type { ExecutionPackage } from '../src/scheduler.js';

const work = (id: string): ExecutionPackage => ({ id, roleId: 'backend', goal: 'isolated test', taskRef: 'task', repository: 'repo', worktree: '/repo', allowedPaths: ['src'], baseline: 'base', contractRef: 'contract', acceptanceCriteria: ['pass'], verificationCommands: ['npm test'], dependencies: [], risk: 1, evidenceFailures: 0, paused: false });
const lead = { groupId: 'g', roleId: 'lead' as const, bindingGeneration: 1, capabilityId: 'lead' };
const backend = { ...lead, roleId: 'backend' as const };

test('two SQLite connections reserve one role slot; completed operations never replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'durable-dispatch-'));
  const path = join(dir, 'state.sqlite');
  const store = new CoordinatorStore(path); store.createGroup('g');
  const a = new DurableScheduler(path); const b = new DurableScheduler(path);
  try {
    a.heartbeat(lead); a.heartbeat(backend);
    a.enqueue(work('one'), 'g', 'op-one'); b.enqueue(work('two'), 'g', 'op-two');
    const first = a.claim(backend)!;
    assert.equal(b.claim(backend), undefined);
    a.started(backend, first.dispatchId, first.leaseToken, 'turn-one');
    a.complete(backend, first.dispatchId, first.leaseToken, { summary: 'passed', evidence: ['npm test passed'] });
    assert.equal(b.enqueue(work('one'), 'g', 'op-one').state, 'completed');
    assert.equal(b.claim(backend)?.id, 'two');
    assert.throws(() => b.enqueue({ ...work('one'), goal: 'changed' }, 'g', 'op-one'), { code: 'IDEMPOTENCY_CONFLICT' });
  } finally { a.close(); b.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('expired start and rebound role remain fenced until lead reconciliation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'durable-recovery-'));
  const path = join(dir, 'state.sqlite');
  const store = new CoordinatorStore(path); store.createGroup('g');
  let now = 1000;
  let scheduler = new DurableScheduler(path, () => now);
  try {
    scheduler.heartbeat(lead); scheduler.heartbeat(backend);
    scheduler.enqueue(work('unknown'), 'g', 'op');
    const claim = scheduler.claim(backend, 1000)!;
    scheduler.close(); scheduler = new DurableScheduler(path, () => now);
    assert.equal(scheduler.claim(backend), undefined);
    now = 2001;
    assert.equal(scheduler.claim(backend), undefined);
    assert.equal(scheduler.get('op')?.state, 'needs_reconciliation');
    assert.throws(() => scheduler.complete(backend, 'op', claim.leaseToken, { evidence: ['stale'] }), { code: 'STALE_LEASE' });
    scheduler.reconcile(lead, 'op', 'not_started', 'thread/read confirms turn was not accepted');
    const retry = scheduler.claim(backend)!;
    store.bindRole({ ...backend, bindingGeneration: 2 });
    assert.throws(() => scheduler.started(backend, 'op', retry.leaseToken, 'stale-turn'), { code: 'FORBIDDEN' });
  } finally { scheduler.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('pause and offline lead retain queue without starting; worker cannot reconcile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'durable-control-'));
  const path = join(dir, 'state.sqlite');
  const store = new CoordinatorStore(path); store.createGroup('g');
  const scheduler = new DurableScheduler(path);
  try {
    scheduler.heartbeat(backend);
    scheduler.enqueue(work('one'), 'g', 'op');
    assert.throws(() => scheduler.claim(backend), { code: 'LEAD_OFFLINE' });
    scheduler.heartbeat(lead);
    scheduler.pause(lead, true);
    assert.equal(scheduler.claim(backend), undefined);
    assert.equal(scheduler.get('op')?.state, 'queued');
    assert.throws(() => scheduler.pause(backend, false), { code: 'FORBIDDEN' });
    scheduler.pause(lead, false);
    assert.ok(scheduler.claim(backend));
    assert.throws(() => scheduler.reconcile(backend, 'op', 'not_started', 'unauthorized'), { code: 'FORBIDDEN' });
  } finally { scheduler.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a dependent dispatch waits for completion of its referenced work',async()=>{
 const {engineFixture}=await import('./fixtures/engine-fixture.js');const f=await engineFixture();
 try{
  await f.engine.execute(f.lead,'automation_role_initialize',{cwd:f.dir});await f.engine.execute(f.backend,'automation_role_initialize',{cwd:f.dir});
  const sent=await f.engine.execute(f.lead,'automation_dispatch',{...f.dispatch,work:{...f.dispatch.work,dependencies:['missing-upstream']}}) as {message:{messageId:string}};
  await f.engine.pump();assert.equal(f.engine.scheduler.get(sent.message.messageId)?.state,'queued');assert.equal(f.engine.budget.status().callsUsed,0);
 }finally{await f.cleanup();}
});

test('lead cancellation preserves queued package and message; cancelled work cannot satisfy dependencies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cancel-dispatch-')); const path = join(dir, 'state.sqlite');
  const store = new CoordinatorStore(path); store.createGroup('g'); const scheduler = new DurableScheduler(path);
  try {
    const message = store.send(lead, { type: 'assistance_request', recipientRole: 'backend', payload: { kind: 'execution_package' } }, 'cancel-me');
    scheduler.enqueue(work('old'), 'g', message.messageId);
    scheduler.enqueue({ ...work('new'), dependencies: ['old'] }, 'g', 'dependent');
    assert.throws(() => scheduler.cancelQueued(backend, message.messageId, 'stale task binding'), { code: 'FORBIDDEN' });
    scheduler.cancelQueued(lead, message.messageId, 'stale task binding');
    scheduler.cancelQueued(lead, message.messageId, 'stale task binding');
    assert.equal(scheduler.get(message.messageId)?.state, 'cancelled');
    assert.equal(scheduler.get(message.messageId)?.goal, 'isolated test');
    assert.equal(store.getMessage(message.messageId)?.status, 'cancelled');
    assert.equal(scheduler.nextReady('g', 'backend'), undefined);
    assert.throws(() => scheduler.cancelQueued(lead, message.messageId, 'different reason'), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal(store.events('g', 0, 100).filter(e => e.type === 'dispatch.cancelled').length, 1);
  } finally { scheduler.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('active and uncertain executions cannot be cancelled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cancel-active-')); const path = join(dir, 'state.sqlite');
  const store = new CoordinatorStore(path); store.createGroup('g'); const scheduler = new DurableScheduler(path);
  try {
    const message = store.send(lead, { type: 'assistance_request', recipientRole: 'backend', payload: {kind:'execution_package'} }, 'active');
    scheduler.enqueue(work('active'), 'g', message.messageId); scheduler.heartbeat(lead); scheduler.heartbeat(backend);
    const lease = scheduler.claim(backend)!;
    assert.throws(() => scheduler.cancelQueued(lead, message.messageId, 'cannot retract start'), {code:'RECONCILIATION_REQUIRED'});
    scheduler.started(backend,message.messageId,lease.leaseToken,'turn');
    assert.throws(() => scheduler.cancelQueued(lead,message.messageId,'cannot retract turn'),{code:'RECONCILIATION_REQUIRED'});
    scheduler.uncertain(backend,message.messageId,lease.leaseToken,'unknown runtime');
    assert.throws(() => scheduler.cancelQueued(lead,message.messageId,'unknown is not idle'),{code:'RECONCILIATION_REQUIRED'});
  } finally { scheduler.close(); store.close(); rmSync(dir, {recursive:true,force:true}); }
});

test('failed archive is atomic, immutable, spent and idempotent; replacement cannot fork', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { ExecutionBudget } = await import('../src/budget.js');
  const { ApprovalBridge } = await import('../src/approval-bridge.js');
  const dir = mkdtempSync(join(tmpdir(), 'archive-failure-')); const path = join(dir, 'state.sqlite');
  const store = new CoordinatorStore(path); store.createGroup('g'); const scheduler = new DurableScheduler(path);
  const budget = new ExecutionBudget(path, 'g', { maxCalls: 1, maxConcurrent: 1 }); const approvals = new ApprovalBridge(path, 'human'); const db = new DatabaseSync(path);
  try {
    scheduler.heartbeat(lead); scheduler.heartbeat(backend);
    const message = store.send(lead, {type:'assistance_request',recipientRole:'backend',payload:{kind:'execution_package'}}, 'original');
    scheduler.enqueue(work('old'), 'g', message.messageId);
    const lease = scheduler.claim(backend)!; scheduler.started(backend, lease.dispatchId, lease.leaseToken, 'turn');
    budget.reserve(lease.dispatchId, lease.leaseToken); budget.mark(lease.leaseToken, 'unknown');
    scheduler.uncertain(backend, lease.dispatchId, lease.leaseToken, 'interrupt');
    approvals.enqueue(backend, 'runtime', 1, 'mcpServer/elicitation/request', {threadId:'thread',turnId:'turn'});
    const original = db.prepare('SELECT work_json,operation_hash,turn_id FROM scheduled_work').get();
    assert.throws(() => scheduler.archiveFailure(backend, lease.dispatchId, 'interrupted', 'verified terminal', 'turn'), {code:'FORBIDDEN'});
    assert.throws(() => scheduler.archiveFailure(lead, lease.dispatchId, 'interrupted', 'verified terminal', 'wrong'), {code:'RECONCILIATION_REQUIRED'});
    db.exec("CREATE TRIGGER reject_archive BEFORE UPDATE ON execution_reservations BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    assert.throws(() => scheduler.archiveFailure(lead, lease.dispatchId, 'interrupted', 'verified terminal', 'turn'), /injected failure/);
    assert.equal(scheduler.get(lease.dispatchId)?.state, 'needs_reconciliation'); assert.equal(store.getMessage(lease.dispatchId)?.status, 'queued'); assert.equal(approvals.list('g').length, 1);
    db.exec('DROP TRIGGER reject_archive');
    scheduler.archiveFailure(lead, lease.dispatchId, 'interrupted', 'verified terminal', 'turn');
    scheduler.archiveFailure(lead, lease.dispatchId, 'interrupted', 'verified terminal', 'turn');
    assert.equal(scheduler.get(lease.dispatchId)?.state, 'failed'); assert.equal(store.getMessage(lease.dispatchId)?.status, 'failed');
    assert.deepEqual(db.prepare('SELECT work_json,operation_hash,turn_id FROM scheduled_work').get(), original);
    assert.equal(approvals.list('g').length, 0); assert.equal(budget.status().callsUsed, 1); assert.equal(budget.status().inFlight, 0); assert.equal(budget.status().unknown, 0);
    assert.throws(() => scheduler.archiveFailure(lead, lease.dispatchId, 'runtime_failed', 'verified terminal', 'turn'), {code:'IDEMPOTENCY_CONFLICT'});
    const replacement = {...work('new'), replacesDispatchId:lease.dispatchId};
    scheduler.enqueue(replacement, 'g', 'new'); scheduler.enqueue(replacement, 'g', 'new');
    assert.throws(() => scheduler.enqueue({...replacement,id:'fork'}, 'g', 'fork'), {code:'IDEMPOTENCY_CONFLICT'});
    assert.throws(() => scheduler.enqueue({...replacement,id:'other',taskRef:'other'}, 'g', 'other'), {code:'TASK_GATE_CLOSED'});
    assert.equal(store.events('g', 0, 100).filter(e => e.type === 'dispatch.failed').length, 1);
  } finally {db.close(); approvals.close(); budget.close(); scheduler.close(); store.close(); rmSync(dir,{recursive:true,force:true});}
});
