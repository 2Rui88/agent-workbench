import {checkWorkerReadiness} from '../src/integrations/worker-readiness.js';
import { inspectOwnedTarget } from '../src/browser/harness.js';
import { RepositoryAuthorities } from '../src/integrations/repository-authorities.js';
import { hostEvidenceCollector } from '../src/integrations/host-evidence.js';
import { connectExistingEdge } from '../src/browser/edge.js';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { inheritedMcpServerIds } from '../src/runtime/role-launch.js';
import { createRuntimeFactory } from '../src/runtime/factory.js';
import type { ClaudeQueryFn } from '../src/runtime/claude-agent.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { recordPid, removePid } from '../src/runtime-processes.js';
import { z } from 'zod';
import { ROLE_IDS, requiresWorkerEnrollment, type RoleId } from '../src/roles.js';
import { CoordinatorEngine } from '../src/engine.js';
import { startCoordinatorSocket } from '../src/ipc.js';
import { agentFor, loadRuntimeConfig, readProtectedJson } from '../src/runtime-config.js';
import { MockTaskAuthority } from '../src/integrations/adapters.js';
import type { TaskAuthority } from '../src/integrations/adapters.js';
import { McpTools } from '../src/integrations/mcp-client.js';
import { RepositoryTaskClient } from '../src/integrations/cli-task.js';
import { readGitContext } from '../src/git-context.js';
import { CoordinatorError } from '../src/errors.js';

const configPath = process.argv[2];
if (!configPath) throw new Error('Usage: npm run daemon -- /path/to/runtime.json');
const config = await loadRuntimeConfig(configPath);
const human = z.object({ capability: z.string().min(32) }).strict().parse(await readProtectedJson(config.humanCredentialFile));
const credentials = z.object({ groupId: z.string(), credentials: z.object({ lead: z.string().min(32), frontend: z.string().min(32), backend: z.string().min(32), audit: z.string().min(32), advisor: z.string().min(32).optional() }).strict() }).strict().parse(await readProtectedJson(config.credentialFile));
if (credentials.groupId !== config.groupId) throw new Error('Credential group does not match config.');
const clients: McpTools[] = [];
const authorities = new RepositoryAuthorities();
let authority: TaskAuthority = new MockTaskAuthority(async (binding) => ({ id: binding.taskRef, owner: binding.owner, repositoryId: binding.repositoryId, worktreePath: binding.worktreePath, version: binding.expectedVersion, status: 'in_progress', lease: { active: true, owner: binding.owner }, conflicts: [] }));
if (config.mode === 'app_server') {
  for (const repository of config.repositories) {
    const transport = new McpTools(); await transport.connect(config.taskMcpUrl!); clients.push(transport);
    const worker=config.workerTasks?.find(w=>w.binding.repositoryId===repository.repositoryId&&w.binding.worktreePath===repository.worktreePath);
    const observation=worker?{taskRef:worker.binding.taskRef,sessionId:worker.sessionId,expiresAt:worker.expiresAt}:config.externalTaskObservation;
    const client = new RepositoryTaskClient(transport, repository.repositoryId, await readGitContext(repository.worktreePath),Date.now,!config.externalTaskObservation&&config.taskHostEvidence?hostEvidenceCollector(config.taskHostEvidence,repository.worktreePath):undefined,observation);
    await client.bind(); authorities.register(client);
  }
  authority = authorities;
}
const anyCodex = ROLE_IDS.some((role) => role !== 'lead' && agentFor(config, role) === 'codex');
const inheritedServers = config.mode === 'app_server' && anyCodex ? await inheritedMcpServerIds() : [];
const siblingMcpScript = fileURLToPath(new URL('./mcp-server.js', import.meta.url));
const roleMcpScript = existsSync(siblingMcpScript) ? siblingMcpScript : fileURLToPath(new URL('../dist/scripts/mcp-server.js', import.meta.url));
if (config.mode === 'app_server' && !existsSync(roleMcpScript)) throw new Error('Build the project before starting App Server mode.');
const engine = new CoordinatorEngine({ databasePath: config.databasePath, groupId: config.groupId, humanCapability: human.capability, allowedRoots: config.allowedRoots, runtimeSource: config.mode, leadMode: config.leadMode, ...(config.realExecution?{realExecution:config.realExecution}:{}),...(config.receiptTimeoutMs?{receiptTimeoutMs:config.receiptTimeoutMs}:{}), ...(config.mockBudget ? {mockBudget:config.mockBudget}:{}),
  ...(config.browser?{browser:{source:'edge_cdp' as const,...(config.browser.harness?{inspectWithHarness:(targetId:string)=>inspectOwnedTarget({...config.browser!.harness!,cdpEndpoint:config.browser!.cdpEndpoint},targetId)}:{}),allowedOrigins:config.browser.allowedOrigins,healthChecks:config.browser.healthUrls.map((url)=>({service:new URL(url).origin,check:async()=>{try{return(await fetch(url,{signal:AbortSignal.timeout(5000),redirect:'error'})).ok;}catch{return false;}}})),connect:()=>connectExistingEdge(config.browser!.cdpEndpoint)}}:{}),
  ...(config.workerTasks?{verifyWorker:async(work)=>{
    if(!requiresWorkerEnrollment(work.roleId))return;
    const worker=config.workerTasks!.find(w=>w.role===work.roleId);
    if(!worker||!work.taskBinding||worker.binding.taskRef!==work.taskRef||worker.binding.worktreePath!==work.worktree||Date.parse(worker.expiresAt)<=Date.now())throw new CoordinatorError('TASK_GATE_CLOSED','Worker write enrollment is absent, expired or mismatched.','Refresh the independent worker Task and lease.');
    const leadRepository=config.repositories.find(r=>!config.workerTasks!.some(w=>w.binding.worktreePath===r.worktreePath))!;
    await checkWorkerReadiness({role:worker.role,binding:work.taskBinding},{taskRef:config.externalTaskObservation!.taskRef,worktreePath:leadRepository.worktreePath},{git:readGitContext,task:binding=>authority.checkGate(binding)});
  }}:{}),
  runtimeFactory: createRuntimeFactory({ config, credentials: credentials.credentials as Partial<Record<RoleId, string>>, roleMcpScript, inheritedServers, claudeQuery: query as unknown as ClaudeQueryFn }), agentFor: (role) => agentFor(config, role), advisor: { suggestAfterRejections: config.advisor?.suggestAfterRejections ?? 2 }, taskAuthority: authority
});
for (const role of ROLE_IDS) { const token = credentials.credentials[role]; if (token) engine.authenticate(role, token, 1); }
await chmod(config.databasePath, 0o600);
const service = await startCoordinatorSocket(engine, config.socketPath);
await recordPid(dirname(config.databasePath), 'daemon');
console.log(JSON.stringify({ status: 'ready', groupId: config.groupId, mode: config.mode, socketPath: config.socketPath, realTurnsEnabled: Boolean(config.realExecution && Date.parse(config.realExecution.expiresAt)>Date.now()) }));
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; await service.close(); await Promise.all(clients.map((client) => client.close())); await removePid(dirname(config.databasePath), 'daemon'); process.exit(0); };
process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); });
