import { createConnection, createServer, type Server, type Socket } from 'node:net';
import type { IpcEndpoint } from './ipc-endpoint.js';

export interface IpcRequest {
  id: string;
  method: string;
  params?: unknown;
}

export interface IpcResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface JsonLineChannel {
  request(method: string, params?: unknown): Promise<unknown>;
  close(): void;
}

function address(endpoint: IpcEndpoint): string | { host: string; port: number } {
  return endpoint.type === 'named-pipe' ? endpoint.name : { host: endpoint.host, port: endpoint.port };
}

function attachProtocol(socket: Socket, onRequest?: (request: IpcRequest) => Promise<unknown>): JsonLineChannel {
  let buffer = '';
  let sequence = 0;
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as IpcResponse | IpcRequest;
      if ('ok' in message) {
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        if (message.ok) waiter.resolve(message.result);
        else waiter.reject(new Error(message.error ?? 'IPC request failed.'));
      } else if (onRequest) {
        void onRequest(message).then(
          (result) => socket.write(`${JSON.stringify({ id: message.id, ok: true, result } satisfies IpcResponse)}\n`),
          (error: unknown) => socket.write(`${JSON.stringify({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies IpcResponse)}\n`)
        );
      }
    }
  });
  const rejectPending = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  socket.on('error', rejectPending);
  socket.on('close', () => rejectPending(new Error('IPC connection closed.')));
  return {
    request(method, params) {
      const id = `${Date.now()}-${sequence++}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.write(`${JSON.stringify({ id, method, params } satisfies IpcRequest)}\n`, (error) => {
          if (error) { pending.delete(id); reject(error); }
        });
      });
    },
    close() { socket.end(); }
  };
}

export async function listenJsonLine(endpoint: IpcEndpoint, onRequest: (request: IpcRequest) => Promise<unknown>): Promise<Server> {
  const server = createServer((socket) => { attachProtocol(socket, onRequest); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(address(endpoint), () => { server.removeListener('error', reject); resolve(); });
  });
  return server;
}

export async function connectJsonLine(endpoint: IpcEndpoint): Promise<JsonLineChannel> {
  const socket = endpoint.type === 'named-pipe'
    ? createConnection(endpoint.name)
    : createConnection(endpoint.port, endpoint.host);
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.once('connect', () => { socket.removeListener('error', reject); resolve(); });
  });
  return attachProtocol(socket);
}
