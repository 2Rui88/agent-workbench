import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { CoordinatorError } from '../src/errors.js';
import { CoordinatorStore } from '../src/store.js';
import { ContractRegistry } from '../src/contracts.js';
import { ValidationRegistry } from '../src/validation.js';
import { UsageLedger } from '../src/usage.js';
import { startLocalAppServer, type LocalAppServerHandle } from '../src/runtime/app-server.js';
import { resolveAuthorizedPath } from '../src/auth.js';
import { BrowserQueue } from '../src/browser/queue.js';
import { connectExistingEdge } from '../src/browser/edge.js';
import { runBrowserRequest } from '../src/browser/runner.js';
import { requireHealthyServices } from '../src/preflight.js';
import { WorkDispatcher } from '../src/dispatch.js';
import { MockTaskAuthority } from '../src/integrations/adapters.js';
import type { ExecutionPackage } from '../src/scheduler.js';
import { MockRuntime } from '../src/runtime/mock.js';
import type { Actor, RoleId } from '../src/protocol.js';
import { ROLE_IDS } from '../src/roles.js';
import { workerToolPolicy, toolAnnotations } from '../src/runtime/tool-policy.js';
import { automationSchemas, type AutomationCommand } from '../src/engine.js';
import { coordinatorRequest } from '../src/ipc.js';

const role = process.env.COORDINATOR_ROLE as RoleId | undefined;
const groupId = process.env.COORDINATOR_GROUP_ID;
if (!role || !(ROLE_IDS as readonly string[]).includes(role) || !groupId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(groupId)) {
  throw new Error('Set a valid COORDINATOR_ROLE and a safe COORDINATOR_GROUP_ID.');
}
const credentialPath = resolve(process.env.COORDINATOR_CREDENTIAL_FILE ?? join(homedir(), '.codex', 'session-coordinator', 'credentials', `${groupId}.json`));
let capability = process.env.COORDINATOR_CAPABILITY;
if (!capability && role && groupId) {
  const saved = JSON.parse(readFileSync(credentialPath, 'utf8')) as { groupId?: string; credentials?: Partial<Record<RoleId, string>> };
  if (saved.groupId === groupId) capability = saved.credentials?.[role];
}
if (!capability || capability.length < 32) {
  throw new Error('Set COORDINATOR_ROLE and COORDINATOR_GROUP_ID, and provide the protected credential file for this role.');
}

const actor: Actor = { groupId, roleId: role, bindingGeneration: Number(process.env.COORDINATOR_BINDING_GENERATION ?? 1), capabilityId: capability };
const dbPath = resolve(process.env.COORDINATOR_DB_PATH ?? join(homedir(), '.codex', 'session-coordinator', 'state.sqlite'));
const socketMode = Boolean(process.env.COORDINATOR_SOCKET_PATH);
const store = socketMode ? undefined : new CoordinatorStore(dbPath);
store?.assertAuthorized(actor, capability);
const contracts = socketMode ? undefined : new ContractRegistry(dbPath);
const validations = socketMode ? undefined : new ValidationRegistry(dbPath);
const usage = socketMode ? undefined : new UsageLedger(dbPath);
const browser = socketMode ? undefined : new BrowserQueue(dbPath);
let appServerHandle: LocalAppServerHandle | undefined;
let appServerReady = false;

function registerTools(): McpServer {
  const server = new McpServer({ name: 'codex-session-coordinator', version: '0.1.0' }, { capabilities: { tools: {} } });
  const exposed = process.env.COORDINATOR_WORKER_TOOL_POLICY === 'scoped-v1' ? workerToolPolicy(actor.roleId) : Object.keys(automationSchemas);
  for (const [name, schema] of Object.entries(automationSchemas)) {
    if (!exposed.includes(name)) continue;
    server.registerTool(name, { description: 'Use the configured single coordinator daemon; identity and controls are enforced by the daemon.', inputSchema: schema as z.ZodObject, annotations: toolAnnotations(name) }, async (input: Record<string, unknown>) => {
      if (!process.env.COORDINATOR_SOCKET_PATH) throw new CoordinatorError('SERVICE_UNHEALTHY', 'Coordinator socket is not configured.', 'Start the project daemon and set COORDINATOR_SOCKET_PATH.');
      const result = await coordinatorRequest(process.env.COORDINATOR_SOCKET_PATH, { channel: 'role', roleId: actor.roleId, generation: actor.bindingGeneration, capability: capability!, command: name as AutomationCommand, input });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    });
  }
  if (socketMode) return server;
  server.registerTool('group_create', { description: 'Create the configured 1+3 role group; lead role only.' }, async () => {
    if (actor.roleId !== 'lead') throw new CoordinatorError('FORBIDDEN', 'Only the lead can create the group.', 'Use the configured lead session.');
    store!.createGroup(actor.groupId);
    return { content: [{ type: 'text', text: JSON.stringify(store!.groupSnapshot(actor.groupId)) }] };
  });
  server.registerTool('group_get', { description: 'Read configured group, bindings, and queued message counts.' }, async () => {
    const snapshot = store!.groupSnapshot(actor.groupId);
    if (!snapshot) throw new CoordinatorError('INVALID_INPUT', 'Group has not been created.', 'Call group_create from the lead session.');
    return { content: [{ type: 'text', text: JSON.stringify(snapshot) }] };
  });
  server.registerTool('role_initialize', { description: 'Initialize or resume this role own App Server thread and report current supported models; does not start a turn.', inputSchema: z.object({ cwd: z.string().min(1) }).strict() }, async ({ cwd }) => {
    if (process.env.COORDINATOR_SOCKET_PATH) {
      const result = await coordinatorRequest(process.env.COORDINATOR_SOCKET_PATH, { channel: 'role', roleId: actor.roleId, generation: actor.bindingGeneration, capability: capability!, command: 'automation_role_initialize', input: { cwd } });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    const configuredRoots = process.env.COORDINATOR_ALLOWED_ROOTS ? JSON.parse(process.env.COORDINATOR_ALLOWED_ROOTS) as string[] : [process.cwd()];
    const authorizedCwd = await resolveAuthorizedPath(cwd, configuredRoots);
    appServerHandle ??= startLocalAppServer(authorizedCwd);
    if (!appServerReady) {
      await appServerHandle.runtime.initialize();
      appServerReady = true;
    }
    const binding = store!.groupSnapshot(actor.groupId)?.roles.find((item) => item.roleId === actor.roleId);
    const threadId = binding?.threadId
      ? await appServerHandle.runtime.resumeThread(binding.threadId, authorizedCwd)
      : await appServerHandle.runtime.startThread(authorizedCwd);
    store!.setRoleThread(actor, threadId);
    const models = await appServerHandle.runtime.listModels();
    return { content: [{ type: 'text', text: JSON.stringify({ roleId: actor.roleId, threadId, cwd: authorizedCwd, models, turnStarted: false }) }] };
  });
  server.registerTool('message_send', { description: 'Send a typed assistance, contract, or test-debug message to a role.', inputSchema: z.object({ type: z.enum(['assistance_request', 'contract_update', 'test_debug']), recipientRole: z.enum(['lead', 'frontend', 'backend', 'audit']), payload: z.record(z.string(), z.unknown()), operationId: z.string().min(1) }).strict() }, async (input) => {
    const { operationId, ...submission } = input;
    const message = store!.send(actor, submission, operationId);
    return { content: [{ type: 'text', text: JSON.stringify(message) }] };
  });
  server.registerTool('work_dispatch', { description: 'Create a role execution package and choose model/effort. Task checks are Mock-only until a production Task MCP adapter is configured; no model turn is started.', inputSchema: z.object({
    taskRef: z.string().min(1), owner: z.string().min(1), repositoryId: z.string().min(1), worktreePath: z.string().min(1), expectedVersion: z.number().int().positive(),
    id: z.string().min(1), roleId: z.enum(['frontend', 'backend', 'audit']), goal: z.string().min(1), repository: z.string().min(1), allowedPaths: z.array(z.string()), baseline: z.string().min(1), contractRef: z.string().min(1), contractRevision: z.string().min(1),
    acceptanceCriteria: z.array(z.string()).min(1), verificationCommands: z.array(z.string()).min(1), dependencies: z.array(z.string()), risk: z.number().min(0).max(10), evidenceFailures: z.number().int().min(0), operationId: z.string().min(1)
  }).strict() }, async (input) => {
    if (actor.roleId !== 'lead') throw new CoordinatorError('FORBIDDEN', 'Only the lead can dispatch execution packages.', 'Send a dispatch request to the lead role.');
    if (process.env.COORDINATOR_SOCKET_PATH) {
      const { owner, repositoryId, worktreePath, expectedVersion, operationId, ...workFields } = input;
      const result = await coordinatorRequest(process.env.COORDINATOR_SOCKET_PATH, { channel: 'role', roleId: actor.roleId, generation: actor.bindingGeneration, capability: capability!, command: 'automation_dispatch', input: { binding: { taskRef: input.taskRef, owner, repositoryId, worktreePath, expectedVersion }, work: { ...workFields, worktree: worktreePath, paused: false }, operationId } });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (process.env.COORDINATOR_TASK_AUTHORITY !== 'mock') throw new CoordinatorError('TASK_GATE_CLOSED', 'Production CLI Task MCP adapter is not configured; dispatch is fail-closed.', 'Configure the verified Task MCP adapter before business dispatch.');
    contracts!.assertUsable(actor.groupId, input.roleId, input.contractRef, input.contractRevision);
    const cwd = await resolveAuthorizedPath(input.worktreePath, JSON.parse(process.env.COORDINATOR_ALLOWED_ROOTS ?? JSON.stringify([process.cwd()])) as string[]);
    const modelRuntime = new MockRuntime();
    await modelRuntime.initialize();
    const catalog = await modelRuntime.listModels();
    const taskAuthority = new MockTaskAuthority(async (binding) => ({ id: binding.taskRef, owner: binding.owner, repositoryId: binding.repositoryId, worktreePath: binding.worktreePath, version: binding.expectedVersion, status: 'in_progress', lease: { active: true, owner: binding.owner }, conflicts: [] }));
    const dispatcher = new WorkDispatcher(store!, taskAuthority);
    const work: ExecutionPackage = { id: input.id, roleId: input.roleId, goal: input.goal, taskRef: input.taskRef, repository: input.repository, worktree: cwd, allowedPaths: input.allowedPaths, baseline: input.baseline, contractRef: input.contractRef, acceptanceCriteria: input.acceptanceCriteria, verificationCommands: input.verificationCommands, dependencies: input.dependencies, risk: input.risk, evidenceFailures: input.evidenceFailures, paused: false };
    const result = await dispatcher.dispatch(actor, { taskRef: input.taskRef, owner: input.owner, repositoryId: input.repositoryId, worktreePath: cwd, expectedVersion: input.expectedVersion }, work, catalog, input.operationId);
    return { content: [{ type: 'text', text: JSON.stringify({ ...result, taskGateMode: 'mock', turnStarted: false }) }] };
  });
  server.registerTool('message_claim', { description: 'Claim the oldest message addressed to this configured role.', inputSchema: z.object({ leaseMs: z.number().int().min(1000).max(300000).default(60000) }).strict() }, async ({ leaseMs }) => {
    const claim = store!.claim(actor, randomUUID(), leaseMs, Boolean(process.env.COORDINATOR_SOCKET_PATH));
    return { content: [{ type: 'text', text: JSON.stringify(claim ?? { empty: true }) }] };
  });
  server.registerTool('message_complete', { description: 'Complete a message using its current lease token.', inputSchema: z.object({ messageId: z.string(), leaseToken: z.string(), result: z.unknown() }).strict() }, async ({ messageId, leaseToken, result }) => {
    store!.complete(actor, messageId, leaseToken, result);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, messageId }) }] };
  });
  server.registerTool('message_renew', { description: 'Renew an active processing lease before it expires.', inputSchema: z.object({ messageId: z.string(), leaseToken: z.string(), leaseMs: z.number().int().min(1000).max(300000).default(60000) }).strict() }, async ({ messageId, leaseToken, leaseMs }) => {
    const expiresAt = store!.renew(actor, messageId, leaseToken, leaseMs);
    return { content: [{ type: 'text', text: JSON.stringify({ messageId, expiresAt }) }] };
  });
  server.registerTool('message_reconcile', { description: 'Reconcile an expired processing operation; lead role only.', inputSchema: z.object({ messageId: z.string(), outcome: z.enum(['completed', 'not_started', 'unknown']), evidence: z.string().min(8), result: z.unknown().optional() }).strict() }, async ({ messageId, outcome, evidence, result }) => {
    store!.reconcile(actor, messageId, outcome, evidence, result);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, messageId, outcome }) }] };
  });
  server.registerTool('contract_publish', { description: 'Publish an immutable contract revision; lead role only.', inputSchema: z.object({ artifactRef: z.string().min(1), revision: z.string().min(1), digest: z.string().min(1), baselineRef: z.string().min(1), compatibility: z.enum(['compatible', 'breaking']), affectedRoles: z.array(z.enum(['lead', 'frontend', 'backend', 'audit'])) }).strict() }, async (input) => {
    const contract = contracts!.publish(actor, input);
    return { content: [{ type: 'text', text: JSON.stringify(contract) }] };
  });
  server.registerTool('contract_ack', { description: 'Acknowledge the exact published contract revision.', inputSchema: z.object({ contractId: z.string(), revision: z.string() }).strict() }, async ({ contractId, revision }) => {
    contracts!.ack(actor, contractId, revision);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, contractId, revision, roleId: actor.roleId }) }] };
  });
  server.registerTool('contract_check', { description: 'Check whether this role may use the selected contract revision.', inputSchema: z.object({ contractId: z.string(), revision: z.string() }).strict() }, async ({ contractId, revision }) => {
    const usable = contracts!.assertUsable(actor.groupId, actor.roleId, contractId, revision);
    return { content: [{ type: 'text', text: JSON.stringify({ usable, contractId, revision }) }] };
  });
  server.registerTool('validation_create', { description: 'Start an immutable audit cycle against an exact baseline.', inputSchema: z.object({ contractRef: z.string(), baselineRef: z.string() }).strict() }, async ({ contractRef, baselineRef }) => {
    const run = validations!.create(actor, contractRef, baselineRef);
    return { content: [{ type: 'text', text: JSON.stringify(run) }] };
  });
  server.registerTool('validation_record', { description: 'Record a validation outcome with command evidence.', inputSchema: z.object({ validationId: z.string(), outcome: z.enum(['passed', 'rejected', 'error']), evidence: z.array(z.object({ command: z.string(), outcome: z.string(), summary: z.string() })) }).strict() }, async ({ validationId, outcome, evidence }) => {
    const run = validations!.record(actor, validationId, outcome, evidence);
    return { content: [{ type: 'text', text: JSON.stringify(run) }] };
  });
  server.registerTool('usage_get', { description: 'Read this role thread latest cumulative token snapshot.', inputSchema: z.object({ threadId: z.string().min(1) }).strict() }, async ({ threadId }) => {
    const snapshot = usage!.current(actor.groupId, actor.roleId, threadId);
    return { content: [{ type: 'text', text: JSON.stringify(snapshot ?? { pending_reconciliation: true }) }] };
  });
  server.registerTool('browser_request', { description: 'Enqueue a browser check for the approved test origin.', inputSchema: z.object({ url: z.string().url(), taskRef: z.string().min(1), operationId: z.string().min(1) }).strict() }, async ({ url, taskRef, operationId }) => {
    const request = browser!.enqueue(actor.groupId, actor.roleId, { url, taskRef }, operationId);
    return { content: [{ type: 'text', text: JSON.stringify(request) }] };
  });
  server.registerTool('browser_claim', { description: 'Claim the next group browser request under the shared Edge lease.', inputSchema: z.object({ leaseMs: z.number().int().min(1000).max(300000).default(60000) }).strict() }, async ({ leaseMs }) => {
    const claim = browser!.claim(actor.roleId, randomUUID(), leaseMs, actor.groupId);
    return { content: [{ type: 'text', text: JSON.stringify(claim ?? { empty: true }) }] };
  });
  server.registerTool('browser_execute', { description: 'Health-check services and navigate an owned Edge page for a claimed request.', inputSchema: z.object({ requestId: z.string(), leaseToken: z.string() }).strict() }, async ({ requestId, leaseToken }) => {
    const request = browser!.get(requestId);
    if (!request || request.groupId !== actor.groupId) throw new CoordinatorError('FORBIDDEN', 'Browser request is not in this role group.', 'Claim a request from the configured group.');
    const payload = request.payload as { url?: string; taskRef?: string };
    const target = new URL(payload.url ?? '');
    if (!['http:', 'https:'].includes(target.protocol)) throw new CoordinatorError('FORBIDDEN', 'Browser requests must use HTTP or HTTPS.', 'Use a web test origin.');
    const allowedOrigins = JSON.parse(process.env.COORDINATOR_BROWSER_ALLOWED_ORIGINS ?? '[]') as string[];
    if (!allowedOrigins.includes(target.origin)) throw new CoordinatorError('FORBIDDEN', 'Browser target origin is not allowlisted.', 'Use an explicitly approved test origin.');
    const healthUrls = JSON.parse(process.env.COORDINATOR_BROWSER_HEALTH_URLS ?? '[]') as string[];
    if (healthUrls.length === 0) throw new CoordinatorError('SERVICE_UNHEALTHY', 'Browser execution requires configured service health checks.', 'Configure health endpoints and verify them before browser work.');
    for (const healthUrl of healthUrls) {
      const health = new URL(healthUrl);
      if (!['http:', 'https:'].includes(health.protocol) || !allowedOrigins.includes(health.origin)) throw new CoordinatorError('FORBIDDEN', 'Health endpoint origin is not allowlisted.', 'Allowlist the exact health endpoint origin.');
    }
    const healthChecks = healthUrls.map((healthUrl) => ({ service: new URL(healthUrl).origin, check: async () => {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
      return response.ok;
    } }));
    let edge: Awaited<ReturnType<typeof connectExistingEdge>> | undefined;
    let started = false;
    try {
      await requireHealthyServices(healthChecks);
      const endpoint = process.env.BU_CDP_URL;
      if (!endpoint) throw new CoordinatorError('INVALID_INPUT', 'Explicit Edge CDP endpoint is required.', 'Set BU_CDP_URL to the approved loopback endpoint.');
      edge = await connectExistingEdge(endpoint);
      browser!.markStarted(requestId, leaseToken);
      started = true;
      const result = await runBrowserRequest({ healthChecks: [], driver: edge, url: payload.url! });
      browser!.finish(requestId, leaseToken, 'completed');
      return { content: [{ type: 'text', text: JSON.stringify({ requestId, taskRef: payload.taskRef, result }) }] };
    } catch (error) {
      if (started) {
        try { browser!.finish(requestId, leaseToken, 'failed'); } catch { /* Expired in-flight actions remain for reconciliation. */ }
      } else {
        browser!.releaseBeforeStart(requestId, leaseToken);
      }
      throw error;
    } finally { await edge?.disconnect(); }
  });
  server.registerTool('browser_reconcile', { description: 'Resolve an expired browser action after inspection; lead role only.', inputSchema: z.object({ requestId: z.string(), outcome: z.enum(['completed', 'not_started', 'unknown']), evidence: z.string().min(8) }).strict() }, async ({ requestId, outcome, evidence }) => {
    if (actor.roleId !== 'lead') throw new CoordinatorError('FORBIDDEN', 'Only the lead can reconcile browser actions.', 'Send reconciliation evidence to the lead.');
    if (browser!.get(requestId)?.groupId !== actor.groupId) throw new CoordinatorError('FORBIDDEN', 'Browser request is not in this role group.', 'Read the configured group queue.');
    browser!.reconcile(requestId, outcome, evidence);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, requestId, outcome }) }] };
  });
  return server;
}

const handle = serveStdio(registerTools);
let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  await handle.close();
  await appServerHandle?.close();
  browser?.close(); usage?.close(); validations?.close(); contracts?.close(); store?.close();
  process.exit(0);
};
process.stdin.on('end', () => { void shutdown(); });
process.stdin.on('close', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
