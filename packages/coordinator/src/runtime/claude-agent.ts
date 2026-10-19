import { randomUUID } from 'node:crypto';
import type { ModelCapability } from '../config.js';
import { CoordinatorError } from '../errors.js';
import { listPromptUuids, readClaudeTurnModel } from './claude-evidence.js';
import type { ClaudeTurnJournal, ClaudeTurnStatus } from './claude-journal.js';
import type { TurnModelEvidence } from './model-evidence.js';
import type { Runtime, RuntimeEvent, TurnInput, TurnReceipt, TurnUsage } from './types.js';

export const CLAUDE_APPROVAL_METHOD = 'claude/canUseTool';
export interface ClaudeMessage { type: string; subtype?: string; [key: string]: unknown; }
export interface ClaudeModelInfo { value: string; resolvedModel?: string; supportsEffort?: boolean; supportedEffortLevels?: string[]; }
export interface ClaudeQueryHandle extends AsyncIterable<ClaudeMessage> { interrupt(): Promise<unknown>; supportedModels(): Promise<ClaudeModelInfo[]>; }
export type ClaudeQueryFn = (params: { prompt: string | AsyncIterable<never>; options: Record<string, unknown> }) => ClaudeQueryHandle;
export interface ClaudeRuntimeOptions { query: ClaudeQueryFn; journal: ClaudeTurnJournal; baseOptions: Record<string, unknown>; transcriptRoot: string; interruptTimeoutMs?: number; }
type PermissionResult = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string; interrupt?: boolean };
interface PendingApproval { turnId: string; input: Record<string, unknown>; resolve(result: PermissionResult): void; }
interface ActiveTurn { handle: ClaudeQueryHandle; abortController: AbortController; threadId: string; }

const text = (value: unknown): string | null => typeof value === 'string' && value.length <= 512 ? value : null;
const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
function bounded(input: Record<string, unknown>): Record<string, unknown> { const raw = JSON.stringify(input); return raw.length <= 4000 ? input : { truncated: raw.slice(0, 4000) }; }
// A field is known only if every model entry reports it; a missing value is never counted as zero.
export function usageFrom(modelUsage: unknown): Pick<TurnUsage, 'inputTokens' | 'outputTokens' | 'cachedInputTokens'> {
  const entries = modelUsage && typeof modelUsage === 'object' ? Object.values(modelUsage as Record<string, Record<string, unknown>>) : [];
  if (!entries.length) return { inputTokens: null, outputTokens: null, cachedInputTokens: null };
  const sum = (pick: (entry: Record<string, unknown>) => number | null): number | null => entries.reduce<number | null>((total, entry) => { const value = pick(entry); return total === null || value === null ? null : total + value; }, 0);
  return {
    inputTokens: sum((entry) => count(entry.inputTokens)),
    outputTokens: sum((entry) => count(entry.outputTokens)),
    cachedInputTokens: sum((entry) => { const read = count(entry.cacheReadInputTokens), created = count(entry.cacheCreationInputTokens); return read === null || created === null ? null : read + created; })
  };
}
async function* idle(signal: AbortSignal): AsyncGenerator<never> { await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); }

export class ClaudeAgentRuntime implements Runtime {
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly serverRequestListeners = new Set<(event: RuntimeEvent) => void>();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly approvals = new Map<string, PendingApproval>();
  private models?: ModelCapability[];
  constructor(private readonly options: ClaudeRuntimeOptions) {}
  onEvent(listener: (event: RuntimeEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onServerRequest(listener: (event: RuntimeEvent) => void): () => void { this.serverRequestListeners.add(listener); return () => this.serverRequestListeners.delete(listener); }
  async initialize(): Promise<void> {}
  async listModels(): Promise<ModelCapability[]> {
    if (this.models) return this.models;
    const abortController = new AbortController();
    const handle = this.options.query({ prompt: idle(abortController.signal), options: { ...this.options.baseOptions, abortController } });
    try {
      const listed = await handle.supportedModels();
      this.models = listed.flatMap((entry) => {
        const efforts = entry.supportsEffort === false ? [] : entry.supportedEffortLevels ?? [];
        return [...new Set([entry.value, entry.resolvedModel].filter((id): id is string => Boolean(id)))].map((model) => ({ model, efforts: [...efforts] }));
      });
      return this.models;
    } finally { abortController.abort(); }
  }
  async startThread(cwd: string): Promise<string> { const threadId = randomUUID(); this.options.journal.createThread(threadId, cwd); return threadId; }
  async resumeThread(threadId: string, cwd: string): Promise<string> {
    const thread = this.options.journal.thread(threadId);
    if (!thread || thread.cwd !== cwd) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Runtime resumed an unexpected Claude session.', 'Inspect the original persisted session before proceeding.');
    this.options.journal.markOrphans(threadId, new Set(this.active.keys()));
    return threadId;
  }
  async readThread(threadId: string): Promise<unknown> {
    if (!this.options.journal.thread(threadId)) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Complete runtime turn history is unavailable.', 'Read the original Claude session journal before changing work state.');
    const turns = this.options.journal.turns(threadId);
    return { thread: { id: threadId, status: { type: turns.some((turn) => turn.status === 'inProgress') ? 'active' : 'idle' }, turns } };
  }
  async readTurnModel(threadId: string, turnId: string): Promise<TurnModelEvidence | undefined> {
    const row = this.options.journal.turn(turnId);
    if (row?.threadId !== threadId) return undefined;
    // The SDK result may omit the prompt uuid; the session only receives coordinator prompts, so the n-th turn is the n-th prompt.
    let promptUuid = row.promptUuid;
    if (!promptUuid) { const index = this.options.journal.turnIndex(turnId); const prompts = index ? await listPromptUuids(this.options.transcriptRoot, threadId) : undefined; promptUuid = prompts?.[index! - 1] ?? null; }
    return promptUuid ? readClaudeTurnModel(this.options.transcriptRoot, threadId, promptUuid) : undefined;
  }
  async readTurnUsage(threadId: string, turnId: string): Promise<TurnUsage | undefined> {
    const row = this.options.journal.turn(turnId);
    if (row?.threadId !== threadId || row.status !== 'completed') return undefined;
    return { inputTokens: row.inputTokens, outputTokens: row.outputTokens, cachedInputTokens: row.cachedInputTokens, costUsd: row.costUsd, source: 'claude_result' };
  }
  async startTurn(turn: TurnInput): Promise<TurnReceipt> {
    const thread = this.options.journal.thread(turn.threadId);
    if (!thread) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Claude session is not known to this runtime.', 'Initialize the role before starting work.');
    if (this.options.journal.turns(turn.threadId).some((item) => item.status === 'inProgress')) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Runtime already has an active turn.', 'Reconcile before automatic execution.');
    const turnId = randomUUID(); const abortController = new AbortController();
    this.options.journal.startTurn({ threadId: turn.threadId, turnId, requestedModel: turn.model, requestedEffort: turn.effort });
    const session = thread.materialized ? { resume: turn.threadId } : { sessionId: turn.threadId };
    let handle: ClaudeQueryHandle;
    try { handle = this.options.query({ prompt: turn.input, options: { ...this.options.baseOptions, cwd: turn.cwd, model: turn.model, effort: turn.effort, abortController, canUseTool: this.permission(turn.threadId, turnId), ...session } }); }
    catch { this.options.journal.update(turnId, { status: 'failed', error: 'Claude runtime could not start.' }); throw new CoordinatorError('PROVIDER_UNAVAILABLE', 'Claude runtime could not start a turn.', 'Check local Claude authentication and provider availability.'); }
    this.options.journal.markMaterialized(turn.threadId);
    this.active.set(turnId, { handle, abortController, threadId: turn.threadId });
    void this.consume(turn.threadId, turnId, handle);
    return { threadId: turn.threadId, turnId, requestedModel: turn.model, requestedEffort: turn.effort, status: 'started' };
  }
  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const active = this.active.get(turnId);
    if (!active || active.threadId !== threadId) return;
    await Promise.race([active.handle.interrupt().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, this.options.interruptTimeoutMs ?? 5000))]);
    if (this.active.has(turnId)) active.abortController.abort();
  }
  async respondToServerRequest(requestId: string | number, result: { decision: 'accept' | 'decline' | 'cancel' }): Promise<void> {
    const pending = this.approvals.get(String(requestId));
    if (!pending) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Claude approval request is no longer pending.', 'Inspect the current runtime request; never replay an approval blindly.');
    pending.resolve(result.decision === 'accept' ? { behavior: 'allow', updatedInput: pending.input } : { behavior: 'deny', message: 'Declined by the human reviewer.', interrupt: result.decision === 'cancel' });
  }
  private emit(event: Omit<RuntimeEvent, 'source'>): void { for (const listener of this.listeners) listener({ ...event, source: 'claude_agent' }); }
  private permission(threadId: string, turnId: string) {
    return (toolName: string, input: Record<string, unknown>, context: { signal: AbortSignal }): Promise<PermissionResult> => new Promise((resolve) => {
      const requestId = randomUUID();
      const finish = (result: PermissionResult) => { if (this.approvals.delete(requestId)) resolve(result); };
      this.approvals.set(requestId, { turnId, input, resolve: finish });
      context.signal.addEventListener('abort', () => finish({ behavior: 'deny', message: 'Approval aborted.' }), { once: true });
      const event: RuntimeEvent = { method: CLAUDE_APPROVAL_METHOD, requestId, threadId, turnId, source: 'claude_agent', params: { threadId, turnId, toolName, input: bounded(input) } };
      for (const listener of this.serverRequestListeners) listener(event);
    });
  }
  private async consume(threadId: string, turnId: string, handle: ClaudeQueryHandle): Promise<void> {
    const journal = this.options.journal;
    let terminal: ClaudeTurnStatus = 'unknown';
    this.emit({ method: 'turn/started', threadId, turnId, params: { threadId, turnId } });
    try {
      for await (const message of handle) {
        if (message.type === 'system' && message.subtype === 'init') journal.update(turnId, { initModel: text(message.model), apiKeySource: text(message.apiKeySource) });
        else if (message.type === 'assistant') this.emit({ method: 'item/completed', threadId, turnId, params: { threadId, turnId } });
        else if (message.type === 'result') {
          terminal = message.subtype === 'success' && message.is_error !== true ? 'completed' : 'failed';
          journal.update(turnId, { status: terminal, promptUuid: text(message.user_message_uuid), costUsd: count(message.total_cost_usd), ...usageFrom(message.modelUsage), error: terminal === 'failed' ? text(message.subtype) ?? 'result_error' : null });
        }
      }
      if (terminal === 'unknown') journal.update(turnId, { status: 'unknown', error: 'Stream ended without a result message.' });
    } catch {
      const aborted = this.active.get(turnId)?.abortController.signal.aborted === true;
      terminal = aborted ? 'interrupted' : 'unknown';
      journal.update(turnId, { status: terminal, error: aborted ? 'Interrupted by coordinator.' : 'Claude runtime stream failed; outcome unknown.' });
      if (!aborted) this.emit({ method: 'error', threadId, turnId, params: { threadId, turnId } });
    } finally {
      this.active.delete(turnId);
      for (const [id, pending] of this.approvals) if (pending.turnId === turnId) { this.approvals.delete(id); pending.resolve({ behavior: 'deny', message: 'Turn ended before approval.' }); }
      this.emit({ method: 'turn/completed', threadId, turnId, params: { threadId, turnId, status: terminal } });
    }
  }
}
