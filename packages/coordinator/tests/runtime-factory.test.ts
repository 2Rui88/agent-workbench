import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeFactory, readOnlyRole } from '../src/runtime/factory.js';
import { ClaudeAgentRuntime } from '../src/runtime/claude-agent.js';
import { MockRuntime } from '../src/runtime/mock.js';
import { engineFixture } from './fixtures/engine-fixture.js';

const config = (mode: 'mock' | 'app_server', databasePath: string) => ({ groupId: 'g', mode, leadMode: 'external', databasePath, socketPath: '/tmp/s', credentialFile: '/tmp/c', humanCredentialFile: '/tmp/h', allowedRoots: ['/repo'], repositories: [{ repositoryId: 'r', worktreePath: '/repo' }, { repositoryId: 'r', worktreePath: '/fe' }], roles: { audit: { agent: 'claude' }, advisor: { agent: 'claude' } }, externalTaskObservation: { taskRef: 'lead', sessionId: 's', expiresAt: new Date(Date.now() + 3600_000).toISOString() }, workerTasks: [{ role: 'frontend', binding: { taskRef: 'f', owner: 'o', repositoryId: 'r', worktreePath: '/fe', expectedVersion: 1 }, sessionId: 's', expiresAt: new Date(Date.now() + 3600_000).toISOString() }], projectMemory: { path: '/docs-worktree/开发协同/项目记忆.md' } }) as never;

test('read-only decision covers audit, advisor and unenrolled workers', () => {
  const c = config('app_server', '/tmp/x.sqlite');
  assert.equal(readOnlyRole(c, 'audit', '/repo'), true);
  assert.equal(readOnlyRole(c, 'advisor', '/repo'), true);
  assert.equal(readOnlyRole(c, 'frontend', '/fe'), false);
  assert.equal(readOnlyRole(c, 'backend', '/repo'), true);
  assert.equal(readOnlyRole(c, 'frontend', '/fe', Date.now() + 7200_000), true);
});

test('factory picks the runtime by role agent and never starts codex for claude roles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-'));
  const codexStarts: string[] = [];
  const env = { HOME: '/h', PATH: '/bin' };
  const codexLaunches: Array<Record<string, any>> = [];
  try {
    const factory = createRuntimeFactory({ config: config('app_server', join(dir, 's.sqlite')), credentials: { audit: 'a'.repeat(40), advisor: 'b'.repeat(40), frontend: 'f'.repeat(40) }, roleMcpScript: '/m.js', inheritedServers: [], claudeQuery: () => { throw new Error('no turn in this test'); }, transcriptRoot: dir, env, startCodex: ((cwd: string, launch: Record<string, any>) => { codexStarts.push(cwd); codexLaunches.push(launch); return { runtime: new MockRuntime() as never, close: async () => {} }; }) as never });
    const audit = factory('audit', '/repo');
    assert.ok(audit.runtime instanceof ClaudeAgentRuntime);
    const auditOptions = (audit.runtime as unknown as { options: { baseOptions: Record<string, any> } }).options.baseOptions;
    assert.deepEqual(auditOptions.additionalDirectories, ['/fe', '/docs-worktree/开发协同'], 'the memory file directory is readable even outside every worktree');
    assert.match(auditOptions.systemPrompt.append, /read \/docs-worktree\/开发协同\/项目记忆\.md before starting/);
    await audit.close();
    factory('frontend', '/fe');
    assert.deepEqual(codexStarts, ['/fe']);
    assert.match(codexLaunches[0]!.threadPolicy.developerInstructions, /项目记忆\.md/);
    assert.ok(!codexLaunches[0]!.args.some((arg: string) => arg.includes('powercontext_role')));
    assert.throws(() => factory('backend', '/repo'), /credential/);
    const mock = createRuntimeFactory({ config: config('mock', join(dir, 's.sqlite')), credentials: {}, roleMcpScript: '/m.js', inheritedServers: [], claudeQuery: () => { throw new Error('x'); }, transcriptRoot: dir });
    assert.ok(mock('audit', '/repo').runtime instanceof MockRuntime);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('dispatch stamps the executing agent and keeps it through the outbox', async () => {
  const f = await engineFixture(undefined, { agentFor: (role) => role === 'backend' ? 'claude' : 'codex' });
  try {
    await f.engine.execute(f.backend, 'automation_role_initialize', { cwd: f.dir });
    await f.engine.execute(f.lead, 'automation_dispatch', f.dispatch);
    const [work] = f.engine.scheduler.list('g');
    assert.equal((work as { agent?: string }).agent, 'claude');
  } finally { await f.cleanup(); }
});
