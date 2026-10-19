import { randomBytes } from 'node:crypto';
import { chmod, rename, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { CoordinatorStore } from '../src/store.js';
import { loadRuntimeConfig, readProtectedJson } from '../src/runtime-config.js';

const [configPath, role] = process.argv.slice(2);
if (!configPath || role !== 'advisor' || process.env.COORDINATOR_ROLE !== 'lead') throw new Error('Usage: COORDINATOR_ROLE=lead npm run group-add-role -- runtime.json advisor');
const config = await loadRuntimeConfig(configPath);
const saved = z.object({ groupId: z.literal(config.groupId), credentials: z.record(z.string(), z.string().min(32)) }).strict().parse(await readProtectedJson(config.credentialFile));
if (saved.credentials.advisor) throw new Error('Advisor credential already exists; reuse it.');
const token = randomBytes(32).toString('base64url');
const temp = `${config.credentialFile}.tmp-${process.pid}`;
await writeFile(temp, `${JSON.stringify({ groupId: saved.groupId, credentials: { ...saved.credentials, advisor: token } }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
const store = new CoordinatorStore(config.databasePath);
try {
  store.addRoleCapability(config.groupId, 'advisor', token);
  await chmod(temp, 0o600);
  await rename(temp, config.credentialFile);
  console.log(JSON.stringify({ groupId: config.groupId, added: 'advisor' }));
} catch (error) { await rm(temp, { force: true }); throw error; } finally { store.close(); }
