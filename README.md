# Agent Workbench

Windows-first multi-agent development workbench formed from `cli-session-task-mcp`
and `codex-session-coordinator`.

The product keeps three user-facing modes:

- **Dashboard**: browser UI for tasks, evidence, dependencies and human acceptance.
- **Herdr**: browser observer for agent sessions and execution events.
- **Kitty**: Windows Terminal controller for agent processes and interactive shells.

The repository is a monorepo, but the task service and coordinator remain separate
modules. During migration their SQLite stores remain separate and are accessed through
service APIs.

## Repository layout

- `packages/task-service`: migrated CLI Session Task MCP service.
- `packages/coordinator`: migrated coordinator runtime, scheduler and role integrations.
- `packages/windows-runtime`: Windows path, IPC endpoint and process lifecycle primitives.
- `packages/shared-contracts`: cross-module contracts (being introduced in phase 0).
- `apps/gateway`: unified local gateway (phase 2).
- `apps/dashboard`: unified task dashboard (phase 3).
- `apps/herdr`: browser session observer (phase 2/3).
- `apps/cli`: unified command line entry point (phase 2).

## Migration status

Phase 0 baseline documentation and the first Windows Runtime primitives are present.
The original projects are copied without flattening their module boundaries. See
`docs/baseline/` and `docs/windows-runtime-migration.md` for the contract and migration
rules.

The original package checks remain available from each workspace. The task service
still requires access to its configured private npm registry.
