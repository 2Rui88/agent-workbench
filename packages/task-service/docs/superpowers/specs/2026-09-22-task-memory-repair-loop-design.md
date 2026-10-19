# Task Memory and Dependency Repair Loop Design

**Date:** 2026-09-22
**Status:** Approved by user on 2026-09-22

## Purpose

Improve cli-session-task-mcp as the authoritative task-level execution ledger so
an Agent can resume work without losing the current objective, failed attempts,
lease ownership, validation evidence, or dependency repair obligations.

The change preserves the existing human acceptance boundary:

1. an Agent submits verified work to pending_acceptance;
2. downstream tasks validate the submitted upstream revision;
3. failed business validation creates upstream repair work;
4. repaired work starts a new validation cycle;
5. only a human can finally accept the task as done.

## Responsibility boundary

cli-session-task-mcp owns short-lived, operational facts that must be strongly
consistent:

- task state, version, current checkpoint, recent failed attempts, and next action;
- session/worktree binding and the exclusive task lease;
- submitted revision and verification evidence;
- dependency validation cycles, repair obligations, and acceptance gates;
- idempotent mutation outcomes and recovery after an unknown client result.

PowerContext remains responsible for cross-task and longer-term knowledge:

- durable architectural decisions and project conventions;
- reusable lessons across multiple tasks;
- human-readable handoff summaries when a larger context transfer is useful.

Codebase Memory remains responsible for code topology and impact discovery.
cli-session-task-mcp stores references and execution evidence, not a duplicate
code graph or a second long-term knowledge base.

## Existing invariants to preserve

- task_submit moves a verified task to pending_acceptance and creates a new
  immutable dependency validation cycle.
- dependency_validation_complete with status rejected represents a business or
  contract failure. Status error represents an execution or infrastructure
  failure and leaves the validation request retryable.
- Dependency validation never marks a business task done.
- The final pending_acceptance to done transition remains human-only and still
  checks the latest dependency validation gate.
- Existing validation run history, retry caps, sanitization, repository ownership,
  and worktree checks remain in force.
- Existing databases migrate in place; retained tasks, checkpoints, validation
  history, and fixtures are not replaced.

## 1. Task-level recovery memory

### Checkpoint extension

Extend the checkpoint contract with an optional bounded attempts array. Each entry
records:

- attempt_id;
- summary;
- outcome: failed, abandoned, or superseded;
- optional evidence_refs;
- server-assigned recorded_at.

The current checkpoint remains the materialized working state. A checkpoint write
may append new attempts but cannot rewrite or delete previously recorded attempts.
The service deduplicates by attempt_id and caps the materialized list while the
append-only task event stream retains the full audit trail.

This captures task-local failed approaches without turning the service into a
general memory system.

### Recovery read model

Add task_recovery_get, backed by a service read model and exposed to the Board task
detail API. It returns a compact continuation packet:

- task id, status, version, goal, acceptance criteria, and scopes;
- current checkpoint and recent attempts;
- active lease holder, expiry, and session/worktree identity;
- latest repository snapshot and submitted evidence fingerprint;
- pending human decisions;
- dependency validation gate and active repair request;
- last relevant task events;
- a computed next_action.

The read model is assembled from existing authoritative records. It does not copy
the packet into a new mutable handoff table.

## 2. Explicit session succession and lease fencing

Remove implicit lease takeover based only on matching owner, repository, and client
family. A different session may continue a leased task only through the existing
explicit session_context successor_session_id and successor_ctx_id path.

Add an internal monotonic generation to active_task_leases:

- a fresh acquisition starts a new generation;
- explicit succession transfers the lease and increments the generation;
- the predecessor session is marked stale in the same transaction;
- subsequent writes by the predecessor fail because its session no longer owns
  the current lease generation.

task_checkpoint renews heartbeat_at and expires_at for the current lease.
task_submit deletes the lease after the final evidence and repository snapshot are
committed. Expired leases remain reclaimable through the existing guarded start
flow; expiry alone does not authorize an implicit same-family takeover.

Compatibility tests that currently expect transport rotation to take over
implicitly will be changed to require the explicit successor fields.

## 3. Evidence bound to submitted code

Introduce a shared task verification evidence contract with:

- command, outcome, and summary;
- head_commit;
- normalized worktree_path;
- changed_files_digest;
- captured_at;
- provenance: server_verified or client_reported.

For a registered local worktree, task_checkpoint and task_submit use the server Git
probe to capture the commit, branch, changed files, and deterministic digest.
Submitted evidence must match the snapshot captured in the same transaction.
Evidence from an older revision or changed-file digest is rejected as stale.

For a remote or unprobeable worktree, the service may retain client-reported
evidence for recovery, but it is labelled client_reported. It cannot satisfy a
strict submission gate that requires server-verifiable freshness. The error
includes a recovery action instead of fabricating remote:path as verified code
identity.

The dependency validation spec continues to carry its immutable target revision,
so downstream validation stays bound to the exact upstream submission cycle.

## 4. Idempotency and unknown-result recovery

Extend operation_results with:

- tool_name;
- a canonical request_hash.

Every write computes the hash from the sanitized, semantically relevant request.
Reusing session_id plus operation_id behaves as follows:

- same tool and same hash: return the stored result;
- different tool or different hash: fail with OPERATION_ID_CONFLICT;
- no stored result: execute the mutation and store its result atomically.

Add read-only operation_result_get for recovery after a timeout or disconnected
response. It returns the stored tool name, request hash, result, and creation time.
The endpoint is restricted to the bound session; an explicit successor may inspect
predecessor results through the recorded succession chain.

Board mutations retain their existing web operation cache and are outside this MCP
operation-result table.

## 5. Rejected validation to upstream repair loop

### Repair request

Add dependency_repair_requests, keyed uniquely by validation request and cycle:

- upstream/downstream task, repository, and owner identity;
- source validation id, cycle, rejection reason, and safe evidence references;
- status: pending, claimed, resolved, superseded, or cancelled;
- claim session/worktree, rolling lease fields, and timestamps.

Completing a dependency validation as rejected atomically creates one pending
repair request and publishes task/dependency events. Completing as error creates no
repair request because infrastructure failure is retried by the downstream
validator.

### Claim and repair

Add:

- dependency_repair_list: list pending repair requests for the current upstream
  owner and repository;
- dependency_repair_receive: claim a pending repair request and resume the
  upstream task from pending_acceptance to in_progress with a normal task lease;
- ordinary task_checkpoint: record repair progress, attempts, and verification;
- ordinary task_submit: submit the repaired revision.

dependency_repair_receive is the only Agent path that may leave
pending_acceptance without a human resume. It is allowed only when a current
rejected validation has an unresolved repair request. Claiming, task transition,
lease acquisition, and worktree scope update occur in one transaction.

When the repaired task is submitted:

1. the active repair request becomes resolved;
2. older pending requests for the prior cycle become superseded;
3. existing task_submit logic creates the next validation cycle for every active
   dependent;
4. the task returns to pending_acceptance;
5. final human acceptance remains blocked until the latest cycle passes.

A second rejection in the new cycle creates a new repair request. History from
prior cycles remains immutable.

## 6. API, events, and Board

Expose repair requests and the recovery read model through MCP, authenticated Board
API, and TypeScript client contracts.

Add an SSE event dependency_repair.changed carrying only identifiers, status, and
cycle. Reasons and evidence remain behind the authenticated detail API.

The Board task drawer shows:

- a compact recovery section with current state, next action, attempts, lease, and
  evidence freshness;
- an upstream repair banner with rejection reason, source validation, cycle, claim
  state, and resubmission status;
- the existing dependency validation gate and human acceptance actions.

The Board does not perform Agent repair claims. It remains a human inspection and
acceptance surface.

## 7. Storage and migration

Use an additive migration:

- add generation to active_task_leases with a compatible default;
- add tool_name and request_hash to operation_results, preserving legacy rows as
  readable results with unknown fingerprints;
- add dependency_repair_requests and its uniqueness/lookup indexes;
- extend JSON schemas without rewriting historical checkpoint payloads.

Legacy operation rows can be read, but replaying their operation id as a new write
fails closed because no request fingerprint exists. The caller must use a fresh
operation id.

## 8. Validation strategy

### Unit and storage

- checkpoint attempts append, deduplicate, cap, and survive migration;
- recovery view computes lease, evidence, gate, repair, and next action correctly;
- implicit same-family succession is rejected;
- explicit succession increments lease generation and invalidates predecessor
  writes;
- task checkpoints renew the task lease;
- same operation id with a different request fails;
- operation-result lookup recovers a completed unknown result;
- rejected validation creates exactly one repair request;
- error validation creates none;
- repair claim is atomic and owner/repository/worktree guarded;
- repaired submission resolves the repair and creates a later validation cycle;
- human acceptance reads only the latest cycle.

### Integration

- MCP schemas and transport cover recovery and repair tools;
- restart recovery preserves operation results, repair claims, and lease fencing;
- Board API enforces project visibility for recovery and repair details;
- SSE reaches both upstream and downstream authorized viewers without leaking
  rejection evidence;
- database migration retains existing fixtures and dependency history.

### Browser

After service health checks and restart with the new build, Edge verifies:

- rejected validation appears as an upstream repair banner;
- repair progress and evidence freshness are visible;
- a new validation cycle replaces the rejected cycle after resubmission;
- acceptance stays disabled until the latest cycle passes;
- only the human acceptance action can set done.

## Files and layers expected to change

1. Shared contracts: task checkpoint, task evidence, repair request contracts.
2. Core services: lease succession, recovery read model, idempotency fingerprint,
   rejected-to-repair transaction, and repaired resubmission.
3. Storage: interfaces, SQLite migration, queries, transaction methods, export.
4. MCP: tool schemas, registration, instructions, structured responses.
5. Server: Board routes, broadcasting service, SSE event.
6. Web: API types, task drawer, dependency notification/recovery presentation.
7. Tests: unit, storage migration, MCP transport, restart/API/SSE, and Edge smoke.

No PowerContext schema, Codebase Memory graph, other repository, host Hook, Git
commit, push, merge, deployment, or production data migration is part of this
change.
