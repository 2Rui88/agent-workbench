import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TurnUsageLedger, codexUsageFromNotification, CODEX_USAGE_METHOD } from '../src/runtime/turn-usage.js';
import { AppServerRuntime } from '../src/runtime/app-server.js';

const breakdown = (inputTokens: number, cachedInputTokens: number, outputTokens: number) => ({ inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens: 0, totalTokens: inputTokens + outputTokens });

test('ledger records one row per dispatch and rejects conflicting rewrites', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'));
  const ledger = new TurnUsageLedger(join(dir, 's.sqlite'));
  try {
    const usage = { inputTokens: 10, outputTokens: 2, cachedInputTokens: 3, costUsd: null, source: 'codex_notification' as const };
    ledger.record({ groupId: 'g', roleId: 'frontend', agent: 'codex', dispatchId: 'd', threadId: 't', turnId: 'u', usage });
    ledger.record({ groupId: 'g', roleId: 'frontend', agent: 'codex', dispatchId: 'd', threadId: 't', turnId: 'u', usage });
    assert.deepEqual(ledger.get('d'), { ...usage, agent: 'codex' });
    assert.throws(() => ledger.record({ groupId: 'g', roleId: 'frontend', agent: 'codex', dispatchId: 'd', threadId: 't', turnId: 'u', usage: { ...usage, inputTokens: 99 } }), { code: 'RECONCILIATION_REQUIRED' });
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('codex notification parsing keeps last and cumulative totals', () => {
  const sample = { threadId: 'th', turnId: 'tu', tokenUsage: { last: breakdown(100, 40, 30), total: breakdown(1100, 400, 300), modelContextWindow: 1 } };
  assert.deepEqual(codexUsageFromNotification(sample), { threadId: 'th', turnId: 'tu', last: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 30 }, total: { inputTokens: 1100, cachedInputTokens: 400, outputTokens: 300 } });
  assert.equal(codexUsageFromNotification({ threadId: 'th', turnId: 'tu' }), undefined);
});

test('per-turn codex usage is the growth of the cumulative total across all responses in the turn', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  const runtime = new AppServerRuntime({ input, output });
  const send = (params: object) => input.write(JSON.stringify({ jsonrpc: '2.0', method: CODEX_USAGE_METHOD, params }) + '\n');
  send({ threadId: 'th', turnId: 'tu', tokenUsage: { last: breakdown(100, 40, 30), total: breakdown(1100, 400, 300) } });
  send({ threadId: 'th', turnId: 'tu', tokenUsage: { last: breakdown(50, 10, 20), total: breakdown(1150, 410, 320) } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(await runtime.readTurnUsage('th', 'tu'), { inputTokens: 150, cachedInputTokens: 50, outputTokens: 50, costUsd: null, source: 'codex_notification' });
  assert.equal(await runtime.readTurnUsage('th', 'other'), undefined);
  runtime.dispose();
});
