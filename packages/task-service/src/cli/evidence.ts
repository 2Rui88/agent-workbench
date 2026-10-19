/// <reference types="node" />

import { createPrivateKey, sign as signWith } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { computeWorktreeContentDigest } from "../repo/worktree-fingerprint.js";
import { parseChangedFiles } from "../repo/repo-probe.js";
import { canonicalJsonBytes } from "../shared/canonical-json.js";
import { normalizeWorktreePath } from "../shared/worktree-path.js";
import type { CreateChallengeResult } from "../core/host-evidence-service.js";

const keyDirectory = join(homedir(), ".cli-session-task");
const privateKeyPath = join(keyDirectory, "host-key.pem");
const keyMetadataPath = join(keyDirectory, "host-key.json");

function usage(): string {
  return [
    "Usage: npm run evidence -- collect --server <url> --session <session_id>",
    "  [--operation checkpoint|submit] [--task <task_id>] [--worktree <path>]",
    "",
    "Runs on the developer machine inside the worktree. Fetches a one-time",
    "challenge, fingerprints the local worktree, signs it with the host key,",
    "and submits host_verified evidence. Run task_checkpoint/task_submit",
    "immediately afterwards, within the evidence window."
  ].join("\n");
}

function parseFlags(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !flag.startsWith("--") || value === undefined) {
      throw new Error(`Unexpected arguments near "${flag ?? ""}"\n${usage()}`);
    }
    values.set(flag, value);
  }
  return values;
}

function execGit(worktree: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", worktree, ...args],
      { timeout: 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
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

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null
      && "message" in payload
      ? String((payload as { message: unknown }).message)
      : response.statusText;
    const code = typeof payload === "object" && payload !== null && "code" in payload
      ? String((payload as { code: unknown }).code)
      : String(response.status);
    throw new Error(`HTTP ${String(response.status)} (${code}) from ${url}: ${message}`);
  }
  return payload as Record<string, unknown>;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "collect") {
    process.stdout.write(usage());
    process.exitCode = command === "help" ? 0 : 1;
    return;
  }
  const flags = parseFlags(rest);
  const server = flags.get("--server");
  const sessionId = flags.get("--session");
  if (server === undefined || sessionId === undefined) {
    throw new Error("--server and --session are required\n" + usage());
  }
  const operation = flags.get("--operation") === "submit" ? "submit" : "checkpoint";
  const worktree = normalizeWorktreePath(realpathSync(flags.get("--worktree") ?? process.cwd()));
  if (!existsSync(privateKeyPath) || !existsSync(keyMetadataPath)) {
    throw new Error(
      `No host key at ${privateKeyPath}. Run "npm run host-key -- generate" `
        + "and register it first."
    );
  }
  const metadata = JSON.parse(readFileSync(keyMetadataPath, "utf8")) as {
    host_key_id?: string;
  };
  if (metadata.host_key_id === undefined) {
    throw new Error(
      `${keyMetadataPath} has no host_key_id; complete host-key register first.`
    );
  }

  const base = server.replace(/\/$/, "");
  const challenge = await postJson(`${base}/host-evidence/challenge`, {
    session_id: sessionId,
    operation,
    ...(flags.has("--task") ? { task_id: flags.get("--task") } : {})
  }) as unknown as CreateChallengeResult;

  const headCommit = (await execGit(worktree, ["rev-parse", "HEAD"])).trimEnd();
  const branch = (await execGit(worktree, ["branch", "--show-current"])).trimEnd();
  const statusOutput = await execGit(worktree, ["status", "--porcelain=v2", "-z"]);
  const contentDigest = await computeWorktreeContentDigest(worktree, headCommit);

  const payload = {
    v: 1 as const,
    kind: "host_worktree_evidence.v1" as const,
    challenge_id: challenge.challenge_id,
    nonce_b64: challenge.nonce_b64,
    repository_id: challenge.repository_id,
    worktree_path: challenge.expected_worktree_path,
    head_commit: headCommit,
    ...(branch === "" ? {} : { branch }),
    changed_files: parseChangedFiles(statusOutput),
    content_digest: contentDigest,
    captured_at: new Date().toISOString(),
    host_key_id: metadata.host_key_id
  };
  const signature = signWith(
    null,
    canonicalJsonBytes(payload),
    createPrivateKey(readFileSync(privateKeyPath, "utf8"))
  ).toString("base64");

  const result = await postJson(`${base}/host-evidence/submit`, {
    payload,
    signature_b64: signature
  });
  process.stdout.write(
    `Host evidence stored: ${String(result.evidence_id)}\n`
      + `  worktree: ${String(result.worktree_path)}\n`
      + `  head: ${String(result.head_commit)}\n`
      + `  digest: ${String(result.content_digest)}\n`
      + `  expires: ${String(result.expires_at)}\n`
      + "Run task_checkpoint/task_submit now, before the evidence expires.\n"
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
