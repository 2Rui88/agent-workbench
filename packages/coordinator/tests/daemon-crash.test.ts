import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { engineFixture } from './fixtures/engine-fixture.js';
import { coordinatorRequest } from '../src/ipc.js';

async function start(path: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/daemon.ts', path], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr!.resume();
  await new Promise<void>((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Daemon startup timeout')); }, 5000);
    child.on('error', reject);
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('Daemon exited before readiness')); });
    child.stdout!.on('data', (chunk) => { buffer += chunk.toString(); if (buffer.includes('"status":"ready"')) { clearTimeout(timeout); resolve(); } });
  });
  return child;
}
async function stop(child: ChildProcess | undefined, signal: NodeJS.Signals): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill(signal); await exited;
}

test('dead coordinator socket is recovered only after owned process crash; turn is not replayed', async () => {
  const f = await engineFixture(); let child: ChildProcess | undefined;
  const path = join(f.dir, 'runtime.json'); const socket = join(f.dir, 'coordinator.sock');
  await writeFile(join(f.dir, 'roles.json'), JSON.stringify({ groupId: 'g', credentials: f.credentials }), { mode: 0o600 });
  await writeFile(join(f.dir, 'human.json'), JSON.stringify({ capability: 'human-control-012345678901234567890123456789' }), { mode: 0o600 });
  await writeFile(path, JSON.stringify({ groupId: 'g', mode: 'mock', databasePath: f.db, socketPath: socket, credentialFile: join(f.dir, 'roles.json'), humanCredentialFile: join(f.dir, 'human.json'), allowedRoots: [f.dir] }));
  const call = (roleId: 'lead' | 'backend', command: 'automation_role_initialize' | 'automation_dispatch' | 'automation_status', input: unknown) => coordinatorRequest(socket, { channel: 'role', roleId, generation: 1, capability: f.credentials[roleId], command, input });
  try {
    child = await start(path);
    await call('lead', 'automation_status', {}); // Real protocol readiness before flow.
    await call('lead', 'automation_role_initialize', { cwd: f.dir }); await call('backend', 'automation_role_initialize', { cwd: f.dir });
    const result = await call('lead', 'automation_dispatch', f.dispatch) as { message: { messageId: string } };
    const deadline = Date.now() + 3000;
    while (f.engine.scheduler.get(result.message.messageId)?.state !== 'active' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.engine.scheduler.get(result.message.messageId)?.state, 'active');
    await stop(child, 'SIGKILL'); child = undefined;
    child = await start(path);
    const status = await call('lead', 'automation_status', {}) as { dispatches: Array<{ state: string }> };
    assert.equal(status.dispatches[0]?.state, 'needs_reconciliation');
    assert.equal(f.engine.store.getMessage(result.message.messageId)?.status, 'needs_reconciliation');
    await call('lead', 'automation_role_initialize', { cwd: f.dir }); await call('backend', 'automation_role_initialize', { cwd: f.dir });
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(f.engine.scheduler.get(result.message.messageId)?.state, 'needs_reconciliation');
  } finally { await stop(child, 'SIGTERM'); await f.cleanup(); }
});

test('daemon records its pid next to the group database and removes it on SIGTERM', async () => {
  const f = await engineFixture(); let child: ChildProcess | undefined;
  const path = join(f.dir, 'runtime.json'); const pidFile = join(dirname(f.db), 'daemon.pid');
  await writeFile(join(f.dir, 'roles.json'), JSON.stringify({ groupId: 'g', credentials: f.credentials }), { mode: 0o600 });
  await writeFile(join(f.dir, 'human.json'), JSON.stringify({ capability: 'human-control-012345678901234567890123456789' }), { mode: 0o600 });
  await writeFile(path, JSON.stringify({ groupId: 'g', mode: 'mock', databasePath: f.db, socketPath: join(f.dir, 'coordinator.sock'), credentialFile: join(f.dir, 'roles.json'), humanCredentialFile: join(f.dir, 'human.json'), allowedRoots: [f.dir] }));
  try {
    child = await start(path);
    assert.equal((await readFile(pidFile, 'utf8')).trim(), String(child.pid));
    await stop(child, 'SIGTERM'); child = undefined;
    assert.equal(existsSync(pidFile), false);
  } finally { await stop(child, 'SIGTERM'); await f.cleanup(); }
});
