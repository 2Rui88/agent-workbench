import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { CoordinatorStore } from '../src/store.js';
import { loadRuntimeConfig } from '../src/runtime-config.js';
import type { RoleId } from '../src/protocol.js';
import { ROLE_IDS } from '../src/roles.js';

const config = process.argv[2] ? await loadRuntimeConfig(process.argv[2]) : undefined;
if (config && process.env.COORDINATOR_GROUP_ID && process.env.COORDINATOR_GROUP_ID !== config.groupId) throw new Error('Environment group does not match runtime config.');
const groupId = config?.groupId ?? process.env.COORDINATOR_GROUP_ID;
const role = process.env.COORDINATOR_ROLE;
if (!groupId || role !== 'lead') throw new Error('Configure COORDINATOR_GROUP_ID and COORDINATOR_ROLE=lead.');
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(groupId)) throw new Error('COORDINATOR_GROUP_ID must be 1-64 safe alphanumeric, dot, underscore, or hyphen characters.');
const credentialPath = resolve(config?.credentialFile ?? process.env.COORDINATOR_CREDENTIAL_FILE ?? `${process.env.HOME}/.codex/session-coordinator/credentials/${groupId}.json`);
const roles: RoleId[] = [...ROLE_IDS];
const credentials = Object.fromEntries(roles.map((roleId) => [roleId, randomBytes(32).toString('base64url')]));
await mkdir(resolve(credentialPath, '..'), { recursive: true, mode: 0o700 });
await chmod(resolve(credentialPath, '..'), 0o700);
await writeFile(credentialPath, `${JSON.stringify({ groupId, credentials }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
await chmod(credentialPath, 0o600);
let store: CoordinatorStore | undefined;
try {
  const databasePath = resolve(config?.databasePath ?? process.env.COORDINATOR_DB_PATH ?? `${process.env.HOME}/.codex/session-coordinator/state.sqlite`);
  await mkdir(resolve(databasePath, '..'), { recursive: true, mode: 0o700 });
  store = new CoordinatorStore(databasePath);
  await chmod(databasePath, 0o600);
  store.initializeGroup(groupId, credentials as Record<RoleId, string>);
  console.log(JSON.stringify({ ...store.groupSnapshot(groupId), credentialsPath: credentialPath }));
} catch (error) {
  await rm(credentialPath, { force: true });
  throw error;
} finally { store?.close(); }
