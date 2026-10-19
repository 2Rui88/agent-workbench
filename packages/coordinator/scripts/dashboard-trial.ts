import { loadRuntimeConfig, readProtectedJson } from '../src/runtime-config.js';
import { coordinatorRequest } from '../src/ipc.js';
import type { AutomationCommand } from '../src/engine.js';
import type { RoleId } from '../src/protocol.js';
const config = await loadRuntimeConfig(process.argv[2]!);
const credentials = await readProtectedJson(config.credentialFile) as { credentials: Record<RoleId, string> };
const send = (roleId: RoleId, command: AutomationCommand, input: unknown) => coordinatorRequest(config.socketPath, { channel: 'role', roleId, generation: 1, capability: credentials.credentials[roleId], command, input });
const cwd = config.repositories[0]!.worktreePath;
const sessionRef = process.env.COORDINATOR_EXTERNAL_SESSION_REF;
if (!sessionRef) throw new Error('Inject the actual external host session reference.');
await send('lead', 'automation_lead_heartbeat', { sessionRef, cwd });
let heartbeatError = false;
const heartbeat = setInterval(() => { void send('lead', 'automation_lead_heartbeat', { sessionRef, cwd }).catch(() => { heartbeatError = true; }); }, 20000);
try {
  for (const role of ['frontend', 'backend', 'audit'] as const) {
    const result = await send(role, 'automation_role_initialize', { cwd }) as { threadId: string };
    console.log(JSON.stringify({ role, threadId: result.threadId, turnStarted: false }));
  }
  const baseline = 'dashboard-local-20261004';
  const contract = await send('lead', 'automation_contract_publish', { artifactRef: 'dashboard-snapshot-v1', revision: 'v1', digest: 'dashboard-local-contract-v1', baselineRef: baseline, compatibility: 'breaking', affectedRoles: ['audit'], operationId: 'dashboard-contract-v1' }) as { contractId: string };
  await send('audit', 'automation_contract_ack', { contractId: contract.contractId, revision: 'v1' });
  const binding = { taskRef: config.externalTaskObservation!.taskRef, owner: 'jande', repositoryId: config.repositories[0]!.repositoryId, worktreePath: cwd, expectedVersion: Number(process.env.COORDINATOR_TASK_VERSION) };
  const result = await send('lead', 'automation_dispatch', { binding, work: {
    id: 'dashboard-runtime-audit-v1', roleId: 'audit', goal: 'Read-only coordinator trial. Inspect src/dashboard/contracts.ts and web/dashboard.js against the approved snapshot contract; run npm run typecheck (read-only). Do not edit files or Task state. Use automation_validation_create with contractRef and baseline from this package; record the actual command result through automation_validation_record. Then call automation_work_complete with this package dispatchId, concise summary and actual evidence. Tools are exposed by coordinator_role MCP; discover their schemas. This is a read-only external-host Task observation trial, not a business-write lease. Return only evidence and blockers; limit final answer to 150 words. Do not expand to full project audit or browser.',
    taskRef: binding.taskRef, repository: binding.repositoryId, worktree: cwd, allowedPaths: ['src/dashboard', 'web'], baseline, contractRef: contract.contractId, contractRevision: 'v1', acceptanceCriteria: ['actual typecheck evidence', 'validation cycle and business receipt', 'no file writes'], verificationCommands: ['npm run typecheck'], dependencies: [], risk: 1, evidenceFailures: 0, paused: false
  }, operationId: 'dashboard-runtime-audit-dispatch-v1' }) as { message: { messageId: string }; model: unknown };
  console.log(JSON.stringify({ dispatchId: result.message.messageId, requested: result.model }));
  for (let i = 0; i < 180; i++) {
    const status = await send('lead', 'automation_status', {}) as { dispatches: Array<{ dispatchId: string; state: string; turnId?: string }>; blocks: unknown; budget: unknown };
    const work = status.dispatches.find((item) => item.dispatchId === result.message.messageId);
    if (work?.state === 'completed' || work?.state === 'needs_reconciliation' || heartbeatError) { console.log(JSON.stringify({ work, blocks: status.blocks, budget: status.budget, heartbeatError })); if (work?.state !== 'completed') process.exitCode = 1; break; }
    if (i % 10 === 0) console.log(JSON.stringify({ state: work?.state, blocks: status.blocks, budget: status.budget }));
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
} finally { clearInterval(heartbeat); }
