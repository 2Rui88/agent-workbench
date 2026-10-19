import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLayoutLock, readLayoutLock, assertNotInsideHerdr } from '../src/terminal/layout-lock.js';

test('only one layout controller per group regardless of backend', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'layout-'));
  try {
    const herdr = await acquireLayoutLock(dir, 'g', 'herdr', { pane: 'w:p' });
    await assert.rejects(acquireLayoutLock(dir, 'g', 'kitty', {}), /herdr.*already running/i);
    assert.equal((await readLayoutLock(dir))!.backend, 'herdr');
    await herdr.release();
    const kitty = await acquireLayoutLock(dir, 'g', 'kitty', {});
    await kitty.release();
    await writeFile(join(dir, 'layout-controller.lock'), JSON.stringify({ pid: 999999, backend: 'kitty', groupId: 'g' }));
    await assert.rejects(acquireLayoutLock(dir, 'g', 'herdr', {}), /stale/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('kitty start refuses to run inside Herdr', () => {
  assert.throws(() => assertNotInsideHerdr({ HERDR_ENV: '1' }), /lead:attach/);
  assertNotInsideHerdr({ KITTY_PID: '1' });
});
