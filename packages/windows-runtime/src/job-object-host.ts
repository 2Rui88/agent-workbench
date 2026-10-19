import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

interface HostResponse { id: string; ok: boolean; result?: unknown; error?: string; }

export class JobObjectHost {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private sequence = 0;
  private closed = false;

  constructor(private readonly scriptPath = fileURLToPath(new URL('../scripts/job-object-host.ps1', import.meta.url))) {
    if (process.platform !== 'win32') throw new Error('Windows Job Objects are only available on Windows.');
    this.child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      try {
        const response = JSON.parse(line) as HostResponse;
        const waiter = this.pending.get(response.id);
        if (!waiter) return;
        this.pending.delete(response.id);
        if (response.ok) waiter.resolve(response.result);
        else waiter.reject(new Error(response.error ?? 'Job Object host rejected the request.'));
      } catch { /* malformed helper output is handled by request timeout/process exit */ }
    });
    const fail = (error: Error) => { for (const waiter of this.pending.values()) waiter.reject(error); this.pending.clear(); };
    this.child.once('error', fail);
    this.child.once('exit', (code) => fail(new Error(`Job Object host exited with code ${code ?? 'unknown'}.`)));
  }

  private request(method: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Job Object host is closed.'));
    const id = `${Date.now()}-${this.sequence++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, method, ...payload })}\n`, (error) => {
        if (error) { this.pending.delete(id); reject(error); }
      });
    });
  }

  async assign(jobId: string, pid: number): Promise<void> { await this.request('assign', { jobId, pid }); }
  async terminate(jobId: string): Promise<void> { await this.request('terminate', { jobId }); }

  async close(): Promise<void> {
    if (this.closed) return;
    try { await this.request('close'); } catch { /* helper may already have exited */ }
    this.closed = true;
    this.child.kill();
  }
}
