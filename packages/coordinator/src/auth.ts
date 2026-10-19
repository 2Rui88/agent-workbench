import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { CoordinatorError } from './errors.js';
import type { Actor, RoleId } from './protocol.js';
import { roleEnum } from './roles.js';

const submissionSchema = z.object({
  type: z.enum(['assistance_request', 'contract_update', 'test_debug', 'dispute', 'arbitration_suggested']),
  recipientRole: roleEnum,
  payload: z.record(z.string(), z.unknown())
}).strict();

export interface MessageSubmission {
  groupId: string;
  senderRole: RoleId;
  bindingGeneration: number;
  type: 'assistance_request' | 'contract_update' | 'test_debug' | 'dispute' | 'arbitration_suggested';
  recipientRole: RoleId;
  payload: Record<string, unknown>;
}

export function createMessageSubmission(actor: Actor, input: unknown): MessageSubmission {
  const parsed = submissionSchema.safeParse(input);
  if (!parsed.success) {
    throw new CoordinatorError('INVALID_INPUT', 'Message submission is invalid.', 'Remove caller-supplied identity fields and provide a valid payload.');
  }
  return {
    groupId: actor.groupId,
    senderRole: actor.roleId,
    bindingGeneration: actor.bindingGeneration,
    ...parsed.data
  };
}

export function assertSameGroup(actor: Actor, targetGroupId: string): void {
  if (actor.groupId !== targetGroupId) {
    throw new CoordinatorError('FORBIDDEN', 'Cross-group access is not allowed.', 'Use a resource in the actor group.');
  }
}

async function canonicalizePossiblyMissing(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    const parent = resolve(absolute, '..');
    if (parent === absolute) throw error;
    const canonicalParent = await canonicalizePossiblyMissing(parent);
    return resolve(canonicalParent, absolute.slice(parent.length + 1));
  }
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..`) && !isAbsolute(rel));
}

export async function resolveAuthorizedPath(candidate: string, allowedRoots: string[]): Promise<string> {
  const [canonicalTarget, canonicalRoots] = await Promise.all([
    canonicalizePossiblyMissing(candidate),
    Promise.all(allowedRoots.map((root) => realpath(root)))
  ]);
  if (!canonicalRoots.some((root) => isWithin(root, canonicalTarget))) {
    throw new CoordinatorError('PATH_OUTSIDE_ALLOWED_ROOT', 'Path resolves outside the allowed workspace roots.', 'Choose a path inside an authorized workspace.');
  }
  return canonicalTarget;
}
