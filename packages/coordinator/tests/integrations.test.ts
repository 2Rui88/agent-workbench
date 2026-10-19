import assert from 'node:assert/strict';
import test from 'node:test';
import { CliTaskAuthority } from '../src/integrations/adapters.js';
import { ValidationRegistry } from '../src/validation.js';
import type { Actor } from '../src/protocol.js';

const task = { id: 't1', owner: 'jande', repositoryId: 'repo', worktreePath: '/worktree', version: 4, status: 'in_progress', lease: { active: true, owner: 'jande' }, conflicts: [] as string[] };
const client = {
  getTask: async () => task,
  checkpoint: async () => ({ ok: true }),
  submit: async () => ({ ok: true, status: 'pending_acceptance' as const })
};

test('no task lease or mismatched Git identity prevents dispatch', async () => {
  const authority = new CliTaskAuthority(client);
  await assert.rejects(authority.checkGate({ taskRef: 't1', owner: 'other', repositoryId: 'repo', worktreePath: '/worktree', expectedVersion: 4 }), { code: 'TASK_GATE_CLOSED' });
  await assert.rejects(authority.checkGate({ taskRef: 't1', owner: 'jande', repositoryId: 'repo', worktreePath: '/wrong', expectedVersion: 4 }), { code: 'TASK_GATE_CLOSED' });
});

test('agent cannot accept task and unknown operation must reconcile first', async () => {
  const authority = new CliTaskAuthority(client);
  await assert.rejects(authority.accept('t1'), { code: 'HUMAN_ACCEPTANCE_ONLY' });
  await assert.rejects(authority.retryUnknown('op-unknown'), { code: 'RECONCILIATION_REQUIRED' });
});

test('validation cycles preserve rejected baseline and require evidence for a new passed cycle', () => {
  const audit: Actor = { groupId: 'g1', roleId: 'audit', bindingGeneration: 1, capabilityId: 'audit-cap' };
  const registry = new ValidationRegistry();
  try {
    const first = registry.create(audit, 'contract-v2', 'commit-a');
    const rejected = registry.record(audit, first.validationId, 'rejected', [{ command: 'npm test', outcome: 'failed', summary: 'assertion failed' }]);
    assert.equal(rejected.baselineRef, 'commit-a');
    assert.throws(() => registry.record(audit, first.validationId, 'passed', [{ command: 'npm test', outcome: 'passed', summary: 'later pass cannot rewrite a rejected cycle' }]), { code: 'VALIDATION_CYCLE_CLOSED' });
    const second = registry.create(audit, 'contract-v2', 'commit-b');
    assert.equal(second.cycle, 2);
    assert.throws(() => registry.record(audit, second.validationId, 'passed', []), { code: 'INVALID_INPUT' });
    assert.equal(registry.record(audit, second.validationId, 'passed', [{ command: 'npm test', outcome: 'passed', summary: 'all tests green' }]).baselineRef, 'commit-b');
  } finally { registry.close(); }
});

test('worker cannot pass a validation cycle owned by the audit role', async () => {
  const { ValidationRegistry } = await import('../src/validation.js');
  const registry = new ValidationRegistry();
  const audit = { groupId: 'audit-group', roleId: 'audit' as const, bindingGeneration: 1, capabilityId: 'audit' };
  try {
    const run = registry.create(audit, 'contract', 'baseline');
    assert.throws(() => registry.record({ ...audit, roleId: 'backend' }, run.validationId, 'passed', [{ command: 'test', outcome: 'passed', summary: 'forged worker receipt' }]), { code: 'FORBIDDEN' });
  } finally { registry.close(); }
});
