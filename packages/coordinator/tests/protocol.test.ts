import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertSameGroup,
  createMessageSubmission,
  resolveAuthorizedPath
} from '../src/auth.js';
import { CommandRegistry } from '../src/protocol.js';
import { assertSupportedModelChoice } from '../src/config.js';
import type { Actor } from '../src/protocol.js';

const frontend: Actor = {
  groupId: 'group-1',
  roleId: 'frontend',
  bindingGeneration: 2,
  capabilityId: 'cap-frontend'
};

test('rejectForgedSender: sender identity comes from actor capability', () => {
  assert.throws(
    () => createMessageSubmission(frontend, {
      type: 'assistance_request',
      recipientRole: 'backend',
      senderRole: 'lead',
      payload: { question: 'review this contract' }
    }),
    { code: 'INVALID_INPUT' }
  );
});

test('rejectCrossGroup: actor cannot route a request to another group', () => {
  assert.throws(() => assertSameGroup(frontend, 'group-2'), { code: 'FORBIDDEN' });
});

test('rejectSymlinkEscape: a workspace symlink cannot escape an allowed root', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'coordinator-path-'));
  const root = join(temp, 'workspace');
  const outside = join(temp, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await symlink(outside, join(root, 'escape'));
  try {
    await assert.rejects(resolveAuthorizedPath(join(root, 'escape', 'file.txt'), [root]), {
      code: 'PATH_OUTSIDE_ALLOWED_ROOT'
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('rejectUnsupportedEffort: model choices must come from model/list', () => {
  assert.throws(() => assertSupportedModelChoice(
    { model: 'gpt-6-luna', effort: 'ultra' },
    [{ model: 'gpt-6-luna', efforts: ['low', 'medium', 'high', 'xhigh'] }]
  ), { code: 'MODEL_EFFORT_UNSUPPORTED' });
});

test('dryRunDoesNotWrite: preview validates input without executing a command', async () => {
  const registry = new CommandRegistry();
  let writes = 0;
  registry.register('message.send', {
    inputSchema: (await import('zod')).z.object({ message: (await import('zod')).z.string().min(1) }),
    execute: async () => { writes += 1; return { sent: true }; }
  });

  const preview = await registry.dryRun('message.send', { message: 'hello' });

  assert.equal(preview.command, 'message.send');
  assert.deepEqual(preview.normalizedInput, { message: 'hello' });
  assert.equal(writes, 0);
});
