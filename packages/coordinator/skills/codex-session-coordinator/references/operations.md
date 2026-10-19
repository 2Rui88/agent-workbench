# Operator commands

Run commands from the actual coordinator checkout. Full instructions are in that checkout's `README.md`; discover its path from the operator/runtime setup, not the global Skill directory. Configuration paths resolve relative to runtime.json; its private socket directory must be owner-only (0700), credentials owner-only (0600).

## New project

- Attach the current Claude session as lead: `npm run -s lead:attach -- --cwd <repo> [--group <id>]` (one JSON line: ATTACHED, ALREADY_ATTACHED, NO_GROUP, CHOOSE_GROUP, LEAD_CONFLICT, BUSY, NOT_CLAUDE, DAEMON_FAILED, ATTACH_FAILED). Attach opens no panes; `layout` in the result only tells whether Herdr is available. The supervisor logs to `<runtime dir>/lead-supervisor.log`.
- `npm run project:init -- --group <id> --repo <lead worktree> --repo-id <id> --frontend <wt> --backend <wt> [--memory <project memory file>] [--env-from <existing daemon.env>] [--create-worktrees --base <branch>]` creates `.state/<group>` (0700) with runtime.json, daemon.env (only `COORDINATOR_*` lines copied from `--env-from`) and helper scripts (start-daemon, human-init, human-approvals, lead-rotate, worker-hold, renew-workers). `--memory` writes `projectMemory.path`. Worker Task content comes from `workerTaskSpecs` in runtime.json. Full steps: `docs/new-project-herdr.md` in the coordinator checkout.
- Project memory is a document in the business repository (`projectMemory: { "path": "<file>" }`, resolved relative to runtime.json, must exist). The lead writes it; workers, audit and advisor read it. A `powerContext` section in runtime.json is rejected (PowerContext is retired).

## Initial installation

- `npm ci`, `npm run typecheck`, `npm run build`, `npm test`.
- Create a new private runtime directory and config; use the README Mock quickstart before real execution.
- Once only: `COORDINATOR_ROLE=lead npm run group-init -- /path/runtime.json` (creates lead, frontend, backend, audit and advisor credentials). Existing four-role groups add the advisor with `COORDINATOR_ROLE=lead npm run group-add-role -- /path/runtime.json advisor`.
- User-owned interactive terminal: `npm run human-control -- /path/runtime.json init`. Existing credentials/group must be reused on resume.
- Start `npm run daemon -- /path/runtime.json`. Build first for real runtimes and observers. One daemon owns a group/socket.
- Zero-model checks: `npm run protocol-preflight -- "$PWD" --claude`.
- Identity checks: `npm run project-preflight -- /path/runtime.json` (Task MCP reachable, every registered worktree's Git identity, memory file readable) and `npm run worker-preflight -- /path/runtime.json /path/worker-tasks.json` (frontend/backend CLI Task owner, lease and worktree only).

## Worker sandbox test commands

- Codex workers run in `workspace-write`, which denies socket listens. `npx tsx --test`, `npm test` (`tsx --test tests/*.test.ts`) and tests that listen on 127.0.0.1 fail with `listen EPERM`.
- Dispatch verification for Codex workers: `npm run typecheck` and `node --import tsx --test <specific test files>`. The lead re-runs `npm test`, `npm run build` and listen-based tests outside the sandbox before audit.
- Enabling sandbox `networkAccess` for workers would also open outbound network; it is a separate user decision.

## Lead connections

- Claude Code needs `cli_session_task` registered once at user level: `claude mcp add --scope user --transport http cli_session_task <task-mcp-url>`.
- The lead is a plain `claude` session attached by `lead:attach`; it calls the coordinator through `npm run client`. The lead supervisor (`scripts/lead-supervisor.ts`) owns heartbeat, worker renewal requests and exit teardown; it starts no layout controller.

## Control and observation

- Schema: `npm run client -- /path/runtime.json lead schema`.
- Status: `npm run client -- /path/runtime.json lead automation_status '{}'` (includes `budget` and `advisorBudget`).
- Pause: `npm run client -- /path/runtime.json lead automation_pause '{"paused":true}'`. Pause stops future scheduling, not active turns or native Task leases.
- Dashboard: `npm run dashboard -- --database /path/state.sqlite --group GROUP_ID --port 25426 --web-root web`. Probe `/health` and `/api/snapshot` before UI checks. If the port is occupied, preserve the occupant.

| Environment | Entry |
| --- | --- |
| Kitty outside, Herdr inside | start `claude` in a Herdr pane; the skill runs `lead:attach`; on the user's explicit request it runs `npm run -s herdr:open -- /path/runtime.json` |
| Kitty only | start `claude` in Kitty; observation only through the manual `npm run kitty:start -- /path/runtime.json --observe-only` instance (attach does not start the Kitty controller) |
| Neither | Dashboard plus a normal terminal |

- Open the observation tab: `npm run -s herdr:open -- /path/runtime.json` (one JSON line: OPENED, ALREADY_OPEN, NOT_HERDR, NO_BUILD, BUSY, OPEN_FAILED). It creates the Herdr tab `流水線協同 · <groupId>` in the caller's workspace (the main session's tab is never split) with five panes: overview (`總覽`) and advisor on the left, frontend, backend, audit on the right. Only on the user's explicit request.
- Close it: `npm run -s herdr:close -- /path/runtime.json` (CLOSED, NOT_OPEN, CLOSE_TIMEOUT). When the lead exits, the controller closes the whole tab itself. If the user closes the tab or its overview pane, layout control stops and nothing is rebuilt.
- Collapse idle role panes: `npm run herdr:compact -- /path/runtime.json [--role advisor]` or `npm run kitty:compact -- /path/runtime.json --compact`. A role pane the user closed reopens only for newer work or a new approval; panes whose observer was replaced are returned to the user.
- Controller log: `<runtime dir>/herdr-follow.log`; mapping: `herdr-panes.json` (`observerTab`, `overviewPane`, `panes`).
- Kitty is a known limitation: attach no longer starts the Kitty controller; it stays available only through `kitty:start --observe-only` / `kitty:follow`.
- Stop the group daemon and worker lease holder: `npm run group:stop -- /path/runtime.json [--if-idle]`. The lead supervisor runs it with `--if-idle` on exit, so idle groups shut down with the lead and busy groups wait for the next lead.
- Do not start a second layout controller; one lock (`layout-controller.lock`) covers Herdr and Kitty. Inspect a stale lock's recorded process before removing it.

## Human controls

- List fresh requests: `npm run human-control -- /path/runtime.json approvals`.
- User responds to the current exact ID: `npm run human-control -- /path/runtime.json respond APPROVAL_ID`.
- User takeover/release: `npm run human-control -- /path/runtime.json takeover audit` or `release audit`; record actual thread state and reason.
- Lead rotation after pause and old-lead expiry: `npm run human-control -- /path/runtime.json lead-rotate`.
- Do not simulate a human TTY, approve for the user, replay expired requests or pass human capability to workers.

## Resume and finish

Preserve the original database, role credentials and runtime config. Reconcile Task lease/session/generation, in-flight execution and authorization before restarting the daemon. Configuration is loaded on startup, not hot-reloaded. Use new validation cycles for changed source. Native Task writes belong to the host lead with fresh host evidence. Submit `pending_acceptance`, never `done`; only the user completes final acceptance.
