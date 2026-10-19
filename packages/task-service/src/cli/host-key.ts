/// <reference types="node" />

import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  createHash,
  sign as signWith
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const keyDirectory = join(homedir(), ".cli-session-task");
const privateKeyPath = join(keyDirectory, "host-key.pem");
const keyMetadataPath = join(keyDirectory, "host-key.json");

interface HostKeyMetadata {
  host_key_id?: string;
  public_key_b64: string;
  registered_at?: string;
}

function usage(): string {
  return [
    "Usage:",
    "  npm run host-key -- generate",
    "  npm run host-key -- register --server <url> --owner <git user.name> --label <host label> [--family codex|claude_code|generic_mcp]",
    "",
    "generate creates ~/.cli-session-task/host-key.pem (Ed25519, 0600) if absent",
    "and prints the SPKI public key (base64). register sends it to the server;",
    "when ~/.cli-session-task/host-key.previous.pem exists, a rotation signature",
    "is produced automatically."
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

function loadOrCreateKeyPair(): { privateKeyPem: string; publicKeyB64: string } {
  if (existsSync(privateKeyPath)) {
    const privateKeyPem = readFileSync(privateKeyPath, "utf8");
    const der = createPublicKey(createPrivateKey(privateKeyPem))
      .export({ format: "der", type: "spki" });
    return { privateKeyPem, publicKeyB64: Buffer.from(der).toString("base64") };
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const der = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  mkdirSync(keyDirectory, { recursive: true });
  writeFileSync(privateKeyPath, privateKeyPem, { mode: 0o600 });
  chmodSync(privateKeyPath, 0o600);
  return { privateKeyPem, publicKeyB64: Buffer.from(der).toString("base64") };
}

function loadPreviousMetadata(): HostKeyMetadata | undefined {
  if (!existsSync(keyMetadataPath)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(keyMetadataPath, "utf8")) as HostKeyMetadata;
  } catch {
    return undefined;
  }
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
    throw new Error(`HTTP ${String(response.status)} from ${url}: ${message}`);
  }
  return payload as Record<string, unknown>;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "generate") {
    const { publicKeyB64 } = loadOrCreateKeyPair();
    process.stdout.write(
      `Host key ready at ${privateKeyPath}\n`
      + `Public key (SPKI DER, base64):\n${publicKeyB64}\n`
      + "Register it with:\n"
      + `  npm run host-key -- register --server <url> `
      + `--owner <git user.name> --label <host label>\n`
    );
    return;
  }
  if (command !== "register") {
    process.stdout.write(usage());
    process.exitCode = command === "help" ? 0 : 1;
    return;
  }
  const flags = parseFlags(rest);
  const server = flags.get("--server");
  const owner = flags.get("--owner");
  const label = flags.get("--label") ?? hostLabel();
  if (server === undefined || owner === undefined) {
    throw new Error("--server and --owner are required\n" + usage());
  }
  const { privateKeyPem, publicKeyB64 } = loadOrCreateKeyPair();
  const previous = loadPreviousMetadata();
  const previousPriv = previous !== undefined && existsSync(join(keyDirectory, "host-key.previous.pem"))
    ? readFileSync(join(keyDirectory, "host-key.previous.pem"), "utf8")
    : undefined;
  let rotationSignature: string | undefined;
  if (previousPriv !== undefined
    && previous !== undefined
    && previous.public_key_b64 !== publicKeyB64) {
    const digest = createHash("sha256")
      .update(Buffer.from(publicKeyB64, "base64"))
      .digest();
    rotationSignature = signWith(
      null,
      digest,
      createPrivateKey(previousPriv)
    ).toString("base64");
  }
  const result = await postJson(`${server.replace(/\/$/, "")}/host-evidence/register-key`, {
    owner,
    label,
    public_key_b64: publicKeyB64,
    ...(flags.has("--family") ? { client_family: flags.get("--family") } : {}),
    ...(rotationSignature === undefined ? {} : { rotation_signature_b64: rotationSignature })
  });
  mkdirSync(keyDirectory, { recursive: true });
  writeFileSync(keyMetadataPath, JSON.stringify({
    host_key_id: result.host_key_id,
    public_key_b64: publicKeyB64,
    registered_at: new Date().toISOString()
  }, null, 2) + "\n");
  process.stdout.write(
    `Registered host key ${String(result.host_key_id)} `
    + `(outcome: ${String(result.outcome)}) for owner ${owner}\n`
  );
}

function hostLabel(): string {
  return `${process.env.USER ?? process.env.USERNAME ?? "host"}@${process.env.HOSTNAME ?? "dev"}`;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

export { loadOrCreateKeyPair, privateKeyPath, keyMetadataPath, usage };
