# Phase 0 baseline

This directory freezes the behavior that must survive the Windows migration.

- `architecture.md`: current responsibilities and target boundaries.
- `contracts.md`: MCP, task-state and coordinator contracts that must remain compatible.
- `verification.md`: baseline commands, environment limitations and migration evidence.

Do not change an existing MCP tool name, input shape, idempotency rule, expected-version
guard or terminal task state without recording a versioned contract change here first.
