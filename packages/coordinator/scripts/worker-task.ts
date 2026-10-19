import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hostEvidenceCollector } from '../src/integrations/host-evidence.js';
import { McpTools } from '../src/integrations/mcp-client.js';
import { readGitContext } from '../src/git-context.js';
import { assertPrivateFile, loadRuntimeConfig } from '../src/runtime-config.js';
import { acquireLease, checkpointLease, initWorkerTask, renewWorkerTask, workerTaskManifest, workerTaskSpec, type WorkerLeaseState } from '../src/worker-task-lease.js';
import { setTimeout as delay } from 'node:timers/promises';
import { unlink } from 'node:fs/promises';
import { recordPid, removePid } from '../src/runtime-processes.js';


const [configPath, roleOrCommand, action] = process.argv.slice(2);
const usage = 'Usage: worker-task <runtime.json> hold | <runtime.json> <frontend|backend> <renew|status> | <runtime.json> manifest <authorized-until-iso>';
if (!configPath || !roleOrCommand) throw new Error(usage);
const config = await loadRuntimeConfig(configPath);
const dir = dirname(config.databasePath);
const statePath = join(dir, 'worker-leases.json');
const load = async (): Promise<WorkerLeaseState[]> => existsSync(statePath) ? (await assertPrivateFile(statePath), JSON.parse(await readFile(statePath, 'utf8')) as WorkerLeaseState[]) : [];
const save = async (states: WorkerLeaseState[]) => { const temp = `${statePath}.tmp`; await writeFile(temp, `${JSON.stringify(states, null, 2)}\n`, { mode: 0o600 }); await rename(temp, statePath); };
const requestPath = (role: string) => join(dir, `renew-${role}.request`);
const ROLES = ['frontend', 'backend'] as const;
const log = (message: string) => process.stdout.write(`[worker-task ${new Date().toISOString()}] ${message}\n`);

if (roleOrCommand === 'manifest') {
  if (!action || Number.isNaN(Date.parse(action))) throw new Error('Provide the authorized-until ISO time.');
  console.log(JSON.stringify(workerTaskManifest(await load(), new Date(action).toISOString()), null, 2));
} else if (roleOrCommand === 'hold') {
  if (!config.taskMcpUrl || !config.taskHostEvidence) throw new Error('Runtime needs taskMcpUrl and taskHostEvidence.');
  // One long-lived transport per worker session: the service refuses to resume a session whose transport is still open.
  const holders = new Map<string, { tools: McpTools; collect: (session: string, task: string) => Promise<void> }>();
  let running = true;
  process.on('SIGINT', () => { running = false; }); process.on('SIGTERM', () => { running = false; });
  await recordPid(dir, 'worker-hold');
  for (const role of ROLES) {
    const repository = config.repositories.find((item) => item.worktreePath.endsWith(`/${role}`));
    if (!repository) throw new Error(`Runtime has no ${role} worktree.`);
    const tools = new McpTools(); await tools.connect(config.taskMcpUrl);
    const collect = (session: string, task: string) => hostEvidenceCollector(config.taskHostEvidence!, repository.worktreePath)(session, task, 'checkpoint');
    holders.set(role, { tools, collect });
    const states = await load();
    const index = states.findIndex((state) => state.role === role);
    if (index < 0) {
      const git = await readGitContext(repository.worktreePath);
      states.push(await initWorkerTask({ tools, collect }, { role, owner: git.owner, repositoryId: repository.repositoryId, worktreePath: repository.worktreePath, ...workerTaskSpec(config, role), acceptanceCriteria: [...workerTaskSpec(config, role).acceptanceCriteria], operationPrefix: `${config.groupId}-${role}` }));
      await save(states); log(`${role}: task created and started`);
    } else {
      for (;;) {
        try { states[index] = await renewWorkerTask({ tools, collect }, states[index]!, `${config.groupId}-${role}-resume-${Date.now()}`); log(`${role}: reattached session`); break; }
        catch { /* the previous transport may still be open */ }
        try { states[index] = await acquireLease({ tools, collect }, states[index]!); log(`${role}: re-acquired expired lease with a new session`); break; }
        catch (error) { log(`${role}: waiting (${(error as Error).message})`); if (!running) process.exit(1); await delay(30_000); }
      }
      await save(states);
    }
  }
  log('holding worker leases; request renewals with "worker-task <runtime> <role> renew"');
  while (running) {
    for (const role of ROLES) {
      if (!existsSync(requestPath(role))) continue;
      const states = await load(); const index = states.findIndex((state) => state.role === role);
      try { states[index] = await checkpointLease(holders.get(role)!, states[index]!, `${config.groupId}-${role}-renew-${Date.now()}`); await save(states); log(`${role}: renewed to version ${states[index]!.version} until ${states[index]!.leaseExpiresAt}`); }
      catch (error) { log(`${role}: renewal failed (${(error as Error).message})`); }
      await unlink(requestPath(role)).catch(() => {});
    }
    const remaining = (await load()).map((state) => `${state.role}:${Math.round((Date.parse(state.leaseExpiresAt) - Date.now()) / 60000)}m`).join(' ');
    if (Date.now() % 300_000 < 5_000) log(`lease remaining ${remaining}`);
    await delay(5_000);
  }
  for (const holder of holders.values()) await holder.tools.close();
  await removePid(dir, 'worker-hold');
} else {
  if (roleOrCommand !== 'frontend' && roleOrCommand !== 'backend') throw new Error(usage);
  const role = roleOrCommand;
  if (action === 'renew') {
    const before = (await load()).find((state) => state.role === role);
    if (!before) throw new Error(`Worker ${role} has no Task.`);
    await writeFile(requestPath(role), 'renew\n', { mode: 0o600 });
    for (let i = 0; i < 24 && existsSync(requestPath(role)); i++) await delay(5_000);
    if (existsSync(requestPath(role))) throw new Error('No running "hold" process picked up the renewal request.');
  } else if (action !== 'status') throw new Error(usage);
  const state = (await load()).find((item) => item.role === role);
  console.log(JSON.stringify(state ? { role, taskId: state.taskId, sessionId: state.sessionId, version: state.version, leaseExpiresAt: state.leaseExpiresAt } : { role, task: null }));
}
