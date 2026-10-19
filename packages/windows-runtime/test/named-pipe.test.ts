import test from 'node:test';
import assert from 'node:assert/strict';
import { connectJsonLine, listenJsonLine } from '../src/named-pipe.js';
import { localhostTcp } from '../src/ipc-endpoint.js';

test('JSON line IPC round trips over localhost TCP fallback', async () => {
  const endpoint = localhostTcp(25431);
  const server = await listenJsonLine(endpoint, async (request) => ({ method: request.method, params: request.params }));
  try {
    const client = await connectJsonLine(endpoint);
    try {
      assert.deepEqual(await client.request('status', { ready: true }), { method: 'status', params: { ready: true } });
    } finally { client.close(); }
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test('named pipe endpoint is available on Windows', { skip: process.platform !== 'win32' }, async () => {
  const endpoint = { type: 'named-pipe' as const, name: `\\\\.\\pipe\\agent-workbench-test-${process.pid}` };
  const server = await listenJsonLine(endpoint, async () => ({ ok: true }));
  try {
    const client = await connectJsonLine(endpoint);
    try { assert.deepEqual(await client.request('ping'), { ok: true }); }
    finally { client.close(); }
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
