# Baseline architecture

## Current responsibilities

`packages/task-service` is the authority for repository/session binding, task state,
leases, worktree scopes, dependencies, checkpoints, verification evidence and human
acceptance. Its MCP endpoint is `/mcp`; its Board and REST endpoints are read/write
surfaces subject to the existing owner and pairing rules.

`packages/coordinator` is the authority for role scheduling, provider execution,
budgets, dispatch receipts, audit/advisor workflow and runtime observation. It calls
the task service through the Streamable HTTP MCP client and must not write the task
database directly.

Dashboard, Herdr and Kitty are separate user-facing modes:

1. Dashboard is a browser task and acceptance surface.
2. Herdr is a browser session observer.
3. Kitty is a terminal/process layout controller.

## Target Windows boundaries

The Windows Gateway will aggregate APIs and event streams, but task facts remain owned
by the task service and execution facts remain owned by the coordinator. The two SQLite
stores stay independent until a later migration proves a shared store is safe.

The Gateway may request a coordinator action, but it must not bypass coordinator gates
or mutate Task Service SQLite directly. The Dashboard may request human acceptance,
but an Agent can only submit `pending_acceptance`.
