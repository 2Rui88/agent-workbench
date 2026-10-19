import { isAbsolute, relative, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';

export function absolutePath(value: string, base = process.cwd()): string {
  if (!value.trim()) throw new Error('Path must not be empty.');
  return resolve(base, value);
}

export function isWithinPath(root: string, candidate: string): boolean {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const rel = relative(rootPath, candidatePath);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export async function canonicalPath(value: string): Promise<string> {
  return realpath(absolutePath(value));
}

export async function assertWithinPath(root: string, candidate: string): Promise<string> {
  const [canonicalRoot, canonicalCandidate] = await Promise.all([
    canonicalPath(root),
    canonicalPath(candidate)
  ]);
  if (!isWithinPath(canonicalRoot, canonicalCandidate)) {
    throw new Error(`Path escapes the configured root: ${canonicalCandidate}`);
  }
  return canonicalCandidate;
}
