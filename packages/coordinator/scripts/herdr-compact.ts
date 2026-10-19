import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { OBSERVED_ROLES } from '../src/roles.js';
import { loadRuntimeConfig } from '../src/runtime-config.js';
import { lockHolderAlive, readLayoutLock } from '../src/terminal/layout-lock.js';

const [configPath, flag, role] = process.argv.slice(2);
if (!configPath || (flag && (flag !== '--role' || !(OBSERVED_ROLES as readonly string[]).includes(role ?? '')))) throw new Error('Usage: herdr-compact <runtime.json> [--role frontend|backend|audit|advisor]');
const config = await loadRuntimeConfig(configPath);
const stateDir = dirname(config.databasePath);
const lock = await readLayoutLock(stateDir);
if (!lock || lock.backend !== 'herdr' || lock.groupId !== config.groupId || !lockHolderAlive(lock)) throw new Error('No running Herdr layout controller for this group; open the observation tab with herdr:open first.');
await writeFile(join(stateDir, 'herdr-panes.json.compact'), role ?? '', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ requested: 'compact', role: role ?? 'idle-all' }));
