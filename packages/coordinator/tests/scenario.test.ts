import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BrowserQueue } from '../src/browser/queue.js';
import { runBrowserRequest } from '../src/browser/runner.js';
import { ContractRegistry } from '../src/contracts.js';
import { WorkDispatcher } from '../src/dispatch.js';
import { CliTaskAuthority } from '../src/integrations/adapters.js';
import { MockRuntime } from '../src/runtime/mock.js';
import type { ExecutionPackage } from '../src/scheduler.js';
import { CooperativeScheduler } from '../src/scheduler.js';
import { CoordinatorStore } from '../src/store.js';
import { UsageLedger } from '../src/usage.js';
import { ValidationRegistry } from '../src/validation.js';

test('mock end-to-end: task gate → model policy → role queue → browser lease → audit → pending acceptance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coordinator-scenario-'));
  const statePath = join(dir, 'state.sqlite');
  const store = new CoordinatorStore(statePath);
  const contracts = new ContractRegistry(statePath);
  const validations = new ValidationRegistry(statePath);
  const usage = new UsageLedger(statePath);
  const browser = new BrowserQueue(join(dir, 'browser.sqlite'));
  store.createGroup('scenario');
  const lead = { groupId: 'scenario', roleId: 'lead' as const, bindingGeneration: 1, capabilityId: 'lead-cap' };
  const backend = { groupId: 'scenario', roleId: 'backend' as const, bindingGeneration: 1, capabilityId: 'backend-cap' };
  const audit = { groupId: 'scenario', roleId: 'audit' as const, bindingGeneration: 1, capabilityId: 'audit-cap' };
  const taskClient = {
    getTask: async () => ({ id: 'task-42', owner: 'jande', repositoryId: 'repo-backend', worktreePath: '/repo/backend', version: 8, status: 'in_progress', lease: { active: true, owner: 'jande' }, conflicts: [] }),
    checkpoint: async () => ({ ok: true }),
    submit: async () => ({ ok: true, status: 'pending_acceptance' as const })
  };
  const authority = new CliTaskAuthority(taskClient);
  const binding = { taskRef: 'task-42', owner: 'jande', repositoryId: 'repo-backend', worktreePath: '/repo/backend', expectedVersion: 8 };
  const work: ExecutionPackage = { id: 'implementation-1', roleId: 'backend', goal: 'Implement the assigned endpoint', taskRef: 'task-42', repository: 'repo-backend', worktree: '/repo/backend', allowedPaths: ['src/api'], baseline: 'commit-base', contractRef: 'contract-v1', acceptanceCriteria: ['response matches contract'], verificationCommands: ['npm test'], dependencies: [], risk: 1, evidenceFailures: 0, paused: false };
  const runtime = new MockRuntime();
  const scheduler = new CooperativeScheduler(store);
  try {
    const contract = contracts.publish(lead, { artifactRef: 'openapi.yaml', revision: 'v1', digest: 'sha256:contract', baselineRef: 'commit-base', compatibility: 'breaking', affectedRoles: ['backend'] });
    contracts.ack(backend, contract.contractId, contract.revision);
    assert.equal(contracts.assertUsable('scenario', 'backend', contract.contractId, 'v1'), true);

    await runtime.initialize();
    const catalog = await runtime.listModels();
    const dispatcher = new WorkDispatcher(store, authority, scheduler);
    const dispatched = await dispatcher.dispatch(lead, binding, { ...work, contractRef: contract.contractId }, catalog, 'operation-1');
    assert.deepEqual({ model: dispatched.model.model, effort: dispatched.model.effort }, { model: 'gpt-6-luna', effort: 'high' });
    const claim = store.claim(backend, 'message-lease-1', 30_000);
    assert.ok(claim);
    assert.equal(claim.payload.taskRef, 'task-42');
    const threadId = await runtime.startThread('/repo/backend');
    scheduler.setOnline('lead', true);
    scheduler.setOnline('backend', true);
    const [started] = await scheduler.tick('scenario', async (scheduled) => {
      const turn = await runtime.startTurn({ threadId, input: scheduled.goal, model: scheduled.model!.model, effort: scheduled.model!.effort, cwd: scheduled.worktree });
      return { turnId: turn.turnId };
    });
    assert.equal(started?.model?.model, dispatched.model.model);
    const receipt = { turnId: started!.turnId };
    assert.equal(runtime.providerCalls, 0);
    store.complete(backend, claim.messageId, claim.leaseToken, { receipt, verification: 'mock-passed' });
    scheduler.complete('backend', receipt.turnId);

    browser.enqueue('scenario', 'audit', { url: 'http://127.0.0.1:3000' }, 'browser-op-1');
    const browserClaim = browser.claim('audit', 'browser-lease-1');
    assert.ok(browserClaim);
    browser.markStarted(browserClaim.requestId, browserClaim.leaseToken);
    const browserResult = await runBrowserRequest({ healthChecks: [{ service: 'mock-app', check: async () => true }], driver: { createOwnPage: async () => ({ goto: async () => ({ title: 'Scenario app' }), close: async () => undefined }) }, url: 'http://127.0.0.1:3000' });
    assert.equal(browserResult.title, 'Scenario app');
    browser.finish(browserClaim.requestId, browserClaim.leaseToken, 'completed');

    const run = validations.create(audit, contract.contractId, 'commit-base');
    validations.record(audit, run.validationId, 'passed', [{ command: 'npm test', outcome: 'passed', summary: 'isolated Mock assertions passed' }]);
    usage.record({ snapshotId: 'usage-1', groupId: 'scenario', roleId: 'backend', threadId, capturedAt: new Date().toISOString(), totals: { inputTokens: 0, outputTokens: 0 } });

    const submitted = await authority.submit('task-42', { summary: 'Mock scenario verified', validationId: run.validationId });
    assert.deepEqual(submitted, { ok: true, status: 'pending_acceptance' });
    await assert.rejects(authority.accept('task-42'), { code: 'HUMAN_ACCEPTANCE_ONLY' });
  } finally {
    browser.close(); usage.close(); validations.close(); contracts.close(); store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
