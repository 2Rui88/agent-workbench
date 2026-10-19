import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CoordinatorStore } from '../src/store.js';
import type { Actor } from '../src/protocol.js';

const frontend: Actor = { groupId: 'g1', roleId: 'frontend', bindingGeneration: 3, capabilityId: 'frontend-cap' };
const backend: Actor = { groupId: 'g1', roleId: 'backend', bindingGeneration: 4, capabilityId: 'backend-cap' };

async function withStore(run: (store: CoordinatorStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'coordinator-store-'));
  const store = new CoordinatorStore(join(dir, 'state.sqlite'));
  store.bindRole(frontend);
  store.bindRole(backend);
  try { await run(store); } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
}

test('message survives reopening the SQLite store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coordinator-persist-'));
  const path = join(dir, 'state.sqlite');
  try {
    const first = new CoordinatorStore(path);
    first.bindRole(frontend);
    const sent = first.send(frontend, { type: 'assistance_request', recipientRole: 'backend', payload: { question: 'review' } }, 'op-1');
    first.close();
    const reopened = new CoordinatorStore(path);
    assert.deepEqual(reopened.getMessage(sent.messageId)?.payload, { question: 'review' });
    reopened.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('same operation is idempotent and rejects changed payload', async () => withStore(async (store) => {
  const first = store.send(frontend, { type: 'assistance_request', recipientRole: 'backend', payload: { question: 'a' } }, 'same-op');
  const retry = store.send(frontend, { type: 'assistance_request', recipientRole: 'backend', payload: { question: 'a' } }, 'same-op');
  assert.equal(first.messageId, retry.messageId);
  assert.throws(() => store.send(frontend, { type: 'assistance_request', recipientRole: 'backend', payload: { question: 'b' } }, 'same-op'), { code: 'IDEMPOTENCY_CONFLICT' });
}));

test('recipient claims oldest message once; another claimant cannot steal the lease', async () => withStore(async (store) => {
  const a = store.send(frontend, { type: 'assistance_request', recipientRole: 'backend', payload: { n: 1 } }, 'op-a');
  const b = store.send(frontend, { type: 'assistance_request', recipientRole: 'backend', payload: { n: 2 } }, 'op-b');
  assert.equal(store.claim(backend, 'claim-a', 30_000)?.messageId, a.messageId);
  assert.equal(store.claim(backend, 'claim-b', 30_000)?.messageId, b.messageId);
}));

test('stale lease generation cannot complete a claimed message', async () => withStore(async (store) => {
  const sent = store.send(frontend, { type: 'assistance_request', recipientRole: 'backend', payload: {} }, 'op-a');
  const claim = store.claim(backend, 'claim-a', 30_000);
  assert.ok(claim);
  assert.throws(() => store.complete({ ...backend, bindingGeneration: 5 }, sent.messageId, claim.leaseToken, { ok: true }), { code: 'STALE_LEASE' });
}));

test('rebinding invalidates an in-flight lease from the previous session', async () => withStore(async (store) => {
  const sent = store.send(frontend, { type: 'assistance_request', recipientRole: 'backend', payload: {} }, 'op-rebind');
  const claim = store.claim(backend, 'claim-rebind', 30_000);
  assert.ok(claim);
  store.bindRole({ ...backend, bindingGeneration: 5 });
  assert.throws(() => store.complete(backend, sent.messageId, claim.leaseToken, { ok: true }), { code: 'STALE_LEASE' });
}));

test('role capability is group and generation scoped', async () => withStore(async (store) => {
  store.setRoleCapability('g1', 'frontend', 'a-secret-local-capability-value-0123456789');
  store.assertAuthorized(frontend, 'a-secret-local-capability-value-0123456789');
  assert.throws(() => store.assertAuthorized({ ...frontend, groupId: 'g2' }, 'a-secret-local-capability-value-0123456789'), { code: 'FORBIDDEN' });
  store.bindRole({ ...frontend, bindingGeneration: 4 });
  assert.throws(() => store.assertAuthorized(frontend, 'a-secret-local-capability-value-0123456789'), { code: 'FORBIDDEN' });
}));

test('expired processing lease requires reconciliation before the message is redelivered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coordinator-expiry-'));
  let now = 1_000;
  const store = new CoordinatorStore(join(dir, 'state.sqlite'), () => now);
  store.bindRole(frontend); store.bindRole(backend); store.bindRole({ groupId: 'g1', roleId: 'lead', bindingGeneration: 1, capabilityId: 'lead' });
  try {
    const sent = store.send(frontend, { type: 'assistance_request', recipientRole: 'backend', payload: { request: 'run' } }, 'op-expiry');
    const claim = store.claim(backend, 'lease-expiry', 100);
    assert.ok(claim);
    now += 101;
    assert.equal(store.claim(backend, 'lease-retry', 100), undefined);
    assert.equal(store.getMessage(sent.messageId)?.status, 'needs_reconciliation');
    assert.throws(() => store.complete(backend, sent.messageId, claim.leaseToken, { ok: true }), { code: 'STALE_LEASE' });
    store.reconcile({ groupId: 'g1', roleId: 'lead', bindingGeneration: 1, capabilityId: 'lead' }, sent.messageId, 'not_started', 'Mock reconciliation confirmed no active operation.');
    assert.ok(store.claim(backend, 'lease-reconciled', 100));
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
