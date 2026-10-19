import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeTurnJournal } from '../src/runtime/claude-journal.js';

test('journal keeps ordered turns, merges patches and fences orphans after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cj-')); const db = join(dir, 's.sqlite');
  const first = new ClaudeTurnJournal(db);
  try {
    first.createThread('th', '/repo');
    assert.equal(first.thread('th')!.materialized, false);
    first.startTurn({ threadId: 'th', turnId: 't1', requestedModel: 'm', requestedEffort: 'high' });
    first.update('t1', { status: 'completed', promptUuid: 'p1', inputTokens: 10 });
    first.startTurn({ threadId: 'th', turnId: 't2', requestedModel: 'm', requestedEffort: 'high' });
    first.markMaterialized('th');
    assert.deepEqual(first.turns('th'), [{ id: 't1', status: 'completed' }, { id: 't2', status: 'inProgress' }]);
    assert.equal(first.turn('t1')!.inputTokens, 10);
    assert.equal(first.turnIndex('t2'), 2);
    assert.equal(first.turnIndex('missing'), undefined);
    assert.throws(() => first.createThread('th', '/other'), { code: 'RECONCILIATION_REQUIRED' });
  } finally { first.close(); }
  const second = new ClaudeTurnJournal(db);
  try {
    assert.equal(second.thread('th')!.materialized, true);
    assert.equal(second.markOrphans('th', new Set()), 1);
    assert.equal(second.turn('t2')!.status, 'unknown');
    assert.match(second.turn('t2')!.error!, /restart/i);
  } finally { second.close(); await rm(dir, { recursive: true, force: true }); }
});
