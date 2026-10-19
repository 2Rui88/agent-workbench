# Baseline contracts

## Task MCP compatibility

The following existing tools and semantics are compatibility-critical:

`session_context`, `task_recovery_get`, `task_conflicts`, `task_attach`, `task_start`,
`task_checkpoint`, `task_submit`, and `operation_result_get`.

Every write continues to use a stable `operation_id`. Mutations continue to require
the current `expected_version`. Unknown write outcomes must be reconciled with
`operation_result_get`; they must not be retried with a new operation ID.

`task_submit` continues to end in `pending_acceptance`; only a human can make a task
terminally accepted.

## Coordinator compatibility

The coordinator continues to own role dispatch, provider turns, budgets, business
receipts and audit/advisor records. A provider completion without the matching business
receipt remains uncertain and requires reconciliation.

## Event compatibility

New Windows event streams must identify `groupId`, `agentId`, `taskId`, `role`, a
monotonic sequence number and an ISO timestamp. Browser observers must receive redacted
summaries rather than credentials or unbounded raw provider transcripts.
