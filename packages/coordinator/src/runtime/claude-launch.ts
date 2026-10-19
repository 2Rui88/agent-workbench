import type { RoleLaunchInput } from './role-launch.js';
import { workerToolPolicy } from './tool-policy.js';

export interface ClaudeLaunchInput extends RoleLaunchInput { cwd: string; readOnly: boolean; extraReadDirs: string[]; instructions: string; }
// USER/LOGNAME are required for the Claude CLI to find the local login in the keychain.
const BASE_ENV = ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME'];

export function claudeRoleLaunch(input: ClaudeLaunchInput, source: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV) { const value = source[key]; if (value) env[key] = value; }
  const roleEnv = { ...env, COORDINATOR_WORKER_TOOL_POLICY: 'scoped-v1', COORDINATOR_ROLE: input.role, COORDINATOR_GROUP_ID: input.groupId, COORDINATOR_BINDING_GENERATION: String(input.generation), COORDINATOR_CAPABILITY: input.capability, COORDINATOR_DB_PATH: input.databasePath, COORDINATOR_SOCKET_PATH: input.socketPath, COORDINATOR_ALLOWED_ROOTS: JSON.stringify(input.allowedRoots) };
  const mcpTools = workerToolPolicy(input.role).map((tool) => `mcp__coordinator_role__${tool}`);
  const builtin = input.readOnly ? ['Read', 'Glob', 'Grep', 'Bash'] : ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'];
  return {
    env,
    settingSources: [],
    strictMcpConfig: true,
    permissionMode: 'default',
    mcpServers: {
      coordinator_role: { type: 'stdio', command: process.execPath, args: [input.mcpScriptPath], env: roleEnv }
    },
    allowedTools: [...builtin, ...mcpTools],
    disallowedTools: [...(input.readOnly ? ['Edit', 'Write', 'NotebookEdit'] : ['NotebookEdit']), 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill'],
    additionalDirectories: [...input.extraReadDirs],
    sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, filesystem: { allowWrite: input.readOnly ? [] : [input.cwd] } },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: input.instructions }
  };
}
