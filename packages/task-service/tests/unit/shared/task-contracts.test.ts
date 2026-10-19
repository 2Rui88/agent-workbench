import { describe, expect, it } from "vitest";
import {
  checkpointPayloadSchema,
  taskStatusSchema
} from "../../../src/shared/task-contracts.js";
import {
  taskAttemptSchema,
  taskCodeFingerprintSchema
} from "../../../src/shared/task-recovery-contracts.js";

const legacyCheckpoint = {
  completed_items: [],
  current_state: "working",
  confirmed_decisions: [],
  pending_decisions: [],
  blockers: [],
  verification: [],
  next_action: "continue"
};

describe("task contracts", () => {
  it("accepts every designed task status", () => {
    expect(taskStatusSchema.parse("pending_acceptance")).toBe("pending_acceptance");
    expect(taskStatusSchema.parse("cancelled")).toBe("cancelled");
  });

  it("rejects a checkpoint without next_action", () => {
    const result = checkpointPayloadSchema.safeParse({
      completed_items: [],
      current_state: "working",
      confirmed_decisions: [],
      pending_decisions: [],
      blockers: [],
      verification: []
    });

    expect(result.success).toBe(false);
  });

  it("keeps legacy checkpoints compatible with an empty attempt history", () => {
    expect(checkpointPayloadSchema.parse(legacyCheckpoint).attempts ?? []).toEqual([]);
  });

  it("parses bounded task attempts and code fingerprints", () => {
    expect(taskAttemptSchema.parse({
      attempt_id: "attempt-1",
      summary: "Tried direct lease transfer",
      outcome: "failed",
      evidence_refs: ["event-1"],
      recorded_at: "2026-09-22T00:00:00.000Z"
    }).outcome).toBe("failed");

    expect(taskCodeFingerprintSchema.parse({
      head_commit: "a".repeat(40),
      worktree_path: "/tmp/worktree",
      content_digest: `sha256:${"b".repeat(64)}`,
      captured_at: "2026-09-22T00:00:00.000Z",
      provenance: "server_verified"
    }).provenance).toBe("server_verified");
  });

  it("rejects duplicate and empty task attempt ids", () => {
    expect(checkpointPayloadSchema.safeParse({
      ...legacyCheckpoint,
      attempts: [{
        attempt_id: "",
        summary: "empty id",
        outcome: "failed",
        evidence_refs: [],
        recorded_at: "2026-09-22T00:00:00.000Z"
      }]
    }).success).toBe(false);

    expect(checkpointPayloadSchema.safeParse({
      ...legacyCheckpoint,
      attempts: [
        {
          attempt_id: "same",
          summary: "first",
          outcome: "failed",
          evidence_refs: [],
          recorded_at: "2026-09-22T00:00:00.000Z"
        },
        {
          attempt_id: "same",
          summary: "second",
          outcome: "abandoned",
          evidence_refs: [],
          recorded_at: "2026-09-22T00:01:00.000Z"
        }
      ]
    }).success).toBe(false);
  });
});
