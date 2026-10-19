import type { PlatformError, TaskStatus } from "../shared/task-contracts.js";

type Actor = "agent" | "human" | "dependency_repair";
type HumanOnlyAction = "accept" | "reject" | "resume" | "cancel" | "force_takeover";

const agentTransitions = new Set([
  "backlog->in_progress",
  "in_progress->waiting_human",
  "waiting_human->in_progress",
  "in_progress->blocked",
  "blocked->in_progress",
  "in_progress->paused",
  "paused->in_progress",
  "in_progress->verifying",
  "verifying->paused",
  "verifying->in_progress",
  "verifying->pending_acceptance"
]);

const terminalStatuses = new Set<TaskStatus>(["done", "cancelled"]);

function transitionKey(from: TaskStatus, to: TaskStatus): string {
  return `${from}->${to}`;
}

function createPlatformError(
  code: string,
  message: string,
  evidence: string[]
): Error & PlatformError {
  const error = new Error(`${code}: ${message}`) as Error & PlatformError;
  error.name = "TaskStateError";
  error.code = code;
  error.retryable = false;
  error.evidence = evidence;
  error.recovery_actions = ["Review the task state and retry with an allowed actor or transition."];
  return error;
}

function throwInvalidTransition(from: TaskStatus, to: TaskStatus): never {
  throw createPlatformError(
    "INVALID_TRANSITION",
    `Transition from ${from} to ${to} is not allowed`,
    [transitionKey(from, to)]
  );
}

export function assertHumanOnlyAction(action: HumanOnlyAction, actor: Actor): void {
  if (actor === "human") {
    return;
  }

  throw createPlatformError(
    "HUMAN_CONFIRMATION_REQUIRED",
    `Only a human can ${action}`,
    [action, actor]
  );
}

export function assertTransition(actor: Actor, from: TaskStatus, to: TaskStatus): void {
  if (terminalStatuses.has(from)) {
    throwInvalidTransition(from, to);
  }

  if (actor !== "dependency_repair" && agentTransitions.has(transitionKey(from, to))) {
    return;
  }

  if (actor === "dependency_repair"
    && from === "pending_acceptance"
    && to === "in_progress") {
    return;
  }

  if (from === "pending_acceptance" && to === "done") {
    assertHumanOnlyAction("accept", actor);
    return;
  }

  if (from === "pending_acceptance" && to === "in_progress") {
    assertHumanOnlyAction("resume", actor);
    return;
  }

  if (from === "pending_acceptance" && to === "paused") {
    assertHumanOnlyAction("reject", actor);
    return;
  }

  if (to === "cancelled") {
    assertHumanOnlyAction("cancel", actor);
    return;
  }

  throwInvalidTransition(from, to);
}

export function statusHoldsLease(status: TaskStatus): boolean {
  return status === "in_progress" || status === "verifying";
}
