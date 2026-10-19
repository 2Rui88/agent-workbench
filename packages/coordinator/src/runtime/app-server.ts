import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import type { ModelCapability } from '../config.js';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {readTurnModel,type TurnModelEvidence} from './model-evidence.js';
import { CoordinatorError } from '../errors.js';
import type { Runtime, RuntimeEvent, TurnInput, TurnReceipt, TurnUsage } from './types.js';
import { CODEX_USAGE_METHOD, codexUsageFromNotification, type UsageCounters } from './turn-usage.js';

interface Pending { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout; }
interface JsonRpcMessage { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: { message?: string; code?: number }; }
export interface ThreadPolicy { sandbox: 'read-only' | 'workspace-write'; approvalPolicy: 'on-request'; approvalsReviewer: 'user'; developerInstructions?: string; }
interface AppServerOptions { input: Readable; output: Writable; requestTimeoutMs?: number; threadPolicy?: ThreadPolicy; }

export interface LocalAppServerHandle {
  runtime: AppServerRuntime;
  close(): Promise<void>;
}

export function startLocalAppServer(cwd: string, launch?: { args: string[]; env: NodeJS.ProcessEnv; threadPolicy: ThreadPolicy }): LocalAppServerHandle {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'CODEX_HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const child = spawn('codex', launch?.args ?? ['app-server', '--listen', 'stdio://'], { cwd, env: launch?.env ?? env, stdio: ['pipe', 'pipe', 'pipe'] });
  const runtime = new AppServerRuntime({ input: child.stdout, output: child.stdin, ...(launch ? { threadPolicy: launch.threadPolicy } : {}) });
  child.stderr.resume();
  child.on('error', (error) => runtime.disconnect(error));
  child.on('exit', (code, signal) => runtime.disconnect(new Error(`App Server exited (${code ?? signal ?? 'unknown'}).`)));
  return {
    runtime,
    async close() {
      runtime.dispose();
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          once(child, 'exit'),
          new Promise<void>((resolve) => setTimeout(resolve, 3000))
        ]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }
  };
}

export class AppServerRuntime implements Runtime {
  private readonly rolloutPaths = new Map<string,string>();
  // Per turn: cumulative total before the turn (first total minus its own last) and the latest total.
  private readonly turnUsage = new Map<string,{threadId:string;baseline:UsageCounters;latest:UsageCounters}>();
  private readonly untouchedThreads = new Set<string>();
  private readonly pending = new Map<string | number, Pending>();
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly serverRequestListeners = new Set<(event: RuntimeEvent) => void>();
  private nextId = 1;
  private closed = false;
  private readonly timeoutMs: number;

  constructor(private readonly streams: AppServerOptions) {
    this.timeoutMs = streams.requestTimeoutMs ?? 30_000;
    const lines = createInterface({ input: streams.input, crlfDelay: Infinity });
    lines.on('line', (line) => this.onLine(line));
    streams.input.on('error', (error) => this.disconnect(error));
    streams.input.on('close', () => this.disconnect(new Error('App Server output closed.')));
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onServerRequest(listener: (event: RuntimeEvent) => void): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) throw new CoordinatorError('RUNTIME_DISCONNECTED', 'App Server is disconnected.', 'Reconnect and reconcile in-flight turns before retrying.');
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CoordinatorError('RUNTIME_TIMEOUT', `App Server request timed out: ${method}`, 'Reconcile thread and turn state before retrying.'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try { await this.write({ jsonrpc: '2.0', id, method, params }); }
    catch (error) {
      const pending = this.pending.get(id);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(id); }
      throw error;
    }
    return promise;
  }

  async respondToServerRequest(requestId: string | number, result: unknown): Promise<void> {
    await this.write({ jsonrpc: '2.0', id: requestId, result });
  }

  async rejectServerRequest(requestId: string | number, code: number, message: string): Promise<void> {
    await this.write({ jsonrpc: '2.0', id: requestId, error: { code, message } });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) throw new Error('App Server is disconnected.');
    await this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'codex-session-coordinator', version: '0.1.0' } });
    await this.notify('initialized');
  }

  async listModels(): Promise<ModelCapability[]> {
    const result = await this.request('model/list', {}) as { data?: Array<{ model?: string; id?: string; supportedReasoningEfforts?: Array<{ reasoningEffort?: string } | string>; efforts?: string[] }> };
    return (result.data ?? []).flatMap((entry) => {
      const model = entry.model ?? entry.id;
      if (!model) return [];
      const efforts = entry.efforts ?? (entry.supportedReasoningEfforts ?? []).map((effort) => typeof effort === 'string' ? effort : effort.reasoningEffort).filter((effort): effort is string => Boolean(effort));
      return [{ model, efforts }];
    });
  }

  async startThread(cwd: string): Promise<string> {
    const result = await this.request('thread/start', { cwd, ...this.streams.threadPolicy }) as { thread?: { id?: string }; threadId?: string };
    const id = result.thread?.id ?? result.threadId;
    if (!id) throw new Error('thread/start did not return a thread ID.');
    this.untouchedThreads.add(id);
    return id;
  }

  async resumeThread(threadId: string, cwd: string): Promise<string> {
    const result = await this.request('thread/resume', { threadId, cwd, ...this.streams.threadPolicy }) as { thread?: { id?: string }; threadId?: string };
    const resumed=result.thread?.id??result.threadId;
    if(resumed!==threadId)throw new CoordinatorError('RECONCILIATION_REQUIRED','Runtime resumed an unexpected thread.','Inspect the original persisted thread before proceeding.');
    return resumed;
  }

  async readThread(threadId: string): Promise<unknown> {
    const response = await this.request('thread/read', { threadId, includeTurns: false }) as {thread?:{id?:string;path?:string|null;status?:{type?:string}}};
    if(response?.thread?.id!==threadId)throw this.historyUnavailable();
    if(typeof response.thread.path==='string')this.rolloutPaths.set(threadId,response.thread.path);
    const turns:Array<{id:string;status:string}>=[];
    const seen=new Set<string>();let cursor:string|undefined;
    for(let page=0;page<100;page++){
      let result:unknown;
      try{result=await this.request('thread/turns/list',{threadId,limit:100,sortDirection:'asc',itemsView:'notLoaded',...(cursor?{cursor}:{})});}
      catch(error){
        const beforeFirstMessage=`thread ${threadId} is not materialized yet; thread/turns/list is unavailable before first user message`;
        if(page===0&&this.untouchedThreads.has(threadId)&&response.thread.status?.type==='idle'&&error instanceof Error&&error.message===beforeFirstMessage)return {thread:{...response.thread,turns:[]}};
        throw this.historyUnavailable();
      }
      const value=result as {data?:unknown[];nextCursor?:unknown};
      if(!value||!Array.isArray(value.data)||!(value.nextCursor===null||typeof value.nextCursor==='string'))throw this.historyUnavailable();
      for(const item of value.data){
        const turn=item as {id?:unknown;status?:unknown};
        if(!turn||typeof turn.id!=='string'||typeof turn.status!=='string')throw this.historyUnavailable();
        turns.push({id:turn.id,status:turn.status});
      }
      if(value.nextCursor===null)return{thread:{...response.thread,turns}};
      if(!value.nextCursor||seen.has(value.nextCursor))throw this.historyUnavailable();
      seen.add(value.nextCursor);cursor=value.nextCursor;
    }
    throw this.historyUnavailable();
  }

  async readTurnModel(threadId:string,turnId:string):Promise<TurnModelEvidence|undefined> {
    const path=this.rolloutPaths.get(threadId);
    return path?readTurnModel(path,join(process.env.CODEX_HOME??join(homedir(),'.codex'),'sessions'),threadId,turnId):undefined;
  }

  private historyUnavailable():CoordinatorError{return new CoordinatorError('RECONCILIATION_REQUIRED','Complete runtime turn history is unavailable.','Read metadata and every thread/turns/list page; never infer empty history from a failed read.');}

  async startTurn(turn: TurnInput): Promise<TurnReceipt> {
    this.untouchedThreads.delete(turn.threadId);
    const result = await this.request('turn/start', { threadId: turn.threadId, input: [{ type: 'text', text: turn.input }], cwd: turn.cwd, model: turn.model, effort: turn.effort }) as { turn?: { id?: string; status?: string }; turnId?: string };
    const receipt = result.turn;
    const turnId = receipt?.id ?? result.turnId;
    if (!turnId) throw new Error('turn/start did not return a turn ID.');
    return { threadId: turn.threadId, turnId, requestedModel: turn.model, requestedEffort: turn.effort, status: receipt?.status ?? 'started' };
  }

  async readTurnUsage(threadId: string, turnId: string): Promise<TurnUsage | undefined> {
    const usage = this.turnUsage.get(turnId);
    if (!usage || usage.threadId !== threadId) return undefined;
    return { inputTokens: usage.latest.inputTokens - usage.baseline.inputTokens, cachedInputTokens: usage.latest.cachedInputTokens - usage.baseline.cachedInputTokens, outputTokens: usage.latest.outputTokens - usage.baseline.outputTokens, costUsd: null, source: 'codex_notification' };
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request('turn/interrupt', { threadId, turnId });
  }

  disconnect(reason: Error = new Error('App Server disconnected.')): void {
    if (this.closed) return;
    this.closed = true;
    const failure = reason instanceof CoordinatorError ? reason : new CoordinatorError('RUNTIME_DISCONNECTED', reason.message, 'Reconnect and reconcile in-flight turns before retrying.');
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(failure);
      this.pending.delete(id);
    }
  }

  dispose(): void { this.disconnect(); }

  private onLine(line: string): void {
    let message: JsonRpcMessage;
    try { message = JSON.parse(line) as JsonRpcMessage; } catch { this.disconnect(new Error('Invalid JSON from App Server.')); return; }
    if (message.id !== undefined && !message.method && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? `App Server error ${message.error.code ?? 'unknown'}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === CODEX_USAGE_METHOD) {
      const usage = codexUsageFromNotification(message.params);
      if (usage) {
        const known = this.turnUsage.get(usage.turnId);
        const baseline = known?.baseline ?? { inputTokens: usage.total.inputTokens - usage.last.inputTokens, cachedInputTokens: usage.total.cachedInputTokens - usage.last.cachedInputTokens, outputTokens: usage.total.outputTokens - usage.last.outputTokens };
        this.turnUsage.set(usage.turnId, { threadId: usage.threadId, baseline, latest: usage.total });
      }
    }
    if (message.method) {
      const params = message.params as { threadId?: string; turnId?: string; turn?: {id?:string} } | undefined;
      const turnId = params?.turnId ?? params?.turn?.id;
      const event: RuntimeEvent = { method: message.method, params: message.params, source: 'app_server', ...(params?.threadId ? { threadId: params.threadId } : {}), ...(turnId ? { turnId } : {}), ...(message.id === undefined ? {} : { requestId: message.id }) };
      const listeners = message.id === undefined ? this.listeners : this.serverRequestListeners;
      for (const listener of listeners) listener(event);
    }
  }

  private async write(message: Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    if (!this.streams.output.write(line)) await once(this.streams.output, 'drain');
  }
}
