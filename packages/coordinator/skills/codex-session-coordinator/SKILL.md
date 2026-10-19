---
name: codex-session-coordinator
description: Coordinate one lead with frontend, backend, audit and advisor workers running on Codex or Claude using the local coordinator workflow. Use when the user, in a plain Claude session in a business repository, asks to start or continue coordinated work for that repository ("开始协同", "继续试点", "派发给前后端", "跑审计", "恢复/验收某组", "打开/关闭观察窗"), and for role dispatch, contract synchronization, per-role agent selection, advisor consultation or arbitration, scoped model execution, Herdr/Kitty observation, lead takeover, recovery, or human acceptance in this workflow.
---

# Session Coordinator (Codex and Claude)

Use one coordinator daemon as the queue and runtime authority. Worker roles reach it through their own MCP connection bound to one role and generation; the lead calls it through the command-line client. Read the operator-provided runtime config and use the actual coordinator checkout for commands; do not assume the business repository contains these scripts. Read [operations](references/operations.md) for installation, observation and approval commands.

Lead commands: `npm --prefix <coordinator> run -s client -- <runtime.json> lead <automation_command> '<json>'` (prints one JSON line). Workers see their own `coordinator_role` server only.

## Roles and agents

- Roles: `lead` (external host session), `frontend`, `backend`, `audit`, `advisor`. Daemon-managed roles each run on the agent configured in `roles.<role>.agent` (`codex` or `claude`, default `codex`). `leadAgent` names the host agent of the lead.
- Current practice: the lead is a Claude Code session; Codex is not used as lead. Typical split: Codex frontend/backend, Claude audit and advisor.
- Every dispatch, validation and advice record carries the executing agent, requested and verified model/effort, and token usage. Use these to compare agents; never substitute requested values for verified evidence.

## Recover before work

- Read actual Git `user.name`/`user.email`. Bind each repository/worktree through CLI Task `session_context` with the raw owner; recover Task version, conflicts and current lease before business writes. Matching owner does not authorize another active session's lease.
- Read the project memory file (`projectMemory.path` in runtime.json, see Project memory) before planning. There is no separate memory service, Scope or Principal: role identity is the CLI Task owner, lease and worktree only.
- `project-preflight` checks that the Task MCP answers, every registered worktree has a Git identity and the memory file is readable; it does not check Task leases. `worker-preflight` checks only frontend/backend CLI Task owner, lease and worktree. `protocol-preflight -- <dir> --claude` checks Codex and Claude runtimes with zero model turns; Claude must report a logged-in account (`accountInfo`), not an API key.
- `mode: mock` proves local protocol only. `mode: real` (alias `app_server`) needs only `taskMcpUrl` and `repositories`; a `powerContext` section is rejected at load time (PowerContext is retired). Use `leadMode: external`.

## Execute under the current authorization

1. Initialize worker threads with `automation_role_initialize` in their exact worktrees; the advisor initializes in the lead worktree. Initialization alone is not a model turn.
2. Lead publishes the exact contract revision, source digest, baseline and affected roles. Affected consumers acknowledge that revision before dependent execution.
3. Lead dispatches a bounded package with Task binding, goal, allowed paths, dependencies, verification commands, acceptance criteria and risk. For Codex workers use `npm run typecheck` and `node --import tsx --test <files>` as verification commands: the workspace-write sandbox denies socket listens, so `npx tsx`, `npm test` (`tsx --test`) and 127.0.0.1 HTTP tests fail with `listen EPERM`; the lead re-runs `npm test`, `npm run build` and listen-based tests outside the sandbox. The agent is fixed by configuration; the model must be in that agent's actual catalog.
4. Real execution requires a current human-approved `realExecution` grant: exact Task IDs, role choices, max calls/concurrency/input characters/turn duration (up to 1 hour) and expiry. Call quota is per grant (`authorizationRef`); concurrency and unknown outcomes stay group-wide. Advisor use additionally needs `choices.advisor` plus `advisor` limits; advisor calls use their own budget. No automatic escalation. During long turns the lead keeps worker and lead Task leases renewed (30-minute leases); renewals bump the Task version, so dispatch right after a renewal while host evidence is fresh.
5. Workers return `automation_work_complete` with real summary and evidence and leave changes uncommitted (worktree Git metadata is outside the worker sandbox). Runtime termination and business receipt are both required.
6. Audit reviews the uncommitted worker diff and creates a validation against the exact contract/baseline and records actual evidence. Use `rejected` for behavior defects and `error` for infrastructure failures. Repair in the owning Task/worktree, publish a new baseline and retain prior cycles.
7. After audit passes, the lead commits each worker diff on its worker branch and merges. Host submits verified native Tasks to `pending_acceptance`; only the human accepts. Checkpoints should include each executor's agent, verified model, audit outcome and advice decisions.

## Advisor

- Consultation and arbitration are requested only by the lead with `automation_advice_request` (`kind: consult|arbitration`, exact contract revision, optional dispatch/validation/path refs). Arbitration must reference the disputed validation.
- The coordinator only suggests arbitration: an `arbitration_suggested` lead-inbox message appears after a worker `dispute` message (sent to lead, referencing a rejected validation) or after N consecutive rejected cycles of one contract (default 2). Deciding to arbitrate stays with the lead.
- The advisor is read-only and answers once with `automation_advice_complete`; arbitration needs a `verdict`. A verdict never changes the audit record: overturning requires a new audit cycle or a human decision.
- Lead records the outcome once with `automation_advice_resolve` (`adopted|rejected|partial` and a note). `sameSource: true` means worker, audit and advisor ran on the same agent; treat that second opinion as less independent.

## Project memory

- Cross-agent project memory is one document inside the business repository, configured as `projectMemory: { "path": "<file>" }` in runtime.json (resolved relative to runtime.json; the file must exist). Examples: LKF uses `开发协同/项目记忆.md` in its docs worktree; LegalAudit uses `docs/项目记忆.md` in its workspace.
- Read it before starting work. Only the lead writes it: long-lived decisions, constraints, preferences and lessons (经验: situation, action, outcome, lesson), tagged with date and writer agent/model.
- Workers, audit and advisor read it only. Their role instructions name the path and say it is read-only; Claude roles get its directory as an additional read directory.
- `cli_session_task` remains the authority for task state and handoff. Never put task progress, leases or handoff notes in the memory file. Work transfer is direct dispatch.

## Attaching the lead (plain Claude session)

- The user starts `claude` normally in the business repository. When the conversation asks to start or continue coordinated work, attach first: `npm --prefix /Users/macmini/playground/codex-session-coordinator run -s lead:attach -- --cwd "$PWD"` and act on the one-line JSON status:
  - `ATTACHED` / `ALREADY_ATTACHED`: continue. Use `runtime` from the result for client commands. Attach opens no panes; `layout` in the result only tells whether Herdr is available for an observation tab.
  - `NO_GROUP`: offer `project:init` and ask the user for the repository identity (CLI Task repository id) and the project memory file path.
  - `CHOOSE_GROUP`: list `candidates` and rerun with `--group <id>` after the user picks.
  - `LEAD_CONFLICT`: another lead session is still live; ask the user to exit it, then attach again.
  - `BUSY`: another attach or the previous lead's teardown is in progress; retry once after a few seconds.
  - `NOT_CLAUDE` / `DAEMON_FAILED` / `ATTACH_FAILED`: report `message` and stop.
- The supervisor started by `lead:attach` keeps the heartbeat and worker lease renewal alive while this Claude process lives; on exit it releases the lead presence and an idle group stops. Do not start daemons, lease holders, controllers or heartbeats by hand.
- Open observation only when the user explicitly asks the main session ("打开观察窗", "打开观察标签", "看看各角色进度"); never on attach or on your own initiative. Run `npm --prefix <coordinator> run -s herdr:open -- <runtime.json>` and act on its JSON status:
  - `OPENED` / `ALREADY_OPEN`: tell the user the tab label (`流水線協同 · <groupId>`).
  - `NOT_HERDR`: the session is not inside Herdr; offer the Dashboard.
  - `NO_BUILD`: the coordinator needs `npm run build` first.
  - `BUSY`: another layout controller runs for this group; report `holder`.
  - `OPEN_FAILED`: report `message` and the log `<runtime dir>/herdr-follow.log`.
- When the user asks to close it ("关闭观察窗"), run `npm --prefix <coordinator> run -s herdr:close -- <runtime.json>` (`CLOSED`, `NOT_OPEN`, `CLOSE_TIMEOUT`).
- The lead still renews its own CLI Task lease (host evidence + `task_checkpoint`) before dispatches and archives and about every 20 minutes; host evidence lasts about 15 minutes.
- A new session takes over automatically once the previous lead presence expired (60s without heartbeat). `human-control <runtime> lead-rotate` stays available as a manual override from a real terminal.

## Recover unknown outcomes

- Check original thread/turn and operation result before retrying an unknown start/write. Preserve operationId for identical idempotent retries; changed requests are new operations.
- Claude turns that ended without a result, or that were in flight when the daemon restarted, are `unknown`; reconcile them instead of assuming completion. `PROVIDER_UNAVAILABLE` means the Claude runtime could not start (login, limits); do not switch agent or model automatically.
- Cancellation is only for queued work that has never started. Archive a failed dispatch only after its original runtime outcome is verified. Historical records are immutable evidence.
- Failed/interrupted calls consume the approved allowance; repairs consume calls too. Never refund or reset quota by recreating the group/database.
- Stale/expired approval IDs are not replayed. Use the separate human CLI from a real user terminal. Claude tool permissions arrive as `claude/canUseTool` approvals in the same queue.

## Observe and verify

- Dashboard and the observation tab are read-only projections; workers execute in background runtimes, not native TUI panes.
- The observation tab is a separate Herdr tab `流水線協同 · <groupId>` in the caller's workspace; the main session's tab is never split and keeps focus. It opens with five panes at once: left column overview (`總覽`) with advisor below; right column frontend, backend, audit stacked. The left column takes about 30% of the width and the right column about 70%, split into thirds. Each pane is renamed with its role, shows a fixed title row (role · state · agent · verified model) and repaints its whole frame in place (no flicker, no scrolling). The overview lists every role's dispatch state, executing agent and model, and latest output.
- Lifecycle: when the lead (claude) exits, the controller closes the whole tab by itself. If the user closes the tab or its overview pane by hand, layout control stops and nothing is rebuilt until the user asks again. A role pane the user closed reopens only for newer work or a new approval; a pane whose observer was replaced is returned to the user. `herdr:compact -- <runtime> [--role <role>]` collapses idle role panes. One layout controller per group (`layout-controller.lock`); its log is `<runtime dir>/herdr-follow.log` and `herdr-panes.json` records `observerTab`, `overviewPane` and `panes`.
- On lead exit the supervisor stops the group daemon and worker lease holder (`group-stop --if-idle`, via `daemon.pid`/`worker-hold.pid`) unless dispatches are in flight or approvals are pending; then they stay for the next lead.
- Kitty: attach no longer starts the Kitty controller. Kitty observation is only the manual `kitty:start --observe-only` / `kitty:follow` entries (`kitty:start` refuses to run inside Herdr); this is a known limitation.
- Actual model means verified evidence (`codex_turn_context` or `claude_transcript`). Missing effort remains unknown. Do not infer physical upstream model routing.
- Browser work reuses one approved Edge CDP connection with an exclusive lease, operates only owned targets/contexts and never launches fallback browsers or copies daily-profile credentials.
- End with exact verification results and remaining gates. Keep secrets and runtime data out of source, reports and skill resources.
