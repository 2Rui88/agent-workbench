import assert from 'node:assert/strict';
import test from 'node:test';
import { engineFixture } from './fixtures/engine-fixture.js';

const agents: Record<string, 'codex' | 'claude'> = { lead: 'codex', frontend: 'codex', backend: 'claude', audit: 'claude', advisor: 'claude' };
async function withAdvisor() {
  const f = await engineFixture(undefined, { agentFor: (role) => agents[role]! });
  const advisor = f.engine.authenticate('advisor', f.credentials.advisor, 1);
  const audit = f.engine.authenticate('audit', f.credentials.audit, 1);
  // managed lead mode only pumps once the lead runtime exists
  await f.engine.execute(f.lead, 'automation_role_initialize', { cwd: f.dir });
  await f.engine.execute(advisor, 'automation_role_initialize', { cwd: f.dir });
  return { ...f, advisor, audit };
}
const request = (f: Awaited<ReturnType<typeof withAdvisor>>, extra: object = {}) => ({ binding: f.dispatch.binding, kind: 'consult', question: 'Which metric definition is safer?', refs: { contractRef: f.dispatch.work.contractRef, contractRevision: 'v1' }, operationId: 'advice-1', ...extra });

test('consult goes through the advisor queue and lead records a single decision', async () => {
  const f = await withAdvisor();
  try {
    const created = await f.engine.execute(f.lead, 'automation_advice_request', request(f)) as { adviceId: string; dispatchId: string; sameSource: boolean };
    assert.equal(created.sameSource, false);
    assert.deepEqual(await f.engine.execute(f.lead, 'automation_advice_request', request(f)), created, 'idempotent replay');
    await f.engine.pump();
    const [work] = f.engine.scheduler.list('g').filter((item) => item.roleId === 'advisor');
    assert.equal(work!.state, 'active');
    assert.equal((work as { agent?: string }).agent, 'claude');
    assert.equal(f.engine.advisorBudget.status().callsUsed, 1);
    assert.equal(f.engine.budget.status().callsUsed, 0);
    await assert.rejects(f.engine.execute(f.backend, 'automation_advice_complete', { adviceId: created.adviceId, recommendation: 'x', rationale: 'y', risks: [], confidence: 'high', evidenceRefs: ['e'] }), { code: 'FORBIDDEN' });
    const done = await f.engine.execute(f.advisor, 'automation_advice_complete', { adviceId: created.adviceId, recommendation: 'Use verified rows only', rationale: 'Unverified rows mislead', risks: ['small samples'], confidence: 'medium', evidenceRefs: ['src/dashboard/projection.ts'] }) as { status: string };
    assert.equal(done.status, 'completed');
    assert.ok(f.engine.store.leadInbox('g').some((message) => (message.payload as { kind?: string }).kind === 'advice_ready'));
    const got = await f.engine.execute(f.lead, 'automation_advice_get', { adviceId: created.adviceId }) as { state: string; agents: { advisor: string } };
    assert.equal(got.state, 'completed'); assert.equal(got.agents.advisor, 'claude');
    await f.engine.execute(f.lead, 'automation_advice_resolve', { adviceId: created.adviceId, decision: 'adopted', note: 'Matches spec', operationId: 'resolve-1' });
    await assert.rejects(f.engine.execute(f.lead, 'automation_advice_resolve', { adviceId: created.adviceId, decision: 'rejected', note: 'changed mind', operationId: 'resolve-2' }), { code: 'CONFLICT' });
  } finally { await f.cleanup(); }
});

test('arbitration requires a verdict and never changes the audit record', async () => {
  const f = await withAdvisor();
  try {
    const validation = await f.engine.execute(f.audit, 'automation_validation_create', { contractRef: f.dispatch.work.contractRef, baselineRef: 'base', operationId: 'v1' }) as { validationId: string };
    await f.engine.execute(f.audit, 'automation_validation_record', { validationId: validation.validationId, outcome: 'rejected', evidence: [{ command: 'npm test', outcome: 'failed', summary: 'regression' }] });
    await assert.rejects(f.engine.execute(f.lead, 'automation_advice_request', request(f, { kind: 'arbitration', operationId: 'arb-0' })), { code: 'INVALID_INPUT' });
    const created = await f.engine.execute(f.lead, 'automation_advice_request', request(f, { kind: 'arbitration', refs: { contractRef: f.dispatch.work.contractRef, contractRevision: 'v1', validationIds: [validation.validationId] }, operationId: 'arb-1' })) as { adviceId: string; sameSource: boolean };
    assert.equal(created.sameSource, true, 'claude audit judged by claude advisor');
    await f.engine.pump();
    await assert.rejects(f.engine.execute(f.advisor, 'automation_advice_complete', { adviceId: created.adviceId, recommendation: 'r', rationale: 'r', risks: [], confidence: 'low', evidenceRefs: ['e'] }), { code: 'INVALID_INPUT' });
    await f.engine.execute(f.advisor, 'automation_advice_complete', { adviceId: created.adviceId, recommendation: 'Overturn', rationale: 'Test was flaky', risks: [], confidence: 'low', evidenceRefs: ['log'], verdict: 'overturn' });
    assert.equal(f.engine.collaboration.validations.get(validation.validationId)!.state, 'rejected');
  } finally { await f.cleanup(); }
});

test('advice requests fail closed without an initialized advisor or with an unknown validation', async () => {
  const f = await engineFixture();
  try {
    await assert.rejects(f.engine.execute(f.lead, 'automation_advice_request', { binding: f.dispatch.binding, kind: 'consult', question: 'q', refs: { contractRef: f.dispatch.work.contractRef, contractRevision: 'v1' }, operationId: 'a' }), { code: 'TASK_GATE_CLOSED' });
  } finally { await f.cleanup(); }
  const g = await withAdvisor();
  try {
    await assert.rejects(g.engine.execute(g.lead, 'automation_advice_request', request(g, { kind: 'arbitration', refs: { contractRef: g.dispatch.work.contractRef, contractRevision: 'v1', validationIds: ['missing'] }, operationId: 'x' })), { code: 'INVALID_INPUT' });
  } finally { await g.cleanup(); }
});
