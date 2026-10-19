import { execFile } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

// Long-running group helpers (daemon, worker lease holder) record their pid next to the group database so the
// lead launcher can stop them when the lead exits, without matching arbitrary processes by name.
export type GroupProcess = 'daemon' | 'worker-hold';
const IN_FLIGHT = new Set(['queued', 'starting', 'leased', 'active', 'needs_reconciliation']);

interface StatusView { budget?: { inFlight?: number; unknown?: number } | null; dispatches?: Array<{ state?: string }>; approvals?: unknown[] }
export function groupIdle(status: StatusView): { idle: boolean; reason?: string } {
  const busy = (status.dispatches ?? []).filter((d) => IN_FLIGHT.has(String(d.state))).length;
  if (busy) return { idle: false, reason: `${busy} 个派发仍在进行或待对账` };
  if (status.approvals?.length) return { idle: false, reason: `${status.approvals.length} 个审批待处理` };
  if (status.budget?.inFlight || status.budget?.unknown) return { idle: false, reason: '仍有进行中或结果未知的调用' };
  return { idle: true };
}

const pidPath = (dir: string, name: GroupProcess) => join(dir, `${name}.pid`);
export async function recordPid(dir: string, name: GroupProcess, pid = process.pid): Promise<void> { await writeFile(pidPath(dir, name), `${pid}\n`, { mode: 0o600 }); }
export async function removePid(dir: string, name: GroupProcess): Promise<void> { await unlink(pidPath(dir, name)).catch(() => {}); }

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// The recorded pid when that process is still alive; a stale or missing record yields undefined.
export async function runningPid(dir: string, name: GroupProcess): Promise<number | undefined> {
  const pid = Number((await readFile(pidPath(dir, name), 'utf8').catch(() => '')).trim());
  return Number.isSafeInteger(pid) && pid > 0 && alive(pid) ? pid : undefined;
}
async function commandLine(pid: number): Promise<string> {
  try { return (await promisify(execFile)('ps', ['-o', 'command=', '-p', String(pid)])).stdout; } catch { return ''; }
}

// Signals the recorded process only when its command line still carries the group marker (normally the runtime
// path), so a recycled pid is never touched. A dead process just has its stale pid file removed.
export async function stopRecorded(dir: string, name: GroupProcess, marker: string, waitMs = 10_000): Promise<'stopped' | 'absent' | 'mismatch' | 'timeout'> {
  const pid = await runningPid(dir, name);
  if (pid === undefined) { await removePid(dir, name); return 'absent'; }
  if (!(await commandLine(pid)).includes(marker)) return 'mismatch';
  process.kill(pid, 'SIGTERM');
  for (let waited = 0; waited < waitMs; waited += 100) {
    if (!alive(pid)) { await removePid(dir, name); return 'stopped'; }
    await delay(100);
  }
  return 'timeout';
}
