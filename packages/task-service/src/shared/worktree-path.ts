/// <reference types="node" />

import { normalize, resolve } from "node:path";

/**
 * Lexical worktree-path normalization used on both sides of the host
 * evidence contract. The server cannot realpath() a remote worktree, so the
 * comparison is lexical: absolute, normalized, no trailing separator.
 */
export function normalizeWorktreePath(path: string): string {
  const input = path.trim();
  // Preserve POSIX paths in the protocol even when the server runs on Windows.
  // Remote host evidence commonly uses /workspace/... paths that must not be
  // rewritten to the Windows drive root.
  if (input.startsWith("/")) {
    const normalized = input.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  }
  const resolved = resolve(normalize(input));
  return resolved.length > 1 && /[\\/]$/.test(resolved)
    ? resolved.slice(0, -1)
    : resolved;
}
