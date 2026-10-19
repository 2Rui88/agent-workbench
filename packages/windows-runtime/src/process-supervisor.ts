import { spawn, type ChildProcess } from 'node:child_process';
import { JobObjectHost } from './job-object-host.js';

export interface ManagedProcess {
  readonly id: string;
  readonly pid: number;
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
}

export interface SpawnSpec {
  id: string;
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  useJobObject?: boolean;
}

/**
 * Windows-safe process lifecycle boundary. The current adapter uses taskkill to
 * terminate the complete tree; a native Job Object adapter can replace it later
 * without changing coordinator callers.
 */
export class WindowsProcessSupervisor {
  private readonly processes = new Map<string, ManagedProcess>();
  private jobHost: JobObjectHost | undefined;

  start(spec: SpawnSpec): ManagedProcess {
    if (this.processes.has(spec.id)) throw new Error(`Process already exists: ${spec.id}`);
    const child = spawn(spec.command, spec.args ?? [], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false
    });
    if (!child.pid) throw new Error(`Process did not expose a PID: ${spec.id}`);
    let ready = Promise.resolve();
    if (spec.useJobObject && process.platform === 'win32') {
      this.jobHost ??= new JobObjectHost();
      ready = this.jobHost.assign(spec.id, child.pid).catch((error) => {
        void this.stop(spec.id);
        child.emit('error', error);
        throw error;
      });
    }
    const managed: ManagedProcess = { id: spec.id, pid: child.pid, child, ready };
    this.processes.set(spec.id, managed);
    const forget = () => { if (this.processes.get(spec.id)?.pid === child.pid) this.processes.delete(spec.id); };
    child.once('exit', forget);
    child.once('error', forget);
    return managed;
  }

  async stop(id: string): Promise<void> {
    const managed = this.processes.get(id);
    if (!managed) return;
    if (this.jobHost && process.platform === 'win32') {
      await this.jobHost.terminate(id).catch(() => {});
    }
    if (process.platform === 'win32') {
      await new Promise<void>((resolve, reject) => {
        const killer = spawn('taskkill', ['/PID', String(managed.pid), '/T', '/F'], { windowsHide: true });
        killer.once('error', reject);
        killer.once('exit', (code) => code === 0 || code === 128 ? resolve() : reject(new Error(`taskkill exited with ${code}`)));
      });
    } else {
      managed.child.kill('SIGTERM');
    }
    this.processes.delete(id);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.processes.keys()].map((id) => this.stop(id)));
    await this.jobHost?.close();
    this.jobHost = undefined;
  }

  get(id: string): ManagedProcess | undefined { return this.processes.get(id); }
}
