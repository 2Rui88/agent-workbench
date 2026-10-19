import { describe, expect, it } from "vitest";
import type { TaskStatus } from "../../../src/shared/task-contracts.js";
import {
  assertHumanOnlyAction,
  assertTransition,
  statusHoldsLease
} from "../../../src/core/task-state.js";

const statuses: TaskStatus[] = [
  "backlog",
  "in_progress",
  "waiting_human",
  "blocked",
  "paused",
  "verifying",
  "pending_acceptance",
  "done",
  "cancelled"
];

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

function transitionKey(from: TaskStatus, to: TaskStatus): string {
  return `${from}->${to}`;
}

function humanAllowsTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (agentTransitions.has(transitionKey(from, to))) {
    return true;
  }

  if (from === "pending_acceptance" && (to === "done" || to === "in_progress" || to === "paused")) {
    return true;
  }

  return !["done", "cancelled"].includes(from) && to === "cancelled";
}

describe("task state", () => {
  it("applies the complete 9 by 9 transition matrix for agents", () => {
    for (const from of statuses) {
      for (const to of statuses) {
        const expected = agentTransitions.has(transitionKey(from, to));
        const transition = () => assertTransition("agent", from, to);

        if (expected) {
          expect(transition, `${from} -> ${to}`).not.toThrow();
        } else if (
          (from === "pending_acceptance" && (to === "done" || to === "in_progress" || to === "paused"))
          || (!["done", "cancelled"].includes(from) && to === "cancelled")
        ) {
          expect(transition, `${from} -> ${to}`).toThrowError("HUMAN_CONFIRMATION_REQUIRED");
        } else {
          expect(transition, `${from} -> ${to}`).toThrowError("INVALID_TRANSITION");
        }
      }
    }
  });

  it("applies the complete 9 by 9 transition matrix for humans", () => {
    for (const from of statuses) {
      for (const to of statuses) {
        const transition = () => assertTransition("human", from, to);

        if (humanAllowsTransition(from, to)) {
          expect(transition, `${from} -> ${to}`).not.toThrow();
        } else {
          expect(transition, `${from} -> ${to}`).toThrowError("INVALID_TRANSITION");
        }
      }
    }
  });

  it("holds a write lease only while work is in progress or verifying", () => {
    expect(statusHoldsLease("in_progress")).toBe(true);
    expect(statusHoldsLease("verifying")).toBe(true);

    for (const status of statuses) {
      if (status !== "in_progress" && status !== "verifying") {
        expect(statusHoldsLease(status), status).toBe(false);
      }
    }
  });

  it("allows only the dependency repair actor to reopen pending acceptance for repair", () => {
    expect(() => assertTransition(
      "dependency_repair",
      "pending_acceptance",
      "in_progress"
    )).not.toThrow();
    expect(() => assertTransition("dependency_repair", "paused", "in_progress"))
      .toThrowError("INVALID_TRANSITION");
    expect(() => assertTransition("agent", "pending_acceptance", "in_progress"))
      .toThrowError("HUMAN_CONFIRMATION_REQUIRED");
  });

  it("requires a human for acceptance, rejection, cancellation, and forced takeover", () => {
    for (const action of ["accept", "reject", "cancel", "force_takeover"] as const) {
      expect(() => assertHumanOnlyAction(action, "agent"), action)
        .toThrowError("HUMAN_CONFIRMATION_REQUIRED");
      expect(() => assertHumanOnlyAction(action, "human"), action).not.toThrow();
    }
  });
});
