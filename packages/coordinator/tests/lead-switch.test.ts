import assert from 'node:assert/strict';
import test from 'node:test';
import { engineFixture } from './fixtures/engine-fixture.js';

test('a second lead session is rejected until paused, expired and rotated; the old lead is fenced', async () => {
  const f = await engineFixture(undefined, { leadMode: 'external' });
  try {
    await f.engine.execute(f.lead, 'automation_lead_heartbeat', { sessionRef: 'codex-1', cwd: f.dir, agent: 'codex' });
    await f.engine.execute(f.lead, 'automation_lead_heartbeat', { sessionRef: 'codex-1', cwd: f.dir, agent: 'codex' });
    await assert.rejects(f.engine.execute(f.lead, 'automation_lead_heartbeat', { sessionRef: 'claude-1', cwd: f.dir, agent: 'claude' }), { code: 'LEAD_CONFLICT' });
    await assert.rejects(f.engine.humanRotateLead('independent-human-token'), { code: 'TASK_GATE_CLOSED' }, 'must pause first');
    await f.engine.execute(f.lead, 'automation_pause', { paused: true });
    await assert.rejects(f.engine.humanRotateLead('independent-human-token'), { code: 'TASK_GATE_CLOSED' }, 'old presence still fresh');
    f.engine.expireLeadPresenceForTest();
    await assert.rejects(f.engine.humanRotateLead('wrong-human-token'), { code: 'FORBIDDEN' });
    const { generation } = await f.engine.humanRotateLead('independent-human-token');
    assert.equal(generation, 2);
    await assert.rejects(f.engine.execute(f.lead, 'automation_status', {}), { code: 'FORBIDDEN' });
    const next = f.engine.authenticate('lead', f.credentials.lead, 2);
    await f.engine.execute(next, 'automation_lead_heartbeat', { sessionRef: 'claude-1', cwd: f.dir, agent: 'claude' });
    const [succession] = f.engine.leadSuccessions();
    assert.deepEqual({ from: succession!.fromSession, fromAgent: succession!.fromAgent, to: succession!.toSession, toAgent: succession!.toAgent, generation: succession!.generation }, { from: 'codex-1', fromAgent: 'codex', to: 'claude-1', toAgent: 'claude', generation: 2 });
  } finally { await f.cleanup(); }
});

test('heartbeat without agent stays compatible with existing hosts', async () => {
  const f = await engineFixture(undefined, { leadMode: 'external' });
  try { await f.engine.execute(f.lead, 'automation_lead_heartbeat', { sessionRef: 'legacy', cwd: f.dir }); assert.equal(f.engine.leadSuccessions().length, 0); } finally { await f.cleanup(); }
});

test('a new session takes over once the previous lead presence has expired, without rotation', async () => {
  const f = await engineFixture(undefined, { leadMode: 'external' });
  try {
    await f.engine.execute(f.lead, 'automation_lead_heartbeat', { sessionRef: 'claude-old', cwd: f.dir, agent: 'claude' });
    await assert.rejects(f.engine.execute(f.lead, 'automation_lead_heartbeat', { sessionRef: 'claude-new', cwd: f.dir, agent: 'claude' }), { code: 'LEAD_CONFLICT' });
    f.engine.expireLeadPresenceForTest();
    await f.engine.execute(f.lead, 'automation_lead_heartbeat', { sessionRef: 'claude-new', cwd: f.dir, agent: 'claude' });
    const [succession] = f.engine.leadSuccessions();
    assert.deepEqual({ from: succession!.fromSession, to: succession!.toSession, generation: succession!.generation }, { from: 'claude-old', to: 'claude-new', generation: 1 });
    await f.engine.execute(f.lead, 'automation_lead_heartbeat', { sessionRef: 'claude-new', cwd: f.dir, agent: 'claude' });
    assert.equal(f.engine.leadSuccessions().length, 1, 'renewing the same session records no further succession');
  } finally { await f.cleanup(); }
});

test('a lead that releases its presence lets the next session take over at once; a foreign release is ignored', async () => {
  const f = await engineFixture(undefined, { leadMode: 'external' });
  try {
    await f.engine.execute(f.lead, 'automation_lead_heartbeat', { sessionRef: 'claude-a', cwd: f.dir, agent: 'claude' });
    await f.engine.execute(f.lead, 'automation_lead_release', { sessionRef: 'someone-else' });
    await assert.rejects(f.engine.execute(f.lead, 'automation_lead_heartbeat', { sessionRef: 'claude-b', cwd: f.dir, agent: 'claude' }), { code: 'LEAD_CONFLICT' });
    await f.engine.execute(f.lead, 'automation_lead_release', { sessionRef: 'claude-a' });
    await f.engine.execute(f.lead, 'automation_lead_heartbeat', { sessionRef: 'claude-b', cwd: f.dir, agent: 'claude' });
    assert.equal(f.engine.leadSuccessions().at(-1)?.toSession, 'claude-b');
  } finally { await f.cleanup(); }
});
