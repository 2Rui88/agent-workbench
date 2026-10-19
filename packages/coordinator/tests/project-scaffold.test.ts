import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildScaffold, writeScaffold } from '../src/project-scaffold.js';
import { loadRuntimeConfig } from '../src/runtime-config.js';

const base = (root: string) => ({ coordinatorRoot: join(root, 'coord'), group: 'my-app-20261010', repo: join(root, 'work', 'my-app'), repoId: 'my-app', memory: join(root, 'work', 'my-app', 'docs', '项目记忆.md'), frontend: join(root, 'work', 'my-app-workers', 'frontend'), backend: join(root, 'work', 'my-app-workers', 'backend'), taskMcpUrl: 'http://172.16.0.90:47321/mcp', taskServerUrl: 'http://172.16.0.90:47321', cliTaskRepo: join(root, 'cli-task') });

test('scaffold builds a runtime.json and helper scripts without secrets', () => {
  const s = buildScaffold(base('/r'));
  assert.equal(s.runDir, '/r/coord/.state/my-app-20261010');
  const names = s.files.map((f) => f.name).sort();
  assert.deepEqual(names, ['human-approvals.sh', 'human-init.sh', 'lead-rotate.sh', 'renew-workers.sh', 'runtime.json', 'start-daemon.sh', 'worker-hold.sh'].sort());
  const runtime = JSON.parse(s.files.find((f) => f.name === 'runtime.json')!.content);
  assert.equal(runtime.mode, 'real'); assert.equal(runtime.leadMode, 'external'); assert.equal(runtime.leadAgent, 'claude');
  assert.equal(runtime.leadWorktree, '/r/work/my-app');
  assert.deepEqual(runtime.roles, { frontend: { agent: 'codex' }, backend: { agent: 'codex' }, audit: { agent: 'claude' }, advisor: { agent: 'claude' } });
  assert.deepEqual(runtime.repositories.map((r: { worktreePath: string }) => r.worktreePath), ['/r/work/my-app', '/r/work/my-app-workers/frontend', '/r/work/my-app-workers/backend']);
  assert.deepEqual(runtime.projectMemory, { path: '/r/work/my-app/docs/项目记忆.md' });
  assert.equal('powerContext' in runtime, false);
  for (const key of ['receiptTimeoutMs', 'realExecution', 'workerTasks', 'workerTaskSpecs']) assert.equal(key in runtime, false, key);
  assert.equal('projectMemory' in JSON.parse(buildScaffold((({ memory: _memory, ...rest }) => rest)(base('/r'))).files.find((f) => f.name === 'runtime.json')!.content), false);
  for (const file of s.files.filter((f) => f.name.endsWith('.sh'))) {
    assert.match(file.content, /^#!\/bin\/sh\nset -eu\n/); assert.equal(file.mode, 0o700);
    assert.ok(file.content.includes('/r/coord/.state/my-app-20261010/runtime.json'), file.name);
  }
  assert.doesNotMatch(s.files.find((f) => f.name === 'start-daemon.sh')!.content, /POWERCONTEXT/);
  assert.equal(s.files.find((f) => f.name === 'runtime.json')!.mode, 0o600);
  assert.ok(!s.files.some((f) => /(AUTHORIZATION|_AUTH)=(?!%q)/.test(f.content)), 'no inline credentials');
  assert.throws(() => buildScaffold({ ...base('/r'), group: 'bad group' }), /group/);
});

test('written scaffold is private, refuses to overwrite, copies only coordinator tokens and loads as config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scaffold-'));
  try {
    const input = base(root);
    for (const dir of [input.coordinatorRoot, input.repo, input.frontend, input.backend, join(input.repo, 'docs')]) await mkdir(dir, { recursive: true });
    await writeFile(input.memory!, '# 项目记忆\n');
    const env = join(root, 'source.env');
    await writeFile(env, 'COORDINATOR_EXTRA=a\nOTHER_SECRET=x\n', { mode: 0o600 });
    const s = buildScaffold(input);
    await writeScaffold(s, { envFrom: env });
    assert.equal((await stat(s.runDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(s.runDir, 'daemon.env'))).mode & 0o777, 0o600);
    const copied = await readFile(join(s.runDir, 'daemon.env'), 'utf8');
    assert.ok(copied.includes('COORDINATOR_EXTRA=a') && !copied.includes('OTHER_SECRET'));
    assert.equal((await stat(join(s.runDir, 'start-daemon.sh'))).mode & 0o777, 0o700);
    await assert.rejects(writeScaffold(s, {}), /exists/);
    const config = await loadRuntimeConfig(join(s.runDir, 'runtime.json'));
    assert.equal(config.mode, 'app_server'); assert.equal(config.leadWorktree, input.repo); assert.equal(config.projectMemory?.path, input.memory);
  } finally { await rm(root, { recursive: true, force: true }); }
});
