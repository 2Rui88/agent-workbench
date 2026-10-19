import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { engineFixture } from './fixtures/engine-fixture.js';
import { startCoordinatorSocket } from '../src/ipc.js';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { groupIdle, recordPid, removePid, stopRecorded } from '../src/runtime-processes.js';

const status = (overrides: Record<string, unknown> = {}) => ({ budget: { inFlight: 0, unknown: 0 }, dispatches: [{ state: 'completed' }, { state: 'failed' }, { state: 'cancelled' }], approvals: [], ...overrides });

test('a group with only finished dispatches and no approvals is idle', () => {
  assert.deepEqual(groupIdle(status()), { idle: true });
});

test('in-flight dispatches, pending approvals or unknown outcomes keep the group running', () => {
  for (const state of ['queued', 'starting', 'leased', 'active', 'needs_reconciliation']) assert.equal(groupIdle(status({ dispatches: [{ state }] })).idle, false, state);
  assert.match(groupIdle(status({ approvals: [{}] })).reason!, /审批/);
  assert.match(groupIdle(status({ budget: { inFlight: 0, unknown: 1 } })).reason!, /未知/);
});

test('stopRecorded stops only the recorded process whose command line carries the marker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pids-'));
  const marker = join(dir, 'runtime.json');
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', marker]);
  try {
    await recordPid(dir, 'daemon', child.pid!);
    assert.equal((await readFile(join(dir, 'daemon.pid'), 'utf8')).trim(), String(child.pid));
    assert.equal(await stopRecorded(dir, 'daemon', join(dir, 'other.json')), 'mismatch');
    assert.equal(child.exitCode, null, 'a pid whose command line lacks the marker is not signalled');
    assert.equal(await stopRecorded(dir, 'daemon', marker), 'stopped');
    assert.equal(existsSync(join(dir, 'daemon.pid')), false);
    assert.equal(await stopRecorded(dir, 'daemon', marker), 'absent');
  } finally { child.kill(); await rm(dir, { recursive: true, force: true }); }
});

test('a stale pid file is removed without signalling anything', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pids-'));
  try {
    await writeFile(join(dir, 'worker-hold.pid'), '999999\n');
    assert.equal(await stopRecorded(dir, 'worker-hold', 'x'), 'absent');
    assert.equal(existsSync(join(dir, 'worker-hold.pid')), false);
    await recordPid(dir, 'worker-hold', process.pid); await removePid(dir, 'worker-hold');
    assert.equal(existsSync(join(dir, 'worker-hold.pid')), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function groupStop(runtime: string): Promise<{ code: number | null; out: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../scripts/group-stop.ts', import.meta.url)), runtime, '--if-idle']);
  let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  return { code, out };
}

test('group-stop stops the recorded daemon and lease holder once the group is idle', async () => {
  const f = await engineFixture(); const sockDir = join(f.dir, 'run'); await mkdir(sockDir, { mode: 0o700 });
  const runtime = join(f.dir, 'runtime.json'); const socketPath = join(sockDir, 'c.sock');
  await writeFile(join(f.dir, 'roles.json'), JSON.stringify({ groupId: 'g', credentials: f.credentials }), { mode: 0o600 });
  await writeFile(runtime, JSON.stringify({ groupId: 'g', databasePath: f.db, socketPath, credentialFile: 'roles.json', humanCredentialFile: 'human.json', allowedRoots: [f.dir] }));
  const service = await startCoordinatorSocket(f.engine, socketPath);
  const fakes = ['daemon', 'worker-hold'].map(() => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', runtime]));
  try {
    await recordPid(f.dir, 'daemon', fakes[0]!.pid!); await recordPid(f.dir, 'worker-hold', fakes[1]!.pid!);
    const result = await groupStop(runtime);
    assert.equal(result.code, 0, result.out);
    await delay(200);
    assert.ok(fakes.every((p) => p.exitCode !== null || p.signalCode !== null), result.out);
    assert.equal(existsSync(join(f.dir, 'daemon.pid')), false);
  } finally { fakes.forEach((p) => p.kill()); await service.close(); await f.cleanup(); }
});

test('group-stop keeps everything when the daemon cannot report its status', async () => {
  const f = await engineFixture(); const runtime = join(f.dir, 'runtime.json');
  await writeFile(join(f.dir, 'roles.json'), JSON.stringify({ groupId: 'g', credentials: f.credentials }), { mode: 0o600 });
  await writeFile(runtime, JSON.stringify({ groupId: 'g', databasePath: f.db, socketPath: join(f.dir, 'missing', 'c.sock'), credentialFile: 'roles.json', humanCredentialFile: 'human.json', allowedRoots: [f.dir] }));
  const fake = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', runtime]);
  try {
    await recordPid(f.dir, 'daemon', fake.pid!);
    const result = await groupStop(runtime);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /保留/);
    assert.equal(fake.exitCode, null);
  } finally { fake.kill(); await f.cleanup(); }
});

test('group-stop treats a dead daemon as stopped and clears its stale pid file', async () => {
  const f = await engineFixture(); const runtime = join(f.dir, 'runtime.json');
  await writeFile(runtime, JSON.stringify({ groupId: 'g', databasePath: f.db, socketPath: join(f.dir, 'missing', 'c.sock'), credentialFile: 'roles.json', humanCredentialFile: 'human.json', allowedRoots: [f.dir] }));
  try {
    await writeFile(join(f.dir, 'daemon.pid'), '999999\n');
    const result = await groupStop(runtime);
    assert.equal(result.code, 0, result.out);
    assert.doesNotMatch(result.out, /保留/);
    assert.equal(existsSync(join(f.dir, 'daemon.pid')), false);
  } finally { await f.cleanup(); }
});
