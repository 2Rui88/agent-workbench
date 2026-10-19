import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { coordinatorRequest } from '../src/ipc.js';
import { heartbeatReporter } from '../src/lead-launch.js';
import { loadRuntimeConfig, readProtectedJson } from '../src/runtime-config.js';
import { runningPid } from '../src/runtime-processes.js';
import { CoordinatorStore } from '../src/store.js';
import { lockHolderAlive, readLayoutLock } from '../src/terminal/layout-lock.js';

// Detached companion of one Claude lead process: heartbeat and worker lease renewal live exactly as long as
// CLAUDE_PID; when it exits an idle group shuts down. The observation tab (herdr:open) is a separate process that
// watches the same lead pid and closes itself.
const args = process.argv.slice(2);
const value = (key: string) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };
const runtimePath = resolve(args[0] ?? ''); const sessionRef = value('--session'); const claudePid = Number(value('--claude-pid'));
if (!args[0] || !sessionRef || !Number.isSafeInteger(claudePid)) throw new Error('Usage: lead-supervisor <runtime.json> --session <ref> --claude-pid <pid>');
const config = await loadRuntimeConfig(runtimePath);
const dir = dirname(config.databasePath);
const ms = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const log = (line: string) => process.stdout.write(`[lead-supervisor ${new Date().toISOString()}] ${line}\n`);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Sibling scripts run the same way this one runs (tsx in development, compiled JS in dist).
const sibling = (name: string, extra: string[], env: NodeJS.ProcessEnv = process.env): ChildProcess =>
  spawn(process.execPath, [...process.execArgv, fileURLToPath(new URL(`./${name}${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url)), ...extra], { env, stdio: 'inherit' });

const recordPath = join(dir, 'lead-supervisor.pid');
await writeFile(recordPath, JSON.stringify({ pid: process.pid, sessionRef, claudePid }), { mode: 0o600 });
const store = new CoordinatorStore(config.databasePath);
const generation = store.groupSnapshot(config.groupId)?.roles.find((role) => role.roleId === 'lead')?.bindingGeneration ?? 1;
store.close();
const capability = z.object({ groupId: z.literal(config.groupId), credentials: z.record(z.string(), z.string().min(32)) }).parse(await readProtectedJson(config.credentialFile)).credentials.lead!;
const report = heartbeatReporter(log);
const beat = () => coordinatorRequest(config.socketPath, { channel: 'role', roleId: 'lead', generation, capability, command: 'automation_lead_heartbeat', input: { sessionRef, cwd: config.leadWorktree ?? dir, agent: 'claude' } })
  .then(() => report.succeeded(), (error: unknown) => report.failed((error as { code?: string }).code ?? 'UNAVAILABLE'));
const renew = async () => { if (await runningPid(dir, 'worker-hold') === undefined) return; for (const role of ['frontend', 'backend']) await writeFile(join(dir, `renew-${role}.request`), 'renew\n', { mode: 0o600 }); log('worker lease renewal requested'); };

let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => {});
let inflight: Promise<unknown> = beat();
await inflight;
const heartbeat = setInterval(() => { inflight = beat(); }, ms('COORDINATOR_HEARTBEAT_MS', 20_000));
const renewal = setInterval(() => { void renew(); }, ms('COORDINATOR_RENEW_MS', 1_200_000));
while (!stopping && alive(claudePid)) await delay(ms('COORDINATOR_WATCH_MS', 1000));
clearInterval(heartbeat); clearInterval(renewal);
log(stopping ? 'stopped by signal' : 'Claude lead exited');
// Leaving normally: expire this session's presence so the next session can take over at once (after any beat in flight).
await inflight;
await coordinatorRequest(config.socketPath, { channel: 'role', roleId: 'lead', generation, capability, command: 'automation_lead_release', input: { sessionRef } }).catch(() => {});
// An open observation tab notices the lead pid itself and closes; give it a moment so the tab is gone before the group stops.
if (!stopping) for (let waited = 0; waited < 10_000 && lockHolderAlive(await readLayoutLock(dir)); waited += 200) await delay(200);
// SIGTERM means a newer session replaces this supervisor: keep the daemon for it. Only a lead exit may stop the group.
if (!stopping) await once(sibling('group-stop', [runtimePath, '--if-idle']), 'exit');
// A newer supervisor may already own the record; only remove our own.
const current = await readFile(recordPath, 'utf8').then((text) => (JSON.parse(text) as { pid?: number }).pid, () => undefined);
if (current === process.pid) await unlink(recordPath).catch(() => {});
process.exit(0);
