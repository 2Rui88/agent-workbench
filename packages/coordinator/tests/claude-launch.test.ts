import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeRoleLaunch } from '../src/runtime/claude-launch.js';
import { roleInstructions } from '../src/runtime/role-instructions.js';
import { workerToolPolicy } from '../src/runtime/tool-policy.js';

const input = (role: 'audit' | 'frontend' | 'advisor', readOnly: boolean) => ({ role, groupId: 'g', generation: 1, capability: 'role-secret-0123456789abcdef', databasePath: '/state/db', socketPath: '/state/s', allowedRoots: ['/repo'], mcpScriptPath: '/c/dist/scripts/mcp-server.js', inheritedServerIds: [], cwd: '/repo', readOnly, extraReadDirs: ['/repo-fe'], instructions: 'Coordinator role.' });
const hostile = { HOME: '/h', PATH: '/bin', LANG: 'C', USER: 'me', LOGNAME: 'me', PC_LEAD: 'Bearer lead-should-not-leak', HERDR_PANE_ID: 'w9:p9-herdr-should-not-leak', HERDR_SOCKET_PATH: '/herdr-socket-should-not-leak', KITTY_PID: 'kitty-pid-should-not-leak', CLAUDECODE: 'claudecode-should-not-leak', CLAUDE_CODE_MESSAGING_TOKEN: 'parent-token-should-not-leak', CLAUDE_CODE_MESSAGING_SOCKET: '/parent-socket-should-not-leak', ANTHROPIC_API_KEY: 'api-key-should-not-leak' };

test('Claude role launch passes an explicit allowlisted environment including login identity', () => {
  const options = claudeRoleLaunch(input('audit', true), hostile) as { env: Record<string, string> };
  assert.deepEqual(Object.keys(options.env).sort(), ['HOME', 'LANG', 'LOGNAME', 'PATH', 'USER']);
  const serialized = JSON.stringify(options);
  for (const [key, value] of Object.entries(hostile)) if (value.includes('should-not-leak')) assert.equal(serialized.includes(value), false, key);
});

test('read-only roles get no write tools and a write-denied sandbox; workers may write only their worktree', () => {
  const audit = claudeRoleLaunch(input('audit', true), hostile) as Record<string, any>;
  assert.deepEqual(audit.settingSources, []); assert.equal(audit.strictMcpConfig, true);
  for (const tool of ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch']) assert.ok(audit.disallowedTools.includes(tool), tool);
  assert.ok(!audit.allowedTools.includes('Edit'));
  assert.deepEqual(audit.sandbox.filesystem.allowWrite, []);
  assert.equal(audit.sandbox.enabled, true); assert.equal(audit.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(audit.additionalDirectories, ['/repo-fe']);
  assert.equal(audit.systemPrompt.append, 'Coordinator role.');
  const frontend = claudeRoleLaunch(input('frontend', false), hostile) as Record<string, any>;
  assert.ok(frontend.allowedTools.includes('Edit'));
  assert.deepEqual(frontend.sandbox.filesystem.allowWrite, ['/repo']);
});

test('the only MCP server is this role identity with its coordinator tool allowlist', () => {
  const advisor = claudeRoleLaunch(input('advisor', true), hostile) as Record<string, any>;
  assert.deepEqual(Object.keys(advisor.mcpServers), ['coordinator_role']);
  assert.equal(advisor.mcpServers.coordinator_role.env.COORDINATOR_ROLE, 'advisor');
  assert.equal(advisor.mcpServers.coordinator_role.env.COORDINATOR_WORKER_TOOL_POLICY, 'scoped-v1');
  const mcpAllowed = advisor.allowedTools.filter((tool: string) => tool.startsWith('mcp__')).map((tool: string) => tool.slice('mcp__coordinator_role__'.length));
  assert.deepEqual(mcpAllowed, workerToolPolicy('advisor'));
  assert.ok(!mcpAllowed.includes('automation_dispatch') && !mcpAllowed.includes('automation_message_send'));
  assert.ok(!JSON.stringify(advisor).includes('powercontext'));
});

test('role instructions point every role at the shared project memory file, read-only', () => {
  const audit = roleInstructions({ role: 'audit', groupId: 'g', projectMemoryPath: '/repo/docs/项目记忆.md' });
  assert.match(audit, /^Coordinator role: audit\. Coordinator group: g\. /);
  assert.match(audit, /read \/repo\/docs\/项目记忆\.md before starting; it is read-only for you, the lead writes it/);
  assert.match(audit, /cli_session_task/);
  assert.doesNotMatch(audit, /PowerContext|Scope|Principal/);
  assert.match(roleInstructions({ role: 'advisor', groupId: 'g' }), /automation_advice_complete/);
  assert.match(roleInstructions({ role: 'advisor', groupId: 'g' }), /No shared project memory file is configured/);
});

test('writing workers leave changes uncommitted for the lead', () => {
  for (const role of ['frontend', 'backend'] as const) assert.match(roleInstructions({ role, groupId: 'g' }), /Do not run git commit/);
  for (const role of ['audit', 'advisor'] as const) assert.doesNotMatch(roleInstructions({ role, groupId: 'g' }), /git commit/);
});
