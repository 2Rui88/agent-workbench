import assert from 'node:assert/strict';
import test from 'node:test';
import { engineFixture } from './fixtures/engine-fixture.js';

test('claude lead + codex workers + claude audit/advisor complete reject -> dispute -> advice -> pass', async () => {
  const agents: Record<string, 'codex' | 'claude'> = { lead: 'claude', frontend: 'codex', backend: 'codex', audit: 'claude', advisor: 'claude' };
  const f = await engineFixture(undefined, { leadMode: 'external', agentFor: (role) => agents[role]!, advisor: { suggestAfterRejections: 2 } });
  const audit = f.engine.authenticate('audit', f.credentials.audit, 1);
  const advisor = f.engine.authenticate('advisor', f.credentials.advisor, 1);
  try {
    await f.engine.execute(f.lead, 'automation_lead_heartbeat', { sessionRef: 'claude-lead', cwd: f.dir, agent: 'claude' });
    for (const actor of [f.backend, advisor]) await f.engine.execute(actor, 'automation_role_initialize', { cwd: f.dir });
    const dispatched = await f.engine.execute(f.lead, 'automation_dispatch', f.dispatch) as { message: { messageId: string } };
    await f.engine.pump();
    const work = f.engine.scheduler.get(dispatched.message.messageId)!;
    assert.equal((work as { agent?: string }).agent, 'codex');
    assert.equal(work.state, 'active');
    await f.engine.execute(f.backend, 'automation_work_complete', { dispatchId: work.dispatchId, summary: 'implemented', evidence: ['npm test passed'] });
    assert.equal(f.engine.scheduler.get(work.dispatchId)!.state, 'completed');
    const v1 = await f.engine.execute(audit, 'automation_validation_create', { contractRef: f.dispatch.work.contractRef, baselineRef: 'base', operationId: 'v1' }) as { validationId: string };
    await f.engine.execute(audit, 'automation_validation_record', { validationId: v1.validationId, outcome: 'rejected', evidence: [{ command: 'npm test', outcome: 'failed', summary: 'edge case' }] });
    await f.engine.execute(f.backend, 'automation_message_send', { type: 'dispute', recipientRole: 'lead', payload: { validationId: v1.validationId, reason: 'spec allows this' }, operationId: 'dispute-1' });
    assert.ok(f.engine.store.leadInbox('g').find((m) => m.type === 'arbitration_suggested'));
    const advice = await f.engine.execute(f.lead, 'automation_advice_request', { binding: f.dispatch.binding, kind: 'arbitration', question: 'Is the rejection valid?', refs: { contractRef: f.dispatch.work.contractRef, contractRevision: 'v1', dispatchIds: [work.dispatchId], validationIds: [v1.validationId] }, operationId: 'arb' }) as { adviceId: string; sameSource: boolean };
    assert.equal(advice.sameSource, false, 'codex worker vs claude audit/advisor');
    await f.engine.pump();
    await f.engine.execute(advisor, 'automation_advice_complete', { adviceId: advice.adviceId, recommendation: 'Uphold; fix edge case', rationale: 'Contract requires it', risks: [], confidence: 'high', evidenceRefs: ['contract v1'], verdict: 'uphold_rejection' });
    const resolved = await f.engine.execute(f.lead, 'automation_advice_resolve', { adviceId: advice.adviceId, decision: 'adopted', note: 'Repair in backend', operationId: 'resolve' }) as { state: string; agents: { worker: string[]; audit: string[]; advisor: string } };
    assert.deepEqual({ state: resolved.state, ...resolved.agents }, { state: 'resolved', worker: ['codex'], audit: ['claude'], advisor: 'claude' });
    const v2 = await f.engine.execute(audit, 'automation_validation_create', { contractRef: f.dispatch.work.contractRef, baselineRef: 'base-2', operationId: 'v2' }) as { validationId: string };
    await f.engine.execute(audit, 'automation_validation_record', { validationId: v2.validationId, outcome: 'passed', evidence: [{ command: 'npm test', outcome: 'passed', summary: 'all green' }] });
    assert.equal(f.engine.collaboration.validations.get(v1.validationId)!.state, 'rejected', 'history retained');
    assert.equal(f.engine.advisorBudget.status().callsUsed, 1);
    assert.equal(f.engine.budget.status().callsUsed, 1);
  } finally { await f.cleanup(); }
});
