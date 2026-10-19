import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinatorEndpoint } from '../src/ipc.js';

test('Windows coordinator endpoints use a stable named pipe', () => {
  if (process.platform !== 'win32') return;
  const first = coordinatorEndpoint('C:\\state\\coordinator.sock');
  assert.match(first, /^\\\\\.\\pipe\\agent-workbench-/);
  assert.equal(first, coordinatorEndpoint('C:\\state\\coordinator.sock'));
  assert.notEqual(first, coordinatorEndpoint('C:\\other\\coordinator.sock'));
});
