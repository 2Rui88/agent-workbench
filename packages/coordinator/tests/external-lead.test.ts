import assert from 'node:assert/strict';
import test from 'node:test';
import { CoordinatorEngine } from '../src/engine.js';
import { engineFixture } from './fixtures/engine-fixture.js';

test('external lead heartbeat enables workers without launching a second lead model', async () => {
  const f = await engineFixture();
  await f.engine.close();
  const engine = new CoordinatorEngine({ ...f.options, leadMode: 'external' });
  try {
    const lead = engine.authenticate('lead', f.credentials.lead, 1);
    const backend = engine.authenticate('backend', f.credentials.backend, 1);
    await assert.rejects(engine.execute(lead, 'automation_role_initialize', { cwd: f.dir }), { code: 'FORBIDDEN' });
    await engine.execute(backend, 'automation_role_initialize', { cwd: f.dir });
    const dispatched = await engine.execute(lead, 'automation_dispatch', f.dispatch) as { message: { messageId: string } };
    await engine.pump();
    assert.equal(engine.scheduler.get(dispatched.message.messageId)?.state, 'queued');
    await assert.rejects(engine.execute(backend, 'automation_lead_heartbeat', { sessionRef: 'actual-current-session', cwd: f.dir }), { code: 'FORBIDDEN' });
    await engine.execute(lead, 'automation_lead_heartbeat', { sessionRef: 'actual-current-session', cwd: f.dir });
    await engine.pump();
    assert.equal(engine.scheduler.get(dispatched.message.messageId)?.state, 'active');
    assert.equal(f.runtimes.length, 1);
  } finally { await engine.close(); await f.cleanup(); }
});

test('external presence expiring during history lookup prevents invocation', async () => {
  const f = await engineFixture(); await f.engine.close();
  const original = Date.now; const baseline = original(); let now = baseline; Date.now = () => now;
  const engine = new CoordinatorEngine({ ...f.options, leadMode: 'external' });
  try {
    const lead = engine.authenticate('lead', f.credentials.lead, 1); const backend = engine.authenticate('backend', f.credentials.backend, 1);
    await engine.execute(lead, 'automation_lead_heartbeat', { sessionRef: 'host', cwd: f.dir });
    await engine.execute(backend, 'automation_role_initialize', { cwd: f.dir });
    const runtime = f.runtimes[0]!; const read = runtime.readThread.bind(runtime); let calls = 0;
    runtime.readThread = async (id) => { now = baseline + 61000; return read(id); };
    runtime.startTurn = async () => { calls++; throw new Error('Must not invoke'); };
    const result = await engine.execute(lead, 'automation_dispatch', f.dispatch) as { message: { messageId: string } };
    now = baseline + 30000; await engine.pump();
    assert.equal(calls, 0); assert.equal(engine.scheduler.get(result.message.messageId)?.state, 'queued');
  } finally { Date.now = original; await engine.close(); await f.cleanup(); }
});
