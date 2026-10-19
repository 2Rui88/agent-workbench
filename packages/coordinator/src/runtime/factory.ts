import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RoleId } from '../protocol.js';
import { agentFor, type RuntimeConfig } from '../runtime-config.js';
import { startLocalAppServer } from './app-server.js';
import { ClaudeAgentRuntime, type ClaudeQueryFn } from './claude-agent.js';
import { ClaudeTurnJournal } from './claude-journal.js';
import { claudeRoleLaunch } from './claude-launch.js';
import { MockRuntime } from './mock.js';
import { roleInstructions } from './role-instructions.js';
import { roleLaunch } from './role-launch.js';
import type { ManagedRuntime } from './types.js';

export interface RuntimeFactoryDeps { config: RuntimeConfig; credentials: Partial<Record<RoleId, string>>; roleMcpScript: string; inheritedServers: string[]; claudeQuery: ClaudeQueryFn; transcriptRoot?: string; env?: NodeJS.ProcessEnv; startCodex?: typeof startLocalAppServer; }

export function readOnlyRole(config: RuntimeConfig, role: RoleId, cwd: string, now = Date.now()): boolean {
  if (role === 'audit' || role === 'advisor') return true;
  return Boolean(config.externalTaskObservation) && !config.workerTasks?.some((worker) => worker.role === role && worker.binding.worktreePath === cwd && Date.parse(worker.expiresAt) > now);
}

export function createRuntimeFactory(deps: RuntimeFactoryDeps): (role: RoleId, cwd: string) => ManagedRuntime {
  const { config } = deps;
  const env = deps.env ?? process.env;
  return (role, cwd) => {
    if (config.mode === 'mock') return { runtime: new MockRuntime(), close: async () => {} };
    const capability = deps.credentials[role];
    if (!capability) throw new Error(`Role ${role} has no credential.`);
    const launch = { role, groupId: config.groupId, generation: 1, capability, databasePath: config.databasePath, socketPath: config.socketPath, allowedRoots: config.allowedRoots, mcpScriptPath: deps.roleMcpScript, inheritedServerIds: deps.inheritedServers };
    const readOnly = readOnlyRole(config, role, cwd);
    const memoryPath = config.projectMemory?.path;
    const instructions = roleInstructions({ role, groupId: config.groupId, ...(memoryPath ? { projectMemoryPath: memoryPath } : {}) });
    if (agentFor(config, role) === 'claude') {
      // The memory file may live outside every registered worktree (another docs worktree); the role still needs to read it.
      const extraReadDirs = [...new Set([...config.repositories.map((repository) => repository.worktreePath), ...(memoryPath ? [dirname(memoryPath)] : [])])].filter((path) => path !== cwd);
      const baseOptions = claudeRoleLaunch({ ...launch, cwd, readOnly, extraReadDirs, instructions }, env);
      const journal = new ClaudeTurnJournal(config.databasePath);
      const runtime = new ClaudeAgentRuntime({ query: deps.claudeQuery, journal, baseOptions, transcriptRoot: deps.transcriptRoot ?? join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects') });
      return { runtime, close: async () => { journal.close(); } };
    }
    return (deps.startCodex ?? startLocalAppServer)(cwd, { ...roleLaunch(launch, env), threadPolicy: { sandbox: readOnly ? 'read-only' : 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user', developerInstructions: instructions } });
  };
}
