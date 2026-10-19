export interface DashboardSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  source: 'coordinator_sqlite';
  groupId: string;
  groupStatus: string;
  roles: Array<{
    roleId: string; threadId: string | null; worktreePath: string | null;
    bindingGeneration: number; queued: number; online: boolean;
    staleApprovals?: number;
    controlOwner: 'human' | 'automatic'; waitingHuman: number;
    dispatches: Array<{ dispatchId: string; workId: string; state: string;
      requestedModel: string | null; requestedEffort: string | null;
      actualModel: string | null; actualEffort?: string | null; actualModelSource?:string|null; turnId: string | null; replacesDispatchId?: string | null;
      queuedAt?: string | null; startedAt?: string | null; completedAt?: string | null; durationMs?: number | null }>;
  }>;
  messageCounts: Record<string, number>;
  contracts: Array<{ artifactRef: string; revision: string; baselineRef: string; compatibility: string }>;
  audits: Array<{ validationId: string; contractRef: string; baselineRef: string; cycle: number; state: string }>;
  budget: { source: string; callsUsed: number; inFlight: number; unknown: number } | null;
  lead: { mode: 'external' | 'managed' | 'unknown'; sessionRef: string | null; expiresAt: string | null };
  totals: { dispatches: number; contracts: number; audits: number };
  truncated: boolean;
  runtime: { observedAt: string; source: string; leadMode: string; blocks: Record<string, string>;
    limits: { maxCalls: number; maxConcurrent: number }; grantExpiresAt: string | null } | null;
}
