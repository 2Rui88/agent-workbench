import assert from 'node:assert/strict';
import test from 'node:test';
import { runBrowserRequest } from '../src/browser/runner.js';

test('health failure prevents browser actions', async () => {
  let created = 0;
  await assert.rejects(runBrowserRequest({
    healthChecks: [{ service: 'app', check: async () => false }],
    driver: { createOwnPage: async () => { created += 1; return { goto: async () => undefined, close: async () => undefined }; } },
    url: 'http://localhost'
  }), { code: 'SERVICE_UNHEALTHY' });
  assert.equal(created, 0);
});

test('cleanup closes only the page created by this request', async () => {
  let userPageOpen = true;
  let ownedPageClosed = false;
  const result = await runBrowserRequest({
    healthChecks: [{ service: 'app', check: async () => true }],
    driver: { createOwnPage: async () => ({ goto: async () => ({ title: 'ready' }), close: async () => { ownedPageClosed = true; } }) },
    url: 'http://localhost'
  });
  assert.equal(result.title, 'ready');
  assert.equal(ownedPageClosed, true);
  assert.equal(userPageOpen, true);
});
