import { setTimeout as delay } from 'node:timers/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CoordinatorObserver } from '../src/observer.js';
import type { RoleId } from '../src/protocol.js';

const groupId = process.env.COORDINATOR_GROUP_ID;
if (!groupId) throw new Error('Set COORDINATOR_GROUP_ID for the read-only observer.');
const observer = new CoordinatorObserver(resolve(process.env.COORDINATOR_DB_PATH ?? join(homedir(), '.codex', 'session-coordinator', 'state.sqlite')));
const intervalMs = Number(process.env.COORDINATOR_WATCH_INTERVAL_MS ?? 2000);
const role = process.env.COORDINATOR_ROLE as RoleId | undefined;
try {
  while (true) {
    process.stdout.write('\u001b[2J\u001b[H');
    const snapshot = observer.snapshot(groupId);
    console.log(JSON.stringify(role ? { role, ...(snapshot?.roles.find((item) => item.roleId === role) ?? { status: 'not_bound' }), groupId, groupStatus: snapshot?.groupStatus } : snapshot ?? { groupId, status: 'not_created' }, null, 2));
    await delay(intervalMs);
  }
} finally { observer.close(); }
