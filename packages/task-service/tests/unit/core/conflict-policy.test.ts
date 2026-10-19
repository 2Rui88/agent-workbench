import { describe, expect, it } from "vitest";
import {
  evaluateConflicts,
  type ConflictSide
} from "../../../src/core/conflict-policy.js";

function side(overrides: Partial<ConflictSide> = {}): ConflictSide {
  return {
    repository_id: "repo-1",
    worktree_path: "/repos/repo/worktrees/left",
    changed_files: ["src/left/alpha.ts"],
    ...overrides
  };
}

function rightSide(overrides: Partial<ConflictSide> = {}): ConflictSide {
  return {
    repository_id: "repo-1",
    worktree_path: "/repos/repo/worktrees/right",
    changed_files: ["src/right/beta.ts"],
    ...overrides
  };
}

describe("evaluateConflicts", () => {
  it("reports no conflict for disjoint worktrees without overlaps", () => {
    const report = evaluateConflicts({ left: side(), right: rightSide() });

    expect(report.level).toBe("none");
    expect(report.code).toBeUndefined();
    expect(report.evidence).toEqual([]);
  });

  it("flags the same writable worktree as a hard worktree conflict", () => {
    const left = side();
    const right = rightSide({
      worktree_path: `${left.worktree_path}/`
    });

    const report = evaluateConflicts({ left, right });

    expect(report.level).toBe("hard");
    expect(report.code).toBe("WORKTREE_CONFLICT");
    expect(report.evidence).toContain(left.worktree_path);
  });

  it("flags overlapping changed files as a hard file conflict", () => {
    const report = evaluateConflicts({
      left: side({ changed_files: ["src/shared/api.ts", "src/left/alpha.ts"] }),
      right: rightSide({ changed_files: ["src/shared/api.ts"] })
    });

    expect(report.level).toBe("hard");
    expect(report.code).toBe("FILE_CONFLICT");
    expect(report.evidence).toContain("src/shared/api.ts");
  });

  it("warns when worktrees in the same repository overlap on module paths", () => {
    const report = evaluateConflicts({
      left: side({ module_paths: ["src/core"] }),
      right: rightSide({ module_paths: ["src/core/session"] })
    });

    expect(report.level).toBe("warning");
    expect(report.code).toBe("MODULE_OVERLAP");
    expect(report.recovery_actions.length).toBeGreaterThan(0);
  });

  it("does not warn on module overlap across different repositories", () => {
    const report = evaluateConflicts({
      left: side({ module_paths: ["src/core"] }),
      right: rightSide({
        repository_id: "repo-2",
        module_paths: ["src/core"]
      })
    });

    expect(report.level).toBe("none");
  });

  it("warns on unfinished soft dependencies only", () => {
    const input = {
      left: side(),
      right: rightSide(),
      soft_dependencies: [
        { task_id: "task-done", status: "done" as const },
        { task_id: "task-blocked", status: "blocked" as const }
      ]
    };

    const report = evaluateConflicts(input);

    expect(report.level).toBe("warning");
    expect(report.code).toBe("SOFT_DEPENDENCY");
    expect(report.evidence).toContain("task-blocked is unfinished (status: blocked)");
    expect(report.evidence).not.toContain("task-done is unfinished (status: done)");
  });

  it("treats failed probes as hard conflicts that outrank file conflicts", () => {
    const left = side({ probe_error: "REPOSITORY_NOT_ALLOWED: /repos/repo/escape" });
    const right = rightSide({
      changed_files: ["src/left/alpha.ts"],
      probe_error: "REPO_PROBE_FAILED: git rev-parse HEAD failed"
    });

    const report = evaluateConflicts({ left, right });

    expect(report.level).toBe("hard");
    expect(report.code).toBe("REPO_PROBE_FAILED");
    expect(report.evidence).toContain("REPOSITORY_NOT_ALLOWED: /repos/repo/escape");
    expect(report.recovery_actions.length).toBeGreaterThan(0);
  });
});
