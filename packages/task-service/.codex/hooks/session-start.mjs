import { execFileSync } from "node:child_process";
import { basename } from "node:path";

async function readInput() {
  try {
    return JSON.parse(await readStdin());
  } catch {
    return {};
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
  });
}

function git(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}

function buildContext(input) {
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const worktree = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!worktree) {
    return "Development pipeline unavailable: the current directory is not a Git worktree. Stop before any task write and resolve the repository path.";
  }

  const owner = git(worktree, ["config", "user.name"]);
  const email = git(worktree, ["config", "user.email"]);
  if (!owner || !email) {
    return [
      "Development pipeline identity check failed.",
      `worktree: ${worktree}`,
      "Git identity is missing or incomplete. Read git config user.name and user.email, then stop before any task write."
    ].join("\n");
  }

  const project = basename(worktree);
  return [
    "Development pipeline context:",
    `- project: ${project}`,
    `- worktree: ${worktree}`,
    `- Git owner: ${owner}`,
    `- Git email: ${email}`,
    "",
    "Run this recovery and execution order for modification or multi-step work:",
    "1. Use Codebase Memory graph tools first for code topology, callers, and impact discovery.",
    "2. Bind cli-session-task-mcp with session_context using this exact worktree and Git owner. Read task_recovery_get for an attached task; otherwise use task_list, dependency_validation_list, and dependency_repair_list before creating work.",
    "3. Before edits, attach the selected task, run task_conflicts, and acquire the task lease with task_start. Treat CLI Task as the authoritative task-level state, version, lease, checkpoint, dependency validation, repair, and acceptance ledger.",
    "4. Record semantic milestones with task_checkpoint. Do not checkpoint every file edit. On downstream rejection, claim the current dependency repair request and repair the upstream task before resubmission.",
    "5. Use PowerContext only for durable decisions, conventions, reusable lessons, and occasional handoff. Resolve the repository-bound project scope beneath the current machine workspace; do not copy task status, versions, leases, or validation runs into long-term memory.",
    "6. Run fresh repository verification before task_submit. Submission enters pending_acceptance and creates the downstream validation cycle; final acceptance remains blocked until the latest cycle passes and a human acts on the Board.",
    "",
    "SessionStart may run before MCP servers are ready. If a required MCP is unavailable, stop before edits and retry binding after the connection is live."
  ].join("\n");
}

const input = await readInput();
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: buildContext(input)
  }
}));
