import { spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { observerTabLabel } from '../src/terminal/herdr-controller.js';
import { lockHolderAlive, readLayoutLock } from '../src/terminal/layout-lock.js';
import { loadRuntimeConfig } from '../src/runtime-config.js';

// Opens the group's observation tab on the user's explicit request. Prints one JSON line:
// OPENED, ALREADY_OPEN, NOT_HERDR, NO_BUILD, BUSY or OPEN_FAILED. The controller lives as long as the lead
// process named by CLAUDE_PID (or until herdr:close); it never starts on its own.
const [configPath] = process.argv.slice(2);
if (!configPath) throw new Error('Usage: herdr-open <runtime.json>');
const print = (status: string, extra: Record<string, unknown>, message: string): never => { process.stdout.write(`${JSON.stringify({ status, ...extra, message })}\n`); process.exit(0); };
const config = await loadRuntimeConfig(configPath);
const dir = dirname(config.databasePath);
const label = observerTabLabel(config.groupId);
const env = process.env;
if (env.HERDR_ENV !== '1' || !env.HERDR_SOCKET_PATH || !env.HERDR_WORKSPACE_ID || !env.HERDR_PANE_ID || !env.HERDR_TAB_ID) print('NOT_HERDR', { groupId: config.groupId }, '当前会话不在 Herdr 中，无法打开观察标签。');
const holder = await readLayoutLock(dir);
if (lockHolderAlive(holder)) {
  if (holder!.backend !== 'herdr' || holder!.groupId !== config.groupId) print('BUSY', { groupId: config.groupId, holder }, '另一个布局控制器正在运行。');
  print('ALREADY_OPEN', { groupId: config.groupId, observerTab: holder!.observerTab ?? null, label }, `观察标签「${label}」已经打开。`);
}
const coordinatorRoot = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '..' : '../..', import.meta.url));
const script = join(coordinatorRoot, 'dist', 'scripts', 'herdr-follow.js');
if (!existsSync(script)) print('NO_BUILD', { groupId: config.groupId }, '协调器尚未构建（npm run build），观察标签不可用。');
const readyFile = join(dir, 'layout-ready.json');
await rm(readyFile, { force: true }); await rm(`${readyFile}.failed`, { force: true });
const out = openSync(join(dir, 'herdr-follow.log'), 'a', 0o600);
const leadPid = Number(env.CLAUDE_PID);
const child = spawn(process.execPath, [script, configPath], { detached: true, stdio: ['ignore', out, out], env: { ...env, COORDINATOR_HERDR_READY_FILE: readyFile, ...(Number.isSafeInteger(leadPid) && leadPid > 0 ? { COORDINATOR_LEAD_PID: String(leadPid) } : {}) } });
child.unref();
for (let i = 0; i < 300 && !existsSync(readyFile) && !existsSync(`${readyFile}.failed`) && child.exitCode === null; i++) await delay(100);
if (!existsSync(readyFile)) {
  const detail = await readFile(`${readyFile}.failed`, 'utf8').catch(() => '');
  print('OPEN_FAILED', { groupId: config.groupId, log: join(dir, 'herdr-follow.log') }, `观察标签未能打开：${detail.trim() || '控制器未就绪'}，请查看 ${join(dir, 'herdr-follow.log')}。`);
}
const ready = JSON.parse(await readFile(readyFile, 'utf8')) as { observerTab?: string };
print('OPENED', { groupId: config.groupId, observerTab: ready.observerTab ?? null, label }, `已打开观察标签「${label}」；关闭它或退出主会话时自动收起。`);
