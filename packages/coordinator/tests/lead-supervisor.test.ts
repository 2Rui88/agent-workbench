import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { engineFixture } from './fixtures/engine-fixture.js';
import { recordPid } from '../src/runtime-processes.js';

const script = (name: string) => fileURLToPath(new URL(`../scripts/${name}.ts`, import.meta.url));
async function waitFor(check: () => boolean | Promise<boolean>, ms = 15000): Promise<void> {
  for (let waited = 0; waited < ms; waited += 100) { if (await check()) return; await delay(100); }
  throw new Error('condition not met in time');
}

test('supervisor heartbeats, requests worker renewals and shuts an idle group down when Claude exits', async () => {
  const f = await engineFixture(); const runtime = join(f.dir, 'runtime.json'); let daemon: ChildProcess | undefined;
  await writeFile(join(f.dir, 'roles.json'), JSON.stringify({ groupId: 'g', credentials: f.credentials }), { mode: 0o600 });
  await writeFile(join(f.dir, 'human.json'), JSON.stringify({ capability: 'human-control-012345678901234567890123456789' }), { mode: 0o600 });
  await writeFile(runtime, JSON.stringify({ groupId: 'g', mode: 'mock', leadMode: 'external', databasePath: f.db, socketPath: join(f.dir, 'coordinator.sock'), credentialFile: join(f.dir, 'roles.json'), humanCredentialFile: join(f.dir, 'human.json'), allowedRoots: [f.dir] }));
  daemon = spawn(process.execPath, ['--import', 'tsx', script('daemon'), runtime], { stdio: 'ignore' });
  const claude = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const holder = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', runtime]);
  try {
    await waitFor(() => existsSync(join(f.dir, 'daemon.pid')));
    await recordPid(f.dir, 'worker-hold', holder.pid!);
    const supervisor = spawn(process.execPath, ['--import', 'tsx', script('lead-supervisor'), runtime, '--session', 'sess-1', '--claude-pid', String(claude.pid)],
      { env: { ...process.env, COORDINATOR_HEARTBEAT_MS: '200', COORDINATOR_RENEW_MS: '300', COORDINATOR_WATCH_MS: '100' }, stdio: 'ignore' });
    await waitFor(() => existsSync(join(f.dir, 'lead-supervisor.pid')));
    assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'lead-supervisor.pid'), 'utf8')), { pid: supervisor.pid, sessionRef: 'sess-1', claudePid: claude.pid });
    await waitFor(() => { const db = new DatabaseSync(f.db, { readOnly: true }); try { return (db.prepare('SELECT session_ref FROM external_lead WHERE group_id=?').get('g') as { session_ref?: string } | undefined)?.session_ref === 'sess-1'; } finally { db.close(); } });
    await waitFor(() => existsSync(join(f.dir, 'renew-frontend.request')) && existsSync(join(f.dir, 'renew-backend.request')));
    const exited = once(supervisor, 'exit');
    claude.kill();
    const [code] = await exited;
    assert.equal(code, 0);
    await waitFor(() => daemon!.exitCode !== null || daemon!.signalCode !== null);
    await waitFor(() => holder.exitCode !== null || holder.signalCode !== null);
    assert.equal(existsSync(join(f.dir, 'lead-supervisor.pid')), false);
    const db = new DatabaseSync(f.db, { readOnly: true });
    try { assert.equal((db.prepare('SELECT expires_at FROM external_lead WHERE group_id=?').get('g') as { expires_at: number }).expires_at, 0, 'the leaving lead releases its presence'); } finally { db.close(); }
    daemon = undefined;
  } finally { claude.kill(); holder.kill(); daemon?.kill(); await f.cleanup(); }
});

test('a supervisor never deletes a record that a newer supervisor wrote', async () => {
  const f = await engineFixture(); const runtime = join(f.dir, 'runtime.json');
  await writeFile(join(f.dir, 'roles.json'), JSON.stringify({ groupId: 'g', credentials: f.credentials }), { mode: 0o600 });
  await writeFile(runtime, JSON.stringify({ groupId: 'g', mode: 'mock', leadMode: 'external', databasePath: f.db, socketPath: join(f.dir, 'missing', 'c.sock'), credentialFile: join(f.dir, 'roles.json'), humanCredentialFile: join(f.dir, 'human.json'), allowedRoots: [f.dir] }));
  const claude = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  try {
    const supervisor = spawn(process.execPath, ['--import', 'tsx', script('lead-supervisor'), runtime, '--session', 'sess-old', '--claude-pid', String(claude.pid)],
      { env: { ...process.env, COORDINATOR_WATCH_MS: '100' }, stdio: 'ignore' });
    await waitFor(() => existsSync(join(f.dir, 'lead-supervisor.pid')));
    const newer = JSON.stringify({ pid: 424242, sessionRef: 'sess-new', claudePid: 434343 });
    await writeFile(join(f.dir, 'lead-supervisor.pid'), newer);
    const exited = once(supervisor, 'exit'); claude.kill(); await exited;
    assert.equal(await readFile(join(f.dir, 'lead-supervisor.pid'), 'utf8'), newer);
  } finally { claude.kill(); await f.cleanup(); }
});
