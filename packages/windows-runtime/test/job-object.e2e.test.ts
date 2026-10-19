import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsProcessSupervisor } from '../src/process-supervisor.js';

test('real Windows Job Object owns and terminates a child process', { skip: process.platform !== 'win32' }, async () => {
  const supervisor = new WindowsProcessSupervisor();
  const managed = supervisor.start({
    id: `e2e-${process.pid}`,
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: process.cwd(),
    useJobObject: true
  });
  await managed.ready;
  assert.equal(typeof managed.pid, 'number');
  assert.doesNotThrow(() => process.kill(managed.pid, 0));
  const exited = new Promise<void>((resolve) => managed.child.once('exit', () => resolve()));
  await supervisor.stop(managed.id);
  await exited;
  assert.throws(() => process.kill(managed.pid, 0));
  await supervisor.stopAll();
});
