import assert from 'node:assert/strict';
import test from 'node:test';
import { roleLaunch } from '../src/runtime/role-launch.js';

const input = (role: 'audit' | 'frontend') => ({ role, groupId: 'group', generation: 1, capability: 'worker-secret', databasePath: '/state/db', socketPath: '/state/socket', allowedRoots: ['/repo'], mcpScriptPath: '/coordinator/dist/scripts/mcp-server.js', inheritedServerIds: ['powercontext', 'cli_session_task', 'coordinator_role'] });

test('role runtime disables inherited MCP identities and exposes only the coordinator role server', () => {
  const launch = roleLaunch(input('audit'), { HOME: '/home', PATH: '/bin', PC_LEAD: 'lead-secret', COORDINATOR_HUMAN_CAPABILITY: 'human-secret' });
  assert.ok(launch.args.includes('mcp_servers.coordinator_role.default_tools_approval_mode="prompt"'));
  assert.ok(launch.args.includes('mcp_servers.coordinator_role.tools.automation_status.approval_mode="approve"'));
  assert.ok(!launch.args.some(arg=>arg.includes('tools.automation_dispatch.approval_mode')));
  assert.equal(launch.env.COORDINATOR_WORKER_TOOL_POLICY,'scoped-v1');
  assert.equal(launch.env.PC_LEAD, undefined);
  assert.equal(launch.env.COORDINATOR_HUMAN_CAPABILITY, undefined);
  assert.equal(launch.env.COORDINATOR_CREDENTIAL_FILE, undefined);
  assert.ok(launch.args.includes('mcp_servers.powercontext.enabled=false'));
  assert.ok(!launch.args.some((arg) => arg.includes('powercontext_role')), 'no PowerContext server is configured any more');
  for (const secret of ['worker-secret', 'lead-secret', 'human-secret']) assert.equal(launch.args.join(' ').includes(secret), false);
});

test('worker policies expose only role receipt tools with narrow approval', async () => {
  const {workerToolPolicy,toolAnnotations} = await import('../src/runtime/tool-policy.js');
  const policy = workerToolPolicy('audit');
  assert.ok(policy.includes('automation_validation_record'));
  assert.ok(!workerToolPolicy('frontend').includes('automation_validation_record'));
  for (const blocked of ['automation_dispatch','automation_archive_failure','automation_task_checkpoint','automation_browser_execute','automation_role_initialize']) assert.ok(!policy.includes(blocked));
  assert.deepEqual(workerToolPolicy('advisor'),['automation_status','automation_events','automation_operation_get','automation_advice_get','automation_advice_complete']);
  assert.equal(toolAnnotations('automation_status').readOnlyHint,true);
  assert.equal(toolAnnotations('automation_message_claim').readOnlyHint,false);
  assert.equal(toolAnnotations('automation_message_claim').idempotentHint,false);
  assert.equal(toolAnnotations('automation_validation_record').readOnlyHint,false);
  assert.equal(toolAnnotations('automation_validation_record').idempotentHint,false);
});

test('Codex role launch never forwards terminal or parent-agent variables', () => {
  const launch = roleLaunch({ ...input('frontend'), capability: 'c'.repeat(32), inheritedServerIds: [] }, { HOME: '/h', PATH: '/bin', HERDR_PANE_ID: 'w:p', KITTY_PID: '1', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's' });
  for (const key of Object.keys(launch.env)) assert.ok(!/^(HERDR_|KITTY_|CLAUDE)/.test(key), key);
});
