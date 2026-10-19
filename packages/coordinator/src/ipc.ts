import { createServer, createConnection } from 'node:net';
import type { Server } from 'node:net';
import { chmod, mkdir, lstat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { automationSchemas, type AutomationCommand, CoordinatorEngine } from './engine.js';
import { CoordinatorOwnership } from './ownership.js';
import { CoordinatorError } from './errors.js';
import type { CoordinatorErrorCode } from './errors.js';
import type { RoleId } from './protocol.js';
import { roleEnum } from './roles.js';

const role = roleEnum;
const requestSchema = z.discriminatedUnion('channel', [
  z.object({ id: z.string().min(1).max(100), channel: z.literal('role'), roleId: role, generation: z.number().int().positive(), capability: z.string().min(32).max(256), command: z.enum(Object.keys(automationSchemas) as [AutomationCommand, ...AutomationCommand[]]), input: z.unknown() }).strict(),
  z.object({ id: z.string().min(1).max(100), channel: z.literal('human'), capability: z.string().min(1).max(256), command: z.enum(['approvals', 'respond', 'takeover', 'release', 'lead-rotate']), input: z.unknown() }).strict()
]);

export async function startCoordinatorSocket(engine: CoordinatorEngine, path: string, intervalMs = 500): Promise<{ close(): Promise<void>; server: Server }> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(path));
  if (parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) throw new CoordinatorError('FORBIDDEN', 'Socket directory must be owned by this user with mode 0700.', 'Use a private coordinator runtime directory.');
  const ownership = new CoordinatorOwnership(engine.databasePath, engine.groupId);
  try { await ownership.acquire(path); } catch (error) { ownership.close(); throw error; }
  const server = createServer((socket) => {
    let buffer = '';
    socket.setTimeout(35_000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 1024 * 1024) { socket.destroy(); return; }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      socket.pause();
      const frame = buffer.slice(0, newline);
      void (async () => {
        let id: string | undefined;
        try {
          const raw = JSON.parse(frame); if (typeof raw?.id === 'string') id = raw.id;
          const input = requestSchema.parse(raw); id = input.id;
          let result: unknown;
          if (input.channel === 'role') result = await engine.execute(engine.authenticate(input.roleId, input.capability, input.generation), input.command, input.input);
          else {
            engine.approvals.authenticate(input.capability);
            if (input.command === 'approvals') result = engine.approvals.list(engine.groupId);
            else if (input.command === 'lead-rotate') result = await engine.humanRotateLead(input.capability);
            else if (input.command === 'respond') {
              const response = z.object({ approvalId: z.string(), decision: z.enum(['accept', 'decline', 'cancel']) }).strict().parse(input.input);
              await engine.humanRespond(input.capability, response.approvalId, response.decision); result = { ok: true };
            } else {
              const control = z.object({ roleId: role, evidence: z.string().min(1) }).strict().parse(input.input);
              result = await engine.humanControl(input.capability, control.roleId, input.command === 'takeover', control.evidence);
            }
          }
          socket.end(`${JSON.stringify({ id, ok: true, result })}\n`);
        } catch (error) {
          const known = error instanceof CoordinatorError;
          socket.end(`${JSON.stringify({ id, ok: false, error: { code: known ? error.code : 'INVALID_INPUT', message: known ? error.message : 'Coordinator request failed validation or execution.', nextAction: known ? error.nextAction : 'Inspect the command schema and current service state.' } })}\n`);
        }
      })();
    });
  });
  let createdSocket:Awaited<ReturnType<typeof lstat>>|undefined;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolve(); }); });
    createdSocket=await lstat(path);
    await chmod(path, 0o600); await ownership.recordSocket(path);
    engine.recoverAfterRestart();
  } catch (error) {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    try{if(createdSocket){const current=await lstat(path);if(current.ino===createdSocket.ino&&current.dev===createdSocket.dev)await unlink(path);}}catch{/* Keep uncertain resources for inspection. */}
    ownership.close();throw error;
  }
  const owned = await lstat(path);
  const timer = setInterval(() => { void engine.pump().catch(() => { /* Pending work remains durable; status exposes dispatch state. */ }); }, intervalMs);
  let closing = false;
  return { server, async close() {
    if (closing) return; closing = true; clearInterval(timer);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    try{await engine.close();}
    finally{
    try { const current = await lstat(path); if (current.ino === owned.ino && current.dev === owned.dev) await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    finally { ownership.close(); }
    }
  } };
}

export async function coordinatorRequest(path: string, request: { channel: 'role'; roleId: RoleId; generation: number; capability: string; command: AutomationCommand; input: unknown } | { channel: 'human'; capability: string; command: 'approvals' | 'respond' | 'takeover' | 'release' | 'lead-rotate'; input: unknown }): Promise<unknown> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const socket = createConnection(path); let buffer = '';
    const fail = (error: Error): void => { socket.destroy(); reject(error); };
    socket.setTimeout(30_000, () => fail(new CoordinatorError('RUNTIME_TIMEOUT', 'Coordinator request timed out; outcome is unknown.', 'Read durable state before repeating the operation.')));
    socket.on('error', () => fail(new CoordinatorError('RUNTIME_DISCONNECTED', 'Coordinator socket is unavailable.', 'Start or reconnect to the configured coordinator.')));
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, ...request })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 1024 * 1024) { fail(new Error('Coordinator response too large.')); return; }
      if (!buffer.includes('\n')) return;
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as { id?: string; ok?: boolean; result?: unknown; error?: { code: string; message: string; nextAction: string } };
        if (response.id !== id) throw new Error('Coordinator response ID mismatch.');
        socket.end();
        if (response.ok) resolve(response.result);
        else reject(new CoordinatorError(response.error?.code as CoordinatorErrorCode ?? 'INVALID_INPUT', response.error?.message ?? 'Coordinator rejected request.', response.error?.nextAction ?? 'Inspect current state.'));
      } catch (error) { fail(error as Error); }
    });
    socket.on('end', () => { if (!buffer.includes('\n')) fail(new CoordinatorError('RUNTIME_DISCONNECTED', 'Coordinator disconnected before returning a receipt.', 'Reconcile the operation before retrying.')); });
  });
}
