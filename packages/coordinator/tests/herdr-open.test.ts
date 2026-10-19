import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { engineFixture } from './fixtures/engine-fixture.js';

const script = (name: string) => fileURLToPath(new URL(`../scripts/${name}.ts`, import.meta.url));
const distReady = existsSync(fileURLToPath(new URL('../dist/scripts/herdr-follow.js', import.meta.url)));
async function run(name: string, args: string[], env: Record<string, string | undefined>): Promise<Record<string, any>> {
  const child = spawn(process.execPath, ['--import', 'tsx', script(name), ...args], { env: { ...process.env, ...env } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  assert.ok(out.trim(), err);
  return JSON.parse(out.trim().split('\n').at(-1)!);
}

test('herdr:open and herdr:close drive the observation tab on explicit request only', { skip: !distReady && 'needs npm run build' }, async () => {
  const f = await engineFixture(); const dir = await mkdtemp(join(tmpdir(), 'herdr-open-')); const socket = join(dir, 's');
  const watcher = fileURLToPath(new URL('../dist/scripts/herdr-watch.js', import.meta.url));
  const roleByPane = new Map<string, string>(); const panes = new Map<string, string>([['w:p-main', 'w:t-main']]); const closed: string[] = []; let count = 0; let creates = 0;
  const server = createServer((connection) => connection.once('data', (data) => {
    const req = JSON.parse(String(data)); let result: unknown = {};
    if (req.method === 'pane.list') result = { panes: [...panes].map(([pane_id, tab_id]) => ({ pane_id, tab_id })) };
    else if (req.method === 'tab.create') { creates++; const pane_id = `w:p-${++count}`; panes.set(pane_id, 'w:t-obs'); result = { tab: { tab_id: 'w:t-obs' }, root_pane: { pane_id, tab_id: 'w:t-obs' } }; }
    else if (req.method === 'pane.split') { const pane_id = `w:p-${++count}`; panes.set(pane_id, panes.get(req.params.target_pane_id)!); result = { pane: { pane_id, tab_id: panes.get(pane_id) } }; }
    else if (req.method === 'pane.send_input') roleByPane.set(req.params.pane_id, String(req.params.text).match(/'(\w+)'$/)![1]!);
    else if (req.method === 'pane.process_info') result = { process_info: { foreground_processes: [{ name: 'node', argv: [process.execPath, watcher, f.db, 'g', roleByPane.get(req.params.pane_id) ?? 'none'] }] } };
    else if (req.method === 'tab.close') { closed.push(req.params.tab_id); for (const [pane, tab] of [...panes]) if (tab === req.params.tab_id) panes.delete(pane); }
    connection.end(JSON.stringify({ id: req.id, result }) + '\n');
  }));
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const lead = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  try {
    const runtime = join(dir, 'runtime.json');
    await writeFile(runtime, JSON.stringify({ groupId: 'g', databasePath: f.db, socketPath: join(dir, 'c.sock'), credentialFile: 'roles.json', humanCredentialFile: 'human.json', allowedRoots: [dir] }));
    const herdr = { HERDR_ENV: '1', HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: 'w:p-main', HERDR_TAB_ID: 'w:t-main', HERDR_WORKSPACE_ID: 'w', CLAUDE_PID: String(lead.pid) };
    assert.equal((await run('herdr-open', [runtime], { HERDR_ENV: undefined, HERDR_SOCKET_PATH: undefined })).status, 'NOT_HERDR');
    assert.equal((await run('herdr-close', [runtime], herdr)).status, 'NOT_OPEN');
    const opened = await run('herdr-open', [runtime], herdr);
    assert.equal(opened.status, 'OPENED', JSON.stringify(opened));
    assert.equal(opened.observerTab, 'w:t-obs'); assert.equal(opened.label, '流水線協同 · g');
    assert.equal([...panes.values()].filter((t) => t === 'w:t-obs').length, 5);
    assert.deepEqual([...panes].filter(([, t]) => t === 'w:t-main').map(([p]) => p), ['w:p-main']);
    const again = await run('herdr-open', [runtime], herdr);
    assert.equal(again.status, 'ALREADY_OPEN'); assert.equal(again.observerTab, 'w:t-obs'); assert.equal(creates, 1);
    const closedResult = await run('herdr-close', [runtime], herdr);
    assert.equal(closedResult.status, 'CLOSED', JSON.stringify(closedResult));
    assert.deepEqual(closed, ['w:t-obs']);
    for (let i = 0; i < 50 && existsSync(join(dirname(f.db), 'layout-controller.lock')); i++) await delay(100);
    assert.equal(existsSync(join(dirname(f.db), 'layout-controller.lock')), false);
    const saved = JSON.parse(await readFile(join(dirname(f.db), 'herdr-panes.json'), 'utf8'));
    assert.equal(saved.observerTab, undefined);
  } finally { lead.kill(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); await f.cleanup(); }
});
