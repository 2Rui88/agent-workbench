import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { engineFixture } from './fixtures/engine-fixture.js';
import { coordinatorRequest, startCoordinatorSocket } from '../src/ipc.js';

// Commands cross the real Unix socket boundary and are driven by the daemon timer.
test('Unix coordinator automatically starts a Mock dispatch and enforces role/human separation', async () => {
  const f = await engineFixture(); const path = join(f.dir, 'coordinator.sock');
  const service = await startCoordinatorSocket(f.engine, path, 10);
  const call = (roleId: 'lead' | 'backend', command: 'automation_role_initialize' | 'automation_dispatch' | 'automation_status' | 'automation_work_complete', input: unknown) => coordinatorRequest(path, { channel: 'role', roleId, generation: 1, capability: f.credentials[roleId], command, input });
  try {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await call('lead', 'automation_role_initialize', { cwd: f.dir });
    await call('backend', 'automation_role_initialize', { cwd: f.dir });
    const result = await call('lead', 'automation_dispatch', f.dispatch) as { message: { messageId: string } };
    const deadline = Date.now() + 2000;
    while (f.engine.scheduler.get(result.message.messageId)?.state !== 'active' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(f.engine.scheduler.get(result.message.messageId)?.state, 'active');
    const complete = await call('backend', 'automation_work_complete', { dispatchId: result.message.messageId, summary: 'Mock business passed', evidence: ['isolated test passed'] });
    assert.deepEqual(complete, { status: 'completed', finalAcceptance: 'human_only' });
    await assert.rejects(coordinatorRequest(path, { channel: 'human', capability: f.credentials.lead, command: 'approvals', input: {} }), { code: 'FORBIDDEN' });
    await assert.rejects(call('backend', 'automation_dispatch', f.dispatch), { code: 'FORBIDDEN' });
    await coordinatorRequest(path, { channel: 'human', capability: 'independent-human-token', command: 'takeover', input: { roleId: 'backend', evidence: 'user inspecting mock thread' } });
    const next = { ...f.dispatch, work: { ...f.dispatch.work, id: 'two' }, operationId: 'op-two' };
    const queued = await call('lead', 'automation_dispatch', next) as { message: { messageId: string } };
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(f.engine.scheduler.get(queued.message.messageId)?.state, 'queued');
    await coordinatorRequest(path, { channel: 'human', capability: 'independent-human-token', command: 'release', input: { roleId: 'backend', evidence: 'mock thread checked; returning control' } });
    assert.equal(f.runtimes.reduce((sum, runtime) => sum + runtime.providerCalls, 0), 0);
  } finally { await service.close(); await f.cleanup(); }
});

test('daemon restart fences persisted active dispatch before its old lease expires', async () => {
  const { CoordinatorEngine } = await import('../src/engine.js');
  const f = await engineFixture(); const path = join(f.dir, 'restart.sock');
  const first = await startCoordinatorSocket(f.engine, path, 10);
  await f.engine.execute(f.lead, 'automation_role_initialize', { cwd: f.dir });
  await f.engine.execute(f.backend, 'automation_role_initialize', { cwd: f.dir });
  const sent = await f.engine.execute(f.lead, 'automation_dispatch', f.dispatch) as { message: { messageId: string } };
  await f.engine.pump();
  assert.equal(f.engine.scheduler.get(sent.message.messageId)?.state, 'active');
  await first.close();
  const recovered = new CoordinatorEngine(f.options);
  const second = await startCoordinatorSocket(recovered, path, 10);
  try {
    assert.equal(recovered.scheduler.get(sent.message.messageId)?.state, 'needs_reconciliation');
    assert.equal(recovered.store.getMessage(sent.message.messageId)?.status, 'needs_reconciliation');
    await recovered.execute(f.lead, 'automation_role_initialize', { cwd: f.dir });
    await recovered.execute(f.backend, 'automation_role_initialize', { cwd: f.dir });
    await recovered.pump();
    assert.equal(recovered.scheduler.get(sent.message.messageId)?.state, 'needs_reconciliation');
    await assert.rejects(recovered.execute(f.backend, 'automation_work_complete', { dispatchId: sent.message.messageId, summary: 'old process receipt', evidence: ['stale evidence'] }), { code: 'STALE_LEASE' });
  } finally { await second.close(); await f.cleanup(); }
});

test('another coordinator for the same database group cannot steal live ownership through a different socket', async () => {
  const { CoordinatorEngine } = await import('../src/engine.js');
  const f = await engineFixture();
  const first = await startCoordinatorSocket(f.engine, join(f.dir, 'first.sock'), 10);
  const other = new CoordinatorEngine(f.options);
  let second: Awaited<ReturnType<typeof startCoordinatorSocket>> | undefined;
  try {
    await assert.rejects(async () => { second = await startCoordinatorSocket(other, join(f.dir, 'second.sock'), 10); }, { code: 'SERVICE_UNHEALTHY' });
  } finally { if (second) await second.close(); else await other.close(); await first.close(); await f.cleanup(); }
});
