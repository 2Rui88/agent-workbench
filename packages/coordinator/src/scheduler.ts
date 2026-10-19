import { randomUUID } from 'node:crypto';
import { CoordinatorError } from './errors.js';
import type { RoleId } from './protocol.js';
import { ROLE_IDS, type AgentKind } from './roles.js';
import type { TaskBinding } from './integrations/adapters.js';

export interface ExecutionPackage {
  id: string;
  roleId: RoleId;
  goal: string;
  taskRef: string;
  repository: string;
  worktree: string;
  allowedPaths: string[];
  baseline: string;
  contractRef: string;
  acceptanceCriteria: string[];
  verificationCommands: string[];
  dependencies: string[];
  risk: number;
  evidenceFailures: number;
  paused: boolean;
  replacesDispatchId?: string | undefined;
  taskBinding?: TaskBinding;
  contractRevision?: string;
  model?: { model: string; effort: string; tier: string; reason: string };
  agent?: AgentKind;
}

export interface ScheduledWork extends ExecutionPackage { groupId: string; dispatchId: string; queuedAt: number; }
export interface StartedWork extends ScheduledWork { turnId: string; startedAt: number; }

export interface SchedulerPersistence {
  loadSchedulerSnapshot(groupId: string): unknown | undefined;
  saveSchedulerSnapshot(groupId: string, payload: unknown): void;
}

interface SchedulerSnapshot {
  queues: ScheduledWork[];
  active: StartedWork[];
  uncertain: ScheduledWork[];
  starting: ScheduledWork[];
}

const workerRoles: Array<RoleId> = [...ROLE_IDS];

export class CooperativeScheduler {
  private readonly online = new Set<RoleId>();
  private readonly queues = new Map<RoleId, ScheduledWork[]>(workerRoles.map((role) => [role, []]));
  private readonly active = new Map<RoleId, StartedWork>();
  private readonly starting = new Map<RoleId, ScheduledWork>();
  private readonly uncertain = new Map<RoleId, ScheduledWork>();
  private readonly loadedGroups = new Set<string>();

  constructor(private readonly persistence?: SchedulerPersistence) {}

  setOnline(role: RoleId, online: boolean): void {
    if (online) this.online.add(role); else this.online.delete(role);
  }

  enqueue(work: ExecutionPackage, groupId = 'default', dispatchId: string = randomUUID()): ScheduledWork {
    this.loadGroup(groupId);
    const existing = [
      ...(this.queues.get(work.roleId) ?? []),
      ...(this.active.has(work.roleId) ? [this.active.get(work.roleId)!] : []),
      ...(this.uncertain.has(work.roleId) ? [this.uncertain.get(work.roleId)!] : [])
    ].find((item) => item.dispatchId === dispatchId);
    if (existing) return existing;
    if (this.queues.get(work.roleId)?.some((item) => item.id === work.id) || this.active.get(work.roleId)?.id === work.id) {
      throw new CoordinatorError('INVALID_INPUT', 'Execution package ID already exists for this role.', 'Use a unique dispatch ID.');
    }
    const scheduled = { ...work, groupId, dispatchId, queuedAt: Date.now() };
    this.queues.get(work.roleId)!.push(scheduled);
    this.persistGroup(groupId);
    return scheduled;
  }

  pending(role: RoleId): number { return this.queues.get(role)?.length ?? 0; }
  activeWork(role: RoleId): StartedWork | undefined { return this.active.get(role); }
  reconciliationNeeded(role: RoleId): ScheduledWork | undefined { return this.uncertain.get(role); }

  async tick(groupId: string, startTurn: (work: ScheduledWork) => Promise<{ turnId: string }>): Promise<StartedWork[]> {
    this.loadGroup(groupId);
    if (!this.online.has('lead')) throw new CoordinatorError('LEAD_OFFLINE', 'Lead is offline; new dispatch is blocked.', 'Restore the lead role before dispatching new work.');
    const ready = workerRoles.flatMap((role) => {
      if (!this.online.has(role) || this.active.has(role) || this.starting.has(role) || this.uncertain.has(role)) return [];
      const queue = this.queues.get(role)!;
      const index = queue.findIndex((work) => work.groupId === groupId && !work.paused);
      if (index < 0) return [];
      const work = queue.splice(index, 1)[0]!;
      this.starting.set(role, work);
      this.persistGroup(groupId);
      return [{ role, work }];
    });
    return Promise.all(ready.map(async ({ role, work }) => {
      try {
        const receipt = await startTurn(work);
        const active: StartedWork = { ...work, turnId: receipt.turnId, startedAt: Date.now() };
        this.active.set(role, active);
        this.starting.delete(role);
        this.persistGroup(groupId);
        return active;
      } catch (error) {
        this.starting.delete(role);
        if (error instanceof CoordinatorError && ['RUNTIME_TIMEOUT', 'RUNTIME_DISCONNECTED'].includes(error.code)) this.uncertain.set(role, work);
        else this.queues.get(role)!.unshift(work);
        this.persistGroup(groupId);
        throw error;
      }
    }));
  }

  reconcile(role: RoleId, outcome: 'not_started' | 'started' | 'completed' | 'unknown', evidence: string, turnId?: string): void {
    const work = this.uncertain.get(role);
    if (!work || !evidence.trim()) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Dispatch has no reconciliation record or evidence.', 'Inspect the App Server thread and turn before changing dispatch state.');
    if (outcome === 'unknown') return;
    if (outcome === 'started' && !turnId) throw new CoordinatorError('INVALID_INPUT', 'A started turn reconciliation requires its turn ID.', 'Read the turn ID from App Server thread state.');
    this.uncertain.delete(role);
    if (outcome === 'not_started') this.queues.get(role)!.unshift(work);
    if (outcome === 'started') {
      this.active.set(role, { ...work, turnId: turnId!, startedAt: Date.now() });
    }
    this.persistGroup(work.groupId);
  }

  complete(role: RoleId, turnId: string): void {
    const active = this.active.get(role);
    if (!active || active.turnId !== turnId) throw new CoordinatorError('STALE_LEASE', 'Turn receipt does not match the active dispatch.', 'Reconcile the active turn before completing work.');
    this.active.delete(role);
    this.persistGroup(active.groupId);
  }

  private loadGroup(groupId: string): void {
    if (this.loadedGroups.has(groupId)) return;
    this.loadedGroups.add(groupId);
    const raw = this.persistence?.loadSchedulerSnapshot(groupId);
    if (!raw || typeof raw !== 'object') return;
    const snapshot = raw as Partial<SchedulerSnapshot>;
    for (const work of snapshot.queues ?? []) this.queues.get(work.roleId)?.push(work);
    for (const work of snapshot.active ?? []) this.active.set(work.roleId, work);
    for (const work of snapshot.uncertain ?? []) this.uncertain.set(work.roleId, work);
    // A process may have died after the runtime accepted turn/start. Never retry blindly.
    for (const work of snapshot.starting ?? []) this.uncertain.set(work.roleId, work);
  }

  private persistGroup(groupId: string): void {
    if (!this.persistence) return;
    const belongs = (work: ScheduledWork): boolean => work.groupId === groupId;
    const snapshot: SchedulerSnapshot = {
      queues: [...this.queues.values()].flat().filter(belongs),
      active: [...this.active.values()].filter(belongs),
      uncertain: [...this.uncertain.values()].filter(belongs),
      starting: [...this.starting.values()].filter(belongs)
    };
    this.persistence.saveSchedulerSnapshot(groupId, snapshot);
  }
}
