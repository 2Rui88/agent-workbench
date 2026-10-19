import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BrowserQueue } from '../src/browser/queue.js';

test('two roles share one exclusive browser lease', async () => withQueue(async (queue) => {
  queue.enqueue('g', 'frontend', { url: 'http://localhost' }, 'op-1');
  queue.enqueue('g', 'audit', { url: 'http://localhost' }, 'op-2');
  assert.ok(queue.claim('frontend', 'lease-1'));
  assert.equal(queue.claim('audit', 'lease-2'), undefined);
}));

test('expiry of an in-flight browser action requires reconciliation and does not cancel it', async () => withQueue(async (queue) => {
  queue.enqueue('g', 'frontend', { url: 'http://localhost' }, 'op-1');
  const claim = queue.claim('frontend', 'lease-1', 10);
  assert.ok(claim);
  queue.markStarted(claim.requestId, claim.leaseToken);
  queue.advanceClock(20);
  assert.equal(queue.claim('audit', 'lease-2'), undefined);
  assert.equal(queue.get(claim.requestId)?.state, 'needs_reconciliation');
}));

test('stale lease cannot release another role claim', async () => withQueue(async (queue) => {
  queue.enqueue('g', 'frontend', { url: 'http://localhost' }, 'op-1');
  const claim = queue.claim('frontend', 'lease-1', 10);
  assert.ok(claim);
  queue.advanceClock(20);
  const next = queue.claim('audit', 'lease-2', 100);
  assert.ok(next);
  assert.equal(queue.release(claim.requestId, claim.leaseToken), false);
}));

async function withQueue(run: (queue: BrowserQueue) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'coordinator-browser-'));
  const queue = new BrowserQueue(join(dir, 'browser.sqlite'));
  try { await run(queue); } finally { queue.close(); await rm(dir, { recursive: true, force: true }); }
}
