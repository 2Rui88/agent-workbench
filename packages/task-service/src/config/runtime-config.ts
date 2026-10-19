/// <reference types="node" />

import { homedir } from "node:os";
import { join } from "node:path";

export interface RuntimeConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  staleAfterMs: 1_800_000;
  sqliteBusyTimeoutMs: 5_000;
  hostChallengeTtlMs: number;
  hostEvidenceWindowMs: number;
}

/**
 * Data directory resolution precedence:
 * 1. the explicit `dataDir` argument (tests and programmatic callers),
 * 2. the `TASK_MCP_DATA_DIR` environment variable (isolated runs, Task 11),
 * 3. the macOS application support default.
 *
 * Port resolution: the `TASK_MCP_PORT` environment variable (isolated E2E
 * runs on a spare port so the resident launchd instance stays untouched),
 * otherwise the 47321 default.
 */
export function createRuntimeConfig(
  dataDir?: string,
  port = environmentPort() ?? 47_321
): RuntimeConfig {
  const resolvedDataDir = dataDir
    ?? environmentDataDir()
    ?? join(
      homedir(),
      "Library",
      "Application Support",
      "cli-session-task-mcp"
    );
  return {
    host: process.env.TASK_MCP_HOST?.trim() || "127.0.0.1",
    port,
    dataDir: resolvedDataDir,
    databasePath: join(resolvedDataDir, "task-progress.sqlite"),
    staleAfterMs: 1_800_000,
    sqliteBusyTimeoutMs: 5_000,
    hostChallengeTtlMs: environmentPositiveInt(
      "TASK_MCP_HOST_CHALLENGE_TTL_MS",
      120_000
    ),
    hostEvidenceWindowMs: environmentPositiveInt(
      "TASK_MCP_HOST_EVIDENCE_WINDOW_MS",
      900_000
    )
  };
}

function environmentPositiveInt(name: string, fallback: number): number {
  const override = process.env[name];
  if (override === undefined || override.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(override, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function environmentDataDir(): string | undefined {
  const override = process.env.TASK_MCP_DATA_DIR;
  return override !== undefined && override.length > 0 ? override : undefined;
}

function environmentPort(): number | undefined {
  const override = process.env.TASK_MCP_PORT;
  if (override === undefined || override.trim().length === 0) {
    return undefined;
  }
  const parsed = Number.parseInt(override, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : undefined;
}
