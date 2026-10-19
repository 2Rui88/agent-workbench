import assert from 'node:assert/strict';
import test from 'node:test';
import { attachContext, attachState, resolveGroup, type GroupCandidate } from '../src/lead-attach.js';

const group = (groupId: string, leadWorktree: string, daemonRunning = false): GroupCandidate => ({ runtimePath: `/c/.state/${groupId}/runtime.json`, groupId, leadWorktree, daemonRunning });

test('resolveGroup picks the only group whose lead worktree is the git root', () => {
  assert.deepEqual(resolveGroup([group('a', '/repo'), group('b', '/other')], '/repo'), { kind: 'single', candidate: group('a', '/repo') });
});

test('resolveGroup prefers the group whose daemon is running, otherwise asks', () => {
  assert.deepEqual(resolveGroup([group('a', '/repo'), group('b', '/repo', true)], '/repo'), { kind: 'single', candidate: group('b', '/repo', true) });
  assert.equal(resolveGroup([group('a', '/repo'), group('b', '/repo')], '/repo').kind, 'choose');
  assert.equal(resolveGroup([group('a', '/repo', true), group('b', '/repo', true)], '/repo').kind, 'choose');
});

test('resolveGroup reports none when no group belongs to the repo', () => {
  assert.deepEqual(resolveGroup([group('a', '/other')], '/repo'), { kind: 'none' });
});

test('attachContext needs the Claude session and process and detects the layout backend', () => {
  assert.equal(attachContext({}).ok, false);
  const base = { CLAUDE_CODE_SESSION_ID: 's-1', CLAUDE_PID: '4242' };
  assert.deepEqual(attachContext(base), { ok: true, sessionRef: 's-1', claudePid: 4242, layout: 'none' });
  assert.equal((attachContext({ ...base, HERDR_ENV: '1', HERDR_SOCKET_PATH: '/s', HERDR_PANE_ID: 'p', HERDR_TAB_ID: 't', HERDR_WORKSPACE_ID: 'w' }) as { layout: string }).layout, 'herdr');
  assert.equal((attachContext({ ...base, HERDR_ENV: '1', HERDR_SOCKET_PATH: '/s' }) as { layout: string }).layout, 'none', 'partial Herdr context is not Herdr');
  assert.equal((attachContext({ ...base, KITTY_WINDOW_ID: '3', KITTY_LISTEN_ON: 'unix:/k' }) as { layout: string }).layout, 'kitty');
  assert.equal(attachContext({ ...base, CLAUDE_PID: 'x' }).ok, false);
});

test('attachState: same live session is already attached; a finished Claude lets its supervisor tear down first', () => {
  const alive = (live: number[]) => (pid: number) => live.includes(pid);
  const now = { sessionRef: 's-1', claudePid: 20 };
  assert.equal(attachState(undefined, now, alive([])), 'attach');
  assert.equal(attachState({ pid: 9, sessionRef: 's-1', claudePid: 20 }, now, alive([9, 20])), 'already');
  assert.equal(attachState({ pid: 9, sessionRef: 's-1', claudePid: 11 }, now, alive([9, 20])), 'wait', 'resumed session: the old Claude is gone and its supervisor is shutting down');
  assert.equal(attachState({ pid: 9, sessionRef: 's-0', claudePid: 11 }, now, alive([9, 20])), 'wait', 'other session gone, supervisor still tearing down');
  assert.equal(attachState({ pid: 9, sessionRef: 's-1', claudePid: 11 }, now, alive([9, 11, 20])), 'replace', 'same session resumed while the old Claude still runs');
  assert.equal(attachState({ pid: 9, sessionRef: 's-0', claudePid: 11 }, now, alive([9, 11, 20])), 'conflict', 'another live lead session');
  assert.equal(attachState({ pid: 9, sessionRef: 's-0', claudePid: 11 }, now, alive([20])), 'attach', 'nothing alive from the old record');
});


import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { engineFixture } from './fixtures/engine-fixture.js';

const attachScript = fileURLToPath(new URL('../scripts/lead-attach.ts', import.meta.url));
const daemonScript = fileURLToPath(new URL('../scripts/daemon.ts', import.meta.url));
async function attach(cwd: string, stateDir: string, env: Record<string, string>): Promise<{ status: string; [key: string]: unknown }> {
  const child = spawn(process.execPath, ['--import', 'tsx', attachScript, '--cwd', cwd], { env: { ...process.env, HERDR_ENV: '', KITTY_WINDOW_ID: '', COORDINATOR_STATE_DIR: stateDir, COORDINATOR_CLAUDE_MARKER: 'setInterval', ...env } });
  let out = ''; child.stdout.on('data', (c) => { out += c; });
  await once(child, 'exit');
  return JSON.parse(out.trim().split('\n').pop()!);
}
async function waitFor(check: () => boolean, ms = 20000): Promise<void> {
  for (let waited = 0; waited < ms; waited += 100) { if (check()) return; await delay(100); }
  throw new Error('condition not met in time');
}

test('lead:attach refuses outside Claude and reports a repo without a group', async () => {
  const state = await mkdtemp(join(tmpdir(), 'attach-state-')); const repo = await mkdtemp(join(tmpdir(), 'attach-repo-'));
  spawnSync('git', ['init', '-q', repo]);
  try {
    assert.equal((await attach(repo, state, { CLAUDE_CODE_SESSION_ID: '', CLAUDE_PID: '' })).status, 'NOT_CLAUDE');
    assert.equal((await attach(repo, state, { CLAUDE_CODE_SESSION_ID: 's', CLAUDE_PID: String(process.pid) })).status, 'NO_GROUP');
  } finally { await rm(state, { recursive: true, force: true }); await rm(repo, { recursive: true, force: true }); }
});

test('lead:attach starts the daemon, attaches once, stays idempotent and is replaced after a Claude restart', async () => {
  const f = await engineFixture();
  const repo = await realpath(f.dir); spawnSync('git', ['init', '-q', repo]); await mkdir(join(repo, 'sub'));
  const runDir = repo; // runtime files (daemon.pid, lead-supervisor.pid) live next to the group database
  const state = await mkdtemp(join(tmpdir(), 'attach-state-')); const groupDir = join(state, 'g'); await mkdir(groupDir, { mode: 0o700 });
  const runtime = join(groupDir, 'runtime.json');
  await writeFile(join(groupDir, 'roles.json'), JSON.stringify({ groupId: 'g', credentials: f.credentials }), { mode: 0o600 });
  await writeFile(join(groupDir, 'human.json'), JSON.stringify({ capability: 'human-control-012345678901234567890123456789' }), { mode: 0o600 });
  await writeFile(runtime, JSON.stringify({ groupId: 'g', mode: 'mock', leadMode: 'external', leadWorktree: repo, databasePath: f.db, socketPath: join(groupDir, 'c.sock'), credentialFile: 'roles.json', humanCredentialFile: 'human.json', allowedRoots: [repo, state] }));
  // project:init puts start-daemon.sh next to the database; this fixture keeps the database in the repo.
  await writeFile(join(runDir, 'start-daemon.sh'), `#!/bin/sh\nexec '${process.execPath}' --import tsx '${daemonScript}' '${runtime}'\n`, { mode: 0o700 });
  const claude = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const restarted = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const env = { CLAUDE_CODE_SESSION_ID: 'sess-1', CLAUDE_PID: String(claude.pid), COORDINATOR_WATCH_MS: '100' };
  const recordPath = join(runDir, 'lead-supervisor.pid');
  try {
    const first = await attach(join(repo, 'sub'), state, env);
    assert.equal(first.status, 'ATTACHED', JSON.stringify(first));
    const firstRecord = JSON.parse(await readFile(recordPath, 'utf8'));
    assert.equal(firstRecord.sessionRef, 'sess-1');
    assert.equal((await attach(repo, state, env)).status, 'ALREADY_ATTACHED');
    const again = await attach(repo, state, { ...env, CLAUDE_PID: String(restarted.pid) });
    assert.equal(again.status, 'ATTACHED', 'a resumed session with a new Claude pid replaces the stale supervisor');
    assert.notEqual(JSON.parse(await readFile(recordPath, 'utf8')).pid, firstRecord.pid);
    assert.ok(existsSync(join(runDir, 'daemon.pid')), 'replacing the supervisor keeps the daemon running');
    claude.kill(); restarted.kill();
    const third = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    try {
      const next = await attach(repo, state, { ...env, CLAUDE_CODE_SESSION_ID: 'sess-3', CLAUDE_PID: String(third.pid) });
      assert.equal(next.status, 'ATTACHED', `a new session right after the old one exits takes over without LEAD_CONFLICT: ${JSON.stringify(next)}`);
    } finally { third.kill(); }
    await waitFor(() => !existsSync(join(runDir, 'daemon.pid')) && !existsSync(recordPath));
  } finally { claude.kill(); restarted.kill(); await rm(state, { recursive: true, force: true }); await f.cleanup(); }
});

test('lead:attach treats a reachable daemon without a pid file as running and does not start another', async () => {
  const f = await engineFixture(); const repo = await realpath(f.dir); spawnSync('git', ['init', '-q', repo]);
  const state = await mkdtemp(join(tmpdir(), 'attach-state-')); const groupDir = join(state, 'g'); await mkdir(groupDir, { mode: 0o700 });
  const runtime = join(groupDir, 'runtime.json');
  await writeFile(join(groupDir, 'roles.json'), JSON.stringify({ groupId: 'g', credentials: f.credentials }), { mode: 0o600 });
  await writeFile(join(groupDir, 'human.json'), JSON.stringify({ capability: 'human-control-012345678901234567890123456789' }), { mode: 0o600 });
  await writeFile(runtime, JSON.stringify({ groupId: 'g', mode: 'mock', leadMode: 'external', leadWorktree: repo, databasePath: f.db, socketPath: join(groupDir, 'c.sock'), credentialFile: 'roles.json', humanCredentialFile: 'human.json', allowedRoots: [repo, state] }));
  const daemon = spawn(process.execPath, ['--import', 'tsx', daemonScript, runtime], { stdio: 'ignore' });
  const claude = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  try {
    await waitFor(() => existsSync(join(repo, 'daemon.pid')));
    await rm(join(repo, 'daemon.pid')); // a daemon from before pid files existed
    const result = await attach(repo, state, { CLAUDE_CODE_SESSION_ID: 'sess-2', CLAUDE_PID: String(claude.pid), COORDINATOR_WATCH_MS: '100' });
    assert.equal(result.status, 'ATTACHED', JSON.stringify(result)); // no start-daemon.sh exists, so a restart attempt would report DAEMON_FAILED
  } finally { claude.kill(); daemon.kill(); await rm(state, { recursive: true, force: true }); await f.cleanup(); }
});


async function groupFixture() {
  const f = await engineFixture(); const repo = await realpath(f.dir); spawnSync('git', ['init', '-q', repo]);
  const state = await mkdtemp(join(tmpdir(), 'attach-state-')); const groupDir = join(state, 'g'); await mkdir(groupDir, { mode: 0o700 });
  const runtime = join(groupDir, 'runtime.json');
  await writeFile(join(groupDir, 'roles.json'), JSON.stringify({ groupId: 'g', credentials: f.credentials }), { mode: 0o600 });
  await writeFile(join(groupDir, 'human.json'), JSON.stringify({ capability: 'human-control-012345678901234567890123456789' }), { mode: 0o600 });
  await writeFile(runtime, JSON.stringify({ groupId: 'g', mode: 'mock', leadMode: 'external', leadWorktree: repo, databasePath: f.db, socketPath: join(groupDir, 'c.sock'), credentialFile: 'roles.json', humanCredentialFile: 'human.json', allowedRoots: [repo, state] }));
  await writeFile(join(repo, 'start-daemon.sh'), `#!/bin/sh\nexec '${process.execPath}' --import tsx '${daemonScript}' '${runtime}'\n`, { mode: 0o700 });
  const claude = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const env = { CLAUDE_CODE_SESSION_ID: 'sess-x', CLAUDE_PID: String(claude.pid), COORDINATOR_WATCH_MS: '100' };
  const cleanup = async () => { claude.kill(); await waitFor(() => !existsSync(join(repo, 'daemon.pid'))).catch(() => {}); await rm(state, { recursive: true, force: true }); await f.cleanup(); };
  return { f, repo, state, groupDir, env, cleanup };
}

test('lead:attach ignores a corrupt supervisor record instead of crashing', async () => {
  const g = await groupFixture();
  try {
    await writeFile(join(g.repo, 'lead-supervisor.pid'), '{not json');
    const result = await attach(g.repo, g.state, g.env);
    assert.equal(result.status, 'ATTACHED', JSON.stringify(result));
  } finally { await g.cleanup(); }
});

test('lead:attach reports failures as JSON', async () => {
  const g = await groupFixture();
  try {
    await rm(join(g.groupDir, 'roles.json'));
    const result = await attach(g.repo, g.state, g.env);
    assert.equal(result.status, 'ATTACH_FAILED', JSON.stringify(result));
  } finally { await g.cleanup(); }
});

test('lead:attach refuses while another attach holds the lock', async () => {
  const g = await groupFixture();
  try {
    await writeFile(join(g.repo, 'lead-attach.lock'), String(process.pid));
    assert.equal((await attach(g.repo, g.state, g.env)).status, 'BUSY');
  } finally { await rm(join(g.repo, 'lead-attach.lock'), { force: true }); await g.cleanup(); }
});

test('lead:attach never signals a recycled pid named in a stale record', async () => {
  const g = await groupFixture(); const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  try {
    await writeFile(join(g.repo, 'lead-supervisor.pid'), JSON.stringify({ pid: unrelated.pid, sessionRef: 'sess-old', claudePid: 999999 }));
    const result = await attach(g.repo, g.state, g.env);
    assert.equal(result.status, 'ATTACHED', JSON.stringify(result));
    await delay(300);
    assert.equal(unrelated.exitCode, null); assert.equal(unrelated.signalCode, null);
  } finally { unrelated.kill(); await g.cleanup(); }
});

test('lead:attach inside Herdr never touches the layout: it attaches and leaves observation to herdr:open', async () => {
  const g = await groupFixture(); const socket = join(g.state, 'h.sock');
  const { createServer } = await import('node:net');
  let requests = 0;
  const server = createServer((connection) => connection.once('data', () => { requests++; connection.end(); }));
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const result = await attach(g.repo, g.state, { ...g.env, HERDR_ENV: '1', HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: 'w:p', HERDR_TAB_ID: 'w:t', HERDR_WORKSPACE_ID: 'w' });
    assert.equal(result.status, 'ATTACHED', JSON.stringify(result));
    assert.equal(result.layout, 'herdr');
    assert.equal(requests, 0, 'no Herdr request is made by attach');
    assert.equal(existsSync(join(g.repo, 'layout-controller.lock')), false);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await g.cleanup(); }
});
