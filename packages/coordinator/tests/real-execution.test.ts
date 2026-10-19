import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRealExecution, realExecutionSchema } from '../src/real-execution.js';
import { engineFixture } from './fixtures/engine-fixture.js';
import { CoordinatorEngine } from '../src/engine.js';

const grant = realExecutionSchema.parse({ authorizationRef: 'user-authorized-task', expiresAt: '2099-01-01T00:00:00Z', taskRefs: ['task'], maxCalls: 1, maxConcurrent: 1, maxInputCharacters: 24000, maxTurnMs: 300000, choices: { frontend: { model: 'gpt-6-luna', effort: 'medium' }, backend: { model: 'gpt-6-luna', effort: 'medium' }, audit: { model: 'gpt-6.1-sol', effort: 'high' } } });

test('real invocation grant rejects missing authorization, wrong task/model and expired grant', async () => {
  const f = await engineFixture();
  try {
    const work = { ...f.dispatch.work, roleId: 'backend' as const, paused: false, model: { model: 'gpt-6-luna', effort: 'medium', tier: 'execution', reason: 'approved' } };
    assertRealExecution(grant, work);
    for (const input of [undefined, { ...grant, expiresAt: '2000-01-01T00:00:00Z' }, { ...grant, taskRefs: ['other'] }]) assert.throws(() => assertRealExecution(input, work), { code: 'TASK_GATE_CLOSED' });
    assert.throws(() => assertRealExecution(grant, { ...work, model: { ...work.model, effort: 'high' } }), { code: 'TASK_GATE_CLOSED' });
  } finally { await f.cleanup(); }
});

test('authorized real mode passes explicit economical choice and uses a persistent real quota', async () => {
  const f = await engineFixture(); await f.engine.close();
  const engine = new CoordinatorEngine({ ...f.options, runtimeSource: 'app_server', leadMode: 'external', realExecution: grant });
  try {
    const lead = engine.authenticate('lead', f.credentials.lead, 1);
    const backend = engine.authenticate('backend', f.credentials.backend, 1);
    await engine.execute(lead, 'automation_lead_heartbeat', { sessionRef: 'host', cwd: f.dir });
    await engine.execute(backend, 'automation_role_initialize', { cwd: f.dir });
    const result = await engine.execute(lead, 'automation_dispatch', f.dispatch) as { message: { messageId: string }; model: { effort: string } };
    assert.equal(result.model.effort, 'medium');
    await engine.pump();
    assert.equal(engine.scheduler.get(result.message.messageId)?.state, 'active');
    assert.equal(engine.budget.status().source, 'app_server');
    assert.equal(engine.budget.status().callsUsed, 1);
  } finally { await engine.close(); await f.cleanup(); }
});

test('grant expiry during history lookup cannot start a turn or consume a call', async () => {
  const f = await engineFixture(); await f.engine.close();
  const originalNow = Date.now; let now = originalNow(); Date.now = () => now;
  const engine = new CoordinatorEngine({ ...f.options, runtimeSource: 'app_server', leadMode: 'external', realExecution: { ...grant, expiresAt: new Date(now + 1000).toISOString() } });
  try {
    const lead = engine.authenticate('lead', f.credentials.lead, 1); const backend = engine.authenticate('backend', f.credentials.backend, 1);
    await engine.execute(lead, 'automation_lead_heartbeat', { sessionRef: 'host', cwd: f.dir });
    await engine.execute(backend, 'automation_role_initialize', { cwd: f.dir });
    const runtime = f.runtimes[0]!; const read = runtime.readThread.bind(runtime); let calls = 0;
    runtime.readThread = async (id) => { now += 2000; return read(id); };
    runtime.startTurn = async () => { calls++; throw new Error('Must not call runtime'); };
    const result = await engine.execute(lead, 'automation_dispatch', f.dispatch) as { message: { messageId: string } };
    await engine.pump();
    assert.equal(calls, 0);
    assert.equal(engine.scheduler.get(result.message.messageId)?.state, 'queued');
    assert.equal(engine.budget.status().callsUsed, 0);
    assert.equal(engine.budget.status().unknown, 0);
  } finally { Date.now = originalNow; await engine.close(); await f.cleanup(); }
});

test('independent watchdog freezes a turn even while a pump is blocked', async () => {
  const f = await engineFixture(); await f.engine.close();
  const engine = new CoordinatorEngine({ ...f.options, runtimeSource: 'app_server', leadMode: 'external', realExecution: { ...grant, maxTurnMs: 1000 } });
  try {
    const lead = engine.authenticate('lead', f.credentials.lead, 1); const backend = engine.authenticate('backend', f.credentials.backend, 1);
    await engine.execute(lead, 'automation_lead_heartbeat', { sessionRef: 'host', cwd: f.dir });
    await engine.execute(backend, 'automation_role_initialize', { cwd: f.dir });
    let interrupted = 0; f.runtimes[0]!.interruptTurn = async () => { interrupted++; };
    const result = await engine.execute(lead, 'automation_dispatch', f.dispatch) as { message: { messageId: string } };
    await engine.pump();
    const runtime = f.runtimes[0]!; const read = runtime.readThread.bind(runtime);
    runtime.readThread = async (id) => { await new Promise((resolve) => setTimeout(resolve, 1500)); return read(id); };
    const receipt = engine.execute(backend, 'automation_work_complete', { dispatchId: result.message.messageId, summary: 'checked', evidence: ['actual test evidence'] });
    const blockedPump = engine.pump();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(interrupted, 1);
    assert.equal(engine.scheduler.get(result.message.messageId)?.state, 'needs_reconciliation');
    assert.equal(engine.budget.status().unknown, 1);
    await blockedPump;
    assert.deepEqual(await receipt, { status: 'receipt_recorded', finalAcceptance: 'human_only' });
  } finally { await engine.close(); await f.cleanup(); }
});

test('grant supports turns up to one hour and the receipt deadline follows the grant', async () => {
  const { receiptDeadlineMs } = await import('../src/real-execution.js');
  assert.equal(realExecutionSchema.parse({ ...grant, maxTurnMs: 3_600_000 }).maxTurnMs, 3_600_000);
  assert.throws(() => realExecutionSchema.parse({ ...grant, maxTurnMs: 3_600_001 }));
  assert.equal(receiptDeadlineMs({ ...grant, maxTurnMs: 3_600_000 }), 3_660_000);
  assert.equal(receiptDeadlineMs(undefined), 300_000);
  assert.equal(receiptDeadlineMs({ ...grant, maxTurnMs: 3_600_000 }, 300_000), 3_660_000);
  assert.equal(receiptDeadlineMs({ ...grant, maxTurnMs: 60_000 }, 300_000), 300_000);
});
