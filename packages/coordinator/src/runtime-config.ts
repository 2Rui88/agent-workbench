import {bindingSchema} from './bindings.js';
import { realExecutionSchema } from './real-execution.js';
import { validateEdgeEndpoint } from './browser/edge.js';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import { agentEnum, type AgentKind, type RoleId } from './roles.js';
import { CoordinatorError } from './errors.js';

const roleRuntime = z.object({ agent: agentEnum }).strict();
const workerTaskSpec = z.object({ title: z.string().min(1).max(200), goal: z.string().min(1).max(4000), acceptanceCriteria: z.array(z.string().min(1).max(1000)).min(1).max(20), nextAction: z.string().min(1).max(1000) }).strict();
export const runtimeConfigSchema = z.object({ groupId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/), mode: z.enum(['mock', 'app_server', 'real']).default('mock').transform((mode) => mode === 'real' ? 'app_server' as const : mode), leadAgent: agentEnum.optional(), workerTaskSpecs: z.object({ frontend: workerTaskSpec, backend: workerTaskSpec }).strict().optional(), leadWorktree: z.string().min(1).optional(), roles: z.object({ frontend: roleRuntime, backend: roleRuntime, audit: roleRuntime, advisor: roleRuntime }).partial().strict().optional(), advisor: z.object({ suggestAfterRejections: z.number().int().min(1).max(10) }).strict().optional(), workerTasks:z.array(z.object({role:z.enum(['frontend','backend']),binding:bindingSchema,sessionId:z.string().min(1),expiresAt:z.string().datetime()}).strict()).max(2).optional(), leadMode: z.enum(['managed','external']).default('managed'), realExecution: realExecutionSchema.optional(), externalTaskObservation: z.object({taskRef:z.string().min(1),sessionId:z.string().min(1),expiresAt:z.string().datetime()}).strict().optional(), databasePath: z.string().min(1), socketPath: z.string().min(1), credentialFile: z.string().min(1), humanCredentialFile: z.string().min(1), allowedRoots: z.array(z.string().min(1)).min(1), receiptTimeoutMs:z.number().int().min(1000).max(3600000).optional(), mockBudget: z.object({maxCalls:z.number().int().min(0),maxConcurrent:z.number().int().min(1).max(4)}).strict().optional(), browser:z.object({cdpEndpoint:z.string().url(),allowedOrigins:z.array(z.string().url()).min(1),healthUrls:z.array(z.string().url()).min(1),harness:z.object({entrypointPath:z.string().min(1),homePath:z.string().min(1)}).strict().optional()}).strict().optional(), taskHostEvidence:z.object({cliRepositoryPath:z.string().min(1),serverUrl:z.string().url()}).strict().optional(), taskMcpUrl: z.string().url().optional(), repositories: z.array(z.object({ repositoryId: z.string().min(1), worktreePath: z.string().min(1) }).strict()).default([]), projectMemory: z.object({ path: z.string().min(1) }).strict().optional() }).strict();
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export async function loadRuntimeConfig(path: string): Promise<RuntimeConfig> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (raw && typeof raw === 'object' && 'powerContext' in raw) throw new CoordinatorError('INVALID_INPUT', 'PowerContext is retired; remove the powerContext section from runtime.json.', 'Configure projectMemory.path for the shared project memory file instead.');
  const config = runtimeConfigSchema.parse(raw);
  const root = dirname(resolve(path));
  for (const key of ['databasePath', 'socketPath', 'credentialFile', 'humanCredentialFile'] as const) config[key] = resolve(root, config[key]);
  if(config.taskHostEvidence)config.taskHostEvidence.cliRepositoryPath=resolve(root,config.taskHostEvidence.cliRepositoryPath);
  config.allowedRoots = config.allowedRoots.map((item) => resolve(root, item));
  for (const repository of config.repositories) repository.worktreePath = resolve(root, repository.worktreePath);
  if (config.leadWorktree) {
    const lead = resolve(root, config.leadWorktree);
    config.leadWorktree = lead;
    const inside = config.allowedRoots.some((base) => { const rel = relative(base, lead); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); });
    if (!inside || (config.repositories.length > 0 && !config.repositories.some((repository) => repository.worktreePath === lead))) throw new CoordinatorError('INVALID_INPUT', 'Lead worktree must be a registered repository inside allowed roots.', 'Configure leadWorktree as the lead repository worktree.');
  }
  if(config.browser){
    validateEdgeEndpoint(config.browser.cdpEndpoint);
    if(config.browser.harness){config.browser.harness.entrypointPath=resolve(root,config.browser.harness.entrypointPath);config.browser.harness.homePath=resolve(root,config.browser.harness.homePath);}
    for(const origin of config.browser.allowedOrigins){const target=new URL(origin);if(target.username||target.password||target.origin!==origin||!['http:','https:'].includes(target.protocol))throw new CoordinatorError('INVALID_INPUT','Browser origin must be an explicit HTTP origin.','Configure the approved task origins.');}
  }
  if(config.workerTasks){
    const canonical=async(path:string):Promise<string>=>{
      const absolute=resolve(root,path);
      try{return await realpath(absolute);}catch(error){
        if(config.mode==='mock'&&(error as NodeJS.ErrnoException).code==='ENOENT')return absolute;
        throw new CoordinatorError('TASK_GATE_CLOSED','Worker worktree cannot be verified.','Use an existing accessible worktree.');
      }
    };
    for(const repository of config.repositories)repository.worktreePath=await canonical(repository.worktreePath);
    if(config.leadWorktree)config.leadWorktree=await canonical(config.leadWorktree);
    for(const worker of config.workerTasks)worker.binding.worktreePath=await canonical(worker.binding.worktreePath);
    if(!config.externalTaskObservation||config.workerTasks.length!==2||new Set(config.workerTasks.map(w=>w.role)).size!==2||new Set(config.workerTasks.map(w=>w.binding.taskRef)).size!==2||new Set(config.workerTasks.map(w=>w.binding.worktreePath)).size!==2)throw new CoordinatorError('INVALID_INPUT','Worker writes need two independent role Tasks and worktrees under an external lead.','Provide explicit frontend/backend enrollments.');
    if(!config.repositories.some(r=>!config.workerTasks!.some(w=>resolve(root,w.binding.worktreePath)===r.worktreePath)))throw new CoordinatorError('INVALID_INPUT','Lead repository is missing.','Keep the lead worktree registered alongside the workers.');
    for(const worker of config.workerTasks){worker.binding.worktreePath=resolve(root,worker.binding.worktreePath);if(worker.binding.taskRef===config.externalTaskObservation.taskRef||!config.repositories.some(r=>r.repositoryId===worker.binding.repositoryId&&r.worktreePath===worker.binding.worktreePath))throw new CoordinatorError('TASK_GATE_CLOSED','Worker Task must be independent and registered in the runtime.','Configure the exact worker repository/worktree.');}
  }
  if (config.projectMemory) {
    const memory = resolve(root, config.projectMemory.path);
    const file = await stat(memory).catch(() => undefined);
    if (!file?.isFile()) throw new CoordinatorError('INVALID_INPUT', 'Project memory file is missing or not a regular file.', 'Point projectMemory.path at the business repository memory document.');
    config.projectMemory.path = memory;
  }
  if (config.mode === 'app_server' && (!config.taskMcpUrl || !config.repositories.length)) throw new CoordinatorError('TASK_GATE_CLOSED', 'App Server mode requires the Task MCP URL and registered repositories.', 'Configure taskMcpUrl and repositories before creating runtime threads.');
  if (config.externalTaskObservation && config.leadMode !== 'external') throw new CoordinatorError('INVALID_INPUT', 'External task observation requires external lead mode and read-only workers.', 'Configure the external observation mode.');
  return config;
}
export async function assertPrivateFile(path: string): Promise<void> {
  const file = await stat(path);
  if (!file.isFile() || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0) throw new CoordinatorError('FORBIDDEN', 'Credential file must be private and owned by this user.', 'Set a protected owner-only credential file.');
}
export async function readProtectedJson(path: string): Promise<unknown> {
  await assertPrivateFile(path);
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export function agentFor(config: Pick<RuntimeConfig, 'roles' | 'leadAgent'>, role: RoleId): AgentKind {
  if (role === 'lead') return config.leadAgent ?? 'codex';
  return config.roles?.[role]?.agent ?? 'codex';
}
