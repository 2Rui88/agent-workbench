import assert from 'node:assert/strict';
import test from 'node:test';
import { engineFixture } from './fixtures/engine-fixture.js';

test('Mock invocation quota retains subsequent work without starting another turn', async () => {
  const f = await engineFixture({ maxCalls: 1, maxConcurrent: 3 });
  try {
    await f.engine.execute(f.lead,'automation_role_initialize',{cwd:f.dir}); await f.engine.execute(f.backend,'automation_role_initialize',{cwd:f.dir});
    const first = await f.engine.execute(f.lead,'automation_dispatch',f.dispatch) as {message:{messageId:string}};
    await f.engine.pump();
    await f.engine.execute(f.backend,'automation_work_complete',{dispatchId:first.message.messageId,summary:'checked',evidence:['test passed']});
    const next = await f.engine.execute(f.lead,'automation_dispatch',{...f.dispatch,work:{...f.dispatch.work,id:'next'},operationId:'next-op'}) as {message:{messageId:string}};
    await f.engine.pump();
    assert.equal(f.engine.scheduler.get(next.message.messageId)?.state,'queued');
    assert.equal(f.engine.store.getMessage(next.message.messageId)?.status,'queued');
    const status = await f.engine.execute(f.lead,'automation_status',{}) as {blocks:Record<string,string>};
    assert.equal(status.blocks.backend,'BUDGET_EXHAUSTED');
  } finally {await f.cleanup();}
});

test('a new grant gets its own call quota while concurrency and unknown outcomes stay group-wide', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { ExecutionBudget } = await import('../src/budget.js');
  const dir = await mkdtemp(join(tmpdir(), 'budget-grant-')); const db = join(dir, 'b.sqlite');
  const old = new ExecutionBudget(db, 'g', { maxCalls: 2, maxConcurrent: 2 }, 'app_server', 'grant-1');
  try {
    old.reserve('d1', 't1'); old.mark('t1', 'completed'); old.reserve('d2', 't2'); old.mark('t2', 'started');
    assert.throws(() => old.reserve('d3', 't3'), { code: 'BUDGET_EXHAUSTED' });
    const next = new ExecutionBudget(db, 'g', { maxCalls: 1, maxConcurrent: 1 }, 'app_server', 'grant-2');
    try {
      assert.equal(next.status().callsUsed, 0);
      assert.throws(() => next.reserve('d4', 't4'), { code: 'BUDGET_EXHAUSTED' }); // d2 still in flight under the old grant
      old.mark('t2', 'unknown');
      assert.throws(() => next.reserve('d4', 't4'), { code: 'RECONCILIATION_REQUIRED' });
      old.reconcile('d2', 'completed', 'verified');
      next.reserve('d4', 't4');
      assert.deepEqual([old.status().callsUsed, next.status().callsUsed], [2, 1]);
    } finally { next.close(); }
  } finally { old.close(); await rm(dir, { recursive: true, force: true }); }
});
