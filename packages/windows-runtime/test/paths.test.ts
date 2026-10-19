import test from 'node:test';
import assert from 'node:assert/strict';
import { isWithinPath } from '../src/paths.js';
import { localhostTcp, namedPipe } from '../src/ipc-endpoint.js';

test('path containment rejects sibling prefixes', () => {
  assert.equal(isWithinPath('C:\\work\\app', 'C:\\work\\app\\src'), true);
  assert.equal(isWithinPath('C:\\work\\app', 'C:\\work\\application'), false);
});

test('named pipe and localhost fallback are validated', () => {
  assert.deepEqual(namedPipe('agent-platform-coordinator'), { type: 'named-pipe', name: '\\\\.\\pipe\\agent-platform-coordinator' });
  assert.deepEqual(localhostTcp(25430), { type: 'tcp', host: '127.0.0.1', port: 25430 });
  assert.throws(() => namedPipe('bad name'));
});
