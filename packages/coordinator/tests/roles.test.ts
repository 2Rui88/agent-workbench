import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROLE_IDS, CORE_ROLE_IDS, OBSERVED_ROLES, roleEnum, agentEnum, requiresWorkerEnrollment } from '../src/roles.js';
import { CoordinatorStore } from '../src/store.js';

const core = { lead: 'lead-capability-0123456789abcdef012345', frontend: 'frontend-capability-0123456789abcdef', backend: 'backend-capability-0123456789abcdef0', audit: 'audit-capability-0123456789abcdef012' };

test('role registry lists advisor as a daemon-managed observed role', () => {
  assert.deepEqual([...ROLE_IDS], ['lead', 'frontend', 'backend', 'audit', 'advisor']);
  assert.deepEqual([...CORE_ROLE_IDS], ['lead', 'frontend', 'backend', 'audit']);
  assert.deepEqual([...OBSERVED_ROLES], ['frontend', 'backend', 'audit', 'advisor']);
  assert.equal(roleEnum.parse('advisor'), 'advisor');
  assert.throws(() => agentEnum.parse('gpt'));
});

test('existing four-role groups stay valid and advisor can be added exactly once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'roles-'));
  const store = new CoordinatorStore(join(dir, 'db.sqlite'));
  try {
    store.initializeGroup('g', core);
    assert.equal(store.groupSnapshot('g')!.roles.length, 5);
    assert.throws(() => store.assertAuthorized({ groupId: 'g', roleId: 'advisor', bindingGeneration: 1, capabilityId: 'x'.repeat(40) }, 'x'.repeat(40)));
    store.addRoleCapability('g', 'advisor', 'advisor-capability-0123456789abcdef01');
    store.assertAuthorized({ groupId: 'g', roleId: 'advisor', bindingGeneration: 1, capabilityId: 'advisor-capability-0123456789abcdef01' }, 'advisor-capability-0123456789abcdef01');
    assert.throws(() => store.addRoleCapability('g', 'advisor', 'other-capability-0123456789abcdef0123'), { code: 'CONFLICT' });
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('only frontend and backend writes need an independent worker Task enrollment', () => {
  assert.deepEqual(ROLE_IDS.filter(requiresWorkerEnrollment), ['frontend', 'backend']);
});
