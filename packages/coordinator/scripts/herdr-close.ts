import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { lockHolderAlive, readLayoutLock } from '../src/terminal/layout-lock.js';
import { loadRuntimeConfig } from '../src/runtime-config.js';

// Asks the running layout controller to close the observation tab and exit. Prints one JSON line: CLOSED, NOT_OPEN or CLOSE_TIMEOUT.
const [configPath] = process.argv.slice(2);
if (!configPath) throw new Error('Usage: herdr-close <runtime.json>');
const config = await loadRuntimeConfig(configPath);
const dir = dirname(config.databasePath);
const print = (status: string, message: string) => process.stdout.write(`${JSON.stringify({ status, groupId: config.groupId, message })}\n`);
const holder = await readLayoutLock(dir);
if (!lockHolderAlive(holder) || holder!.backend !== 'herdr' || holder!.groupId !== config.groupId) { print('NOT_OPEN', '观察标签没有打开。'); process.exit(0); }
await writeFile(join(dir, 'herdr-panes.json.close'), 'close\n', { mode: 0o600 });
for (let i = 0; i < 150; i++) { if (!lockHolderAlive(await readLayoutLock(dir))) { print('CLOSED', '观察标签已关闭。'); process.exit(0); } await delay(100); }
print('CLOSE_TIMEOUT', `控制器未在 15 秒内退出，请查看 ${join(dir, 'herdr-follow.log')}。`);
