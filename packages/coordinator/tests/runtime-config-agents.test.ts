import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRuntimeConfig, agentFor } from '../src/runtime-config.js';
import { realExecutionSchema, assertRealExecution } from '../src/real-execution.js';

async function write(config: object) {
  const dir = await mkdtemp(join(tmpdir(), 'cfg-')); await mkdir(join(dir, 'repo'));
  const path = join(dir, 'runtime.json');
  await writeFile(path, JSON.stringify({ groupId: 'g', databasePath: 's.sqlite', socketPath: 'c.sock', credentialFile: 'r.json', humanCredentialFile: 'h.json', allowedRoots: ['.'], ...config }));
  return { dir, path };
}
const grant = { authorizationRef: 'a', expiresAt: new Date(Date.now() + 3600_000).toISOString(), taskRefs: ['t'], maxCalls: 2, maxConcurrent: 1, maxInputCharacters: 12000, maxTurnMs: 60000, choices: { frontend: { model: 'm', effort: 'medium' }, backend: { model: 'm', effort: 'medium' }, audit: { model: 'a', effort: 'high' } } };
const work = (roleId: string, model = { model: 'adv', effort: 'high', tier: 'analysis', reason: 'r' }) => ({ id: 'w', roleId, goal: 'g', taskRef: 't', repository: 'r', worktree: '/w', allowedPaths: ['.'], baseline: 'b', contractRef: 'c', acceptanceCriteria: ['a'], verificationCommands: ['v'], dependencies: [], risk: 0, evidenceFailures: 0, paused: false, model }) as never;

test('legacy config loads unchanged and defaults every role to codex', async () => {
  const { dir, path } = await write({});
  try {
    const config = await loadRuntimeConfig(path);
    assert.equal(config.mode, 'mock');
    for (const key of ['roles', 'leadAgent', 'leadWorktree', 'advisor']) assert.equal(key in config, false, key);
    for (const role of ['lead', 'frontend', 'backend', 'audit', 'advisor'] as const) assert.equal(agentFor(config, role), 'codex');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('real mode alias, per-role agents and lead worktree resolution', async () => {
  const { dir, path } = await write({ mode: 'mock', leadAgent: 'claude', leadWorktree: 'repo', roles: { audit: { agent: 'claude' }, advisor: { agent: 'claude' } }, advisor: { suggestAfterRejections: 3 } });
  try {
    const config = await loadRuntimeConfig(path);
    assert.equal(agentFor(config, 'lead'), 'claude');
    assert.equal(agentFor(config, 'frontend'), 'codex');
    assert.equal(agentFor(config, 'audit'), 'claude');
    assert.equal(config.leadWorktree, join(dir, 'repo'));
    assert.equal(config.advisor?.suggestAfterRejections, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
  const alias = await write({ mode: 'real' });
  try { await assert.rejects(loadRuntimeConfig(alias.path), { code: 'TASK_GATE_CLOSED' }); } finally { await rm(alias.dir, { recursive: true, force: true }); }
});

test('lead worktree must stay inside allowed roots', async () => {
  const { dir, path } = await write({ leadWorktree: '/etc' });
  try { await assert.rejects(loadRuntimeConfig(path), { code: 'INVALID_INPUT' }); } finally { await rm(dir, { recursive: true, force: true }); }
});

test('advisor execution needs its own choice and limits', () => {
  const plain = realExecutionSchema.parse(grant);
  assert.throws(() => assertRealExecution(plain, work('advisor')), { code: 'TASK_GATE_CLOSED' });
  assert.throws(() => realExecutionSchema.parse({ ...grant, choices: { ...grant.choices, advisor: { model: 'adv', effort: 'high' } } }));
  const full = realExecutionSchema.parse({ ...grant, choices: { ...grant.choices, advisor: { model: 'adv', effort: 'high' } }, advisor: { maxCalls: 1, maxInputCharacters: 4000 } });
  assertRealExecution(full, work('advisor'));
  assert.throws(() => assertRealExecution(full, work('advisor', { model: 'other', effort: 'high', tier: 'x', reason: 'r' })), { code: 'TASK_GATE_CLOSED' });
});

test('worker Task specs come from runtime config and are validated', async () => {
  const spec = { title: 't', goal: 'g', acceptanceCriteria: ['a'], nextAction: 'n' };
  const ok = await write({ workerTaskSpecs: { frontend: spec, backend: spec } });
  const bad = await write({ workerTaskSpecs: { frontend: { ...spec, acceptanceCriteria: [] }, backend: spec } });
  try {
    assert.deepEqual((await loadRuntimeConfig(ok.path)).workerTaskSpecs?.frontend, spec);
    await assert.rejects(loadRuntimeConfig(bad.path));
  } finally { await rm(ok.dir, { recursive: true, force: true }); await rm(bad.dir, { recursive: true, force: true }); }
});

test('real mode needs only the Task MCP and registered repositories; PowerContext is retired', async () => {
  const { dir, path } = await write({ mode: 'real', taskMcpUrl: 'http://127.0.0.1:1/mcp', repositories: [{ repositoryId: 'r', worktreePath: 'repo' }] });
  try { assert.equal((await loadRuntimeConfig(path)).mode, 'app_server'); } finally { await rm(dir, { recursive: true, force: true }); }
  const legacy = await write({ mode: 'real', taskMcpUrl: 'http://127.0.0.1:1/mcp', repositories: [{ repositoryId: 'r', worktreePath: 'repo' }], powerContext: { baseUrl: 'http://127.0.0.1:8787', roles: [] } });
  try { await assert.rejects(loadRuntimeConfig(legacy.path), /PowerContext.*retired/i); } finally { await rm(legacy.dir, { recursive: true, force: true }); }
});

test('project memory path resolves against the runtime directory and must be a readable file', async () => {
  const { dir, path } = await write({ projectMemory: { path: 'repo/docs/项目记忆.md' } });
  try {
    await assert.rejects(loadRuntimeConfig(path), { code: 'INVALID_INPUT' });
    await mkdir(join(dir, 'repo', 'docs'), { recursive: true }); await writeFile(join(dir, 'repo', 'docs', '项目记忆.md'), '# memory\n');
    assert.equal((await loadRuntimeConfig(path)).projectMemory?.path, join(dir, 'repo', 'docs', '项目记忆.md'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
