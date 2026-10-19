# Task Memory and Dependency Repair Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make cli-session-task-mcp a durable task-level execution ledger with compact recovery, explicit session succession, code-bound verification, safe idempotency recovery, and a claimable rejected-validation repair loop while preserving human final acceptance.

**Architecture:** Extend the existing checkpoint, lease, operation-result, repository snapshot, and dependency-validation seams. Keep the current task state machine and validation-cycle authority, add one additive SQLite migration, and assemble recovery as a read model instead of a second handoff store. Rejected validation creates an upstream repair request that claims the normal task lease; error validation remains retry-only.

**Tech Stack:** TypeScript, Zod, Node.js crypto/fs/child_process, SQLite STRICT tables, MCP SDK, Express, SSE, React/Vite, Vitest, browser-harness with Microsoft Edge.

**Spec:** docs/superpowers/specs/2026-09-22-task-memory-repair-loop-design.md

## Global Constraints

- Preserve task_submit to pending_acceptance to dependency validation gate to human-only final acceptance.
- rejected means a business/code validation failure and creates repair work; error means infrastructure/execution failure and creates no repair work.
- cli-session-task-mcp owns task-level strongly consistent execution facts. PowerContext remains the cross-task and long-term memory system.
- Do not change another repository, PowerContext, Codebase Memory, or host Hook configuration.
- Use the isolated feat/task-memory-repair-loop worktree and owner jande.
- Keep existing SQLite data and fixtures through an additive migration.
- Do not commit, push, merge, deploy, run production migrations, or mark the business task done.
- Use 2-space indentation and existing project patterns.
- After each task, run its focused tests, git diff --check, and persist an MCP checkpoint instead of committing.

## Review Focus

1. A reused operation id with a changed request must fail closed instead of replaying the first result; Task 3 adds unit, storage, and MCP coverage.
2. A predecessor session racing after explicit succession must fail every lease-bearing write; Task 4 adds transaction and transport coverage.
3. Verification that passed before a worktree content change must not satisfy task_submit; Task 5 adds tracked, staged, deleted, renamed, and untracked-file cases.
4. A rejected validation retry or duplicate completion must create exactly one repair request, while error creates none; Task 6 adds idempotency and restart cases.
5. Removing/recreating a dependency edge or starting a later cycle must make older repair work unclaimable; Task 6 adds generation/cycle isolation tests.

---

### Task 1: Shared task-memory contracts and deterministic worktree fingerprints

**Files:**
- Create: src/shared/task-recovery-contracts.ts
- Create: src/repo/worktree-fingerprint.ts
- Modify: src/shared/task-contracts.ts:41-73
- Modify: src/repo/repo-probe.ts:12-138
- Test: tests/unit/shared/task-contracts.test.ts
- Test: tests/integration/repo/repo-probe.test.ts

**Interfaces:**
- Consumes: RepoProbe.inspect(RepoProbeInput)
- Produces: TaskAttemptDraft, TaskAttempt, TaskCodeFingerprint, TaskVerificationEvidence, DependencyRepairRequest, TaskRecoveryView, computeWorktreeContentDigest()

- [x] **Step 1: Write failing contract tests**

Add tests that parse a checkpoint with attempts, reject duplicate/empty attempt ids, parse code fingerprints, and keep old checkpoints compatible by defaulting attempts to an empty array.

~~~ts
expect(checkpointPayloadSchema.parse(legacyCheckpoint).attempts).toEqual([]);
expect(taskAttemptSchema.parse({
  attempt_id: "attempt-1",
  summary: "Tried direct lease transfer",
  outcome: "failed",
  evidence_refs: ["event-1"],
  recorded_at: "2026-09-22T00:00:00.000Z"
}).outcome).toBe("failed");
~~~

- [x] **Step 2: Run contract tests and verify failure**

Run: npm test -- tests/unit/shared/task-contracts.test.ts

Expected: FAIL because attempts and recovery schemas do not exist.

- [x] **Step 3: Define bounded schemas and types**

Create task-recovery-contracts.ts with separate write and stored attempt shapes so
the client never supplies the authoritative timestamp:

~~~ts
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
  provenance: z.enum(["server_verified", "client_reported"])
});

export const taskVerificationEvidenceSchema = z.object({
  command: z.string().min(1),
  outcome: z.enum(["passed", "failed", "not_run"]),
  summary: z.string().min(1),
  code_fingerprint: taskCodeFingerprintSchema.optional()
});
~~~

Update stored checkpointPayloadSchema so attempts defaults to [] and verification
uses taskVerificationEvidenceSchema. Add checkpointWritePayloadSchema for
task_checkpoint/task_switch with TaskAttemptDraft entries. task_adopt continues to
accept a full stored checkpoint. Cap attempts at 20 in the materialized checkpoint.

- [x] **Step 4: Write failing repository fingerprint tests**

Cover clean worktree stability and digest changes for unstaged edits, staged edits, deletion, rename, and untracked file content. Assert changing only file timestamps does not change the digest.

~~~ts
const before = await probe.inspect(input);
writeFileSync(join(worktree, "src/new.ts"), "export const value = 1;\n");
const after = await probe.inspect(input);
expect(after.content_digest).not.toBe(before.content_digest);
expect(after.content_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
~~~

- [x] **Step 5: Run repository tests and verify failure**

Run: npm test -- tests/integration/repo/repo-probe.test.ts

Expected: FAIL because RepoSnapshotDraft has no content_digest.

- [x] **Step 6: Implement streaming content hashing**

Implement computeWorktreeContentDigest(worktreePath, headCommit) using SHA-256 over:

1. a format/version prefix;
2. head commit;
3. streamed git diff --binary HEAD output;
4. sorted untracked paths and their file bytes or symlink targets.

Use spawn for git diff so large diffs do not rely on a fixed stdout buffer. Reject unreadable paths with RepoProbeError(REPO_PROBE_FAILED). Add content_digest to RepoSnapshotDraft and RepoProbe.inspect output.

- [x] **Step 7: Run focused tests**

Run:

~~~bash
npm test -- tests/unit/shared/task-contracts.test.ts tests/integration/repo/repo-probe.test.ts
npm run typecheck
git diff --check
~~~

Expected: all pass.

### Task 2: Additive SQLite migration and storage primitives

**Files:**
- Modify: src/storage/migrations.ts
- Modify: src/storage/progress-store.ts
- Modify: src/storage/sqlite-progress-store.ts
- Modify: src/cli/export-data.ts
- Test: tests/unit/storage/migrations.test.ts
- Test: tests/integration/storage/sqlite-progress-store.test.ts
- Test: tests/integration/cli/export-data.test.ts

**Interfaces:**
- Consumes: shared recovery/repair contracts from Task 1
- Produces: schema v13, lease generation, snapshot content digest, fingerprinted operation results, dependency repair persistence and query methods

- [x] **Step 1: Write failing migration tests**

Assert v12 databases upgrade to v13 without losing tasks, checkpoints, operation results, dependency contexts, or validation runs. Assert these additions:

~~~ts
expect(schemaVersion).toBe(13);
expect(columns("active_task_leases")).toContain("generation");
expect(columns("repo_snapshots")).toContain("content_digest");
expect(columns("operation_results")).toEqual(expect.arrayContaining([
  "tool_name", "request_hash"
]));
expect(tables).toContain("dependency_repair_requests");
~~~

Also open a retained non-empty fixture copy, migrate it, and verify original row counts and foreign-key integrity.

- [x] **Step 2: Run migration tests and verify failure**

Run: npm test -- tests/unit/storage/migrations.test.ts

Expected: FAIL at schema version 12 and missing columns/table.

- [x] **Step 3: Add migration metadata and SQL**

Append version 13 named add_task_memory_and_repair_loop. Add columns with backward-compatible defaults/nullability:

~~~sql
ALTER TABLE active_task_leases
  ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0);
ALTER TABLE repo_snapshots ADD COLUMN content_digest TEXT;
ALTER TABLE operation_results ADD COLUMN tool_name TEXT;
ALTER TABLE operation_results ADD COLUMN request_hash TEXT;

CREATE TABLE dependency_repair_requests (
  repair_id TEXT PRIMARY KEY,
  validation_id TEXT NOT NULL UNIQUE
    REFERENCES dependency_validations(validation_id) ON DELETE CASCADE,
  source_run_id TEXT NOT NULL
    REFERENCES dependency_validation_runs(run_id) ON DELETE CASCADE,
  ctx_id TEXT,
  upstream_task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  downstream_task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  cycle INTEGER NOT NULL CHECK (cycle > 0),
  status TEXT NOT NULL CHECK (
    status IN ('pending','claimed','resolved','superseded','cancelled')
  ),
  rejection_reason TEXT NOT NULL,
  claimed_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
  claimed_worktree_path TEXT,
  claimed_at TEXT,
  resolved_at TEXT,
  superseded_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
~~~

Create upstream/status/cycle and downstream/status indexes. Legacy operation rows retain null tool_name/request_hash and remain readable only.

- [x] **Step 4: Define storage records and transaction methods**

Extend ActiveTaskLease, RepoSnapshotRecord, and OperationResult. Add:

~~~ts
export interface DependencyRepairRequestRecord {
  repair_id: string;
  validation_id: string;
  source_run_id: string;
  ctx_id: string | null;
  upstream_task_id: string;
  downstream_task_id: string;
  cycle: number;
  status: "pending" | "claimed" | "resolved" | "superseded" | "cancelled";
  rejection_reason: string;
  claimed_session_id: string | null;
  claimed_worktree_path: string | null;
  claimed_at: string | null;
  resolved_at: string | null;
  superseded_at: string | null;
  created_at: string;
  updated_at: string;
}
~~~

Add transaction methods:

~~~ts
getDependencyRepairRequest(repairId: string): DependencyRepairRequestRecord | undefined;
getDependencyRepairByValidation(validationId: string): DependencyRepairRequestRecord | undefined;
listDependencyRepairsForUpstream(taskId: string): DependencyRepairRequestRecord[];
insertDependencyRepairRequest(record: DependencyRepairRequestRecord): void;
updateDependencyRepairRequest(
  record: DependencyRepairRequestRecord,
  expectedStatus: DependencyRepairRequestRecord["status"]
): void;
~~~

Add store-level owner/repository filtered list and detail reads needed by MCP and Board.

- [x] **Step 5: Implement row mapping and CRUD**

Use the existing strict optionalRow, expected-status update, JSON sanitation, and StorageError(VERSION_CONFLICT) patterns. Include generation/content_digest/tool_name/request_hash in all existing reads and writes.

- [x] **Step 6: Update data export**

Export repair requests and new columns without changing or redacting unrelated existing sections. Keep rejection evidence as references and sanitized reason; never export secrets.

- [x] **Step 7: Run focused storage tests**

Run:

~~~bash
npm test -- tests/unit/storage/migrations.test.ts tests/integration/storage/sqlite-progress-store.test.ts tests/integration/cli/export-data.test.ts
npm run typecheck
git diff --check
~~~

Expected: all pass, including retained non-empty migration coverage.

### Task 3: Request-fingerprinted idempotency and unknown-result recovery

**Files:**
- Create: src/core/operation-fingerprint.ts
- Modify: src/core/task-service.ts:430-2200
- Modify: src/mcp/tool-schemas.ts
- Modify: src/mcp/register-tools.ts
- Test: tests/unit/core/task-service.test.ts
- Test: tests/integration/mcp/mcp-tools.test.ts
- Test: tests/integration/server/restart-recovery.test.ts

**Interfaces:**
- Consumes: OperationResult fields and storage methods from Task 2
- Produces: canonicalRequestHash(), operation_result_get, OPERATION_ID_CONFLICT

- [x] **Step 1: Write canonical hashing tests**

Add tests proving object key order does not change a hash, array order does, undefined keys are omitted, and operation_id is excluded from the semantic request body.

~~~ts
expect(canonicalRequestHash({ b: 2, a: 1 }))
  .toBe(canonicalRequestHash({ a: 1, b: 2 }));
expect(canonicalRequestHash({ values: ["a", "b"] }))
  .not.toBe(canonicalRequestHash({ values: ["b", "a"] }));
~~~

- [x] **Step 2: Implement canonicalRequestHash**

Recursively sort object keys, preserve arrays, reject non-JSON values, JSON.stringify the canonical value, and return sha256 plus lowercase hex.

- [x] **Step 3: Write failing service idempotency tests**

Cover:

- same session, operation id, tool, and request returns cached result;
- same key with changed expected_version or task_id throws OPERATION_ID_CONFLICT;
- same key reused by another tool throws OPERATION_ID_CONFLICT;
- a legacy row with null fingerprint is readable but cannot be replayed as a write;
- results survive closing and reopening SQLite.

- [x] **Step 4: Replace operation wrappers**

Change the internal API to:

~~~ts
#withOperation<T>(
  sessionId: string,
  operationId: string,
  toolName: string,
  semanticInput: JsonValue,
  mutate: (tx: ProgressTransaction) => T
): T
~~~

Update every MCP write path to provide its stable tool name and an input object excluding operation_id. Validation completion hashes sanitized reason/evidence. cached-operation fast paths must validate tool/hash before returning.

- [x] **Step 5: Add operation-result lookup**

Add:

~~~ts
getOperationResult(input: {
  session_id: string;
  operation_id: string;
}): OperationResult | undefined
~~~

Look in the current session first, then follow its explicit predecessor link through successor_session_id with cycle detection and a maximum depth of 32. Never search unrelated same-owner sessions.

Register the read-only MCP tool operation_result_get and return tool_name, request_hash, result, created_at, and source_session_id.

- [x] **Step 6: Run focused idempotency tests**

Run:

~~~bash
npm test -- tests/unit/core/task-service.test.ts tests/integration/mcp/mcp-tools.test.ts tests/integration/server/restart-recovery.test.ts
npm run typecheck
git diff --check
~~~

Expected: all pass and old replay tests still pass only for byte-equivalent logical calls.

### Task 4: Explicit session succession and consistent task leases

**Files:**
- Modify: src/core/session-service.ts:96-226
- Modify: src/core/task-service.ts:1080-1430 and 2200-2350
- Modify: src/storage/progress-store.ts
- Modify: src/storage/sqlite-progress-store.ts
- Test: tests/integration/core/session-service.test.ts
- Test: tests/integration/core/task-races.test.ts
- Test: tests/integration/mcp/mcp-transport.test.ts
- Test: tests/unit/core/task-service.test.ts

**Interfaces:**
- Consumes: ActiveTaskLease.generation from Task 2
- Produces: explicit-only succession, renewed checkpoint leases, predecessor fencing

- [x] **Step 1: Change tests to reject implicit takeover**

Replace transport-rotation expectations with:

~~~ts
await expect(service.checkpointTask({
  ...checkpointInput,
  session_id: "same-family-new-session"
})).rejects.toMatchObject({ code: "TASK_LEASE_CONFLICT" });
~~~

Add a paired case where session_context supplies successor_session_id and the new session succeeds.

- [x] **Step 2: Run succession tests and verify failure**

Run:

~~~bash
npm test -- tests/integration/core/session-service.test.ts tests/integration/mcp/mcp-transport.test.ts tests/integration/core/task-races.test.ts
~~~

Expected: the implicit takeover test fails under current #isSameAgentSuccession behavior.

- [x] **Step 3: Remove same-family lease transfer**

Delete #isSameAgentSuccession and all checkpoint/submit/start branches that transfer a lease based only on client_family, owner, and repository. A lease held by another session always conflicts.

- [x] **Step 4: Increment generation during explicit succession**

Inside SessionService.sessionContextInTransaction, transfer the lease, update task session/worktree, stale the predecessor, and increment generation in the same transaction:

~~~ts
tx.putLease({
  ...lease,
  session_id: record.session_id,
  generation: lease.generation + 1,
  heartbeat_at: now,
  expires_at: addMilliseconds(now, leaseTtlMs)
});
~~~

Pass leaseTtlMs into SessionService instead of leaving the inherited expiry stale. Use task version progression as the monotonic audit boundary when acquiring a brand-new lease.

- [x] **Step 5: Renew leases on checkpoint**

After validating current session ownership and before committing the checkpoint, replace heartbeat_at and expires_at while preserving acquired_at and generation.

Add tests that checkpoint moves expiry forward, predecessor checkpoint fails after succession, and expired lease reclaim does not imply session succession.

- [x] **Step 6: Run focused lease tests**

Run:

~~~bash
npm test -- tests/integration/core/session-service.test.ts tests/integration/core/task-races.test.ts tests/integration/mcp/mcp-transport.test.ts tests/unit/core/task-service.test.ts
npm run typecheck
git diff --check
~~~

Expected: all pass.

### Task 5: Immutable attempts, code-bound verification, and compact recovery

**Files:**
- Modify: src/core/task-service.ts
- Modify: src/storage/progress-store.ts
- Modify: src/storage/sqlite-progress-store.ts
- Modify: src/mcp/tool-schemas.ts
- Modify: src/mcp/register-tools.ts
- Modify: src/server/board-routes.ts
- Test: tests/unit/core/task-service.test.ts
- Test: tests/integration/mcp/mcp-tools.test.ts
- Test: tests/integration/server/board-api.test.ts

**Interfaces:**
- Consumes: TaskCodeFingerprint, snapshot content_digest, renewed leases
- Produces: append-only attempt merge, task_recovery_get, stale-evidence submission gate

- [ ] **Step 1: Write failing attempt merge tests**

Assert:

- new attempt ids append with server time;
- replaying an attempt id is idempotent only when contents match;
- changing a prior attempt id fails INVALID_INPUT;
- omitting attempts never erases old attempts;
- materialized checkpoint keeps the latest 20 while task_attempt_recorded events retain all.

- [ ] **Step 2: Implement server-owned attempt merge**

Treat client attempt entries as proposals without trusting recorded_at. Merge against the prior checkpoint by attempt_id, stamp now for new entries, emit one task_attempt_recorded event per append, and preserve old entries.

- [ ] **Step 3: Write failing evidence-freshness tests**

Test this sequence:

1. checkpoint all-passed evidence at fingerprint A;
2. mutate a tracked or untracked file to fingerprint B;
3. task_submit with the same evidence;
4. expect CHECKPOINT_REQUIRED or INVALID_INPUT with A/B evidence and a recovery action to rerun verification and checkpoint.

Also test unchanged fingerprint submission passes, failed/not_run evidence fails, and remote/client_reported evidence cannot satisfy strict submit.

- [ ] **Step 4: Stamp checkpoint evidence and gate submit**

For a server-probed local worktree, stamp every checkpoint verification entry with:

~~~ts
{
  head_commit: snapshot.head_commit,
  worktree_path: snapshot.worktree_path,
  content_digest: snapshot.content_digest,
  captured_at: snapshot.captured_at,
  provenance: "server_verified"
}
~~~

task_submit probes again and requires the current checkpoint to contain non-empty, all-passed, server_verified evidence whose head_commit, normalized worktree_path, and content_digest all match the new probe. Keep the current verification input for compatibility, but require its command/outcome/summary set to match the checkpoint evidence.

- [ ] **Step 5: Define and assemble TaskRecoveryView**

Add a read model with:

~~~ts
export interface TaskRecoveryView {
  task: TaskDetail;
  checkpoint: CheckpointPayload | null;
  active_lease: ActiveTaskLease | null;
  lease_session: SessionRecord | null;
  latest_snapshot: RepoSnapshotRecord | null;
  evidence_state: "fresh" | "stale" | "unverifiable" | "missing";
  pending_decisions: HumanDecisionRecord[];
  dependency_validation_gate: DependencyValidationGate;
  active_repair: DependencyRepairRequestRecord | null;
  recent_events: TaskEventRecord[];
  next_action: string;
}
~~~

Compute evidence_state by probing an accessible local worktree and comparing the
live fingerprint with checkpoint evidence. Return unverifiable for remote or
inaccessible worktrees and missing when no stamped evidence exists. Compute
next_action deterministically from status, pending decisions, repair state,
evidence state, and validation gate. Do not persist the assembled view.

- [ ] **Step 6: Expose recovery reads**

Register task_recovery_get with task/session authorization. Add recovery to GET /api/tasks/:taskId after Board project visibility checks.

- [ ] **Step 7: Run focused memory/recovery tests**

Run:

~~~bash
npm test -- tests/unit/core/task-service.test.ts tests/integration/mcp/mcp-tools.test.ts tests/integration/server/board-api.test.ts
npm run typecheck
git diff --check
~~~

Expected: all pass.

### Task 6: Rejected-validation upstream repair lifecycle

**Files:**
- Modify: src/core/task-state.ts
- Modify: src/core/task-service.ts
- Modify: src/storage/progress-store.ts
- Modify: src/storage/sqlite-progress-store.ts
- Test: tests/unit/core/task-state.test.ts
- Test: tests/unit/core/task-service.test.ts
- Test: tests/integration/server/dependency-validation-recovery.test.ts
- Test: tests/integration/server/restart-recovery.test.ts

**Interfaces:**
- Consumes: dependency validation runs/cycles and normal task leases
- Produces: listDependencyRepairRequests(), receiveDependencyRepair(), rejected-to-repair transaction, repaired resubmission

- [ ] **Step 1: Write failing rejected/error creation tests**

For rejected completion, assert one pending repair row references validation_id, source run, upstream/downstream, ctx, cycle, sanitized reason, and source evidence through the run. Replay the identical completion and assert no duplicate.

For error completion, assert the validation remains pending and repair list stays empty.

- [ ] **Step 2: Run creation tests and verify failure**

Run:

~~~bash
npm test -- tests/unit/core/task-service.test.ts -t "repair"
~~~

Expected: FAIL because repair persistence is unused.

- [ ] **Step 3: Create repair atomically on rejection**

Inside completeDependencyValidation, after the rejected response and run are persisted, insert the repair request in the same transaction. Emit dependency_repair_requested on both tasks and append a dependency context event. Reference validation/run evidence rather than duplicating raw command output.

- [ ] **Step 4: Write failing claim tests**

Cover owner, repository, worktree, current dependency edge/generation, latest cycle, rejected status, pending_acceptance upstream state, no conflicting task lease, idempotent receive, and restart recovery.

Assert receive atomically:

- sets repair pending to claimed;
- moves upstream pending_acceptance to in_progress through a dedicated dependency_repair actor/path;
- acquires the normal task lease;
- updates task session/worktree scope and version;
- emits repair_claimed and task_repair_started.

- [ ] **Step 5: Implement list and receive service methods**

Add:

~~~ts
listDependencyRepairRequests(input: {
  session_id: string;
  owner: string;
  repository_id?: string;
}): Promise<DependencyRepairRequestRecord[]>;

receiveDependencyRepair(input: {
  session_id: string;
  operation_id: string;
  repair_id: string;
  owner: string;
  expected_version: number;
}): Promise<TaskMutationResult & {
  repair: DependencyRepairRequestRecord;
}>;
~~~

Do not create a second repair lease. The normal active_task_leases row is the only execution authority.

- [ ] **Step 6: Resolve and cycle on task_submit**

When submitting repaired work:

- require fresh evidence from Task 5;
- resolve the claimed repair tied to the latest rejected cycle;
- supersede any older pending repair rows;
- reuse #requestDependencyValidations to create the next cycle;
- return the task to pending_acceptance.

If an edge is removed/recreated, mark old pending/claimed repair requests superseded. If the task is cancelled, mark them cancelled. A later rejected cycle creates a new repair id.

- [ ] **Step 7: Prove human gate semantics**

Add tests that humanAccept:

- fails while latest cycle is rejected, pending, or missing;
- ignores passed results from earlier cycles;
- succeeds only after every current acceptance-gate dependent passes the newest cycle;
- remains the only path to done.

- [ ] **Step 8: Run focused repair tests**

Run:

~~~bash
npm test -- tests/unit/core/task-state.test.ts tests/unit/core/task-service.test.ts tests/integration/server/dependency-validation-recovery.test.ts tests/integration/server/restart-recovery.test.ts
npm run typecheck
git diff --check
~~~

Expected: all pass.

### Task 7: MCP, API, SSE, and Board wiring

**Files:**
- Modify: src/mcp/tool-schemas.ts
- Modify: src/mcp/register-tools.ts
- Modify: src/server/main.ts
- Modify: src/server/board-routes.ts
- Modify: src/server/sse-hub.ts
- Modify: src/web/api-client.ts
- Modify: src/web/task-board.tsx
- Modify: src/web/task-drawer.tsx
- Modify: src/web/dependency-notifications.tsx
- Test: tests/integration/mcp/mcp-tools.test.ts
- Test: tests/integration/server/board-api.test.ts
- Test: tests/unit/server/sse-hub.test.ts
- Test: tests/unit/web/api-client.test.ts
- Test: tests/unit/web/task-drawer.test.tsx
- Test: tests/unit/web/dependency-notifications.test.tsx

**Interfaces:**
- Consumes: recovery and repair service APIs from Tasks 5-6
- Produces: dependency_repair_list, dependency_repair_receive, dependency_repair.changed, authenticated Board detail presentation

- [ ] **Step 1: Add failing MCP schema/registration tests**

Assert the four new tools are registered with exact schemas:

- operation_result_get
- task_recovery_get
- dependency_repair_list
- dependency_repair_receive

Assert receive requires expected_version and owner, while list/read tools perform no mutation.

- [ ] **Step 2: Register MCP handlers and instructions**

Update server instructions to state:

- use task_recovery_get at resume/compact boundaries;
- use explicit session successor fields, never same-family takeover;
- query operation_result_get after an unknown write result;
- rejected creates upstream repair, error stays downstream retry;
- receive repair, checkpoint normally, and task_submit to create a new cycle;
- only a human accepts done.

- [ ] **Step 3: Add BroadcastingTaskService repair broadcasts**

Publish task.changed for both tasks and dependency_repair.changed with only:

~~~ts
{
  repair_id,
  validation_id,
  upstream_task_id,
  downstream_task_id,
  cycle,
  status
}
~~~

Do not place rejection reason, command output, or evidence on SSE.

- [ ] **Step 4: Add authenticated Board API fields**

GET /api/tasks/:taskId returns recovery and dependency_repairs after existing project visibility checks. Add an owner/repository filtered repair activity endpoint only if the existing dependency activity feed cannot represent upstream repair attention without N+1 requests.

- [ ] **Step 5: Add API client and EventSource support**

Define DependencyRepairItem, DependencyRepairChangedEvent, TaskRecoveryView, and add repair/recovery to TaskDetailEnvelope. Make task-board refetch the affected open drawer and attention counts on dependency_repair.changed.

- [ ] **Step 6: Render recovery and repair UX**

In task-drawer:

- show current state and computed next action first;
- show recent failed attempts with outcome/time/evidence refs;
- show lease owner/session/generation/expiry;
- show code fingerprint and evidence freshness;
- show repair banner with cycle, downstream task, reason, claim state, and source validation;
- retain existing validation gate and human acceptance controls.

In dependency-notifications, distinguish rejected-awaiting-repair, repair-in-progress, and resubmitted-new-cycle without adding a Board action that claims Agent work.

- [ ] **Step 7: Run transport/UI unit tests**

Run:

~~~bash
npm test -- tests/integration/mcp/mcp-tools.test.ts tests/integration/server/board-api.test.ts tests/unit/server/sse-hub.test.ts tests/unit/web/api-client.test.ts tests/unit/web/task-drawer.test.tsx tests/unit/web/dependency-notifications.test.tsx
npm run typecheck
git diff --check
~~~

Expected: all pass.

### Task 8: Full regression and isolated end-to-end acceptance

**Files:**
- Modify: tests/e2e/seed-e2e.ts
- Modify: tests/e2e/board-smoke.py
- Modify only if required by observed gaps: tests/integration/server/security.test.ts

**Interfaces:**
- Consumes: complete implementation
- Produces: reproducible evidence for every acceptance criterion

- [ ] **Step 1: Extend the E2E fixture**

Seed:

- a task with checkpoint attempts and fresh code fingerprint;
- explicit predecessor/successor lease history;
- one error validation with no repair;
- one rejected validation with pending repair;
- one claimed repair;
- one repaired task on a newer pending validation cycle;
- one fully passed latest cycle ready for human acceptance.

Use a copied temporary SQLite database. Do not point tests at the resident data directory.

- [ ] **Step 2: Extend Edge smoke assertions**

Verify the drawer shows recovery facts, failed attempts, lease generation, evidence freshness, repair banner/status, and latest validation cycle. Verify human acceptance is disabled for rejected/pending current cycles and enabled only for the passed latest cycle.

- [ ] **Step 3: Run complete static and automated checks**

Run:

~~~bash
npm run check
~~~

Expected: typecheck, all Vitest tests, server build, and web build pass.

- [ ] **Step 4: Start an isolated runtime**

Create a temporary data directory, seed it, choose an unused local port, start the built server with TASK_MCP_DATA_DIR and TASK_MCP_PORT, and retain the process handle.

Health precheck:

~~~bash
curl --fail --silent http://127.0.0.1:PORT/health
~~~

Expected: the existing health endpoint returns 200 before browser work begins. If
it fails, stop and fix runtime startup before running Edge.

- [ ] **Step 5: Run Microsoft Edge browser verification**

Run test:e2e:edge with BOARD_URL pointing to the isolated port. Capture the exact exit result and inspect the active browser UI if an assertion fails.

- [ ] **Step 6: Prove the repair cycle through MCP/API**

Against the isolated runtime:

1. complete downstream validation as rejected and observe one repair;
2. replay the same operation and observe the same result/no duplicate;
3. complete another validation as error and observe no repair;
4. claim repair as upstream owner;
5. checkpoint fresh passed evidence;
6. submit repaired task and observe a larger cycle number;
7. pass current downstream validations;
8. verify Board acceptance changes to enabled;
9. use the human API to accept in the isolated fixture and verify done;
10. verify no Agent MCP tool can set done.

- [ ] **Step 7: Audit objective coverage**

Map evidence to every Goal requirement:

- task memory and compact recovery;
- explicit succession and lease consistency;
- evidence bound to code content and cycle;
- idempotency and unknown-result recovery;
- rejected repair queue, error distinction, and new cycle;
- MCP/storage/API/SSE/Board;
- preserved human final gate and PowerContext boundary;
- existing data migration compatibility.

Treat any missing or indirect evidence as incomplete and fix it before submission.

- [ ] **Step 8: Persist final checkpoint and submit for acceptance**

Record commands/results, changed files, limitations, and next action in task_checkpoint. Call task_submit with the final fresh all-passed verification, moving MCP task 4adac4cb-9bdb-4fc0-bef9-e4a1648e1000 to pending_acceptance. Do not mark done.

- [ ] **Step 9: Stop isolated processes and report**

Stop only the process started in Step 4. Preserve the temporary evidence database until the user finishes review. Report worktree, branch, changed files, test evidence, runtime/browser evidence, MCP task version/status, and remaining human acceptance action.
