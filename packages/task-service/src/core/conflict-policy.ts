import type { TaskStatus } from "../shared/task-contracts.js";

export type ConflictLevel = "none" | "warning" | "hard";

export type ConflictCode =
  | "WORKTREE_CONFLICT"
  | "FILE_CONFLICT"
  | "MODULE_OVERLAP"
  | "SOFT_DEPENDENCY"
  | "REPO_PROBE_FAILED";

export interface ConflictSide {
  task_id?: string;
  repository_id: string;
  worktree_path: string;
  changed_files: readonly string[];
  module_paths?: readonly string[];
  probe_error?: string;
}

export interface SoftDependency {
  task_id: string;
  status: TaskStatus;
}

export interface ConflictPolicyInput {
  left: ConflictSide;
  right: ConflictSide;
  soft_dependencies?: readonly SoftDependency[];
}

export interface ConflictReport {
  level: ConflictLevel;
  code?: ConflictCode;
  message: string;
  evidence: string[];
  recovery_actions: string[];
}

const terminalStatuses: ReadonlySet<TaskStatus> = new Set(["done", "cancelled"]);

function normalizeWorktreePath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function sharedChangedFiles(
  left: readonly string[],
  right: readonly string[]
): string[] {
  const rightFiles = new Set(right);
  return [...new Set(left)]
    .filter((file) => rightFiles.has(file))
    .sort();
}

function firstModuleOverlap(
  left: readonly string[],
  right: readonly string[]
): [string, string] | undefined {
  for (const leftModule of left) {
    for (const rightModule of right) {
      if (modulesOverlap(leftModule, rightModule)) {
        return [leftModule, rightModule];
      }
    }
  }
  return undefined;
}

function modulesOverlap(left: string, right: string): boolean {
  return left === right
    || left.startsWith(`${right}/`)
    || right.startsWith(`${left}/`);
}

function unfinishedDependencies(
  dependencies: readonly SoftDependency[]
): SoftDependency[] {
  return dependencies.filter((dependency) => !terminalStatuses.has(dependency.status));
}

function conflictReport(
  level: ConflictLevel,
  code: ConflictCode | undefined,
  message: string,
  evidence: readonly string[],
  recoveryActions: readonly string[]
): ConflictReport {
  const report: ConflictReport = {
    level,
    message,
    evidence: [...evidence],
    recovery_actions: [...recoveryActions]
  };
  if (code !== undefined) {
    report.code = code;
  }
  return report;
}

function noConflictReport(): ConflictReport {
  return conflictReport(
    "none",
    undefined,
    "No repository conflicts detected",
    [],
    []
  );
}

export function evaluateConflicts(input: ConflictPolicyInput): ConflictReport {
  const probeError = [input.left.probe_error, input.right.probe_error]
    .find((error) => error !== undefined);
  if (probeError !== undefined) {
    return conflictReport(
      "hard",
      "REPO_PROBE_FAILED",
      "The repository probe failed; starting or switching tasks is forbidden",
      [probeError],
      ["Fix repository access and re-run the probe before starting or switching tasks."]
    );
  }

  if (
    normalizeWorktreePath(input.left.worktree_path)
      === normalizeWorktreePath(input.right.worktree_path)
  ) {
    return conflictReport(
      "hard",
      "WORKTREE_CONFLICT",
      "Both tasks would write to the same worktree",
      [input.left.worktree_path],
      ["Move one of the tasks to a dedicated worktree before starting it."]
    );
  }

  const sharedFiles = sharedChangedFiles(
    input.left.changed_files,
    input.right.changed_files
  );
  if (sharedFiles.length > 0) {
    return conflictReport(
      "hard",
      "FILE_CONFLICT",
      "The tasks change overlapping files",
      sharedFiles,
      [
        "Split ownership of the shared files or wait for the active task to finish",
        "re-run the probe after the conflict is resolved."
      ]
    );
  }

  if (input.left.repository_id === input.right.repository_id) {
    const overlap = firstModuleOverlap(
      input.left.module_paths ?? [],
      input.right.module_paths ?? []
    );
    if (overlap !== undefined) {
      return conflictReport(
        "warning",
        "MODULE_OVERLAP",
        "Worktrees in the same repository overlap on module paths",
        [overlap.join(" ~ ")],
        ["Review module ownership with the other task owner before proceeding."]
      );
    }
  }

  const unfinished = unfinishedDependencies(input.soft_dependencies ?? []);
  if (unfinished.length > 0) {
    return conflictReport(
      "warning",
      "SOFT_DEPENDENCY",
      "Soft dependencies are not finished yet",
      unfinished.map(
        (dependency) => `${dependency.task_id} is unfinished (status: ${dependency.status})`
      ),
      ["Check the dependency task status; proceed only when the delay is acceptable."]
    );
  }

  return noConflictReport();
}
