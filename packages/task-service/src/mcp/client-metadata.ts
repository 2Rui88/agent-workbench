import type { ClientFamily } from "../shared/task-contracts.js";

export interface ClientMetadataInput {
  name: string;
  version: string;
}

export interface ClientMetadata {
  client_family: ClientFamily;
  client_name: string;
  client_version: string;
}

const clientFamilyByName: ReadonlyMap<string, ClientFamily> = new Map([
  ["codex-cli", "codex"],
  // Real Codex CLI connections report clientInfo.name "codex-mcp-client".
  ["codex-mcp-client", "codex"],
  ["claude-code", "claude_code"]
]);

export function normalizeClientMetadata(input: ClientMetadataInput): ClientMetadata {
  const normalizedFamily = clientFamilyByName.get(input.name.trim().toLowerCase());
  return {
    client_family: normalizedFamily ?? "generic_mcp",
    client_name: input.name,
    client_version: input.version
  };
}
