/// <reference types="node" />

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import type { RepoSnapshot } from "../shared/task-contracts.js";
import type { RepositoryRecord } from "../storage/progress-store.js";
import { computeWorktreeContentDigest } from "./worktree-fingerprint.js";

export type RepoProbeErrorCode = "REPOSITORY_NOT_ALLOWED" | "REPO_PROBE_FAILED";

export class RepoProbeError extends Error {
  readonly code: RepoProbeErrorCode;

  constructor(code: RepoProbeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RepoProbeError";
    this.code = code;
  }
}

export interface RepoSnapshotDraft extends RepoSnapshot {
  worktree_path: string;
  branch: string;
  changed_files: string[];
  content_digest?: string;
  /** Evidence source for this draft; direct probes read as server_verified. */
  provenance_source?: "server_verified" | "host_verified";
  /** Host evidence backing a host_verified draft. */
  host_evidence_id?: string;
}

export interface RepoProbeInput {
  repository: RepositoryRecord;
  worktree_path: string;
}

const gitCommandTimeoutMs = 10_000;
const gitCommandMaxBufferBytes = 16 * 1024 * 1024;

const ordinaryChangedEntry = /^1 (..) \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/;
const renamedChangedEntry = /^2 (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/;
const unmergedEntry = /^u (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/;
const untrackedEntry = /^\? (.+)$/;

function execGit(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        timeout: gitCommandTimeoutMs,
        maxBuffer: gitCommandMaxBufferBytes,
        windowsHide: true
      },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function parseWorktreeList(output: string): string[] {
  const paths: string[] = [];
  for (const entry of output.split("\0")) {
    if (entry.startsWith("worktree ")) {
      paths.push(entry.slice("worktree ".length));
    }
  }
  return paths;
}

export function parseChangedFiles(output: string): string[] {
  const files: string[] = [];
  let skipNextEntry = false;
  for (const entry of output.split("\0")) {
    if (entry === "") {
      continue;
    }
    if (skipNextEntry) {
      // The previous entry was a rename; this field is its original path.
      skipNextEntry = false;
      continue;
    }
    const match
      = untrackedEntry.exec(entry)
        ?? ordinaryChangedEntry.exec(entry)
        ?? renamedChangedEntry.exec(entry)
        ?? unmergedEntry.exec(entry);
    if (match === null) {
      // Ignored entries ("! <path>") and unknown records stay invisible.
      continue;
    }
    files.push(match.at(-1)!);
    skipNextEntry = entry.startsWith("2 ");
  }
  files.sort();
  return files;
}

async function resolveRealPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw new RepoProbeError(
      "REPOSITORY_NOT_ALLOWED",
      `Path cannot be resolved for the whitelist check: ${path}`,
      { cause: error }
    );
  }
}

async function runGitOrProbeFailure(
  description: string,
  args: readonly string[]
): Promise<string> {
  try {
    return await execGit(args);
  } catch (error) {
    throw new RepoProbeError(
      "REPO_PROBE_FAILED",
      `Git command failed while ${description}`,
      { cause: error }
    );
  }
}

export class RepoProbe {
  async inspect(input: RepoProbeInput): Promise<RepoSnapshotDraft> {
    const rootPath = await resolveRealPath(input.repository.path);
    const toplevel = (await runGitOrProbeFailure(
      "locating the registered repository root",
      ["-C", rootPath, "rev-parse", "--show-toplevel"]
    )).trimEnd();
    if (toplevel !== rootPath) {
      throw new RepoProbeError(
        "REPOSITORY_NOT_ALLOWED",
        `Registered path ${rootPath} is not the repository root (${toplevel})`
      );
    }

    const worktreePath = await resolveRealPath(input.worktree_path);
    const allowedWorktrees = await this.#allowedWorktrees(rootPath);
    if (!allowedWorktrees.has(worktreePath)) {
      throw new RepoProbeError(
        "REPOSITORY_NOT_ALLOWED",
        `Path ${worktreePath} is not a worktree of the registered repository ${rootPath}`
      );
    }

    const headCommit = (await runGitOrProbeFailure(
      "resolving the worktree HEAD commit",
      ["-C", worktreePath, "rev-parse", "HEAD"]
    )).trimEnd();
    if (headCommit === "") {
      throw new RepoProbeError(
        "REPO_PROBE_FAILED",
        `Worktree ${worktreePath} has no HEAD commit to probe`
      );
    }

    const branch = (await runGitOrProbeFailure(
      "resolving the worktree branch",
      ["-C", worktreePath, "branch", "--show-current"]
    )).trimEnd();
    const statusOutput = await runGitOrProbeFailure(
      "collecting the worktree status",
      ["-C", worktreePath, "status", "--porcelain=v2", "-z"]
    );

    let contentDigest: string;
    try {
      contentDigest = await computeWorktreeContentDigest(worktreePath, headCommit);
    } catch (error) {
      throw new RepoProbeError(
        "REPO_PROBE_FAILED",
        `Failed to fingerprint worktree content: ${worktreePath}`,
        { cause: error }
      );
    }

    return {
      repository_id: input.repository.repository_id,
      repository_path: toplevel,
      worktree_path: worktreePath,
      head_commit: headCommit,
      branch,
      changed_files: parseChangedFiles(statusOutput),
      content_digest: contentDigest,
      captured_at: new Date().toISOString()
    };
  }

  async #allowedWorktrees(rootPath: string): Promise<Set<string>> {
    const output = await runGitOrProbeFailure(
      "listing the worktrees of the registered repository",
      ["-C", rootPath, "worktree", "list", "--porcelain", "-z"]
    );
    const allowed = new Set<string>();
    for (const listedPath of parseWorktreeList(output)) {
      try {
        allowed.add(await realpath(listedPath));
      } catch {
        // A missing or prunable worktree cannot be probed; skip it.
      }
    }
    return allowed;
  }
}
