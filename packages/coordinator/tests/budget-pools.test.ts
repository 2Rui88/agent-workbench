import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionBudget } from '../src/budget.js';
import { engineFixture } from './fixtures/engine-fixture.js';

test('advisor pool counts separately from worker pool in the same database', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'budget-'));
  const db = join(dir, 's.sqlite');
  const workers = new ExecutionBudget(db, 'g', { maxCalls: 1, maxConcurrent: 1 }, 'app_server');
  const advisor = new ExecutionBudget(db, 'g', { maxCalls: 1, maxConcurrent: 1 }, 'advisor');
  try {
    workers.reserve('d1', 't1');
    assert.throws(() => workers.reserve('d2', 't2'), { code: 'BUDGET_EXHAUSTED' });
    advisor.reserve('a1', 't3');
    assert.equal(advisor.status().callsUsed, 1);
    assert.equal(workers.status().callsUsed, 1);
    advisor.mark('t3', 'unknown');
    workers.mark('t1', 'completed');
    assert.throws(() => advisor.reserve('a2', 't4'), { code: 'RECONCILIATION_REQUIRED' });
  } finally { workers.close(); advisor.close(); await rm(dir, { recursive: true, force: true }); }
});

test('engine exposes a separate advisor budget in status', async () => {
  const f = await engineFixture();
  try {
    const status = await f.engine.execute(f.lead, 'automation_status', {}) as { budget: { source: string }; advisorBudget: { source: string } };
    assert.equal(status.budget.source, 'mock');
    assert.equal(status.advisorBudget.source, 'mock_advisor');
  } finally { await f.cleanup(); }
});
