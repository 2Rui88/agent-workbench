/// <reference types="node" />

import { spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdtemp, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

function updateFieldHeader(hash: Hash, label: string, byteLength: number): void {
  hash.update(label);
  hash.update("\0");
  hash.update(String(byteLength));
  hash.update("\0");
}

function updateField(hash: Hash, label: string, value: string | Buffer): void {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  updateFieldHeader(hash, label, bytes.length);
  hash.update(bytes);
  hash.update("\0");
}

function gitOutput(worktreePath: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", worktreePath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(
          `git ${args.join(" ")} failed with exit code ${String(code)}: `
            + Buffer.concat(errors).toString("utf8").trim()
        ));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

async function gitOutputToFile(
  worktreePath: string,
  args: readonly string[],
  outputPath: string
): Promise<void> {
  const child = spawn("git", ["-C", worktreePath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const errors: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const exited = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `git ${args.join(" ")} failed with exit code ${String(code)}: `
          + Buffer.concat(errors).toString("utf8").trim()
      ));
    });
  });
  const outcomes = await Promise.allSettled([
    pipeline(child.stdout, createWriteStream(outputPath, { flags: "wx" })),
    exited
  ]);
  const failure = outcomes.find((outcome) => outcome.status === "rejected");
  if (failure?.status === "rejected") {
    throw failure.reason;
  }
}

function updateFile(hash: Hash, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
}

export async function computeWorktreeContentDigest(
  worktreePath: string,
  headCommit: string
): Promise<string> {
  const hash = createHash("sha256");
  updateField(hash, "format", "cli-session-task-worktree.v1");
  updateField(hash, "head", headCommit);

  const tempDirectory = await mkdtemp(join(tmpdir(), "cli-session-task-diff-"));
  try {
    const diffPath = join(tempDirectory, "tracked.diff");
    await gitOutputToFile(worktreePath, [
      "diff",
      "--binary",
      "--no-ext-diff",
      "HEAD",
      "--"
    ], diffPath);
    const diffStat = await stat(diffPath);
    updateFieldHeader(hash, "tracked-diff", diffStat.size);
    await updateFile(hash, diffPath);
    hash.update("\0");
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }

  const untrackedOutput = await gitOutput(worktreePath, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z"
  ]);
  const untracked = untrackedOutput.toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0)
    .sort();
  for (const relativePath of untracked) {
    const absolutePath = join(worktreePath, relativePath);
    const stat = await lstat(absolutePath);
    updateField(hash, "untracked-path", relativePath);
    if (stat.isSymbolicLink()) {
      updateField(hash, "untracked-symlink", await readlink(absolutePath));
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Unsupported untracked entry type: ${relativePath}`);
    }
    updateField(hash, "untracked-size", String(stat.size));
    await updateFile(hash, absolutePath);
    hash.update("\0");
  }

  return `sha256:${hash.digest("hex")}`;
}
