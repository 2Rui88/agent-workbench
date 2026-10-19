# Failure Recovery and Scoped Tool Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Preserve the current host lead; no new model calls or subagents in this phase.

**Goal:** Close confirmed interrupted executions as failures, preserve spent calls, and validate narrowly authorized worker tools with Mock and zero-model protocol checks.

**Architecture:** Runtime evidence gates a lead-only failure archive; one SQLite transaction updates dispatch, message, budget and obsolete approvals. New packages remain separate immutable records linked to the failed dispatch. Role launch overrides use explicit per-tool approval and exposure lists; daemon identity/lease/Scope gates remain authoritative.

**Tech Stack:** TypeScript, Node SQLite, Codex AppServer 0.160.0, MCP, Herdr, existing Edge CDP.

**Spec:** Current session decisions and docs/superpowers/specs/2026-10-04-coordinator-dashboard-design.md. User authorized planning for recovery, scoped tool authorization, and Mock checks; implementation awaits confirmation of this file's impact list.

## Global Constraints

- Current group dashboard-e2e-20261004; existing lead thread is external. Preserve lead PTY, focus, observer mapping, browser, private credentials and all prior records.
- Zero new Provider/model turns, automatic retries or upgrades. No commits, pushes, shared service or global config changes.
- CLI Task controls actual owner/worktree/version/lease. PowerContext workers use their explicit project Scope and their own Principal; host verifies role bindings.
- Failed, cancelled, interrupted, unknown, passed and pending_acceptance are distinct. Only humans accept the project.
- Preserve spent calls: failed consumes a call and releases inFlight only after verified terminal evidence; unknown continues freezing execution.
- Local per-tool config uses mcp_servers.<id>.tools.<tool>.approval_mode="approve", server default "prompt", and enabled_tools. Keep sandbox and approvalPolicy on-request. Local 0.160.0 config/read accepted these settings with zero model turns; this is parsing evidence, not a real model tool invocation.

## Impact List

| Files | Change and validation |
|---|---|
| src/durable-scheduler.ts, src/store.ts, src/budget.ts, src/approval-bridge.ts, src/migrations.ts | Add terminal failed dispatch/message/budget handling, failure reason/evidence and replacement lineage; obsolete pending approval state becomes stale. Atomic transaction, rollback, idempotence and spent-call tests. |
| src/engine.ts, src/runtime/app-server.ts, src/observer.ts | Lead-only automation_archive_failure; verify original runtime thread/turn is failed/interrupted and no live turn remains. Add optional replacesDispatchId on a separately dispatched package; no implicit replay. Normalize terminal evidence, preserve unavailable-history fence. |
| src/scheduler.ts, src/dispatch.ts | New package lineage validated against same group/role/task/repository/worktree, terminal failed predecessor and current Task/contract. Unique direct successor; original payload/hash unchanged. |
| src/runtime/tool-policy.ts (new), src/runtime/role-launch.ts, scripts/mcp-server.ts, scripts/daemon.ts | Explicit role tool exposure/approval policy and honest MCP annotations. Host enrollment remains verified; workers receive explicit Scope and cannot call resolve_scope_binding/server administration. |
| src/dashboard/contracts.ts, src/dashboard/projection.ts, web/dashboard.js | Show failed and stale separately; expose whitelisted failed/replacement refs, retain originals and total history. No raw evidence/commands/credentials returned. |
| src/terminal/herdr-controller.ts, scripts/herdr-watch.ts | Show failed/replacement metadata and retained failure result. Closed failure/stale approval does not impersonate active work; default observer retention and own-only compact guards remain. |
| tests/durable-scheduler.test.ts, tests/engine.test.ts, tests/budget.test.ts, tests/approval-bridge.test.ts, tests/role-launch.test.ts, tests/dashboard.test.ts, tests/herdr.test.ts, tests/automatic-workflow.test.ts, tests/runtime.test.ts | Test recovery/rollback, role/Scope boundaries, lost responses, replacement/acceptance gates, projection/pane state and Mock rejection/repair cycle. |
| scripts/protocol-preflight.ts, docs/verification.md | Report model-free effective config/tool catalog evidence separately from Mock and real Provider evidence. |

## Task 1: Evidence-Gated Failure Archive and Replacement

- [ ] Write failing tests: interrupted/failed turn archives; inProgress, unknown history, mismatched thread/turn, stale binding and completed-without-business-receipt remain fenced. Non-lead is rejected.
- [ ] Write failing tests: failure archive preserves original payload/hash/turn, closes processing leases and stale approvals, retains callsUsed=1, sets inFlight=0/unknown=0; fault injection rolls back all tables. Identical operation replays once; changed evidence conflicts.
- [ ] Implement `automation_archive_failure({binding,dispatchId,reason,evidence,operationId})` with reason enum interrupted|runtime_failed. Check the current Task binding/lease and its repository/worktree against the historical package, then read actual runtime through the initialized original role; do not accept a user-supplied terminal status as proof.
- [ ] Implement `DurableScheduler.archiveFailure(actor,dispatchId,reason,evidence,turnId)` as a same-database transaction across existing dispatch/message/budget/approval tables. Only needs_reconciliation with matching recorded turn may close; preserve failure evidence and processing identity.
- [ ] Add optional `replacesDispatchId` to ExecutionPackage/work schema. New lead dispatch validates same group/role/task/repository/worktree and archived predecessor; save a unique lineage edge without changing the original work_json/hash. Validate before message emission; recovery remains idempotent if response is lost.
- [ ] Submission includes only completed current dispatches and latest passed audit. Failed predecessors can be retired from the task-wide blocker only through a complete explicitly included replacement chain for the current baseline. Failure itself never satisfies a dependency; downstream packages must name the new package explicitly. Disallow forked/cyclic lineage, cross-task substitution and accepting failed IDs.
- [ ] Run focused scheduler/budget/engine tests; keep RED and GREEN evidence. Do not modify the live failed dispatch until focused Mock verification is complete and user scope confirmation is recorded.

## Task 2: Scoped Worker Tool Policy

- [ ] Add `workerToolPolicy(role)` in src/runtime/tool-policy.ts. Common coordinator tools: automation_status, automation_events, automation_operation_get, automation_contract_ack, automation_work_complete and own message send/claim/renew/complete. Audit additionally receives automation_validation_create and automation_validation_record. Exclude lead/admin/Task writes/failure recovery/browser/model launch tools from this initial policy.
- [ ] PowerContext read list (verified actual tools/list): get_scope, search_memory, search_topic_memory, get_topic_memory, list_memory_entries, get_memory_entry. Every business request uses the provided scope_id. Exclude resolve_scope_binding, Scope/binding administration and memory writes in this phase. Role Principals retain existing project grants; no service-side expansion.
- [ ] Add failing launch tests: default prompt; approve only listed tools; enabled_tools restricts exposure; inherited servers/plugins/apps stay disabled; no human/lead secret in worker environment or args; no global config mutation. Keep thread sandbox and on-request policy.
- [ ] Map truthful readonly/destructive/idempotent annotations in scripts/mcp-server.ts for the exposed coordinator tools. Annotation is documentation; daemon identity/lease/state checks remain enforcement.
- [ ] Guide worker developerInstructions to use the already verified explicit Scope rather than resolve_scope_binding. Do not pretend CLI Task session is a Principal. Keep project preflight checks and actual tool catalog verification.
- [ ] Extend zero-model protocol preflight to read only selected effective server/tool policy fields and compare to expected allowlists. No secrets/full config output; no thread turn/start. A config parse or tools/list response proves neither auto approval at execution nor a completed audit.
- [ ] Run role-launch/runtime/approval tests and zero-model config/catalog checks. Any unsupported setting fails closed; no fallback to broad approvalPolicy=never or full server approval.

## Task 3: Observable Mock Recovery and Gates

- [ ] Add failure/replacement refs to whitelisted Dashboard DTO/projection and localized failed/stale labels. Preserve snapshot limits, coherent read, retry/stale semantics and unknown actual model/token labels.
- [ ] Add tests for original failed plus active replacement rows, unchanged historical total, no credential/evidence leakage, stale approvals excluded from waitingHuman, retained observer output and focus/PTY identity.
- [ ] Exercise isolated Mock workflow: dispatch -> approval -> interrupt -> confirmed archive -> explicit new dispatch -> audit rejection -> bounded explicit repair package -> passed current audit -> pending_acceptance only. No automatic retry after failure; no agent acceptance.
- [ ] Exercise role-tool wrong-role denial and Scope isolation with fixture protocol checks. Cover state changes across SQLite, Dashboard HTTP and Herdr controller transport.
- [ ] Run npm test, npm run typecheck, npm run build. Run real HTTP/Edge UI checks only after service/CDP preflight and browser exclusive lease, on owned isolated resources; this remains zero Provider calls.
- [ ] Recover the existing real interrupted record through verified archive after local gates pass. Keep group paused and expired grant; no new model execution.
- [ ] Update verification and CLI Task checkpoint with exact evidence and remaining limits. Real audit/repair and independent worker write worktrees remain separate pending validation.

## Review Focus

- Archived failed execution must not refund a paid call or be mistaken for business completion.
- A new authorization grant must state remaining/cumulative quota explicitly; archive never silently extends the old grant.
- Runtime metadata/history disagreements or unavailable history keep the original execution fenced.
- Default prompt and tool allowlists must not inherit a broader global approve rule; effective config verification is required.
- Approval arriving after interruption, instance replacement or deadline is stale; no acceptance may revive an old turn.

## Planning Evidence

Official MCP docs: https://learn.chatgpt.com/docs/extend/mcp?surface=cli and configuration reference https://learn.chatgpt.com/docs/config-file/config-reference. Local Codex 0.160.0 config/read accepted disabled probe server default prompt, enabled_tools=[automation_status] and per-tool approval_mode=approve; modelTurns=0/configWrites=0. PowerContext audit tools/list authenticated with its existing Principal; listed read tools and metadata above. Current live state was read-only checked: old v1 cancelled, v2 needs_reconciliation, one budget unknown; Dashboard health passed.

## Handoff

Confirm the impact list before business code changes. Implement in the existing main conversation using Mock/protocol checks; no delegated/paid review in this phase. Real invocation quota is requested only after this corrected path is reviewable.
