import type { TurnModelEvidence } from './model-evidence.js';
import type { ModelCapability } from '../config.js';

export interface TurnInput { threadId: string; input: string; model: string; effort: string; cwd: string; }
export interface RuntimeEvent { threadId?: string; turnId?: string; requestId?: string | number; method: string; params: unknown; source: 'app_server' | 'mock' | 'claude_agent'; }
export interface TurnUsage { inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; costUsd: number | null; source: 'claude_result' | 'codex_notification'; }
export interface TurnReceipt { threadId: string; turnId: string; requestedModel: string; requestedEffort: string; actualModel?: string; status: string; }
export interface Runtime {
  initialize(): Promise<void>;
  listModels(): Promise<ModelCapability[]>;
  startThread(cwd: string): Promise<string>;
  resumeThread(threadId: string, cwd: string): Promise<string>;
  readThread(threadId: string): Promise<unknown>;
  readTurnModel?(threadId:string,turnId:string):Promise<TurnModelEvidence|undefined>;
  readTurnUsage?(threadId: string, turnId: string): Promise<TurnUsage | undefined>;
  startTurn(input: TurnInput): Promise<TurnReceipt>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
}
export interface ManagedRuntime { runtime: Runtime; close(): Promise<void>; }
