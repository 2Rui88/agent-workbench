import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const hookPath = resolve(repositoryRoot, ".codex/hooks/session-start.mjs");
const hookConfigPath = resolve(repositoryRoot, ".codex/hooks.json");
const temporaryRepositories: string[] = [];

function createRepository(withIdentity: boolean): string {
  const path = mkdtempSync(resolve(tmpdir(), "cli-task-hook-"));
  temporaryRepositories.push(path);
  execFileSync("git", ["init", "-q", path]);
  if (withIdentity) {
    execFileSync("git", ["-C", path, "config", "user.name", "jande"]);
    execFileSync("git", ["-C", path, "config", "user.email", "jande@example.test"]);
  }
  return path;
}

function runHook(path: string, source = "startup") {
  return spawnSync(process.execPath, [hookPath], {
    cwd: path,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null"
    },
    input: JSON.stringify({
      cwd: path,
      hook_event_name: "SessionStart",
      session_id: "session-test",
      source
    })
  });
}

afterEach(() => {
  for (const path of temporaryRepositories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("Codex SessionStart pipeline hook", () => {
  it("injects the repository identity and three-tool recovery order", () => {
    const path = createRepository(true);
    const result = runHook(path, "resume");
    const canonicalPath = execFileSync("git", ["-C", path, "rev-parse", "--show-toplevel"], {
      encoding: "utf8"
    }).trim();

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput: {
        additionalContext: string;
        hookEventName: string;
      };
    };
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(output.hookSpecificOutput.additionalContext).toContain(`worktree: ${canonicalPath}`);
    expect(output.hookSpecificOutput.additionalContext).toContain("Git owner: jande");
    expect(output.hookSpecificOutput.additionalContext).toContain("Codebase Memory");
    expect(output.hookSpecificOutput.additionalContext).toContain("session_context");
    expect(output.hookSpecificOutput.additionalContext).toContain("task_recovery_get");
    expect(output.hookSpecificOutput.additionalContext).toContain("dependency_repair_list");
    expect(output.hookSpecificOutput.additionalContext).toContain("PowerContext");
    expect(output.hookSpecificOutput.additionalContext).toContain("pending_acceptance");
  });

  it("fails closed for task writes when the Git identity is missing", () => {
    const path = createRepository(false);
    const result = runHook(path);

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(output.hookSpecificOutput.additionalContext).toContain("Git identity is missing");
    expect(output.hookSpecificOutput.additionalContext).toContain("stop before any task write");
  });

  it("registers the hook for every root-session start source", () => {
    const config = JSON.parse(readFileSync(hookConfigPath, "utf8")) as {
      hooks: {
        SessionStart: Array<{
          hooks: Array<{ command: string; type: string }>;
          matcher: string;
        }>;
      };
    };

    expect(config.hooks.SessionStart).toEqual([
      {
        matcher: "startup|resume|clear|compact",
        hooks: [
          expect.objectContaining({
            type: "command",
            command: expect.stringContaining("/.codex/hooks/session-start.mjs")
          })
        ]
      }
    ]);
  });
});
