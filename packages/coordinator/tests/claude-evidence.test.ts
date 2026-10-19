import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudeTurnModel, listPromptUuids } from '../src/runtime/claude-evidence.js';

const session = '11111111-2222-4333-8444-555555555555';
const line = (value: object) => JSON.stringify({ sessionId: session, ...value });
const prompt = (uuid: string) => line({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text: 'do work' }] } });
const toolResult = (uuid: string) => line({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x' }] } });
const assistant = (model: string, effort = 'high') => line({ type: 'assistant', uuid: 'a' + Math.random(), effort, message: { model, content: [] } });
const noise = () => line({ type: 'attachment', uuid: 'n' + Math.random() });

async function project(lines: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'claude-projects-'));
  await mkdir(join(root, '-Users-me-repo'));
  await writeFile(join(root, '-Users-me-repo', `${session}.jsonl`), lines.join('\n') + '\n');
  return root;
}

test('reads one consistent model and effort for the turn and ignores synthetic rows and later turns', async () => {
  const root = await project([JSON.stringify({ type: 'queue-operation', sessionId: session }), prompt('p0'), assistant('claude-haiku-5-5', 'low'), prompt('p1'), noise(), assistant('claude-opus-5-5'), toolResult('t1'), assistant('<synthetic>'), assistant('claude-opus-5-5'), prompt('p2'), assistant('claude-sonnet-5-5')]);
  try {
    assert.deepEqual(await readClaudeTurnModel(root, session, 'p1'), { model: 'claude-opus-5-5', effort: 'high', source: 'claude_transcript' });
    assert.deepEqual(await listPromptUuids(root, session), ['p0', 'p1', 'p2']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('inconsistent effort keeps the model evidence but reports effort unknown', async () => {
  const root = await project([prompt('p1'), assistant('claude-opus-5-5', 'high'), assistant('claude-opus-5-5', 'low')]);
  try { assert.deepEqual(await readClaudeTurnModel(root, session, 'p1'), { model: 'claude-opus-5-5', effort: null, source: 'claude_transcript' }); } finally { await rm(root, { recursive: true, force: true }); }
});

test('mixed models, missing prompt, foreign session and malformed lines are not evidence', async () => {
  const mixed = await project([prompt('p1'), assistant('claude-opus-5-5'), assistant('claude-haiku-5-5')]);
  const foreign = await project([prompt('p1'), JSON.stringify({ sessionId: 'other', type: 'assistant', message: { model: 'm' } })]);
  const broken = await project([prompt('p1'), '{oops', assistant('m')]);
  try {
    assert.equal(await readClaudeTurnModel(mixed, session, 'p1'), undefined);
    assert.equal(await readClaudeTurnModel(mixed, session, 'missing'), undefined);
    assert.equal(await readClaudeTurnModel(foreign, session, 'p1'), undefined);
    assert.equal(await readClaudeTurnModel(broken, session, 'p1'), undefined);
    assert.equal(await listPromptUuids(broken, session), undefined);
    assert.equal(await readClaudeTurnModel(mixed, 'not-a-uuid', 'p1'), undefined);
  } finally { for (const dir of [mixed, foreign, broken]) await rm(dir, { recursive: true, force: true }); }
});

test('symlinked transcripts and a trailing partial line are handled safely', async () => {
  const root = await project([prompt('p1'), assistant('claude-opus-5-5')]);
  const outside = await mkdtemp(join(tmpdir(), 'outside-'));
  try {
    await writeFile(join(root, '-Users-me-repo', `${session}.jsonl`), [prompt('p1'), assistant('claude-opus-5-5'), '{"partial'].join('\n'));
    assert.equal((await readClaudeTurnModel(root, session, 'p1'))?.model, 'claude-opus-5-5');
    await rm(join(root, '-Users-me-repo', `${session}.jsonl`));
    await writeFile(join(outside, 'x.jsonl'), prompt('p1') + '\n' + assistant('m') + '\n');
    await symlink(join(outside, 'x.jsonl'), join(root, '-Users-me-repo', `${session}.jsonl`));
    assert.equal(await readClaudeTurnModel(root, session, 'p1'), undefined);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('an interruption marker is not a prompt, so later turns keep their index and evidence', async () => {
  const marker = (uuid: string, text: string) => line({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] } });
  const root = await project([prompt('p0'), assistant('claude-sonnet-5-5'), marker('m1', '[Request interrupted by user]'), assistant('<synthetic>'), prompt('p1'), assistant('claude-sonnet-5-5'), marker('m2', '[Request interrupted by user for tool use]'), prompt('p2'), assistant('claude-sonnet-5-5')]);
  try {
    assert.deepEqual(await listPromptUuids(root, session), ['p0', 'p1', 'p2']);
    assert.deepEqual(await readClaudeTurnModel(root, session, 'p1'), { model: 'claude-sonnet-5-5', effort: 'high', source: 'claude_transcript' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
