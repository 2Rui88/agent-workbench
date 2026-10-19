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

// The layout backend only says where an observation tab could be opened later (herdr:open); attach never opens one.
export function attachContext(env: NodeJS.ProcessEnv): { ok: true; sessionRef: string; claudePid: number; layout: Layout } | { ok: false; reason: string } {
  const sessionRef = env.CLAUDE_CODE_SESSION_ID?.trim(); const claudePid = Number(env.CLAUDE_PID);
  if (!sessionRef || !Number.isSafeInteger(claudePid) || claudePid <= 0) return { ok: false, reason: '需要在 Claude Code 会话内执行（缺少 CLAUDE_CODE_SESSION_ID 或 CLAUDE_PID）。' };
  const herdr = env.HERDR_ENV === '1' && Boolean(env.HERDR_SOCKET_PATH && env.HERDR_PANE_ID && env.HERDR_TAB_ID && env.HERDR_WORKSPACE_ID);
  const kitty = Boolean(env.KITTY_WINDOW_ID && env.KITTY_LISTEN_ON);
  return { ok: true, sessionRef, claudePid, layout: herdr ? 'herdr' : kitty ? 'kitty' : 'none' };
}

export interface SupervisorRecord { pid: number; sessionRef: string; claudePid: number }
// A supervisor whose Claude already exited is tearing down on its own: wait for it instead of signalling it.
export function attachState(record: SupervisorRecord | undefined, now: { sessionRef: string; claudePid: number }, alive: (pid: number) => boolean): 'attach' | 'already' | 'wait' | 'replace' | 'conflict' {
  if (!record || !alive(record.pid)) return 'attach';
  if (record.sessionRef === now.sessionRef && record.claudePid === now.claudePid) return 'already';
  if (!alive(record.claudePid)) return 'wait';
  return record.sessionRef === now.sessionRef ? 'replace' : 'conflict';
}
