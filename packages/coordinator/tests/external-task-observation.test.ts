import assert from 'node:assert/strict';
import test from 'node:test';
import { RepositoryTaskClient } from '../src/integrations/cli-task.js';

test('external observation verifies exact live holder without impersonating it or permitting writes', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const git = { owner: 'jande', email: 'jande@example.test', worktreePath: '/actual', head: 'base' };
  let holder = 'host-session';
  const client = new RepositoryTaskClient({ call: async (name, args) => {
    calls.push({ name, args });
    if (name === 'session_context') return { ok: true, data: { session_id: 'own-observer-session', repository_id: 'repo', worktree_path: '/actual' } };
    if (name === 'task_recovery_get') return { ok: true, data: { recovery: { task: { task_id: 'task', repository_id: 'repo', owner: 'jande', status: 'in_progress', version: 1, scopes: [{ scope_type: 'worktree_path', scope_value: '/actual' }] }, active_lease: { session_id: holder, expires_at: '2099-01-01T00:00:00Z' }, lease_session: { owner: 'jande', worktree_path: '/actual' } } } };
    return { ok: true, data: { conflict: { level: 'none' } } };
  } }, 'repo', git, Date.now, undefined, { taskRef: 'task', sessionId: 'host-session', expiresAt: '2099-01-01T00:00:00Z' });
  await client.bind();
  assert.equal((await client.getTask('task')).lease.active, true);
  assert.equal(calls.find((call) => call.name === 'task_recovery_get')?.args.session_id, 'own-observer-session');
  for (const action of [() => client.checkpoint('task', { operationId: 'cp', expectedVersion: 1 }), () => client.submit('task', {}), () => client.recoverAndStart('task', 'lead', 'start')]) await assert.rejects(action, { code: 'FORBIDDEN' });
  assert.equal(calls.some((call) => ['task_checkpoint', 'task_submit', 'task_start'].includes(call.name)), false);
  holder = 'different-session';
  assert.equal((await client.getTask('task')).lease.active, false);
  await assert.rejects(client.getTask('other-task'), { code: 'TASK_GATE_CLOSED' });
});
