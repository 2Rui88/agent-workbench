import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { coordinatorRequest } from '../src/ipc.js';
import { loadRuntimeConfig, readProtectedJson } from '../src/runtime-config.js';
import { groupIdle, runningPid, stopRecorded } from '../src/runtime-processes.js';

// Stops the group's daemon and worker lease holder. With --if-idle (used when the lead exits) it keeps them
// running while work is in flight or its state cannot be read, so the next lead can resume it.
const [path, flag] = process.argv.slice(2);
if (!path || (flag && flag !== '--if-idle')) throw new Error('Usage: group-stop <runtime.json> [--if-idle]');
const runtimePath = resolve(path);
const config = await loadRuntimeConfig(runtimePath);
const dir = dirname(config.databasePath);
const say = (message: string) => process.stdout.write(`[Coordinator] ${message}\n`);

async function idleReason(): Promise<string | undefined> {
  if (await runningPid(dir, 'daemon') === undefined) return undefined;
  try {
    const saved = z.object({ groupId: z.literal(config.groupId), credentials: z.record(z.string(), z.string().min(32)) }).parse(await readProtectedJson(config.credentialFile));
    const status = await coordinatorRequest(config.socketPath, { channel: 'role', roleId: 'lead', generation: 1, capability: saved.credentials.lead!, command: 'automation_status', input: {} });
    const verdict = groupIdle(status as Parameters<typeof groupIdle>[0]);
    return verdict.idle ? undefined : verdict.reason;
  } catch { return '无法读取协调器状态'; }
}

const busy = flag === '--if-idle' ? await idleReason() : undefined;
if (busy) {
  say(`daemon 与 worker 租约保留：${busy}。下次启动 lead 会继续接管。`);
} else {
  for (const name of ['worker-hold', 'daemon'] as const) {
    const outcome = await stopRecorded(dir, name, runtimePath);
    if (outcome === 'stopped') say(`${name} 已停止。`);
    else if (outcome === 'mismatch' || outcome === 'timeout') say(`${name} 未停止（${outcome === 'mismatch' ? 'pid 已被其他进程占用' : '等待退出超时'}），请手动核对。`);
  }
}
