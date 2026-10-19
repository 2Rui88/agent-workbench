import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';

export interface HerdrTransport { request(method: string, params: Record<string, unknown>): Promise<any>; }
export interface HerdrContext { socketPath: string; leadPane: string; tabId: string; workspaceId: string; }
export function requireHerdrContext(env: NodeJS.ProcessEnv): HerdrContext {
  if (env.HERDR_ENV !== '1') throw new Error('Run this entry point inside Herdr.');
  const { HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: leadPane, HERDR_TAB_ID: tabId, HERDR_WORKSPACE_ID: workspaceId } = env;
  if (!socketPath || !leadPane || !tabId || !workspaceId) throw new Error('Herdr caller context needs explicit socket, pane, tab and workspace IDs.');
  return {socketPath, leadPane, tabId, workspaceId};
}

export class HerdrClient implements HerdrTransport {
  constructor(private readonly socketPath: string, private readonly timeoutMs = 5000) {}
  request(method: string, params: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = randomUUID(); const socket = createConnection(this.socketPath);
      let buffer = ''; let settled = false;
      const finish = (error: Error | null, result?: unknown) => {
        if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error(`Herdr ${method} timed out; outcome unknown, inspect before retry.`)), this.timeoutMs);
      socket.on('connect', () => socket.write(JSON.stringify({id, method, params}) + '\n'));
      socket.on('error', (error) => finish(error));
      socket.on('close', () => { if (!settled) finish(new Error('Herdr connection closed before response; outcome unknown.')); });
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        if (buffer.length > 2_000_000) { finish(new Error('Herdr response too large.')); return; }
        const end = buffer.indexOf('\n'); if (end < 0) return;
        try {
          const message = JSON.parse(buffer.slice(0,end)) as {id?: string; result?: unknown; error?: {code?:string;message?:string}};
          if (message.id !== id) throw new Error('Herdr response ID mismatch.');
          if (message.error) throw new Error(`Herdr ${message.error.code}: ${message.error.message}`);
          if (!('result' in message)) throw new Error('Herdr response has no result.');
          finish(null, message.result);
        } catch (error) { finish(error instanceof Error ? error : new Error('Invalid Herdr response.')); }
      });
    });
  }
}
