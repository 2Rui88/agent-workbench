/// <reference types="node" />

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeConfig } from "../../../src/config/runtime-config.js";
import { SqliteDatabase } from "../../../src/storage/database.js";

const temporaryDirectories: string[] = [];
const startedAt = "2026-10-16T02:00:00.000Z";

function temporaryDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function runRegisterCli(dataDir: string, args: readonly string[]): Promise<{
  code: number | null;
  stderr: string;
}> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", join(process.cwd(), "src/cli/register-repository.ts"), ...args],
    {
      env: { ...process.env, TASK_MCP_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("repo:register cli", () => {
  it("refuses to register a repository into an archived project", async () => {
    const dataDir = temporaryDir("cli-session-task-mcp-register-");
    const repositoryPath = realpathSync(temporaryDir("cli-session-task-mcp-register-repo-"));
    execFileSync("git", ["-C", repositoryPath, "init", "-b", "main"], { stdio: "ignore" });
    const database = SqliteDatabase.open(createRuntimeConfig(dataDir));
    try {
      const store = database.createProgressStore();
      store.transaction((tx) => {
        tx.upsertProject({
          project_id: "project-archived",
          name: "Archived",
          created_by: "jande",
          created_at: startedAt,
          updated_at: startedAt
        });
        tx.archiveProject("project-archived", "jande", startedAt);
      });
    } finally {
      database.close();
    }

    const result = await runRegisterCli(dataDir, [
      "--project-id", "project-archived",
      "--project-name", "Archived",
      "--repository-id", "repo-cli-archived",
      "--repository-name", "CLI Archived",
      "--path", repositoryPath
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("PROJECT_ARCHIVED");
    const reopened = SqliteDatabase.open(createRuntimeConfig(dataDir));
    try {
      const store = reopened.createProgressStore();
      expect(store.getRepository("repo-cli-archived")).toBeUndefined();
      expect(store.getProject("project-archived")?.archived_at).toBe(startedAt);
    } finally {
      reopened.close();
    }
  });
});
