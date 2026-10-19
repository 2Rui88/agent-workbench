import assert from 'node:assert/strict';
import test from 'node:test';
import { validateEdgeEndpoint } from '../src/browser/edge.js';

test('Edge CDP requires explicit loopback endpoint', () => {
  assert.equal(validateEdgeEndpoint('http://127.0.0.1:9222').port, '9222');
  assert.throws(() => validateEdgeEndpoint('http://example.com:9222'));
  assert.throws(() => validateEdgeEndpoint('http://127.0.0.1:9222/path'));
});

test('Edge endpoint rejects embedded credentials',()=>{
 assert.throws(()=>validateEdgeEndpoint('http://user:secret@127.0.0.1:9222'));
});
