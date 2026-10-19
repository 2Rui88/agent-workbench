import { z } from "zod";

export const taskAttemptDraftSchema = z.object({
  attempt_id: z.string().min(1).max(128),
  summary: z.string().min(1).max(2000),
  outcome: z.enum(["failed", "abandoned", "superseded"]),
  evidence_refs: z.array(z.string().min(1).max(256)).max(20).default([])
});

export const taskAttemptSchema = z.object({
  ...taskAttemptDraftSchema.shape,
  recorded_at: z.iso.datetime()
});

export const taskCodeFingerprintSchema = z.object({
  head_commit: z.string().min(1),
  worktree_path: z.string().min(1),
  content_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  captured_at: z.iso.datetime(),
  provenance: z.enum(["server_verified", "host_verified", "client_reported"])
});

export const taskVerificationEvidenceSchema = z.object({
  command: z.string().min(1),
  outcome: z.enum(["passed", "failed", "not_run"]),
  summary: z.string().min(1),
  code_fingerprint: taskCodeFingerprintSchema.optional()
});

export const dependencyRepairStatusSchema = z.enum([
  "pending",
  "claimed",
  "resolved",
  "superseded",
  "cancelled"
]);

export type TaskAttemptDraft = z.infer<typeof taskAttemptDraftSchema>;
export type TaskAttempt = z.infer<typeof taskAttemptSchema>;
export type TaskCodeFingerprint = z.infer<typeof taskCodeFingerprintSchema>;
export type TaskVerificationEvidence = z.infer<typeof taskVerificationEvidenceSchema>;
export type DependencyRepairStatus = z.infer<typeof dependencyRepairStatusSchema>;
