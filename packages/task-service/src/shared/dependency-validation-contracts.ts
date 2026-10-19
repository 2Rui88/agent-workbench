import { z } from "zod";

/**
 * Dependency validation data crosses three trust boundaries (the upstream
 * checkpoint, an Agent MCP client, and the Board).  Keep the contract small
 * and explicit at each boundary; in particular, never serialize a complete
 * checkpoint into a validation request.
 */

const MAX_SPEC_BYTES = 16_384;
const MAX_EVIDENCE_BYTES = 8_192;
const MAX_PROGRESS_BYTES = 8_192;

const bounded = (max: number) => z.string().trim().min(1).max(max);

export const dependencyValidationScopeSchema = z.object({
  worktree_path: bounded(1_024),
  changed_files: z.array(bounded(1_024)).max(256),
  module_paths: z.array(bounded(1_024)).max(128)
}).strict();

export const dependencyValidationTimeoutStrategySchema = z.object({
  kind: z.literal("rolling_lease"),
  lease_ttl_ms: z.number().int().positive().max(86_400_000),
  max_attempts: z.number().int().positive().max(8)
}).strict();

/** Immutable, non-sensitive instructions for a downstream runner. */
export const dependencyValidationSpecSchema = z.object({
  schema_version: z.literal("dependency-validation.v1"),
  upstream_task_id: bounded(256),
  upstream_task_version: z.number().int().nonnegative(),
  upstream_repository_id: bounded(256),
  downstream_task_id: bounded(256),
  downstream_repository_id: bounded(256),
  cycle: z.number().int().positive(),
  target_revision: bounded(256),
  target_head_commit: bounded(256),
  scope: dependencyValidationScopeSchema,
  command: bounded(1_024),
  commands: z.array(bounded(1_024)).min(1).max(64),
  timeout_strategy: dependencyValidationTimeoutStrategySchema
}).strict();

/** Evidence is intentionally separate from the generic task checkpoint
 * verification schema.  The latter strips revision/worktree fields. */
export const dependencyValidationEvidenceSchema = z.object({
  command: bounded(1_024),
  outcome: z.enum(["passed", "failed", "not_run"]),
  summary: bounded(4_096),
  revision: bounded(256).optional(),
  target_revision: bounded(256).optional(),
  worktree_path: bounded(1_024).optional()
}).strict();

export type DependencyValidationSpec = z.infer<typeof dependencyValidationSpecSchema>;
export type DependencyValidationEvidence = z.infer<typeof dependencyValidationEvidenceSchema>;

export interface DependencyValidationSpecFallback {
  upstream_task_id?: string | undefined;
  upstream_task_version?: number | undefined;
  upstream_repository_id?: string | undefined;
  downstream_task_id?: string | undefined;
  downstream_repository_id?: string | undefined;
  cycle?: number | undefined;
  target_revision?: string | undefined;
  target_head_commit?: string | undefined;
  worktree_path?: string | undefined;
  changed_files?: readonly string[] | undefined;
  module_paths?: readonly string[] | undefined;
  command?: string | undefined;
  commands?: readonly string[] | undefined;
  lease_ttl_ms?: number | undefined;
  max_attempts?: number | undefined;
  /** Internal read-path switch: keep explicitly persisted immutable fields. */
  preserve_persisted_fields?: boolean | undefined;
}

/**
 * Validate identity fields on a caller-supplied spec before persistence.
 * Missing fields are legacy-compatible and are filled by the sanitizer; an
 * explicit mismatch, however, would relabel a validation row and is rejected.
 */
export function assertDependencyValidationSpecIdentity(
  value: unknown,
  expected: DependencyValidationSpecFallback
): void {
  if (!isRecord(value)) return;
  const stringFields = [
    "upstream_task_id",
    "upstream_repository_id",
    "downstream_task_id",
    "downstream_repository_id"
  ] as const;
  for (const field of stringFields) {
    const expectedValue = expected[field];
    const actualValue = value[field];
    if (expectedValue !== undefined && actualValue !== undefined
      && actualValue !== expectedValue) {
      throw new Error(`validation_spec ${field} does not match its validation row`);
    }
  }
  const numericFields = ["cycle", "upstream_task_version"] as const;
  for (const field of numericFields) {
    const expectedValue = expected[field];
    const actualValue = value[field];
    if (expectedValue !== undefined && actualValue !== undefined
      && actualValue !== expectedValue) {
      throw new Error(`validation_spec ${field} does not match its validation row`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result.length > 0 && result.length <= max ? result : undefined;
}

function redactSensitiveText(value: string): string {
  // Validation output is untrusted command/test text.  Redact both labelled
  // credentials and common token prefixes before it crosses into storage or
  // the Board.  Unknown checkpoint fields are dropped separately below.
  const labelled = value.replace(
    /((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)([^\s,;]+)/gi,
    "$1[redacted]"
  );
  const bearer = labelled.replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, "[redacted credential]");
  const prefixed = bearer.replace(
    /\b(?:sk-[A-Za-z0-9][A-Za-z0-9._-]{8,}|gh[pousr]_[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
    "[redacted credential]"
  );
  // A bare marker such as `MCP_SECRET_MUST_NOT_ESCAPE` is itself sensitive
  // test material; do not echo it merely because it lacks an `=` delimiter.
  // Match markers embedded in identifiers as well (for example
  // `MCP_SECRET_MUST_NOT_ESCAPE`); word-boundaries do not see underscores as
  // separators, so a broad case-insensitive check is intentional here.
  return /(?:secret|password|token|api[_-]?key|authorization)/i.test(prefixed)
    ? "[redacted sensitive output]"
    : prefixed;
}

function safeText(value: unknown, max: number): string | undefined {
  const result = safeString(value, max);
  return result === undefined ? undefined : redactSensitiveText(result);
}

function safeCommand(value: unknown): string | undefined {
  const command = safeString(value, 1_024);
  if (command === undefined) return undefined;
  // Commands are execution hints, not a channel for credentials.  Keep the
  // contract useful while redacting common inline secret forms.
  const redacted = redactSensitiveText(command);
  return redacted === "[redacted sensitive output]"
    || redacted.includes("[redacted credential]")
    || redacted.includes("[redacted]")
    ? "[redacted command]"
    : redacted;
}

function safePositiveInt(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max
    ? value
    : fallback;
}

function safeNonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
}

function safeStringArray(
  value: unknown,
  maxItems: number,
  maxItemLength: number,
  sanitize = false
): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => sanitize ? safeText(item, maxItemLength) : safeString(item, maxItemLength))
    .filter((item): item is string => item !== undefined)
    .slice(0, maxItems);
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (typeof child === "object" && child !== null && !Object.isFrozen(child)) {
      freezeDeep(child);
    }
  }
  return value;
}

function withinLimit(value: unknown, limit: number): boolean {
  try {
    return JSON.stringify(value).length <= limit;
  } catch {
    return false;
  }
}

/**
 * Convert legacy/database values to the public contract.  Only fields named
 * below are copied; checkpoint decisions, blockers, human_context,
 * verification and every other arbitrary key are deliberately ignored.
 */
export function sanitizeDependencyValidationSpec(
  value: unknown,
  fallback: DependencyValidationSpecFallback = {}
): DependencyValidationSpec {
  const source = isRecord(value) ? value : {};
  // Fallback values are authoritative when supplied by the row/task
  // relationship.  A legacy JSON blob must not be able to relabel a request
  // as belonging to another task, repository, cycle, or revision.
  const upstreamTaskId = safeString(fallback.upstream_task_id, 256)
    ?? safeString(source.upstream_task_id, 256)
    ?? "unknown-upstream";
  const upstreamRepositoryId = safeString(fallback.upstream_repository_id, 256)
    ?? safeString(source.upstream_repository_id, 256)
    ?? "unknown-repository";
  const downstreamTaskId = safeString(fallback.downstream_task_id, 256)
    ?? safeString(source.downstream_task_id, 256)
    ?? "unknown-downstream";
  const downstreamRepositoryId = safeString(fallback.downstream_repository_id, 256)
    ?? safeString(source.downstream_repository_id, 256)
    ?? "unknown-repository";
  const cycle = safePositiveInt(fallback.cycle, safePositiveInt(source.cycle, 1, 2_147_483_647), 2_147_483_647);
  // Relationship identity (task/repository/cycle) is authoritative from the
  // row.  On storage/API reads, preserve explicit immutable fields and only
  // use task/snapshot fallbacks for legacy rows that omitted them.  Callers
  // sanitizing an untrusted candidate without this switch get authoritative
  // fallback values for all identity-adjacent fields as well.
  const preservePersisted = fallback.preserve_persisted_fields === true;
  const targetRevision = (preservePersisted
    ? safeText(source.target_revision, 256)
      ?? safeText(source.target_head_commit, 256)
      ?? safeText(fallback.target_revision, 256)
      ?? safeText(fallback.target_head_commit, 256)
    : safeText(fallback.target_revision, 256)
      ?? safeText(fallback.target_head_commit, 256)
      ?? safeText(source.target_revision, 256)
      ?? safeText(source.target_head_commit, 256))
    ?? "unknown-revision";
  const targetHeadCommit = (preservePersisted
    ? safeText(source.target_head_commit, 256)
      ?? safeText(source.target_revision, 256)
      ?? safeText(fallback.target_head_commit, 256)
      ?? safeText(fallback.target_revision, 256)
    : safeText(fallback.target_head_commit, 256)
      ?? safeText(fallback.target_revision, 256)
      ?? safeText(source.target_head_commit, 256)
      ?? safeText(source.target_revision, 256))
    ?? targetRevision;
  const sourceWorktreePath = safeText(
    isRecord(source.scope) ? source.scope.worktree_path : undefined,
    1_024
  ) ?? safeText(source.worktree_path, 1_024);
  const sourceScope = isRecord(source.scope) ? source.scope : undefined;
  const sourceHasChangedFiles = sourceScope !== undefined
    && Array.isArray(sourceScope.changed_files);
  const sourceHasModulePaths = sourceScope !== undefined
    && Array.isArray(sourceScope.module_paths);
  const worktreePath = (preservePersisted ? sourceWorktreePath : undefined)
    ?? safeText(fallback.worktree_path, 1_024)
    ?? sourceWorktreePath
    ?? "unknown-worktree";
  const fallbackChangedFiles = safeStringArray(fallback.changed_files, 256, 1_024, true);
  const sourceChangedFiles = safeStringArray(
      isRecord(source.scope) ? source.scope.changed_files : undefined,
      256,
      1_024,
      true
    );
  const changedFiles = preservePersisted
    ? (sourceHasChangedFiles ? sourceChangedFiles : fallbackChangedFiles)
    : fallback.changed_files !== undefined
      ? (fallbackChangedFiles.length > 0 ? fallbackChangedFiles : sourceChangedFiles)
      : sourceChangedFiles;
  const fallbackModulePaths = safeStringArray(fallback.module_paths, 128, 1_024, true);
  const sourceModulePaths = safeStringArray(
      isRecord(source.scope) ? source.scope.module_paths : undefined,
      128,
      1_024,
      true
    );
  const modulePaths = preservePersisted
    ? (sourceHasModulePaths ? sourceModulePaths : fallbackModulePaths)
    : fallback.module_paths !== undefined
      ? (fallbackModulePaths.length > 0 ? fallbackModulePaths : sourceModulePaths)
      : sourceModulePaths;
  const sourceCommand = safeCommand(source.command)
    ?? safeCommand(source.commands instanceof Array ? source.commands[0] : undefined);
  const fallbackCommand = safeCommand(fallback.command)
    ?? safeCommand(fallback.commands?.[0]);
  const command = (preservePersisted ? sourceCommand ?? fallbackCommand : fallbackCommand ?? sourceCommand)
    ?? "not specified";
  const commands = safeStringArray(source.commands, 64, 1_024).map((entry) => safeCommand(entry) ?? "[redacted command]");
  const fallbackCommands = safeStringArray(fallback.commands, 64, 1_024).map((entry) => safeCommand(entry) ?? "[redacted command]");
  const effectiveCommands = preservePersisted
    ? (commands.length > 0
      ? commands
      : fallback.commands !== undefined && fallbackCommands.length > 0
        ? fallbackCommands
        : [command])
    : (fallback.commands !== undefined && fallbackCommands.length > 0
      ? fallbackCommands
      : commands.length > 0 ? commands : [command]);
  const candidate: DependencyValidationSpec = {
    schema_version: "dependency-validation.v1",
    upstream_task_id: upstreamTaskId,
    upstream_task_version: preservePersisted
      && typeof source.upstream_task_version === "number"
      && Number.isInteger(source.upstream_task_version)
      && source.upstream_task_version >= 0
      ? source.upstream_task_version
      : safeNonNegativeInt(fallback.upstream_task_version,
        safeNonNegativeInt(source.upstream_task_version, 0)),
    upstream_repository_id: upstreamRepositoryId,
    downstream_task_id: downstreamTaskId,
    downstream_repository_id: downstreamRepositoryId,
    cycle,
    target_revision: targetRevision,
    target_head_commit: targetHeadCommit,
    scope: {
      worktree_path: worktreePath,
      changed_files: preservePersisted && sourceHasChangedFiles
        ? changedFiles
        : changedFiles.length > 0 ? changedFiles : fallbackChangedFiles,
      module_paths: preservePersisted && sourceHasModulePaths
        ? modulePaths
        : modulePaths.length > 0 ? modulePaths : fallbackModulePaths
    },
    command,
    commands: effectiveCommands,
    timeout_strategy: {
      kind: "rolling_lease",
      lease_ttl_ms: preservePersisted
        ? safePositiveInt(
          isRecord(source.timeout_strategy)
            ? source.timeout_strategy.lease_ttl_ms
            : undefined,
          safePositiveInt(fallback.lease_ttl_ms, 1_800_000, 86_400_000),
          86_400_000
        )
        : fallback.lease_ttl_ms !== undefined
          ? safePositiveInt(fallback.lease_ttl_ms, 1_800_000, 86_400_000)
          : safePositiveInt(
            isRecord(source.timeout_strategy)
              ? source.timeout_strategy.lease_ttl_ms
              : undefined,
            1_800_000,
            86_400_000
          ),
      max_attempts: preservePersisted
        ? safePositiveInt(
          isRecord(source.timeout_strategy)
            ? source.timeout_strategy.max_attempts
            : undefined,
          safePositiveInt(fallback.max_attempts, 2, 8),
          8
        )
        : fallback.max_attempts !== undefined
          ? safePositiveInt(fallback.max_attempts, 2, 8)
          : safePositiveInt(
            isRecord(source.timeout_strategy)
              ? source.timeout_strategy.max_attempts
              : undefined,
            2,
            8
          )
    }
  };
  const parsed = dependencyValidationSpecSchema.parse(candidate);
  if (!withinLimit(parsed, MAX_SPEC_BYTES)) {
    // Keep the fallback bounded even when a caller supplies huge arrays.
    return freezeDeep(dependencyValidationSpecSchema.parse({
      ...parsed,
      scope: { ...parsed.scope, changed_files: [], module_paths: [] },
      command: "not specified",
      commands: ["not specified"]
    }));
  }
  return freezeDeep(parsed);
}

/** Keep progress useful to the Board while dropping arbitrary/secret keys. */
export function sanitizeDependencyValidationProgress(
  value: unknown
): Record<string, string | number | boolean | string[]> {
  const source = isRecord(value) ? value : {};
  const result: Record<string, string | number | boolean | string[]> = {};
  for (const key of [
    "stage", "step", "phase", "message", "current", "completed", "completed_checks",
    "completed_items", "total", "percent", "status"
  ]) {
    const item = source[key];
    if (typeof item === "string" && item.length <= 1_024) {
      result[key] = redactSensitiveText(item.trim());
    }
    else if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
    else if (typeof item === "boolean") result[key] = item;
    else if (Array.isArray(item)) {
      const values = item
        .map((entry) => safeText(entry, 1_024))
        .filter((entry): entry is string => entry !== undefined)
        .slice(0, 256);
      if (values.length > 0) result[key] = values;
    }
  }
  if (!withinLimit(result, MAX_PROGRESS_BYTES)) return {};
  return freezeDeep(result);
}

/** Sanitize human/runner reason text before it is exposed by Board history. */
export function sanitizeDependencyValidationText(
  value: unknown,
  max = 4_096
): string | undefined {
  return safeText(value, max);
}

/** Sanitize persisted/seeded evidence before it reaches storage or Board. */
export function sanitizeDependencyValidationEvidence(value: unknown): DependencyValidationEvidence[] {
  if (!Array.isArray(value)) return [];
  const result: DependencyValidationEvidence[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const command = safeCommand(candidate.command);
    const summary = safeText(candidate.summary, 4_096);
    const outcome = candidate.outcome;
    if (command === undefined || summary === undefined
      || (outcome !== "passed" && outcome !== "failed" && outcome !== "not_run")) {
      continue;
    }
    const evidence: DependencyValidationEvidence = {
      command,
      outcome,
      summary,
      ...(safeText(candidate.revision, 256) === undefined
        ? {}
        : { revision: safeText(candidate.revision, 256)! }),
      ...(safeText(candidate.target_revision, 256) === undefined
        ? {}
        : { target_revision: safeText(candidate.target_revision, 256)! }),
      ...(safeText(candidate.worktree_path, 1_024) === undefined
        ? {}
        : { worktree_path: safeText(candidate.worktree_path, 1_024)! })
    };
    result.push(evidence);
    if (result.length >= 256) break;
  }
  if (!withinLimit(result, MAX_EVIDENCE_BYTES)) {
    const boundedResult: DependencyValidationEvidence[] = [];
    for (const entry of result) {
      const boundedEntry: DependencyValidationEvidence = {
        command: entry.command.slice(0, 256),
        outcome: entry.outcome,
        summary: entry.summary.slice(0, 512),
        ...(entry.revision === undefined ? {} : { revision: entry.revision.slice(0, 128) }),
        ...(entry.target_revision === undefined ? {} : { target_revision: entry.target_revision.slice(0, 128) }),
        ...(entry.worktree_path === undefined ? {} : { worktree_path: entry.worktree_path.slice(0, 256) })
      };
      if (!withinLimit([...boundedResult, boundedEntry], MAX_EVIDENCE_BYTES)) break;
      boundedResult.push(boundedEntry);
    }
    return boundedResult.map((entry) => freezeDeep(entry));
  }
  return result.map((entry) => freezeDeep(entry));
}
