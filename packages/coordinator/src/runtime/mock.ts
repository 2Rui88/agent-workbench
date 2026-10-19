import { randomUUID } from 'node:crypto';
import type { TurnModelEvidence } from './model-evidence.js';
import type { ModelCapability } from '../config.js';
import type { Runtime, TurnInput, TurnReceipt } from './types.js';

export class MockRuntime implements Runtime {
  readonly providerCalls = 0;
  private readonly threads = new Map<string, string>();
  private readonly turns = new Map<string, TurnReceipt>();

  async initialize(): Promise<void> {}
  async listModels(): Promise<ModelCapability[]> {
    return [
      { model: 'gpt-6-luna', efforts: ['low', 'medium', 'high', 'xhigh'] },
      { model: 'gpt-6.1-sol', efforts: ['low', 'medium', 'high', 'xhigh'] },
      { model: 'gpt-6-astra', efforts: ['low', 'medium', 'high', 'xhigh', 'ultra'] }
    ];
  }
  async startThread(cwd: string): Promise<string> { const id = randomUUID(); this.threads.set(id, cwd); return id; }
  async resumeThread(threadId: string, cwd: string): Promise<string> { this.threads.set(threadId, cwd); return threadId; }
  async readThread(threadId: string): Promise<unknown> { return { threadId, cwd: this.threads.get(threadId), turns: [...this.turns.values()].filter((turn) => turn.threadId === threadId) }; }
  async readTurnModel(_threadId:string,_turnId:string):Promise<TurnModelEvidence|undefined>{return undefined;}
  async startTurn(input: TurnInput): Promise<TurnReceipt> {
    if (!this.threads.has(input.threadId)) throw new Error('Mock thread not found.');
    const receipt = { threadId: input.threadId, turnId: randomUUID(), requestedModel: input.model, requestedEffort: input.effort, status: 'completed' };
    this.turns.set(receipt.turnId, receipt);
    return receipt;
  }
  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const turn = this.turns.get(turnId);
    if (turn?.threadId === threadId) this.turns.set(turnId, { ...turn, status: 'interrupted' });
  }
}
