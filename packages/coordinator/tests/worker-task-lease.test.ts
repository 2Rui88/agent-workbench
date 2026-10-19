import assert from 'node:assert/strict';
import test from 'node:test';
import { initWorkerTask, renewWorkerTask, workerTaskManifest, type WorkerLeaseState } from '../src/worker-task-lease.js';

function fakeService(options: { conflict?: string; leaseHolder?: string; version?: number } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let version = options.version ?? 0; let token = 0;
  const reply = (data: Record<string, unknown>) => ({ ok: true, data });
  const tools = {
    async call(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === 'session_context') return reply({ session_id: (args.resume_session_id as string) ?? 'worker-session', resume_token: `token-${++token}`, repository_id: args.repository_id, worktree_path: args.worktree_path });
      if (name === 'task_create') return reply({ task_id: 'task-1', version: 0 });
      if (name === 'task_conflicts') return reply({ conflict: { level: options.conflict ?? 'none' } });
      if (name === 'task_start') { version = 1; return reply({ task_id: 'task-1', status: 'in_progress', version }); }
      if (name === 'task_checkpoint') { version += 1; return reply({ task_id: 'task-1', status: 'in_progress', version }); }
      if (name === 'task_recovery_get') return reply({ recovery: { task: { version, status: 'in_progress' }, active_lease: { session_id: options.leaseHolder ?? 'worker-session', expires_at: '2026-10-08T16:00:00.000Z' } } });
      throw new Error(`unexpected ${name}`);
    }
  };
  const collected: string[] = [];
  return { tools, calls, collected, collect: async (session: string, task: string) => { collected.push(`${session}/${task}`); } };
}
const spec = { role: 'frontend' as const, owner: 'jande', repositoryId: 'codex-session-coordinator', worktreePath: '/w/frontend', title: 'Dashboard 执行方展示：前端', goal: 'g', acceptanceCriteria: ['a'], nextAction: 'n', operationPrefix: 'op' };

test('init binds the worker worktree, creates, verifies and starts the task with host evidence', async () => {
  const s = fakeService();
  const state = await initWorkerTask({ tools: s.tools, collect: s.collect }, spec);
  assert.deepEqual(state, { role: 'frontend', taskId: 'task-1', sessionId: 'worker-session', resumeToken: 'token-1', version: 1, worktreePath: '/w/frontend', owner: 'jande', repositoryId: 'codex-session-coordinator', leaseExpiresAt: '2026-10-08T16:00:00.000Z' });
  assert.deepEqual(s.calls.map((c) => c.name), ['session_context', 'task_create', 'task_conflicts', 'task_start', 'task_recovery_get']);
  assert.deepEqual(s.calls[1]!.args.scopes, [{ scope_type: 'worktree_path', scope_value: '/w/frontend' }]);
  assert.deepEqual(s.collected, ['worker-session/task-1']);
});

test('init refuses to start a task with conflicts', async () => {
  const s = fakeService({ conflict: 'file' });
  await assert.rejects(initWorkerTask({ tools: s.tools, collect: s.collect }, spec), { code: 'TASK_GATE_CLOSED' });
  assert.ok(!s.calls.some((c) => c.name === 'task_start'));
});

test('renew reattaches the same session, checkpoints at the current version and keeps it in progress', async () => {
  const s = fakeService({ version: 1 });
  const state: WorkerLeaseState = { role: 'backend', taskId: 'task-1', sessionId: 'worker-session', resumeToken: 'token-old', version: 1, worktreePath: '/w/backend', owner: 'jande', repositoryId: 'codex-session-coordinator', leaseExpiresAt: 'x' };
  const renewed = await renewWorkerTask({ tools: s.tools, collect: s.collect }, state, 'renew-1');
  assert.deepEqual(s.calls[0]!.args, { owner: 'jande', repository_id: 'codex-session-coordinator', workspace_path: '/w/backend', worktree_path: '/w/backend', resume_session_id: 'worker-session', resume_token: 'token-old' });
  const checkpoint = s.calls.find((c) => c.name === 'task_checkpoint')!.args;
  assert.equal(checkpoint.expected_version, 1); assert.equal(checkpoint.target_status, undefined);
  assert.deepEqual({ version: renewed.version, token: renewed.resumeToken }, { version: 2, token: 'token-1' });
});

test('renew fails closed when another session holds the lease', async () => {
  const s = fakeService({ leaseHolder: 'someone-else' });
  const state: WorkerLeaseState = { role: 'backend', taskId: 'task-1', sessionId: 'worker-session', resumeToken: 't', version: 1, worktreePath: '/w/backend', owner: 'jande', repositoryId: 'codex-session-coordinator', leaseExpiresAt: 'x' };
  await assert.rejects(renewWorkerTask({ tools: s.tools, collect: s.collect }, state, 'renew-2'), { code: 'TASK_GATE_CLOSED' });
});

test('manifest produces runtime workerTasks without resume tokens', () => {
  const manifest = workerTaskManifest([{ role: 'frontend', taskId: 't1', sessionId: 's1', resumeToken: 'secret-token', version: 3, worktreePath: '/w/f', owner: 'jande', repositoryId: 'r', leaseExpiresAt: 'x' }], '2026-10-08T19:00:00.000Z');
  assert.deepEqual(manifest, [{ role: 'frontend', binding: { taskRef: 't1', owner: 'jande', repositoryId: 'r', worktreePath: '/w/f', expectedVersion: 3 }, sessionId: 's1', expiresAt: '2026-10-08T19:00:00.000Z' }]);
  assert.ok(!JSON.stringify(manifest).includes('secret-token'));
});

test('checkpointLease renews on the live transport without reattaching', async () => {
  const { checkpointLease } = await import('../src/worker-task-lease.js');
  const s = fakeService({ version: 1 });
  const state: WorkerLeaseState = { role: 'frontend', taskId: 'task-1', sessionId: 'worker-session', resumeToken: 't', version: 1, worktreePath: '/w/f', owner: 'jande', repositoryId: 'r', leaseExpiresAt: 'x' };
  const renewed = await checkpointLease({ tools: s.tools, collect: s.collect }, state, 'live-1');
  assert.deepEqual(s.calls.map((c) => c.name), ['task_checkpoint', 'task_recovery_get']);
  assert.equal(renewed.version, 2);
});

test('acquireLease starts an existing task from a new session once the old lease has expired', async () => {
  const { acquireLease } = await import('../src/worker-task-lease.js');
  const calls: string[] = [];
  let leaseHolder: string | null = 'old-session'; let expires = new Date(Date.now() + 60_000).toISOString(); let version = 3;
  const tools = { async call(name: string, args: Record<string, unknown>) {
    calls.push(name);
    if (name === 'session_context') return { ok: true, data: { session_id: 'new-session', resume_token: 'nt', worktree_path: args.worktree_path } };
    if (name === 'task_recovery_get') return { ok: true, data: { recovery: { task: { version }, active_lease: leaseHolder ? { session_id: leaseHolder, expires_at: expires } : null } } };
    if (name === 'task_conflicts') return { ok: true, data: { conflict: { level: 'none' } } };
    if (name === 'task_start') { assert.equal(args.expected_version, 3); version = 4; leaseHolder = 'new-session'; expires = '2026-10-08T17:00:00.000Z'; return { ok: true, data: { version } }; }
    throw new Error(name);
  } };
  const state: WorkerLeaseState = { role: 'backend', taskId: 'task-1', sessionId: 'old-session', resumeToken: 'ot', version: 3, worktreePath: '/w/b', owner: 'jande', repositoryId: 'r', leaseExpiresAt: expires };
  await assert.rejects(acquireLease({ tools, collect: async () => {} }, state), { code: 'RECONCILIATION_REQUIRED' });
  expires = new Date(Date.now() - 1000).toISOString();
  const acquired = await acquireLease({ tools, collect: async () => {} }, state);
  assert.deepEqual({ sessionId: acquired.sessionId, version: acquired.version, token: acquired.resumeToken }, { sessionId: 'new-session', version: 4, token: 'nt' });
});

test('worker Task spec is read from config and refused when missing', async () => {
  const { workerTaskSpec } = await import('../src/worker-task-lease.js');
  const spec = { title: 'Fix login', goal: 'g', acceptanceCriteria: ['a'], nextAction: 'n' };
  assert.deepEqual(workerTaskSpec({ workerTaskSpecs: { frontend: spec, backend: spec } }, 'backend'), spec);
  assert.throws(() => workerTaskSpec({}, 'frontend'), { code: 'INVALID_INPUT' });
});
