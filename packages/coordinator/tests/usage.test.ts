import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanApprovalGate } from '../src/approvals.js';
import { UsageLedger } from '../src/usage.js';
import type { Actor } from '../src/protocol.js';

const actor: Actor = { groupId: 'g1', roleId: 'backend', bindingGeneration: 1, capabilityId: 'cap' };

test('server request waits for a separate human capability', () => {
  const human = { id: 'separate-human-capability' };
  const gate = new HumanApprovalGate(human);
  const request = gate.request(actor, 'rpc-1', { command: 'write' });
  assert.equal(gate.list()[0]?.state, 'waiting_human');
  assert.throws(() => gate.respond(request.id, { id: actor.capabilityId }, { decision: 'approve' }), { code: 'FORBIDDEN' });
  assert.deepEqual(gate.respond(request.id, human, { decision: 'approve' }), { runtimeRequestId: 'rpc-1', decision: { decision: 'approve' } });
});

test('duplicate and out-of-order cumulative snapshots do not change usage', () => {
  const ledger = new UsageLedger();
  const current = { snapshotId: 's2', groupId: 'g1', roleId: 'backend', threadId: 't1', capturedAt: '2026-10-03T12:00:02.000Z', totals: { inputTokens: 20, outputTokens: 8 } };
  assert.equal(ledger.record(current), true);
  assert.equal(ledger.record(current), false);
  assert.equal(ledger.record({ ...current, snapshotId: 's1', capturedAt: '2026-10-03T12:00:01.000Z', totals: { inputTokens: 9, outputTokens: 2 } }), false);
  assert.equal(ledger.current('g1', 'backend', 't1')?.totals.inputTokens, 20);
  ledger.close();
});

test('usage snapshots survive reopening the ledger', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coordinator-usage-'));
  const path = join(dir, 'usage.sqlite');
  const snapshot = { snapshotId: 'persisted-s1', groupId: 'g1', roleId: 'backend', threadId: 't1', capturedAt: '2026-10-03T12:00:02.000Z', totals: { inputTokens: 20, outputTokens: 8 } };
  const first = new UsageLedger(path); first.record(snapshot); first.close();
  const reopened = new UsageLedger(path);
  try { assert.equal(reopened.current('g1', 'backend', 't1')?.totals.inputTokens, 20); } finally { reopened.close(); await rm(dir, { recursive: true, force: true }); }
});
