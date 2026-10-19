import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractRegistry } from '../src/contracts.js';
import type { Actor } from '../src/protocol.js';

const lead: Actor = { groupId: 'g', roleId: 'lead', bindingGeneration: 1, capabilityId: 'lead' };
const backend: Actor = { groupId: 'g', roleId: 'backend', bindingGeneration: 1, capabilityId: 'back' };

test('contract mismatch blocks only explicitly affected consumers', () => {
  const registry = new ContractRegistry();
  try {
  const contract = registry.publish(lead, { artifactRef: 'openapi.yaml', revision: 'v2', digest: 'sha256:abc', baselineRef: 'commit-a', compatibility: 'breaking', affectedRoles: ['backend'] });
  assert.equal(registry.assertUsable('g', 'frontend', contract.contractId, 'v1'), true);
  assert.throws(() => registry.assertUsable('g', 'backend', contract.contractId, 'v1'), { code: 'CONTRACT_MISMATCH' });
  registry.ack(backend, contract.contractId, 'v2');
  assert.equal(registry.assertUsable('g', 'backend', contract.contractId, 'v2'), true);
  } finally { registry.close(); }
});

test('contract revisions survive reopening the registry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coordinator-contract-'));
  const path = join(dir, 'contracts.sqlite');
  const first = new ContractRegistry(path);
  const contract = first.publish(lead, { artifactRef: 'schema', revision: 'v1', digest: 'sha256:d', baselineRef: 'base', compatibility: 'compatible', affectedRoles: [] });
  first.close();
  const reopened = new ContractRegistry(path);
  try { assert.equal(reopened.assertUsable('g', 'frontend', contract.contractId, 'v1'), true); } finally { reopened.close(); await rm(dir, { recursive: true, force: true }); }
});

test('publishing a newer breaking revision fences older packages of affected consumers', () => {
  const registry = new ContractRegistry();
  try {
    const old = registry.publish(lead, {artifactRef:'api',revision:'v1',digest:'old',baselineRef:'b1',compatibility:'breaking',affectedRoles:['backend']});
    registry.ack(backend,old.contractId,'v1');
    registry.publish(lead,{artifactRef:'api',revision:'v2',digest:'new',baselineRef:'b2',compatibility:'breaking',affectedRoles:['backend']});
    assert.throws(()=>registry.assertUsable('g','backend',old.contractId,'v1'),{code:'CONTRACT_MISMATCH'});
    assert.equal(registry.assertUsable('g','frontend',old.contractId,'v1'),true);
  }finally{registry.close();}
});
