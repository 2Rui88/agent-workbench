import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const LOCK = 'layout-controller.lock';
export interface LayoutLockHolder { pid: number; backend: 'herdr' | 'kitty'; groupId: string; observerTab?: string; }
export async function readLayoutLock(stateDir: string): Promise<LayoutLockHolder | undefined> {
  try { return JSON.parse(await readFile(join(stateDir, LOCK), 'utf8')) as LayoutLockHolder; } catch { return undefined; }
}
export function lockHolderAlive(holder: LayoutLockHolder | undefined): boolean {
  try { if (holder?.pid) { process.kill(holder.pid, 0); return true; } } catch { /* dead */ }
  return false;
}
export async function acquireLayoutLock(stateDir: string, groupId: string, backend: 'herdr' | 'kitty', context: Record<string, unknown>): Promise<{ release(): Promise<void>; update(extra: Record<string, unknown>): Promise<void> }> {
  const path = join(stateDir, LOCK);
  const handle = await open(path, 'wx', 0o600).catch(async () => {
    const holder = await readLayoutLock(stateDir);
    throw new Error(lockHolderAlive(holder) ? `Layout controller (${holder!.backend}, pid ${holder!.pid}) is already running for this group.` : 'Layout controller lock is stale; inspect the recorded process and pane mapping before removing it.');
  });
  const write = async (extra: Record<string, unknown>) => { await handle.truncate(0); await handle.write(JSON.stringify({ ...context, ...extra, pid: process.pid, backend, groupId }), 0); };
  await write({});
  return { update: write, release: async () => { await handle.close(); await unlink(path).catch(() => {}); } };
}
export function assertNotInsideHerdr(env: NodeJS.ProcessEnv): void {
  if (env.HERDR_ENV === '1') throw new Error('已在 Herdr 中运行：直接在 Herdr 窗格启动 claude 并让 skill 接入（lead:attach），观察标签用 herdr:open 打开，避免另起一个 Kitty 实例和第二个布局控制器。');
}
