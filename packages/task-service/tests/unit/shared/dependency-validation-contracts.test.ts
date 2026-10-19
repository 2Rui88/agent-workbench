import { describe, expect, it } from "vitest";
import {
  assertDependencyValidationSpecIdentity,
  dependencyValidationEvidenceSchema,
  dependencyValidationSpecSchema,
  sanitizeDependencyValidationEvidence,
  sanitizeDependencyValidationProgress,
  sanitizeDependencyValidationSpec
} from "../../../src/shared/dependency-validation-contracts.js";

const authoritative = {
  upstream_task_id: "upstream-1",
  upstream_task_version: 7,
  upstream_repository_id: "repo-upstream",
  downstream_task_id: "downstream-1",
  downstream_repository_id: "repo-downstream",
  cycle: 4,
  target_revision: "abc123",
  target_head_commit: "abc123",
  worktree_path: "/worktrees/downstream",
  changed_files: ["src/feature.ts"],
  module_paths: ["src"],
  command: "npm test",
  commands: ["npm test"],
  lease_ttl_ms: 1_800_000,
  max_attempts: 2
} as const;

describe("dependency validation contracts", () => {
  it("keeps only the bounded non-sensitive validation allow-list", () => {
    const secret = "DO_NOT_LEAK_123";
    const spec = sanitizeDependencyValidationSpec({
      upstream_task_id: "attacker-task",
      upstream_task_version: 999,
      upstream_repository_id: "attacker-repo",
      downstream_task_id: "attacker-downstream",
      cycle: 99,
      human_context: [{ secret }],
      confirmed_decisions: [`decision ${secret}`],
      blockers: [`blocker ${secret}`],
      verification: [{ command: `API_KEY=${secret}`, summary: secret }],
      scope: {
        worktree_path: authoritative.worktree_path,
        changed_files: authoritative.changed_files,
        module_paths: authoritative.module_paths,
        hidden: secret
      },
      command: "npm test",
      commands: ["npm test"],
      timeout_strategy: {
        kind: "rolling_lease",
        lease_ttl_ms: authoritative.lease_ttl_ms,
        max_attempts: authoritative.max_attempts
      },
      unexpected: secret
    }, authoritative);

    expect(JSON.stringify(spec)).not.toContain(secret);
    expect(spec).toMatchObject({
      schema_version: "dependency-validation.v1",
      upstream_task_id: authoritative.upstream_task_id,
      upstream_task_version: authoritative.upstream_task_version,
      upstream_repository_id: authoritative.upstream_repository_id,
      downstream_task_id: authoritative.downstream_task_id,
      downstream_repository_id: authoritative.downstream_repository_id,
      cycle: authoritative.cycle,
      target_revision: authoritative.target_revision,
      target_head_commit: authoritative.target_head_commit,
      scope: {
        worktree_path: authoritative.worktree_path,
        changed_files: [...authoritative.changed_files],
        module_paths: [...authoritative.module_paths]
      }
    });
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.scope)).toBe(true);
    expect(Object.isFrozen(spec.timeout_strategy)).toBe(true);
    expect(() => dependencyValidationSpecSchema.parse(spec)).not.toThrow();
  });

  it("preserves revision and worktree fields in strict Agent evidence", () => {
    const evidence = dependencyValidationEvidenceSchema.parse({
      command: "npm test",
      outcome: "passed",
      summary: "all checks passed",
      revision: "agent-revision",
      target_revision: "target-revision",
      worktree_path: "/worktrees/downstream"
    });
    // Strict schemas reject unknown fields rather than persisting them.
    expect(evidence).toEqual(expect.objectContaining({
      revision: "agent-revision",
      target_revision: "target-revision",
      worktree_path: "/worktrees/downstream"
    }));
    expect(sanitizeDependencyValidationEvidence([evidence])).toEqual([evidence]);
    expect(() => dependencyValidationEvidenceSchema.parse({
      command: "npm test",
      outcome: "passed",
      summary: "ok",
      secret: "not allowed"
    })).toThrow();
  });

  it("rejects explicit identity mismatches instead of relabeling a request", () => {
    expect(() => assertDependencyValidationSpecIdentity({
      upstream_task_id: "attacker-task",
      upstream_task_version: authoritative.upstream_task_version,
      upstream_repository_id: authoritative.upstream_repository_id,
      downstream_task_id: authoritative.downstream_task_id,
      downstream_repository_id: authoritative.downstream_repository_id,
      cycle: authoritative.cycle
    }, authoritative)).toThrow(/upstream_task_id/);
  });

  it("uses authoritative timeout fallbacks for untrusted legacy candidates", () => {
    const spec = sanitizeDependencyValidationSpec({
      timeout_strategy: {
        kind: "rolling_lease",
        lease_ttl_ms: 86_400_000,
        max_attempts: 8
      }
    }, {
      ...authoritative,
      lease_ttl_ms: 60_000,
      max_attempts: 2
    });
    expect(spec.timeout_strategy).toEqual({
      kind: "rolling_lease",
      lease_ttl_ms: 60_000,
      max_attempts: 2
    });
  });

  it("does not overwrite an immutable persisted contract with a newer task snapshot", () => {
    const persisted = sanitizeDependencyValidationSpec({
      ...authoritative,
      target_revision: "persisted-revision",
      target_head_commit: "persisted-head",
      scope: {
        worktree_path: "/persisted/worktree",
        changed_files: ["src/original.ts"],
        module_paths: ["src/original"]
      },
      timeout_strategy: {
        kind: "rolling_lease",
        lease_ttl_ms: 120_000,
        max_attempts: 2
      }
    });
    const reread = sanitizeDependencyValidationSpec(persisted, {
      preserve_persisted_fields: true,
      ...authoritative,
      upstream_task_version: 99,
      target_revision: "newer-revision",
      target_head_commit: "newer-head",
      worktree_path: "/newer/worktree",
      changed_files: ["src/newer.ts"],
      module_paths: ["src/newer"],
      lease_ttl_ms: 1_800_000
    });
    expect(reread).toMatchObject({
      upstream_task_version: authoritative.upstream_task_version,
      target_revision: "persisted-revision",
      target_head_commit: "persisted-head",
      scope: {
        worktree_path: "/persisted/worktree",
        changed_files: ["src/original.ts"],
        module_paths: ["src/original"]
      },
      timeout_strategy: { lease_ttl_ms: 120_000 }
    });

    const emptyScope = sanitizeDependencyValidationSpec({
      ...persisted,
      scope: {
        worktree_path: "/persisted/worktree",
        changed_files: [],
        module_paths: []
      }
    }, {
      preserve_persisted_fields: true,
      ...authoritative,
      changed_files: ["src/newer.ts"],
      module_paths: ["src/newer"]
    });
    expect(emptyScope.scope.changed_files).toEqual([]);
    expect(emptyScope.scope.module_paths).toEqual([]);
  });

  it("drops arbitrary progress and bounds the serialized result", () => {
    const progress = sanitizeDependencyValidationProgress({
      phase: "running",
      completed: ["unit"],
      human_context: "secret context",
      token: "secret token"
    });
    expect(progress).toEqual({ phase: "running", completed: ["unit"] });
    expect(JSON.stringify(progress)).not.toContain("secret");
    expect(Object.isFrozen(progress)).toBe(true);
  });
});
