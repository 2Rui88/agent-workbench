import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RoleId } from '../protocol.js';
import { workerToolPolicy, toolPolicyOverrides } from './tool-policy.js';
import { CoordinatorError } from '../errors.js';

export interface RoleLaunchInput {
  role: RoleId;
  groupId: string;
  generation: number;
  capability: string;
  databasePath: string;
  socketPath: string;
  allowedRoots: string[];
  mcpScriptPath: string;
  inheritedServerIds: string[];
}

export async function inheritedMcpServerIds(): Promise<string[]> {
  const { stdout } = await promisify(execFile)('codex', ['-c', 'features.plugins=false', '-c', 'features.apps=false', 'mcp', 'list', '--json'], { maxBuffer: 1024 * 1024, timeout: 10_000 });
  const servers = JSON.parse(stdout) as Array<{ name?: string }>;
  if (!Array.isArray(servers) || servers.some((server) => typeof server.name !== 'string')) throw new CoordinatorError('INVALID_INPUT', 'Unable to enumerate inherited MCP configuration.', 'Check the local Codex configuration before role startup.');
  return servers.map((server) => server.name!);
}

export function roleLaunch(input: RoleLaunchInput, source: NodeJS.ProcessEnv = process.env): { args: string[]; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'CODEX_HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL']) if (source[key]) env[key] = source[key];
  Object.assign(env, { COORDINATOR_WORKER_TOOL_POLICY: 'scoped-v1', COORDINATOR_ROLE: input.role, COORDINATOR_GROUP_ID: input.groupId, COORDINATOR_BINDING_GENERATION: String(input.generation), COORDINATOR_CAPABILITY: input.capability, COORDINATOR_DB_PATH: input.databasePath, COORDINATOR_SOCKET_PATH: input.socketPath, COORDINATOR_ALLOWED_ROOTS: JSON.stringify(input.allowedRoots) });
  const args: string[] = ['-c', 'features.plugins=false', '-c', 'features.apps=false'];
  // Disable every inherited server explicitly; assigning a map may merge old entries.
  for (const id of input.inheritedServerIds) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new CoordinatorError('INVALID_INPUT', 'Inherited MCP server name cannot be safely overridden.', 'Use an explicit supported server identifier.');
    args.push('-c', `mcp_servers.${id}.enabled=false`);
  }
  const envNames = ['COORDINATOR_WORKER_TOOL_POLICY', 'COORDINATOR_ROLE', 'COORDINATOR_GROUP_ID', 'COORDINATOR_BINDING_GENERATION', 'COORDINATOR_CAPABILITY', 'COORDINATOR_DB_PATH', 'COORDINATOR_SOCKET_PATH', 'COORDINATOR_ALLOWED_ROOTS'];
  args.push('-c', `mcp_servers.coordinator_role={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(input.mcpScriptPath)}],env_vars=${JSON.stringify(envNames)},enabled=true}`);
  for (const override of toolPolicyOverrides('coordinator_role', workerToolPolicy(input.role))) args.push('-c', override);
  args.push('app-server', '--listen', 'stdio://');
  return { args, env };
}
