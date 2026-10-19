# Skill-Driven Lead Attach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A plain `claude` session in a business repo joins the coordinator workflow from inside the conversation (via the skill running `lead:attach`), with a background supervisor that keeps heartbeat, worker lease renewal and observer panes alive for exactly as long as that Claude process lives.

**Architecture:** Pure decision logic lives in `src/lead-attach.ts` (group resolution, environment check, attach state). `scripts/lead-attach.ts` performs the side effects once (find group, start daemon/worker-hold if needed, first heartbeat as the takeover check, spawn the supervisor detached). `scripts/lead-supervisor.ts` runs detached, bound to `CLAUDE_PID`: heartbeats, writes worker renew requests, runs the existing Herdr/Kitty layout controller, and on Claude exit lets the controller close its panes and runs `group-stop --if-idle`. `src/external-lead.ts` lets a new session take over once the old presence has expired.

**Tech Stack:** Node 24 + TypeScript (ESM), `tsx`, `node:test`, `node:sqlite`, zod; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-skill-driven-lead-attach-design.md`

## Global Constraints

- Node `>=24`; ESM; run tests with `node --import tsx --test <files>`; full suite `npm test`; `npm run typecheck`; `npm run build`.
- No new npm dependencies.
- File names kebab-case; match the surrounding dense code style of each file; comments only for non-obvious intent.
- User-facing messages in Chinese; human-facing times in Asia/Taipei (UTC+8); stored data and logs stay UTC ISO.
- Session identity comes only from `CLAUDE_CODE_SESSION_ID`; process binding only from `CLAUDE_PID`.
- Never signal a process unless its recorded pid is alive and its command line contains the group runtime path (reuse `stopRecorded` / `runningPid` from `src/runtime-processes.ts`).
- Takeover rule: a different session may replace the registered lead only when the old presence has expired (`expires_at <= now`); otherwise `LEAD_CONFLICT`.
- Old launchers (`new-lead.sh`, `resume-lead.sh`, `herdr-resume.sh`, `kitty-lead.sh` lead mode) stay working until Task 6 (real verification) passes; Task 7 retires them.

## Review Focus

1. Claude restarted with `claude --resume <same id>` gets a new `CLAUDE_PID`; the old supervisor (bound to the dead PID) must be treated as stale and replaced, not reported as `ALREADY_ATTACHED`. → test in Task 2 (`attachState`) and Task 4.
2. `claude` started in a subdirectory or through a symlinked path of the repo must still find the group (compare real paths of git roots). → test in Task 2 (`resolveGroup`).
3. A daemon started before this change (no `daemon.pid`) but already serving the socket must be detected as running, not double-started. → test in Task 4 (`daemonReachable` path).
4. The supervisor must survive the `lead:attach` process (and the Claude Bash tool command) exiting: spawned detached, unref'd, output to a log file. → asserted in Task 4 end-to-end test.
5. Two groups registered for the same repo with one daemon running: the running one is chosen without asking. → test in Task 2.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/external-lead.ts` (modify) | Takeover once the old presence expired |
| `src/lead-attach.ts` (create) | Pure: `resolveGroup`, `attachContext`, `attachState`, types |
| `scripts/lead-supervisor.ts` (create) | Detached supervisor bound to `CLAUDE_PID` |
| `scripts/lead-attach.ts` (create) | One-shot attach with side effects; one JSON line on stdout |
| `package.json` (modify) | `lead:attach` script |
| `tests/lead-switch.test.ts` (modify) | Takeover tests |
| `tests/lead-attach.test.ts` (create) | Pure logic tests + attach end-to-end test |
| `tests/lead-supervisor.test.ts` (create) | Supervisor script test |
| `skills/codex-session-coordinator/SKILL.md`, `references/operations.md`, `docs/new-project-herdr.md` (modify) | Intent trigger, attach flow, Handoff rule, lead Task renewal reminder |

---

### Task 1: Expired lead presence can be taken over without rotation

**Files:**
- Modify: `src/external-lead.ts:22`
- Test: `tests/lead-switch.test.ts`

**Interfaces:**
- Consumes: `ExternalLead.heartbeat(actor, sessionRef, cwd, agent)` (existing)
- Produces: same signature; behaviour change only. `CoordinatorEngine.leadSuccessions()` records the takeover with the unchanged generation.

- [ ] **Step 1: Write the failing test** — append to `tests/lead-switch.test.ts`:

```ts
test('a new session takes over once the previous lead presence has expired, without rotation', async () => {
  const f = await engineFixture(undefined, { leadMode: 'external' });
  try {
    await f.engine.execute(f.lead, 'automation_lead_heartbeat', { sessionRef: 'claude-old', cwd: f.dir, agent: 'claude' });
    await assert.rejects(f.engine.execute(f.lead, 'automation_lead_heartbeat', { sessionRef: 'claude-new', cwd: f.dir, agent: 'claude' }), { code: 'LEAD_CONFLICT' });
    f.engine.expireLeadPresenceForTest();
    await f.engine.execute(f.lead, 'automation_lead_heartbeat', { sessionRef: 'claude-new', cwd: f.dir, agent: 'claude' });
    const [succession] = f.engine.leadSuccessions();
    assert.deepEqual({ from: succession!.fromSession, to: succession!.toSession, generation: succession!.generation }, { from: 'claude-old', to: 'claude-new', generation: 1 });
    await f.engine.execute(f.lead, 'automation_lead_heartbeat', { sessionRef: 'claude-new', cwd: f.dir, agent: 'claude' });
    assert.equal(f.engine.leadSuccessions().length, 1, 'renewing the same session records no further succession');
  } finally { await f.cleanup(); }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --import tsx --test --test-name-pattern 'takes over once' tests/lead-switch.test.ts`
Expected: FAIL — the third heartbeat rejects with `LEAD_CONFLICT`.

- [ ] **Step 3: Implement** — in `src/external-lead.ts` replace the takeover condition and its comment:

```ts
      // A different lead may take over once the previous presence has expired; human rotation stays available as an override.
      if (existing.expires_at > Date.now()) throw new CoordinatorError('LEAD_CONFLICT', 'Another lead session is registered for this group.', 'Wait for the previous lead to exit (presence expires after 60s) or stop it, then attach again.');
```

- [ ] **Step 4: Run both lead-switch tests**

Run: `node --import tsx --test tests/lead-switch.test.ts`
Expected: PASS (3 tests; the existing rotation test still passes because rotation implies expiry).

- [ ] **Step 5: Commit**

```bash
git add src/external-lead.ts tests/lead-switch.test.ts
git commit -m "feat(lead): a new session takes over an expired lead presence"
```

---

### Task 2: Pure attach logic

**Files:**
- Create: `src/lead-attach.ts`
- Test: `tests/lead-attach.test.ts`

**Interfaces:**
- Produces:
  - `type Layout = 'herdr' | 'kitty' | 'none'`
  - `interface GroupCandidate { runtimePath: string; groupId: string; leadWorktree: string; daemonRunning: boolean }`
  - `resolveGroup(candidates: GroupCandidate[], gitRoot: string): { kind: 'single'; candidate: GroupCandidate } | { kind: 'choose'; candidates: GroupCandidate[] } | { kind: 'none' }` — `leadWorktree` and `gitRoot` are compared as given (callers pass real paths).
  - `attachContext(env: NodeJS.ProcessEnv): { ok: true; sessionRef: string; claudePid: number; layout: Layout } | { ok: false; reason: string }`
  - `interface SupervisorRecord { pid: number; sessionRef: string; claudePid: number }`
  - `attachState(record: SupervisorRecord | undefined, now: { sessionRef: string; claudePid: number }, alive: (pid: number) => boolean): 'attach' | 'already' | 'replace' | 'conflict'`

- [ ] **Step 1: Write the failing tests** — create `tests/lead-attach.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { attachContext, attachState, resolveGroup, type GroupCandidate } from '../src/lead-attach.js';

const group = (groupId: string, leadWorktree: string, daemonRunning = false): GroupCandidate => ({ runtimePath: `/c/.state/${groupId}/runtime.json`, groupId, leadWorktree, daemonRunning });

test('resolveGroup picks the only group whose lead worktree is the git root', () => {
  assert.deepEqual(resolveGroup([group('a', '/repo'), group('b', '/other')], '/repo'), { kind: 'single', candidate: group('a', '/repo') });
});

test('resolveGroup prefers the group whose daemon is running, otherwise asks', () => {
  assert.deepEqual(resolveGroup([group('a', '/repo'), group('b', '/repo', true)], '/repo'), { kind: 'single', candidate: group('b', '/repo', true) });
  assert.equal(resolveGroup([group('a', '/repo'), group('b', '/repo')], '/repo').kind, 'choose');
  assert.equal(resolveGroup([group('a', '/repo', true), group('b', '/repo', true)], '/repo').kind, 'choose');
});

test('resolveGroup reports none when no group belongs to the repo', () => {
  assert.deepEqual(resolveGroup([group('a', '/other')], '/repo'), { kind: 'none' });
});

test('attachContext needs the Claude session and process and detects the layout backend', () => {
  assert.equal(attachContext({}).ok, false);
  const base = { CLAUDE_CODE_SESSION_ID: 's-1', CLAUDE_PID: '4242' };
  assert.deepEqual(attachContext(base), { ok: true, sessionRef: 's-1', claudePid: 4242, layout: 'none' });
  assert.equal((attachContext({ ...base, HERDR_ENV: '1', HERDR_SOCKET_PATH: '/s', HERDR_PANE_ID: 'p', HERDR_TAB_ID: 't', HERDR_WORKSPACE_ID: 'w' }) as { layout: string }).layout, 'herdr');
  assert.equal((attachContext({ ...base, HERDR_ENV: '1', HERDR_SOCKET_PATH: '/s' }) as { layout: string }).layout, 'none', 'partial Herdr context is not Herdr');
  assert.equal((attachContext({ ...base, KITTY_WINDOW_ID: '3', KITTY_LISTEN_ON: 'unix:/k' }) as { layout: string }).layout, 'kitty');
  assert.equal(attachContext({ ...base, CLAUDE_PID: 'x' }).ok, false);
});

test('attachState: same live session is already attached; a restarted Claude replaces its stale supervisor', () => {
  const alive = (live: number[]) => (pid: number) => live.includes(pid);
  const now = { sessionRef: 's-1', claudePid: 20 };
  assert.equal(attachState(undefined, now, alive([])), 'attach');
  assert.equal(attachState({ pid: 9, sessionRef: 's-1', claudePid: 20 }, now, alive([9, 20])), 'already');
  assert.equal(attachState({ pid: 9, sessionRef: 's-1', claudePid: 11 }, now, alive([9, 20])), 'replace', 'resumed session with a new Claude pid');
  assert.equal(attachState({ pid: 9, sessionRef: 's-0', claudePid: 11 }, now, alive([9, 11, 20])), 'conflict', 'another live lead session');
  assert.equal(attachState({ pid: 9, sessionRef: 's-0', claudePid: 11 }, now, alive([9, 20])), 'replace', 'other session gone, supervisor left behind');
  assert.equal(attachState({ pid: 9, sessionRef: 's-0', claudePid: 11 }, now, alive([20])), 'attach', 'nothing alive from the old record');
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --import tsx --test tests/lead-attach.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lead-attach.js`.

- [ ] **Step 3: Implement** — create `src/lead-attach.ts`:

```ts
// Pure decisions for attaching a plain Claude session as the group lead; the attach script performs the effects.
export type Layout = 'herdr' | 'kitty' | 'none';
export interface GroupCandidate { runtimePath: string; groupId: string; leadWorktree: string; daemonRunning: boolean }

export function resolveGroup(candidates: GroupCandidate[], gitRoot: string): { kind: 'single'; candidate: GroupCandidate } | { kind: 'choose'; candidates: GroupCandidate[] } | { kind: 'none' } {
  const mine = candidates.filter((candidate) => candidate.leadWorktree === gitRoot);
  if (!mine.length) return { kind: 'none' };
  if (mine.length === 1) return { kind: 'single', candidate: mine[0]! };
  const running = mine.filter((candidate) => candidate.daemonRunning);
  return running.length === 1 ? { kind: 'single', candidate: running[0]! } : { kind: 'choose', candidates: mine };
}

export function attachContext(env: NodeJS.ProcessEnv): { ok: true; sessionRef: string; claudePid: number; layout: Layout } | { ok: false; reason: string } {
  const sessionRef = env.CLAUDE_CODE_SESSION_ID?.trim(); const claudePid = Number(env.CLAUDE_PID);
  if (!sessionRef || !Number.isSafeInteger(claudePid) || claudePid <= 0) return { ok: false, reason: '需要在 Claude Code 会话内执行（缺少 CLAUDE_CODE_SESSION_ID 或 CLAUDE_PID）。' };
  const herdr = env.HERDR_ENV === '1' && Boolean(env.HERDR_SOCKET_PATH && env.HERDR_PANE_ID && env.HERDR_TAB_ID && env.HERDR_WORKSPACE_ID);
  const kitty = Boolean(env.KITTY_WINDOW_ID && env.KITTY_LISTEN_ON);
  return { ok: true, sessionRef, claudePid, layout: herdr ? 'herdr' : kitty ? 'kitty' : 'none' };
}

export interface SupervisorRecord { pid: number; sessionRef: string; claudePid: number }
export function attachState(record: SupervisorRecord | undefined, now: { sessionRef: string; claudePid: number }, alive: (pid: number) => boolean): 'attach' | 'already' | 'replace' | 'conflict' {
  if (!record || !alive(record.pid)) return 'attach';
  if (record.sessionRef === now.sessionRef && record.claudePid === now.claudePid) return 'already';
  if (record.sessionRef !== now.sessionRef && alive(record.claudePid)) return 'conflict';
  return 'replace';
}
```

- [ ] **Step 4: Run tests**

Run: `node --import tsx --test tests/lead-attach.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lead-attach.ts tests/lead-attach.test.ts
git commit -m "feat(lead): pure attach decisions for plain Claude sessions"
```

---

### Task 3: Lead supervisor

**Files:**
- Create: `scripts/lead-supervisor.ts`
- Test: `tests/lead-supervisor.test.ts`

**Interfaces:**
- Consumes: `recordPid`/`runningPid`/`removePid` are for `GroupProcess`; the supervisor writes its own JSON record file `lead-supervisor.pid` (`SupervisorRecord` from Task 2). `heartbeatReporter` from `src/lead-launch.ts`. `coordinatorRequest` from `src/ipc.ts`. `CoordinatorStore` from `src/store.ts`. `loadRuntimeConfig`, `readProtectedJson` from `src/runtime-config.ts`.
- Produces: CLI `lead-supervisor <runtime.json> --session <ref> --claude-pid <pid> --layout herdr|kitty|none`. Files: `<runtimeDir>/lead-supervisor.pid` (JSON `SupervisorRecord`), `<runtimeDir>/lead-supervisor.log` (written by the spawner). Env overrides for tests: `COORDINATOR_HEARTBEAT_MS` (default 20000), `COORDINATOR_RENEW_MS` (default 1200000), `COORDINATOR_WATCH_MS` (default 1000). Renew requests: writes `<runtimeDir>/renew-frontend.request` and `renew-backend.request` (the existing `worker-hold` protocol) when `runningPid(dir,'worker-hold')` is defined.

- [ ] **Step 1: Write the failing test** — create `tests/lead-supervisor.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { engineFixture } from './fixtures/engine-fixture.js';
import { recordPid } from '../src/runtime-processes.js';

const script = (name: string) => fileURLToPath(new URL(`../scripts/${name}.ts`, import.meta.url));
async function waitFor(check: () => boolean | Promise<boolean>, ms = 15000): Promise<void> {
  for (let waited = 0; waited < ms; waited += 100) { if (await check()) return; await delay(100); }
  throw new Error('condition not met in time');
}

test('supervisor heartbeats, requests worker renewals and shuts an idle group down when Claude exits', async () => {
  const f = await engineFixture(); const runtime = join(f.dir, 'runtime.json'); let daemon: ChildProcess | undefined;
  await writeFile(join(f.dir, 'roles.json'), JSON.stringify({ groupId: 'g', credentials: f.credentials }), { mode: 0o600 });
  await writeFile(join(f.dir, 'human.json'), JSON.stringify({ capability: 'human-control-012345678901234567890123456789' }), { mode: 0o600 });
  await writeFile(runtime, JSON.stringify({ groupId: 'g', mode: 'mock', leadMode: 'external', databasePath: f.db, socketPath: join(f.dir, 'coordinator.sock'), credentialFile: join(f.dir, 'roles.json'), humanCredentialFile: join(f.dir, 'human.json'), allowedRoots: [f.dir] }));
  daemon = spawn(process.execPath, ['--import', 'tsx', script('daemon'), runtime], { stdio: 'ignore' });
  const claude = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const holder = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', runtime]);
  try {
    await waitFor(() => existsSync(join(f.dir, 'daemon.pid')));
    await recordPid(f.dir, 'worker-hold', holder.pid!);
    const supervisor = spawn(process.execPath, ['--import', 'tsx', script('lead-supervisor'), runtime, '--session', 'sess-1', '--claude-pid', String(claude.pid), '--layout', 'none'],
      { env: { ...process.env, COORDINATOR_HEARTBEAT_MS: '200', COORDINATOR_RENEW_MS: '300', COORDINATOR_WATCH_MS: '100' }, stdio: 'ignore' });
    await waitFor(() => existsSync(join(f.dir, 'lead-supervisor.pid')));
    assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'lead-supervisor.pid'), 'utf8')), { pid: supervisor.pid, sessionRef: 'sess-1', claudePid: claude.pid });
    await waitFor(() => { const db = new DatabaseSync(f.db, { readOnly: true }); try { return (db.prepare('SELECT session_ref FROM external_lead WHERE group_id=?').get('g') as { session_ref?: string } | undefined)?.session_ref === 'sess-1'; } finally { db.close(); } });
    await waitFor(() => existsSync(join(f.dir, 'renew-frontend.request')) && existsSync(join(f.dir, 'renew-backend.request')));
    const exited = once(supervisor, 'exit');
    claude.kill();
    const [code] = await exited;
    assert.equal(code, 0);
    await waitFor(() => daemon!.exitCode !== null || daemon!.signalCode !== null);
    await waitFor(() => holder.exitCode !== null || holder.signalCode !== null);
    assert.equal(existsSync(join(f.dir, 'lead-supervisor.pid')), false);
    daemon = undefined;
  } finally { claude.kill(); holder.kill(); daemon?.kill(); await f.cleanup(); }
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --import tsx --test tests/lead-supervisor.test.ts`
Expected: FAIL — `scripts/lead-supervisor.ts` not found (supervisor exits immediately; `lead-supervisor.pid` never appears → "condition not met in time").

- [ ] **Step 3: Implement** — create `scripts/lead-supervisor.ts`:

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { coordinatorRequest } from '../src/ipc.js';
import { heartbeatReporter } from '../src/lead-launch.js';
import { loadRuntimeConfig, readProtectedJson } from '../src/runtime-config.js';
import { runningPid } from '../src/runtime-processes.js';
import { CoordinatorStore } from '../src/store.js';
import type { Layout } from '../src/lead-attach.js';

// Detached companion of one Claude lead process: heartbeat, worker lease renewal and observer panes live exactly
// as long as CLAUDE_PID; when it exits the panes close and an idle group shuts down.
const args = process.argv.slice(2);
const value = (key: string) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };
const runtimePath = resolve(args[0] ?? ''); const sessionRef = value('--session'); const claudePid = Number(value('--claude-pid')); const layout = (value('--layout') ?? 'none') as Layout;
if (!args[0] || !sessionRef || !Number.isSafeInteger(claudePid) || !['herdr', 'kitty', 'none'].includes(layout)) throw new Error('Usage: lead-supervisor <runtime.json> --session <ref> --claude-pid <pid> --layout herdr|kitty|none');
const config = await loadRuntimeConfig(runtimePath);
const dir = dirname(config.databasePath);
const ms = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const log = (line: string) => process.stdout.write(`[lead-supervisor ${new Date().toISOString()}] ${line}\n`);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Sibling scripts run the same way this one runs (tsx in development, compiled JS in dist).
const sibling = (name: string, extra: string[], env: NodeJS.ProcessEnv = process.env): ChildProcess =>
  spawn(process.execPath, [...process.execArgv, fileURLToPath(new URL(`./${name}${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url)), ...extra], { env, stdio: 'inherit' });

const recordPath = join(dir, 'lead-supervisor.pid');
await writeFile(recordPath, JSON.stringify({ pid: process.pid, sessionRef, claudePid }), { mode: 0o600 });
const store = new CoordinatorStore(config.databasePath);
const generation = store.groupSnapshot(config.groupId)?.roles.find((role) => role.roleId === 'lead')?.bindingGeneration ?? 1;
store.close();
const capability = z.object({ groupId: z.literal(config.groupId), credentials: z.record(z.string(), z.string().min(32)) }).parse(await readProtectedJson(config.credentialFile)).credentials.lead!;
const report = heartbeatReporter(log);
const beat = () => coordinatorRequest(config.socketPath, { channel: 'role', roleId: 'lead', generation, capability, command: 'automation_lead_heartbeat', input: { sessionRef, cwd: config.leadWorktree ?? dir, agent: 'claude' } })
  .then(() => report.succeeded(), (error: unknown) => report.failed((error as { code?: string }).code ?? 'UNAVAILABLE'));
const renew = async () => { if (await runningPid(dir, 'worker-hold') === undefined) return; for (const role of ['frontend', 'backend']) await writeFile(join(dir, `renew-${role}.request`), 'renew\n', { mode: 0o600 }); log('worker lease renewal requested'); };

const controller = layout === 'none' ? undefined : sibling(layout === 'herdr' ? 'herdr-follow' : 'kitty-follow', [runtimePath], { ...process.env, COORDINATOR_LEAD_PID: String(claudePid) });
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => {});
await beat();
const heartbeat = setInterval(() => { void beat(); }, ms('COORDINATOR_HEARTBEAT_MS', 20_000));
const renewal = setInterval(() => { void renew(); }, ms('COORDINATOR_RENEW_MS', 1_200_000));
while (!stopping && alive(claudePid)) await delay(ms('COORDINATOR_WATCH_MS', 1000));
clearInterval(heartbeat); clearInterval(renewal);
log(stopping ? 'stopped by signal' : 'Claude lead exited');
if (controller && controller.exitCode === null) {
  // The controller notices the lead PID itself and closes its own panes; SIGTERM leads to the same closeAll path.
  const exited = once(controller, 'exit');
  if (stopping) controller.kill('SIGTERM');
  await Promise.race([exited, delay(10_000).then(() => controller.kill('SIGTERM'))]);
}
// SIGTERM means a newer session replaces this supervisor: keep the daemon for it. Only a lead exit may stop the group.
if (!stopping) await once(sibling('group-stop', [runtimePath, '--if-idle']), 'exit');
await unlink(recordPath).catch(() => {});
process.exit(0);
```

- [ ] **Step 4: Run test**

Run: `node --import tsx --test tests/lead-supervisor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lead-supervisor.ts tests/lead-supervisor.test.ts
git commit -m "feat(lead): supervisor bound to the Claude process"
```

---

### Task 4: `lead:attach` script

**Files:**
- Create: `scripts/lead-attach.ts`
- Modify: `package.json` (add `"lead:attach": "tsx scripts/lead-attach.ts"`)
- Test: `tests/lead-attach.test.ts` (append)

**Interfaces:**
- Consumes: `resolveGroup`, `attachContext`, `attachState`, `SupervisorRecord`, `GroupCandidate` (Task 2); supervisor CLI (Task 3); `runningPid` (`src/runtime-processes.ts`); `coordinatorRequest`; `loadRuntimeConfig`, `readProtectedJson`.
- Produces: CLI `lead:attach -- --cwd <repo> [--group <groupId>]`. Env: `COORDINATOR_STATE_DIR` overrides `<coordinator>/.state` (tests). Prints exactly one JSON line `{ status, groupId?, runtime?, layout?, candidates?, message }` with `status ∈ ATTACHED | ALREADY_ATTACHED | NO_GROUP | CHOOSE_GROUP | LEAD_CONFLICT | NOT_CLAUDE | DAEMON_FAILED`; exit code 0 for every status (the skill reads the status). Starts the daemon via `start-daemon.sh` and worker-hold via `worker-hold.sh` in the directory of the group database (`project:init` generates both there, next to `state.sqlite`), detached, appending to `daemon.log` / `worker-hold.log`.

- [ ] **Step 1: Write the failing end-to-end test** — append to `tests/lead-attach.test.ts`:

```ts
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { engineFixture } from './fixtures/engine-fixture.js';

const attachScript = fileURLToPath(new URL('../scripts/lead-attach.ts', import.meta.url));
const daemonScript = fileURLToPath(new URL('../scripts/daemon.ts', import.meta.url));
async function attach(cwd: string, stateDir: string, env: Record<string, string>): Promise<{ status: string; [key: string]: unknown }> {
  const child = spawn(process.execPath, ['--import', 'tsx', attachScript, '--cwd', cwd], { env: { ...process.env, HERDR_ENV: '', KITTY_WINDOW_ID: '', COORDINATOR_STATE_DIR: stateDir, ...env } });
  let out = ''; child.stdout.on('data', (c) => { out += c; });
  await once(child, 'exit');
  return JSON.parse(out.trim().split('\n').pop()!);
}
async function waitFor(check: () => boolean, ms = 20000): Promise<void> {
  for (let waited = 0; waited < ms; waited += 100) { if (check()) return; await delay(100); }
  throw new Error('condition not met in time');
}

test('lead:attach refuses outside Claude and reports a repo without a group', async () => {
  const state = await mkdtemp(join(tmpdir(), 'attach-state-')); const repo = await mkdtemp(join(tmpdir(), 'attach-repo-'));
  spawnSync('git', ['init', '-q', repo]);
  try {
    assert.equal((await attach(repo, state, { CLAUDE_CODE_SESSION_ID: '', CLAUDE_PID: '' })).status, 'NOT_CLAUDE');
    assert.equal((await attach(repo, state, { CLAUDE_CODE_SESSION_ID: 's', CLAUDE_PID: String(process.pid) })).status, 'NO_GROUP');
  } finally { await rm(state, { recursive: true, force: true }); await rm(repo, { recursive: true, force: true }); }
});

test('lead:attach starts the daemon, attaches once, stays idempotent and is replaced after a Claude restart', async () => {
  const f = await engineFixture();
  const repo = await realpath(f.dir); spawnSync('git', ['init', '-q', repo]); await mkdir(join(repo, 'sub'));
  const runDir = repo; // runtime files (daemon.pid, lead-supervisor.pid) live next to the group database
  const state = await mkdtemp(join(tmpdir(), 'attach-state-')); const groupDir = join(state, 'g'); await mkdir(groupDir, { mode: 0o700 });
  const runtime = join(groupDir, 'runtime.json');
  await writeFile(join(groupDir, 'roles.json'), JSON.stringify({ groupId: 'g', credentials: f.credentials }), { mode: 0o600 });
  await writeFile(join(groupDir, 'human.json'), JSON.stringify({ capability: 'human-control-012345678901234567890123456789' }), { mode: 0o600 });
  await writeFile(runtime, JSON.stringify({ groupId: 'g', mode: 'mock', leadMode: 'external', leadWorktree: repo, databasePath: f.db, socketPath: join(groupDir, 'c.sock'), credentialFile: 'roles.json', humanCredentialFile: 'human.json', allowedRoots: [repo, state] }));
  // project:init puts start-daemon.sh next to the database; this fixture keeps the database in the repo.
  await writeFile(join(runDir, 'start-daemon.sh'), `#!/bin/sh\nexec '${process.execPath}' --import tsx '${daemonScript}' '${runtime}'\n`, { mode: 0o700 });
  const claude = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const restarted = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const env = { CLAUDE_CODE_SESSION_ID: 'sess-1', CLAUDE_PID: String(claude.pid), COORDINATOR_WATCH_MS: '100' };
  const recordPath = join(runDir, 'lead-supervisor.pid');
  try {
    const first = await attach(join(repo, 'sub'), state, env);
    assert.equal(first.status, 'ATTACHED', JSON.stringify(first));
    const firstRecord = JSON.parse(await readFile(recordPath, 'utf8'));
    assert.equal(firstRecord.sessionRef, 'sess-1');
    assert.equal((await attach(repo, state, env)).status, 'ALREADY_ATTACHED');
    const again = await attach(repo, state, { ...env, CLAUDE_PID: String(restarted.pid) });
    assert.equal(again.status, 'ATTACHED', 'a resumed session with a new Claude pid replaces the stale supervisor');
    assert.notEqual(JSON.parse(await readFile(recordPath, 'utf8')).pid, firstRecord.pid);
    assert.ok(existsSync(join(runDir, 'daemon.pid')), 'replacing the supervisor keeps the daemon running');
    claude.kill(); restarted.kill();
    await waitFor(() => !existsSync(join(runDir, 'daemon.pid')) && !existsSync(recordPath));
  } finally { claude.kill(); restarted.kill(); await rm(state, { recursive: true, force: true }); await f.cleanup(); }
});

test('lead:attach treats a reachable daemon without a pid file as running and does not start another', async () => {
  const f = await engineFixture(); const repo = await realpath(f.dir); spawnSync('git', ['init', '-q', repo]);
  const state = await mkdtemp(join(tmpdir(), 'attach-state-')); const groupDir = join(state, 'g'); await mkdir(groupDir, { mode: 0o700 });
  const runtime = join(groupDir, 'runtime.json');
  await writeFile(join(groupDir, 'roles.json'), JSON.stringify({ groupId: 'g', credentials: f.credentials }), { mode: 0o600 });
  await writeFile(join(groupDir, 'human.json'), JSON.stringify({ capability: 'human-control-012345678901234567890123456789' }), { mode: 0o600 });
  await writeFile(runtime, JSON.stringify({ groupId: 'g', mode: 'mock', leadMode: 'external', leadWorktree: repo, databasePath: f.db, socketPath: join(groupDir, 'c.sock'), credentialFile: 'roles.json', humanCredentialFile: 'human.json', allowedRoots: [repo, state] }));
  const daemon = spawn(process.execPath, ['--import', 'tsx', daemonScript, runtime], { stdio: 'ignore' });
  const claude = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  try {
    await waitFor(() => existsSync(join(repo, 'daemon.pid')));
    await rm(join(repo, 'daemon.pid')); // a daemon from before pid files existed
    const result = await attach(repo, state, { CLAUDE_CODE_SESSION_ID: 'sess-2', CLAUDE_PID: String(claude.pid), COORDINATOR_WATCH_MS: '100' });
    assert.equal(result.status, 'ATTACHED', JSON.stringify(result)); // no start-daemon.sh exists, so a restart attempt would report DAEMON_FAILED
  } finally { claude.kill(); daemon.kill(); await rm(state, { recursive: true, force: true }); await f.cleanup(); }
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --import tsx --test --test-name-pattern 'lead:attach' tests/lead-attach.test.ts`
Expected: FAIL — `scripts/lead-attach.ts` not found (JSON parse of empty output throws).

- [ ] **Step 3: Implement** — create `scripts/lead-attach.ts`:

```ts
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { coordinatorRequest } from '../src/ipc.js';
import { attachContext, attachState, resolveGroup, type GroupCandidate, type SupervisorRecord } from '../src/lead-attach.js';
import { loadRuntimeConfig, readProtectedJson, type RuntimeConfig } from '../src/runtime-config.js';
import { runningPid } from '../src/runtime-processes.js';
import { CoordinatorStore } from '../src/store.js';

// Attaches the calling Claude session as the group lead. Prints one JSON line; the skill decides what to say.
const args = process.argv.slice(2);
const value = (key: string) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };
const done = (status: string, extra: Record<string, unknown>, message: string): never => { process.stdout.write(`${JSON.stringify({ status, ...extra, message })}\n`); process.exit(0); };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// scripts/lead-attach.ts (tsx) and dist/scripts/lead-attach.js both resolve to the coordinator checkout root.
const coordinatorRoot = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '..' : '../..', import.meta.url));
const stateDir = process.env.COORDINATOR_STATE_DIR ?? join(coordinatorRoot, '.state');

const context = attachContext(process.env);
if (!context.ok) done('NOT_CLAUDE', {}, context.reason);
const { sessionRef, claudePid, layout } = context as Extract<ReturnType<typeof attachContext>, { ok: true }>;
const top = spawnSync('git', ['-C', resolve(value('--cwd') ?? process.cwd()), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
const gitRoot = top.status === 0 ? await realpath(top.stdout.trim()) : await realpath(resolve(value('--cwd') ?? process.cwd()));

async function daemonReachable(config: RuntimeConfig): Promise<boolean> {
  const capability = z.object({ credentials: z.record(z.string(), z.string()) }).parse(await readProtectedJson(config.credentialFile)).credentials.lead;
  try { await coordinatorRequest(config.socketPath, { channel: 'role', roleId: 'lead', generation: leadGeneration(config), capability: capability!, command: 'automation_status', input: {} }); return true; } catch { return false; }
}
function leadGeneration(config: RuntimeConfig): number { const store = new CoordinatorStore(config.databasePath); try { return store.groupSnapshot(config.groupId)?.roles.find((r) => r.roleId === 'lead')?.bindingGeneration ?? 1; } finally { store.close(); } }

const candidates: Array<GroupCandidate & { config: RuntimeConfig }> = [];
for (const entry of existsSync(stateDir) ? await readdir(stateDir, { withFileTypes: true }) : []) {
  const runtimePath = join(stateDir, entry.name, 'runtime.json');
  if (!entry.isDirectory() || !existsSync(runtimePath)) continue;
  try {
    const config = await loadRuntimeConfig(runtimePath);
    if (!config.leadWorktree) continue;
    candidates.push({ runtimePath, groupId: config.groupId, leadWorktree: await realpath(config.leadWorktree), daemonRunning: (await runningPid(dirname(config.databasePath), 'daemon')) !== undefined, config });
  } catch { /* unreadable runtime: not a candidate */ }
}
const wanted = value('--group');
const chosen = wanted ? candidates.filter((c) => c.groupId === wanted && c.leadWorktree === gitRoot) : candidates;
const pick = resolveGroup(chosen, gitRoot);
if (pick.kind === 'none') done('NO_GROUP', { gitRoot }, '当前仓库还没有协同组，可用 project:init 新建。');
if (pick.kind === 'choose') done('CHOOSE_GROUP', { candidates: pick.candidates.map((c) => c.groupId) }, '当前仓库有多个协同组，请选择一个（--group）。');
const group = (pick as { candidate: GroupCandidate }).candidate as GroupCandidate & { config: RuntimeConfig };
const { config, runtimePath } = group; const dir = dirname(config.databasePath);
const recordPath = join(dir, 'lead-supervisor.pid');
const record = existsSync(recordPath) ? JSON.parse(await readFile(recordPath, 'utf8')) as SupervisorRecord : undefined;
const state = attachState(record, { sessionRef, claudePid }, alive);
if (state === 'already') done('ALREADY_ATTACHED', { groupId: config.groupId, runtime: runtimePath, layout }, '本会话已接入。');
if (state === 'conflict') done('LEAD_CONFLICT', { groupId: config.groupId }, '另一个 lead 会话仍在线，请先退出它。');
if (state === 'replace' && record) { try { process.kill(record.pid, 'SIGTERM'); } catch { /* already gone */ } for (let i = 0; i < 100 && alive(record.pid); i++) await delay(100); }

const detached = (script: string, logName: string) => { const out = openSync(join(dir, logName), 'a', 0o600); spawn('sh', [script], { detached: true, stdio: ['ignore', out, out] }).unref(); };
if ((await runningPid(dir, 'daemon')) === undefined && !(await daemonReachable(config))) {
  if (!existsSync(join(dir, 'start-daemon.sh'))) done('DAEMON_FAILED', { groupId: config.groupId }, `缺少 ${join(dir, 'start-daemon.sh')}。`);
  detached(join(dir, 'start-daemon.sh'), 'daemon.log');
  for (let i = 0; i < 300 && !(await daemonReachable(config)); i++) await delay(100);
  if (!(await daemonReachable(config))) done('DAEMON_FAILED', { groupId: config.groupId }, `daemon 未就绪，请查看 ${join(dir, 'daemon.log')}。`);
}
if (config.workerTasks?.length && (await runningPid(dir, 'worker-hold')) === undefined && existsSync(join(dir, 'worker-hold.sh'))) detached(join(dir, 'worker-hold.sh'), 'worker-hold.log');

const capability = z.object({ credentials: z.record(z.string(), z.string()) }).parse(await readProtectedJson(config.credentialFile)).credentials.lead!;
try {
  await coordinatorRequest(config.socketPath, { channel: 'role', roleId: 'lead', generation: leadGeneration(config), capability, command: 'automation_lead_heartbeat', input: { sessionRef, cwd: config.leadWorktree!, agent: 'claude' } });
} catch (error) {
  if ((error as { code?: string }).code === 'LEAD_CONFLICT') done('LEAD_CONFLICT', { groupId: config.groupId }, '另一个 lead 会话仍在线（心跳未过期），请先退出它。');
  throw error;
}
const supervisorScript = fileURLToPath(new URL(`./lead-supervisor${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url));
const out = openSync(join(dir, 'lead-supervisor.log'), 'a', 0o600);
spawn(process.execPath, [...process.execArgv, supervisorScript, runtimePath, '--session', sessionRef, '--claude-pid', String(claudePid), '--layout', layout], { detached: true, stdio: ['ignore', out, out], env: process.env }).unref();
for (let i = 0; i < 100 && !existsSync(recordPath); i++) await delay(100);
done('ATTACHED', { groupId: config.groupId, runtime: runtimePath, layout }, layout === 'none' ? '已接入（当前终端不支持观察窗格）。' : '已接入，观察窗格将按需打开。');
```

Add to `package.json` scripts: `"lead:attach": "tsx scripts/lead-attach.ts",`.

- [ ] **Step 4: Run tests**

Run: `node --import tsx --test tests/lead-attach.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Run the full suite, typecheck and build**

Run: `npm run typecheck && npm run build && npm test`
Expected: all pass; `dist/scripts/lead-attach.js` and `dist/scripts/lead-supervisor.js` exist.

- [ ] **Step 6: Commit**

```bash
git add scripts/lead-attach.ts package.json tests/lead-attach.test.ts
git commit -m "feat(lead): lead:attach joins a plain Claude session to its group"
```

---

### Task 5: Skill and docs carry the intent-driven flow

**Files:**
- Modify: `skills/codex-session-coordinator/SKILL.md`, `skills/codex-session-coordinator/references/operations.md`, `docs/new-project-herdr.md`
- Sync: copy both skill files to `~/.claude/skills/codex-session-coordinator/`

**Interfaces:**
- Consumes: `lead:attach` statuses (Task 4).

- [ ] **Step 1: SKILL.md** — in the frontmatter `description`, add the trigger intents: starting or continuing collaboration for this repository, dispatching to frontend/backend, running an audit, recovering or accepting a group's work. Replace the "Lead launch and rotation" section with:

```markdown
## Attaching the lead (plain Claude session)

- The user starts `claude` normally in the business repository. When the conversation asks to start or continue coordinated work, attach first: `npm --prefix /Users/macmini/playground/codex-session-coordinator run -s lead:attach -- --cwd "$PWD"` and act on the one-line JSON status:
  - `ATTACHED` / `ALREADY_ATTACHED`: continue; panes open on demand.
  - `NO_GROUP`: offer `project:init` and ask the user for Scope and repository identity.
  - `CHOOSE_GROUP`: list `candidates` and rerun with `--group <id>` after the user picks.
  - `LEAD_CONFLICT`: another lead session is still live; ask the user to exit it.
  - `NOT_CLAUDE` / `DAEMON_FAILED`: report `message` and stop.
- The lead calls the coordinator through `npm run client -- <runtime> lead <command> '<json>'`; there is no coordinator MCP in the lead session.
- The supervisor keeps heartbeat, worker lease renewal and observer panes alive while this Claude process lives; on exit panes close and an idle group stops. Do not start daemons, lease holders or controllers by hand.
- The lead renews its own CLI Task lease (host evidence + `task_checkpoint`) before dispatches and archives and about every 20 minutes.
- Never use PowerContext Handoff tools in this workflow.
- A new session takes over automatically once the previous lead presence expired (60s); `human-control lead-rotate` remains a manual override.
```

- [ ] **Step 2: operations.md** — add an "Attach" entry at the top of the command list:

```markdown
- Attach the current Claude session as lead: `npm run -s lead:attach -- --cwd <repo> [--group <id>]` (one JSON line: ATTACHED, ALREADY_ATTACHED, NO_GROUP, CHOOSE_GROUP, LEAD_CONFLICT, NOT_CLAUDE, DAEMON_FAILED). Logs: `<runtime dir>/lead-supervisor.log`.
```

- [ ] **Step 3: docs/new-project-herdr.md** — replace section 7 body with:

```markdown
在 Kitty 里的 Herdr 窗格中进入业务仓库，直接启动 `claude`。对话里说明要做的事（例如"开始协同：……"），skill 会执行 `lead:attach` 接入本组：按需启动 daemon 与 worker 租约、发心跳、观察窗格按需打开；退出 `claude` 时窗格关闭，组空闲则自动停止。旧启动器 `new-lead.sh` / `resume-lead.sh` 在新流程实机验收前仍可用。
```

- [ ] **Step 4: Sync installed skill and verify**

Run: `cp skills/codex-session-coordinator/SKILL.md ~/.claude/skills/codex-session-coordinator/SKILL.md && cp skills/codex-session-coordinator/references/operations.md ~/.claude/skills/codex-session-coordinator/references/operations.md && diff -rq skills/codex-session-coordinator ~/.claude/skills/codex-session-coordinator && echo SYNCED`
Expected: `SYNCED`

- [ ] **Step 5: Commit**

```bash
git add skills/codex-session-coordinator docs/new-project-herdr.md
git commit -m "docs: intent-driven lead attach in the coordinator skill"
```

---

### Task 6: Real verification in Herdr (with the user)

**Files:** none (results go to `docs/verification.md`)

- [ ] **Step 1:** Prepare a throwaway group with `project:init` for a test business repository (mock mode, no real execution grant).
- [ ] **Step 2:** User opens a Herdr pane in that repo and runs plain `claude`; says "开始协同：检查状态".
- [ ] **Step 3:** Confirm: skill runs `lead:attach` → `ATTACHED`; `daemon.pid`, `lead-supervisor.pid` exist; `automation_status` shows the session as lead.
- [ ] **Step 4:** Dispatch a mock work item; confirm the observer pane opens, then completes.
- [ ] **Step 5:** User exits `claude`; confirm observer panes close, `group-stop --if-idle` stopped the daemon, no coordinator processes remain.
- [ ] **Step 6:** Record the result in `docs/verification.md` (times in Asia/Taipei) and commit `docs: record skill-driven lead attach verification`.

---

### Task 7: Retire the old launchers (only after Task 6 passes)

**Files:**
- Modify: `scripts/herdr-resume.sh`, `scripts/kitty-lead.sh`, `src/lead-launch.ts`, `scripts/lead-session.ts`, `src/project-scaffold.ts`, `tests/project-scaffold.test.ts`, `docs/new-project-herdr.md`, skill files

- [ ] **Step 1: Update the scaffold test first** — in `tests/project-scaffold.test.ts`, change the expected generated script list to exclude `new-lead.sh` and `resume-lead.sh` (keep `lead-rotate.sh`); run `node --import tsx --test tests/project-scaffold.test.ts` and confirm it FAILS on the extra scripts.
- [ ] **Step 2:** Remove `new-lead.sh` / `resume-lead.sh` from `src/project-scaffold.ts`; rerun the scaffold test → PASS.
- [ ] **Step 3:** Delete `scripts/lead-session.ts`, the `buildLeadLaunch`/`parseLeadArgs`/`resolveLeadSession` exports of `src/lead-launch.ts` (keep `heartbeatReporter`, used by the supervisor), their tests, the lead-launch branch of `scripts/herdr-resume.sh` (delete the script and the `herdr:resume` npm entry) and the lead branch of `scripts/kitty-lead.sh` (keep `--observe-only`).
- [ ] **Step 4:** `npm run typecheck && npm run build && npm test` → all pass.
- [ ] **Step 5:** Remove launcher references from `docs/new-project-herdr.md` and the skill; sync the installed skill; commit `refactor(lead): retire launcher in favour of lead:attach`.
- [ ] **Step 6:** Correct the PowerContext topic memory that claims "已确认只需在 Kitty 里启动 Herdr、再启动 claude" (after this task it becomes true; record the verified flow).
