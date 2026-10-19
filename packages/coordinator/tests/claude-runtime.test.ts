import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAgentRuntime, CLAUDE_APPROVAL_METHOD, type ClaudeMessage, type ClaudeQueryFn } from '../src/runtime/claude-agent.js';
import { ClaudeTurnJournal } from '../src/runtime/claude-journal.js';
import { observeThread } from '../src/runtime/thread-state.js';
import { ApprovalBridge } from '../src/approval-bridge.js';

type Script = (options: Record<string, unknown>) => AsyncGenerator<ClaudeMessage>;
function fakeQuery(scripts: Script[], models = [{ value: 'opus', resolvedModel: 'claude-opus-5-5', supportedEffortLevels: ['low', 'medium', 'high'] }]) {
  const calls: Array<Record<string, unknown>> = []; let interrupts = 0;
  const query: ClaudeQueryFn = ({ options }) => {
    calls.push(options);
    const script = typeof options.model === 'string' ? scripts.shift()! : async function* () {};
    const stream = script(options);
    return { [Symbol.asyncIterator]: () => stream, interrupt: async () => { interrupts++; }, supportedModels: async () => models };
  };
  return { query, calls, interrupts: () => interrupts };
}
const success = (extra: object = {}) => ({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, modelUsage: { 'claude-opus-5-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 50, cacheCreationInputTokens: 5, costUSD: 0.01 } }, ...extra });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function setup(scripts: Script[]) {
  const dir = await mkdtemp(join(tmpdir(), 'claude-rt-'));
  const journal = new ClaudeTurnJournal(join(dir, 's.sqlite'));
  const fake = fakeQuery(scripts);
  const runtime = new ClaudeAgentRuntime({ query: fake.query, journal, baseOptions: { settingSources: [] }, transcriptRoot: join(dir, 'projects'), interruptTimeoutMs: 50 });
  return { dir, journal, fake, runtime, cleanup: async () => { journal.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('first turn creates the session, later turns resume it, and usage is recorded', async () => {
  const s = await setup([async function* () { yield { type: 'system', subtype: 'init', model: 'claude-opus-5-5', apiKeySource: 'none' }; yield { type: 'assistant', message: { model: 'claude-opus-5-5' } }; yield success(); }, async function* () { yield success({ user_message_uuid: 'p2' }); }]);
  try {
    assert.deepEqual(await s.runtime.listModels(), [{ model: 'opus', efforts: ['low', 'medium', 'high'] }, { model: 'claude-opus-5-5', efforts: ['low', 'medium', 'high'] }]);
    const thread = await s.runtime.startThread('/repo');
    assert.deepEqual(observeThread(await s.runtime.readThread(thread), thread).turns, []);
    const first = await s.runtime.startTurn({ threadId: thread, input: '{"goal":"x"}', model: 'claude-opus-5-5', effort: 'high', cwd: '/repo' });
    await settle();
    const second = await s.runtime.startTurn({ threadId: thread, input: '{}', model: 'claude-opus-5-5', effort: 'high', cwd: '/repo' });
    await settle();
    const modelCalls = s.fake.calls.filter((call) => call.model);
    assert.equal(modelCalls[0]!.sessionId, thread); assert.equal(modelCalls[0]!.resume, undefined);
    assert.equal(modelCalls[1]!.resume, thread); assert.equal(modelCalls[1]!.sessionId, undefined);
    assert.deepEqual(observeThread(await s.runtime.readThread(thread), thread).turns.map((t) => t.status), ['completed', 'completed']);
    assert.deepEqual(await s.runtime.readTurnUsage!(thread, first.turnId), { inputTokens: 100, outputTokens: 20, cachedInputTokens: 55, costUsd: 0.01, source: 'claude_result' });
    assert.equal(s.journal.turn(first.turnId)!.apiKeySource, 'none');
    assert.equal(s.journal.turn(second.turnId)!.promptUuid, 'p2');
  } finally { await s.cleanup(); }
});

test('model evidence falls back to the n-th transcript prompt when the result has no prompt uuid', async () => {
  const s = await setup([async function* () { yield success(); }, async function* () { yield success(); }]);
  try {
    const thread = await s.runtime.startThread('/repo');
    await s.runtime.startTurn({ threadId: thread, input: 'a', model: 'claude-opus-5-5', effort: 'high', cwd: '/repo' }); await settle();
    const second = await s.runtime.startTurn({ threadId: thread, input: 'b', model: 'claude-opus-5-5', effort: 'high', cwd: '/repo' }); await settle();
    const rows = [
      { type: 'user', uuid: 'u1', sessionId: thread, message: { content: [{ type: 'text', text: 'a' }] } },
      { type: 'assistant', uuid: 'a1', sessionId: thread, effort: 'high', message: { model: 'claude-haiku-5-5' } },
      { type: 'user', uuid: 'u2', sessionId: thread, message: { content: [{ type: 'text', text: 'b' }] } },
      { type: 'assistant', uuid: 'a2', sessionId: thread, effort: 'high', message: { model: 'claude-opus-5-5' } }
    ];
    await mkdir(join(s.dir, 'projects', '-repo'), { recursive: true });
    await writeFile(join(s.dir, 'projects', '-repo', `${thread}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    assert.deepEqual(await s.runtime.readTurnModel(thread, second.turnId), { model: 'claude-opus-5-5', effort: 'high', source: 'claude_transcript' });
  } finally { await s.cleanup(); }
});

test('stream without result or with an error is never reported as completed', async () => {
  const s = await setup([async function* () { yield { type: 'assistant', message: { model: 'm' } }; }, async function* () { throw new Error('child exited'); }, async function* () { yield { type: 'result', subtype: 'error_max_turns', is_error: true }; }]);
  try {
    const thread = await s.runtime.startThread('/repo');
    const statuses: string[] = [];
    for (let i = 0; i < 3; i++) { const turn = await s.runtime.startTurn({ threadId: thread, input: 'x', model: 'm', effort: 'high', cwd: '/repo' }); await settle(); statuses.push(s.journal.turn(turn.turnId)!.status); }
    assert.deepEqual(statuses, ['unknown', 'unknown', 'failed']);
  } finally { await s.cleanup(); }
});

test('a second turn cannot start while one is in progress, and interrupt aborts after timeout', async () => {
  const s = await setup([async function* (options) { const signal = (options.abortController as AbortController).signal; await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })); throw new Error('aborted'); }]);
  try {
    const thread = await s.runtime.startThread('/repo');
    const turn = await s.runtime.startTurn({ threadId: thread, input: 'x', model: 'm', effort: 'high', cwd: '/repo' });
    await assert.rejects(s.runtime.startTurn({ threadId: thread, input: 'y', model: 'm', effort: 'high', cwd: '/repo' }), { code: 'RECONCILIATION_REQUIRED' });
    await s.runtime.interruptTurn(thread, turn.turnId);
    await settle();
    assert.equal(s.fake.interrupts(), 1);
    assert.equal(s.journal.turn(turn.turnId)!.status, 'interrupted');
  } finally { await s.cleanup(); }
});

test('resume marks orphaned in-progress turns from a previous instance as unknown', async () => {
  const s = await setup([]);
  const id = '11111111-2222-4333-8444-555555555555';
  try {
    s.journal.createThread(id, '/repo');
    s.journal.startTurn({ threadId: id, turnId: 'old', requestedModel: 'm', requestedEffort: 'high' });
    assert.equal(await s.runtime.resumeThread(id, '/repo'), id);
    assert.equal(s.journal.turn('old')!.status, 'unknown');
    await assert.rejects(s.runtime.resumeThread(id, '/elsewhere'), { code: 'RECONCILIATION_REQUIRED' });
  } finally { await s.cleanup(); }
});

test('tool permission requests flow through the human approval bridge', async () => {
  let decision: unknown;
  const s = await setup([async function* (options) { decision = await (options.canUseTool as Function)('Bash', { command: 'npm test' }, { signal: new AbortController().signal }); yield success(); }]);
  const bridge = new ApprovalBridge(join(s.dir, 's.sqlite'), 'human-capability-0123456789');
  try {
    const actor = { groupId: 'g', roleId: 'audit' as const, bindingGeneration: 1, capabilityId: 'c' };
    s.runtime.onServerRequest((event) => { bridge.enqueue(actor, 'instance', event.requestId!, event.method, event.params); });
    const thread = await s.runtime.startThread('/repo');
    await s.runtime.startTurn({ threadId: thread, input: 'x', model: 'm', effort: 'high', cwd: '/repo' });
    await settle();
    const [pending] = bridge.list('g');
    assert.equal(pending!.method, CLAUDE_APPROVAL_METHOD);
    assert.equal((pending!.params as { toolName: string }).toolName, 'Bash');
    await bridge.respond(pending!.id, 'human-capability-0123456789', 'accept', 'instance', (id, result) => s.runtime.respondToServerRequest(id, result as { decision: 'accept' }));
    await settle();
    assert.deepEqual(decision, { behavior: 'allow', updatedInput: { command: 'npm test' } });
    assert.equal(bridge.list('g').length, 0);
    await assert.rejects(s.runtime.respondToServerRequest('missing', { decision: 'accept' }), { code: 'RECONCILIATION_REQUIRED' });
  } finally { bridge.close(); await s.cleanup(); }
});

test('Claude usage keeps a field unknown when any model entry lacks it instead of counting zero', async () => {
  const { usageFrom } = await import('../src/runtime/claude-agent.js');
  assert.deepEqual(usageFrom({ a: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 1, cacheCreationInputTokens: 1 }, b: { inputTokens: 5, cacheReadInputTokens: 3 } }), { inputTokens: 15, outputTokens: null, cachedInputTokens: null });
  assert.deepEqual(usageFrom({}), { inputTokens: null, outputTokens: null, cachedInputTokens: null });
  assert.deepEqual(usageFrom({ a: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 2, cacheCreationInputTokens: 3 } }), { inputTokens: 1, outputTokens: 1, cachedInputTokens: 5 });
});
