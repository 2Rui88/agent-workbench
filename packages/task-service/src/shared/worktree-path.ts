/// <reference types="node" />

import { normalize, resolve } from "node:path";

/**
 * Lexical worktree-path normalization used on both sides of the host
 * evidence contract. The server cannot realpath() a remote worktree, so the
 * comparison is lexical: absolute, normalized, no trailing separator.
 */
export function normalizeWorktreePath(path: string): string {
  const resolved = resolve(normalize(path));
  return resolved.length > 1 && resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;
}
