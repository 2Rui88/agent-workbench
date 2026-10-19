import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoordinatorEngine, type EngineOptions } from '../../src/engine.js';
import { MockRuntime } from '../../src/runtime/mock.js';
import { ContractRegistry } from '../../src/contracts.js';

export async function engineFixture(mockBudget?: { maxCalls: number; maxConcurrent: number }, extra: Partial<EngineOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'coordinator-engine-'));
  const db = join(dir, 'state.sqlite');
  const runtimes: MockRuntime[] = [];
  const options: EngineOptions = { databasePath: db, groupId: 'g', ...(mockBudget ? { mockBudget } : {}), humanCapability: 'independent-human-token', allowedRoots: [dir], runtimeSource: 'mock', runtimeFactory: () => { const runtime = new MockRuntime(); runtimes.push(runtime); return { runtime, close: async () => {} }; }, taskAuthority: { checkGate: async (binding) => ({ id: binding.taskRef, owner: binding.owner, repositoryId: binding.repositoryId, worktreePath: binding.worktreePath, version: binding.expectedVersion, status: 'in_progress', lease: { active: true, owner: binding.owner }, conflicts: [] }) } };
  Object.assign(options, extra);
  const engine = new CoordinatorEngine(options);
  const credentials = { lead: 'lead-capability-0123456789abcdef012345', frontend: 'frontend-capability-0123456789abcdef', backend: 'backend-capability-0123456789abcdef0', audit: 'audit-capability-0123456789abcdef012', advisor: 'advisor-capability-0123456789abcdef01' };
  engine.store.initializeGroup('g', credentials);
  const lead = engine.authenticate('lead', credentials.lead, 1); const backend = engine.authenticate('backend', credentials.backend, 1);
  const contracts = new ContractRegistry(db);
  const contract = contracts.publish(lead, { artifactRef: 'api', revision: 'v1', digest: 'hash', baselineRef: 'base', compatibility: 'breaking', affectedRoles: ['backend'] });
  contracts.ack(backend, contract.contractId, 'v1'); contracts.close();
  const dispatch = { binding: { taskRef: 'task', owner: 'jande', repositoryId: 'repo', worktreePath: dir, expectedVersion: 1 }, work: { id: 'one', roleId: 'backend', goal: 'Mock work', taskRef: 'task', repository: 'repo', worktree: dir, allowedPaths: ['src'], baseline: 'base', contractRef: contract.contractId, contractRevision: 'v1', acceptanceCriteria: ['passed'], verificationCommands: ['npm test'], dependencies: [], risk: 1, evidenceFailures: 0 }, operationId: 'dispatch-op' };
  return { dir, db, engine, options, credentials, lead, backend, runtimes, dispatch, cleanup: async () => { await engine.close(); await rm(dir, { recursive: true, force: true }); } };
}
