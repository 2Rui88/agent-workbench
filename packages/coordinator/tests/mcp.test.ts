import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CoordinatorStore } from '../src/store.js';

test('MCP stdio handshake exposes role-scoped queue tools and persists a message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coordinator-mcp-'));
  const dbPath = join(dir, 'state.sqlite');
  const capability = 'mcp-protocol-test-capability-0123456789abcdef';
  const leadCapability = 'lead-protocol-test-capability-0123456789abcdef';
  const auditCapability = 'audit-protocol-test-capability-0123456789abcdef';
  const store = new CoordinatorStore(dbPath);
  store.createGroup('g-mcp');
  store.setRoleCapability('g-mcp', 'backend', capability);
  store.setRoleCapability('g-mcp', 'lead', leadCapability);
  store.setRoleCapability('g-mcp', 'audit', auditCapability);
  store.close();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'scripts/mcp-server.ts'],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '', HOME: dir, COORDINATOR_ROLE: 'backend', COORDINATOR_GROUP_ID: 'g-mcp', COORDINATOR_CAPABILITY: capability, COORDINATOR_DB_PATH: dbPath },
    stderr: 'ignore'
  });
  const client = new Client({ name: 'coordinator-test-client', version: '0.1.0' });
  const leadTransport = new StdioClientTransport({
    command: process.execPath, args: ['--import', 'tsx', 'scripts/mcp-server.ts'], cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '', HOME: dir, COORDINATOR_ROLE: 'lead', COORDINATOR_GROUP_ID: 'g-mcp', COORDINATOR_CAPABILITY: leadCapability, COORDINATOR_TASK_AUTHORITY: 'mock', COORDINATOR_DB_PATH: dbPath }, stderr: 'ignore'
  });
  const leadClient = new Client({ name: 'coordinator-lead-test', version: '0.1.0' });
  const auditTransport = new StdioClientTransport({
    command: process.execPath, args: ['--import', 'tsx', 'scripts/mcp-server.ts'], cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '', HOME: dir, COORDINATOR_ROLE: 'audit', COORDINATOR_GROUP_ID: 'g-mcp', COORDINATOR_CAPABILITY: auditCapability, COORDINATOR_DB_PATH: dbPath }, stderr: 'ignore'
  });
  const auditClient = new Client({ name: 'coordinator-audit-test', version: '0.1.0' });
  try {
    await client.connect(transport);
    await leadClient.connect(leadTransport);
    await auditClient.connect(auditTransport);
    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === 'message_send'));
    const result = await client.callTool({ name: 'message_send', arguments: { type: 'assistance_request', recipientRole: 'lead', payload: { question: 'contract clarification' }, operationId: 'mcp-op-1' } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const text = result.content.find((part) => part.type === 'text');
    assert.ok(text && text.type === 'text');
    const message = JSON.parse(text.text) as { senderRole: string; recipientRole: string; groupId: string };
    assert.deepEqual({ senderRole: message.senderRole, recipientRole: message.recipientRole, groupId: message.groupId }, { senderRole: 'backend', recipientRole: 'lead', groupId: 'g-mcp' });

    const fromLead = await leadClient.callTool({ name: 'message_send', arguments: { type: 'assistance_request', recipientRole: 'backend', payload: { question: 'review API contract' }, operationId: 'mcp-op-2' } });
    assert.notEqual(fromLead.isError, true, JSON.stringify(fromLead));
    const claimed = await client.callTool({ name: 'message_claim', arguments: { leaseMs: 30000 } });
    const claimText = claimed.content.find((part) => part.type === 'text');
    assert.ok(claimText && claimText.type === 'text');
    const claim = JSON.parse(claimText.text) as { messageId: string; leaseToken: string };
    assert.ok(claim.messageId && claim.leaseToken);
    const completed = await client.callTool({ name: 'message_complete', arguments: { messageId: claim.messageId, leaseToken: claim.leaseToken, result: { summary: 'Contract reviewed', evidence: ['mock-check'] } } });
    assert.notEqual(completed.isError, true, JSON.stringify(completed));

    const leadClaim = await leadClient.callTool({ name: 'message_claim', arguments: { leaseMs: 30000 } });
    const leadClaimText = leadClaim.content.find((part) => part.type === 'text');
    assert.ok(leadClaimText && leadClaimText.type === 'text');
    assert.match(leadClaimText.text, /"senderRole":"backend"/);

    const published = await leadClient.callTool({ name: 'contract_publish', arguments: { artifactRef: 'api.yaml', revision: 'v2', digest: 'sha256:mock', baselineRef: 'commit-a', compatibility: 'breaking', affectedRoles: ['backend'] } });
    const publishedText = published.content.find((part) => part.type === 'text');
    assert.ok(publishedText && publishedText.type === 'text');
    const contract = JSON.parse(publishedText.text) as { contractId: string; revision: string };
    const blocked = await client.callTool({ name: 'contract_check', arguments: { contractId: contract.contractId, revision: 'v1' } });
    assert.equal(blocked.isError, true);
    const acked = await client.callTool({ name: 'contract_ack', arguments: { contractId: contract.contractId, revision: 'v2' } });
    assert.notEqual(acked.isError, true, JSON.stringify(acked));
    const usable = await client.callTool({ name: 'contract_check', arguments: { contractId: contract.contractId, revision: 'v2' } });
    assert.notEqual(usable.isError, true, JSON.stringify(usable));

    const dispatched = await leadClient.callTool({ name: 'work_dispatch', arguments: {
      taskRef: 'task-42', owner: 'jande', repositoryId: 'repo-backend', worktreePath: process.cwd(), expectedVersion: 8,
      id: 'implementation-42', roleId: 'backend', goal: 'Implement the endpoint', repository: 'repo-backend', allowedPaths: ['src/api'], baseline: 'commit-a', contractRef: contract.contractId, contractRevision: 'v2',
      acceptanceCriteria: ['matches the published API'], verificationCommands: ['npm test'], dependencies: [], risk: 1, evidenceFailures: 0, operationId: 'dispatch-op-42'
    } });
    const dispatchedText = dispatched.content.find((part) => part.type === 'text');
    assert.ok(dispatchedText && dispatchedText.type === 'text');
    const dispatchResult = JSON.parse(dispatchedText.text) as { taskGateMode: string; turnStarted: boolean; model: { model: string; effort: string } };
    assert.equal(dispatchResult.taskGateMode, 'mock');
    assert.equal(dispatchResult.turnStarted, false);
    assert.deepEqual({ model: dispatchResult.model.model, effort: dispatchResult.model.effort }, { model: 'gpt-6-luna', effort: 'high' });
    const dispatchClaim = await client.callTool({ name: 'message_claim', arguments: { leaseMs: 30000 } });
    const dispatchClaimText = dispatchClaim.content.find((part) => part.type === 'text');
    assert.ok(dispatchClaimText && dispatchClaimText.type === 'text');
    const packageMessage = JSON.parse(dispatchClaimText.text) as { messageId: string; leaseToken: string; payload: { model: { model: string; effort: string } } };
    assert.deepEqual(packageMessage.payload.model, { model: 'gpt-6-luna', effort: 'high' });
    await client.callTool({ name: 'message_complete', arguments: { messageId: packageMessage.messageId, leaseToken: packageMessage.leaseToken, result: { summary: 'mock worker completed' } } });

    const validation = await auditClient.callTool({ name: 'validation_create', arguments: { contractRef: contract.contractId, baselineRef: 'commit-a' } });
    const validationText = validation.content.find((part) => part.type === 'text');
    assert.ok(validationText && validationText.type === 'text');
    const run = JSON.parse(validationText.text) as { validationId: string; state: string };
    assert.equal(run.state, 'running');
    const recorded = await auditClient.callTool({ name: 'validation_record', arguments: { validationId: run.validationId, outcome: 'passed', evidence: [{ command: 'npm test', outcome: 'passed', summary: 'mock passed' }] } });
    assert.notEqual(recorded.isError, true, JSON.stringify(recorded));

    const browserRequest = await client.callTool({ name: 'browser_request', arguments: { url: 'https://app.test/', taskRef: 'task-1', operationId: 'mcp-browser-1' } });
    assert.notEqual(browserRequest.isError, true, JSON.stringify(browserRequest));
    const browserClaim = await auditClient.callTool({ name: 'browser_claim', arguments: { leaseMs: 30000 } });
    const browserClaimText = browserClaim.content.find((part) => part.type === 'text');
    assert.ok(browserClaimText && browserClaimText.type === 'text');
    const browserClaimValue = JSON.parse(browserClaimText.text) as { requestId: string; payload: { url: string } };
    assert.equal(browserClaimValue.payload.url, 'https://app.test/');
  } finally {
    await auditClient.close();
    await leadClient.close();
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
