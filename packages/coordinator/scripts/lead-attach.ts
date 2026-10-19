import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { open, readFile, readdir, realpath, rm, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { coordinatorRequest } from '../src/ipc.js';
import { attachContext, attachState, resolveGroup, type GroupCandidate, type Layout, type SupervisorRecord } from '../src/lead-attach.js';
import { loadRuntimeConfig, readProtectedJson, type RuntimeConfig } from '../src/runtime-config.js';
import { runningPid, stopRecorded } from '../src/runtime-processes.js';
import { CoordinatorStore } from '../src/store.js';

// Attaches the calling Claude session as the group lead. Prints one JSON line; the skill decides what to say.
const args = process.argv.slice(2);
const value = (key: string) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };
class Done { constructor(readonly line: Record<string, unknown>) {} }
const done = (status: string, extra: Record<string, unknown>, message: string): never => { throw new Done({ status, ...extra, message }); };
const live = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const commandLine = (pid: number) => { try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }); } catch { return ''; } };
// scripts/lead-attach.ts (tsx) and dist/scripts/lead-attach.js both resolve to the coordinator checkout root.
const coordinatorRoot = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '..' : '../..', import.meta.url));
const stateDir = process.env.COORDINATOR_STATE_DIR ?? join(coordinatorRoot, '.state');
const claudeMarker = process.env.COORDINATOR_CLAUDE_MARKER ?? 'claude';
let lockPath: string | undefined;

async function main(): Promise<void> {
  const context = attachContext(process.env);
  if (!context.ok) done('NOT_CLAUDE', {}, context.reason);
  const { sessionRef, claudePid } = context as Extract<ReturnType<typeof attachContext>, { ok: true }>;
  const layout: Layout = (context as { layout: Layout }).layout;
  const cwd = resolve(value('--cwd') ?? process.env.INIT_CWD ?? process.cwd());
  const top = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const gitRoot = await realpath(top.status === 0 ? top.stdout.trim() : cwd);

  const candidates: Array<GroupCandidate & { config: RuntimeConfig }> = [];
  for (const entry of existsSync(stateDir) ? await readdir(stateDir, { withFileTypes: true }) : []) {
    const runtimePath = join(stateDir, entry.name, 'runtime.json');
    if (!entry.isDirectory() || !existsSync(runtimePath)) continue;
    try {
      const config = await loadRuntimeConfig(runtimePath);
      if (!config.leadWorktree) continue;
      candidates.push({ runtimePath, groupId: config.groupId, leadWorktree: await realpath(config.leadWorktree), daemonRunning: (await runningPid(dirname(config.databasePath), 'daemon')) !== undefined, config });
    } catch { /* unreadable runtime: not a candidate */ }
  }
  const wanted = value('--group');
  const pick = resolveGroup(wanted ? candidates.filter((c) => c.groupId === wanted) : candidates, gitRoot);
  if (pick.kind === 'none') done('NO_GROUP', { gitRoot }, wanted ? `当前仓库没有名为 ${wanted} 的协同组。` : '当前仓库还没有协同组，可用 project:init 新建。');
  if (pick.kind === 'choose') done('CHOOSE_GROUP', { candidates: pick.candidates.map((c) => c.groupId) }, '当前仓库有多个协同组，请选择一个（--group）。');
  const { config, runtimePath } = (pick as { candidate: GroupCandidate }).candidate as GroupCandidate & { config: RuntimeConfig };
  const dir = dirname(config.databasePath);
  const extra = { groupId: config.groupId, runtime: runtimePath };

  // One attach at a time per group; a lock left by a dead attach is cleared.
  const lock = join(dir, 'lead-attach.lock');
  const holder = Number((await readFile(lock, 'utf8').catch(() => '')).trim());
  if (holder && holder !== process.pid && live(holder)) done('BUSY', extra, '另一个接入正在进行，请稍后再试。');
  await rm(lock, { force: true });
  await (await open(lock, 'wx', 0o600)).writeFile(String(process.pid));
  lockPath = lock;

  // A recorded pid counts only while its command line still shows the expected process, so recycled pids are ignored.
  const recordPath = join(dir, 'lead-supervisor.pid');
  const readRecord = async () => { try { return JSON.parse(await readFile(recordPath, 'utf8')) as SupervisorRecord; } catch { return undefined; } };
  const record = await readRecord();
  const alive = (pid: number) => live(pid) && (pid === record?.pid ? commandLine(pid).includes('lead-supervisor') && commandLine(pid).includes(runtimePath) : commandLine(pid).includes(claudeMarker));
  const state = attachState(record, { sessionRef, claudePid }, alive);
  if (state === 'already') done('ALREADY_ATTACHED', { ...extra, layout }, '本会话已接入。');
  if (state === 'conflict') done('LEAD_CONFLICT', extra, '另一个 lead 会话仍在线，请先退出它。');
  if (state === 'wait' || state === 'replace') {
    if (state === 'replace') try { process.kill(record!.pid, 'SIGTERM'); } catch { /* already gone */ }
    for (let i = 0; i < 300 && live(record!.pid); i++) await delay(100);
    if (live(record!.pid)) done('BUSY', extra, '上一个 lead 会话仍在收尾，请稍后再试。');
  }

  const capability = z.object({ credentials: z.record(z.string(), z.string()) }).parse(await readProtectedJson(config.credentialFile)).credentials.lead;
  if (!capability) done('ATTACH_FAILED', extra, '缺少 lead 凭证。');
  const store = new CoordinatorStore(config.databasePath);
  const generation = (() => { try { return store.groupSnapshot(config.groupId)?.roles.find((r) => r.roleId === 'lead')?.bindingGeneration ?? 1; } finally { store.close(); } })();
  const request = (command: 'automation_status' | 'automation_lead_heartbeat', input: unknown) => coordinatorRequest(config.socketPath, { channel: 'role', roleId: 'lead', generation, capability: capability!, command, input });
  const reachable = () => request('automation_status', {}).then(() => true, () => false);

  const detached = (script: string, logName: string) => { const out = openSync(join(dir, logName), 'a', 0o600); spawn('sh', [script], { detached: true, stdio: ['ignore', out, out] }).unref(); };
  let startedDaemon = false;
  if ((await runningPid(dir, 'daemon')) === undefined && !(await reachable())) {
    if (!existsSync(join(dir, 'start-daemon.sh'))) done('DAEMON_FAILED', extra, `缺少 ${join(dir, 'start-daemon.sh')}。`);
    detached(join(dir, 'start-daemon.sh'), 'daemon.log'); startedDaemon = true;
    for (let i = 0; i < 300 && !(await reachable()); i++) await delay(100);
    if (!(await reachable())) done('DAEMON_FAILED', extra, `daemon 未就绪，请查看 ${join(dir, 'daemon.log')}。`);
  }
  if (config.workerTasks?.length && (await runningPid(dir, 'worker-hold')) === undefined && existsSync(join(dir, 'worker-hold.sh'))) detached(join(dir, 'worker-hold.sh'), 'worker-hold.log');

  try {
    await request('automation_lead_heartbeat', { sessionRef, cwd: config.leadWorktree!, agent: 'claude' });
  } catch (error) {
    if ((error as { code?: string }).code !== 'LEAD_CONFLICT') throw error;
    if (startedDaemon) await stopRecorded(dir, 'daemon', runtimePath);
    done('LEAD_CONFLICT', extra, '另一个 lead 会话仍在线（心跳未过期），请先退出它。');
  }

  const supervisorScript = fileURLToPath(new URL(`./lead-supervisor${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url));
  const out = openSync(join(dir, 'lead-supervisor.log'), 'a', 0o600);
  const child = spawn(process.execPath, [...process.execArgv, supervisorScript, runtimePath, '--session', sessionRef, '--claude-pid', String(claudePid)], { detached: true, stdio: ['ignore', out, out], env: process.env });
  child.unref();
  for (let i = 0; i < 100 && (await readRecord())?.pid !== child.pid && child.exitCode === null; i++) await delay(100);
  // Observation is never opened here: the user asks for it explicitly and the skill runs herdr:open.
  done('ATTACHED', { ...extra, layout }, layout === 'herdr' ? '已接入。需要观察时再说一声，我会打开观察标签。' : '已接入（当前终端不支持观察标签）。');
}

try { await main(); } catch (error) {
  const line = error instanceof Done ? error.line : { status: 'ATTACH_FAILED', code: (error as { code?: string }).code ?? 'ERROR', message: (error as Error).message };
  if (lockPath) await unlink(lockPath).catch(() => {});
  process.stdout.write(`${JSON.stringify(line)}\n`);
}
