import assert from 'node:assert/strict';
import test from 'node:test';
import { engineFixture } from './fixtures/engine-fixture.js';

type Fixture = Awaited<ReturnType<typeof engineFixture>>;
const reject = async (f: Fixture, audit: never, n: number) => {
  const run = await f.engine.execute(audit, 'automation_validation_create', { contractRef: f.dispatch.work.contractRef, baselineRef: `base-${n}`, operationId: `v-${n}` }) as { validationId: string };
  await f.engine.execute(audit, 'automation_validation_record', { validationId: run.validationId, outcome: 'rejected', evidence: [{ command: 'npm test', outcome: 'failed', summary: 'x' }] });
  return run.validationId;
};
const suggestions = (f: Fixture) => f.engine.store.leadInbox('g').filter((message) => message.type === 'arbitration_suggested');

test('second consecutive rejection suggests arbitration exactly once per rejection', async () => {
  const f = await engineFixture(); const audit = f.engine.authenticate('audit', f.credentials.audit, 1) as never;
  try {
    await reject(f, audit, 1);
    assert.equal(suggestions(f).length, 0);
    const second = await reject(f, audit, 2);
    assert.equal(suggestions(f).length, 1);
    assert.equal((suggestions(f)[0]!.payload as { validationIds: string[] }).validationIds[0], second);
    await reject(f, audit, 3);
    assert.equal(suggestions(f).length, 2);
  } finally { await f.cleanup(); }
});

test('threshold is configurable', async () => {
  const f = await engineFixture(undefined, { advisor: { suggestAfterRejections: 3 } }); const audit = f.engine.authenticate('audit', f.credentials.audit, 1) as never;
  try { await reject(f, audit, 1); await reject(f, audit, 2); assert.equal(suggestions(f).length, 0); await reject(f, audit, 3); assert.equal(suggestions(f).length, 1); } finally { await f.cleanup(); }
});

test('worker dispute must reference a rejected validation and is routed to lead', async () => {
  const f = await engineFixture(); const audit = f.engine.authenticate('audit', f.credentials.audit, 1) as never;
  try {
    const rejected = await reject(f, audit, 1);
    await assert.rejects(f.engine.execute(f.backend, 'automation_message_send', { type: 'dispute', recipientRole: 'audit', payload: { validationId: rejected, reason: 'flaky' }, operationId: 'd0' }), { code: 'INVALID_INPUT' });
    await assert.rejects(f.engine.execute(f.backend, 'automation_message_send', { type: 'dispute', recipientRole: 'lead', payload: { validationId: 'missing', reason: 'flaky' }, operationId: 'd1' }), { code: 'INVALID_INPUT' });
    await f.engine.execute(f.backend, 'automation_message_send', { type: 'dispute', recipientRole: 'lead', payload: { validationId: rejected, reason: 'flaky test' }, operationId: 'd2' });
    assert.equal((suggestions(f)[0]!.payload as { reason: string }).reason, 'dispute');
    assert.ok(f.engine.store.leadInbox('g').some((message) => message.type === 'dispute'));
    await assert.rejects(f.engine.execute(f.backend, 'automation_message_send', { type: 'arbitration_suggested', recipientRole: 'lead', payload: {}, operationId: 'd3' }), { code: 'FORBIDDEN' });
  } finally { await f.cleanup(); }
});
