import type { DashboardSnapshot } from '../dashboard/contracts.js';
import type { HerdrTransport } from './herdr-client.js';
import { setTimeout as delay } from 'node:timers/promises';
import { OBSERVED_ROLES, type ObservedRole } from '../roles.js';
import { placeObserver } from './observer-layout.js';

export type WorkerRole = ObservedRole;
export type ObserverRole = WorkerRole | 'overview';
export const OBSERVER_LABELS: Record<ObserverRole, string> = { overview: '總覽', frontend: 'frontend', backend: 'backend', audit: 'audit', advisor: 'advisor' };
export const observerTabLabel = (groupId: string): string => `流水線協同 · ${groupId}`;
// What the role showed when the user closed its pane; only newer work reopens it.
export interface ClosedMarker { dispatchIds: string[]; waitingHuman: number; }
export interface LayoutState { closedAt: Partial<Record<WorkerRole, ClosedMarker>>; returned: string[]; }
// Everything the controller persists between runs: the observation tab, its overview pane and the role panes.
export interface HerdrLayoutState extends LayoutState { observerTab?: string; overviewPane?: string; panes: Partial<Record<WorkerRole, string>>; readyRoles: WorkerRole[]; }
export type LayoutEvent = { type: 'pane_closed_by_user' | 'pane_returned'; role: WorkerRole } | { type: 'tab_closed_by_user' | 'overview_closed_by_user' | 'tab_created'; tabId: string };
type Role = DashboardSnapshot['roles'][number];
interface Options { groupId: string; workspaceId: string; cwd: string; observerArgv(role: ObserverRole): string[]; save?(state: HerdrLayoutState): Promise<void>; onEvent?(event: LayoutEvent): void; }
const roles: WorkerRole[] = [...OBSERVED_ROLES];
// Role panes are created in this order so the fixed layout comes out the same every time: frontend splits the overview
// RIGHT first, so the right column runs the full height; advisor then splits only the left column DOWN.
const OPEN_ORDER: WorkerRole[] = ['frontend', 'advisor', 'backend', 'audit'];
// Herdr's split ratio is the fraction the target (first) pane keeps.
export const SPLIT_RATIOS = {
  // Overview keeps ~30% of the width; the right column (frontend/backend/audit) gets the rest.
  overviewRight: 0.3,
  // Overview and advisor share the narrow left column evenly.
  overviewDown: 0.5,
  // Frontend keeps a third when backend splits it; audit then halves backend, so the right column is in thirds.
  rightColumnThird: 0.33,
  rightColumnHalf: 0.5,
} as const;

export class ObserverTabClosed extends Error { constructor(message: string) { super(message); this.name = 'ObserverTabClosed'; } }

function activated(role: Role, snapshot: DashboardSnapshot): boolean {
  return role.waitingHuman > 0 || role.dispatches.some((d)=>['queued','starting','leased','active','needs_reconciliation'].includes(d.state)) || Boolean(snapshot.runtime?.blocks[role.roleId] && role.queued > 0);
}
function state(role: Role, snapshot: DashboardSnapshot): string {
  if (role.waitingHuman || snapshot.runtime?.blocks[role.roleId] || role.dispatches.some((d)=>d.state==='needs_reconciliation')) return 'blocked';
  if (role.dispatches.some((d)=>['active','starting','leased'].includes(d.state))) return 'working';
  const latest=role.dispatches.find(d=>d.state!=='cancelled');
  if (latest?.state==='failed') return 'failed';
  return 'idle';
}
export function closedMarker(role: Role | undefined): ClosedMarker { return { dispatchIds: role?.dispatches.map((d) => d.dispatchId) ?? [], waitingHuman: role?.waitingHuman ?? 0 }; }
export function reopenAllowed(marker: ClosedMarker | undefined, role: Role): boolean {
  return !marker || role.dispatches.some((d) => !marker.dispatchIds.includes(d.dispatchId)) || role.waitingHuman > marker.waitingHuman;
}
const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";

// Owns one Herdr tab ("流水線協同 · <group>") in the caller's workspace. The main session's tab is never touched.
export class HerdrController {
  private readonly owned: Partial<Record<WorkerRole,string>>;
  private readonly pending:Set<WorkerRole>;
  private readonly closedAt: Partial<Record<WorkerRole, ClosedMarker>>;
  private readonly returned: Set<string>;
  private tab: string | undefined;
  private overview: string | undefined;
  // The overview pane of a freshly created tab before its observer is verified; never persisted as ours until then.
  private overviewPending = false;
  private frozen = false;
  constructor(private readonly transport: HerdrTransport, private readonly options: Options, saved: Partial<HerdrLayoutState> = {}) {
    this.owned = {...saved.panes};
    const ids=Object.values(this.owned);
    if((saved.overviewPane&&ids.includes(saved.overviewPane))||new Set(ids).size!==ids.length)throw new Error('Invalid owned pane mapping; overview and role panes must remain distinct.');
    this.pending=new Set(roles.filter((role)=>this.owned[role]&&!(saved.readyRoles??[]).includes(role)));
    this.closedAt={...saved.closedAt};
    this.returned=new Set(saved.returned??[]);
    this.tab=saved.observerTab; this.overview=saved.overviewPane;
  }
  panes(): Partial<Record<WorkerRole,string>> { return {...this.owned}; }
  observerTab(): string | undefined { return this.tab; }
  layoutState(): HerdrLayoutState { return { ...(this.tab ? { observerTab: this.tab } : {}), ...(this.overview && !this.overviewPending ? { overviewPane: this.overview } : {}), panes: this.panes(), readyRoles: roles.filter((role)=>this.owned[role]&&!this.pending.has(role)), closedAt: {...this.closedAt}, returned: [...this.returned] }; }

  // Opens the observation tab with all five panes, or re-adopts a still-open tab whose overview observer is ours.
  // Every split happens before any observer starts: an observer launched into a pane that later shrinks would leave
  // its taller first frame behind as blank scrollback.
  async open(snapshot: DashboardSnapshot): Promise<string> {
    if (this.frozen) throw new Error('Herdr controller frozen; inspect persisted pane mapping before restarting.');
    if (snapshot.groupId !== this.options.groupId) throw new Error('Herdr group mismatch.');
    try {
      const inventory = await this.inventory();
      const alive = this.tab !== undefined && inventory.some((p) => p.tab_id === this.tab);
      if (!alive || !this.overview || !inventory.some((p) => p.pane_id === this.overview) || !await this.occupantMatches(this.overview, 'overview')) {
        if (alive) throw new Error('Saved observation tab is still open but its overview pane is not ours; close it before opening again.');
        await this.createTab();
      }
      await this.reconcileTopology(snapshot);
      const created: WorkerRole[] = [];
      for (const role of OPEN_ORDER) if (!this.owned[role]) { delete this.closedAt[role]; await this.splitPane(role); created.push(role); }
      if (this.overviewPending) { await this.occupy(this.overview!, 'overview'); this.overviewPending = false; await this.save(); }
      for (const role of created) await this.occupyPending(role);
      await this.save();
      return this.tab!;
    } catch (error) { this.frozen = true; throw error; }
  }
  // Creates the tab and records it; the root pane becomes the (still pending) overview pane, occupied after the splits.
  private async createTab(): Promise<void> {
    const label = observerTabLabel(this.options.groupId);
    const response = await this.transport.request('tab.create', { workspace_id: this.options.workspaceId, cwd: this.options.cwd, label, focus: false });
    const tabId = response?.tab?.tab_id;
    if (typeof tabId !== 'string') throw new Error('Unexpected Herdr tab.create receipt; outcome requires reconciliation.');
    this.tab = tabId; this.overview = undefined; this.overviewPending = false; for (const role of roles) delete this.owned[role]; this.pending.clear();
    await this.save();
    const root = typeof response?.root_pane?.pane_id === 'string' ? response.root_pane.pane_id as string : (await this.inventory()).filter((p) => p.tab_id === tabId).map((p) => p.pane_id);
    const rootPane = Array.isArray(root) ? (root.length === 1 ? root[0]! : undefined) : root;
    if (!rootPane) throw new Error('Cannot identify the root pane of the new observation tab.');
    this.options.onEvent?.({ type: 'tab_created', tabId });
    this.overview = rootPane; this.overviewPending = true;
  }
  // Only the freshly created shell receives the fixed observer command; exec replaces the shell so the pane closes with the observer.
  private async occupy(paneId: string, role: ObserverRole): Promise<void> {
    await this.transport.request('pane.rename', { pane_id: paneId, label: OBSERVER_LABELS[role] });
    await this.transport.request('pane.send_input', { pane_id: paneId, text: 'exec ' + this.options.observerArgv(role).map(quote).join(' '), keys: ['enter'] });
    await this.assertOccupant(paneId, role, true);
  }
  // Splits a new role pane into place and records it as pending: created, but its observer not yet verified.
  private async splitPane(role: WorkerRole): Promise<void> {
    const place = placeObserver(role, this.owned, this.overview!);
    const ratio = place.direction === 'right' ? SPLIT_RATIOS.overviewRight
      : place.target === this.overview ? SPLIT_RATIOS.overviewDown
      : role === 'backend' ? SPLIT_RATIOS.rightColumnThird : SPLIT_RATIOS.rightColumnHalf;
    const response = await this.transport.request('pane.split', { target_pane_id: place.target, direction: place.direction, ratio, cwd: this.options.cwd, focus: false });
    const paneId = response?.pane?.pane_id;
    if (typeof paneId !== 'string' || response.pane.tab_id !== this.tab) throw new Error('Unexpected Herdr split receipt; outcome requires reconciliation.');
    this.owned[role] = paneId; this.pending.add(role); await this.save();
    if (place.above) await this.transport.request('pane.swap', { source_pane_id: paneId, target_pane_id: place.target });
  }
  private async occupyPending(role: WorkerRole): Promise<void> {
    await this.occupy(this.owned[role]!, role);
    this.pending.delete(role); await this.save();
  }
  // Reopening one pane later: the rest of the layout already stands, so it is split and occupied straight away.
  private async openPane(role: WorkerRole): Promise<void> {
    await this.splitPane(role);
    await this.occupyPending(role);
  }
  async sync(snapshot: DashboardSnapshot): Promise<void> {
    if (this.frozen) throw new Error('Herdr controller frozen; inspect persisted pane mapping before restarting.');
    if (snapshot.groupId !== this.options.groupId) throw new Error('Herdr group mismatch.');
    if (!this.tab) throw new Error('Observation tab is not open; call open() first.');
    try {
      await this.reconcileTopology(snapshot);
      for(const role of roles)if(this.owned[role]){
        if(this.pending.has(role)){await this.assertOccupant(this.owned[role]!,role,true);this.pending.delete(role);await this.save();}
        else if(!await this.occupantMatches(this.owned[role]!,role))await this.returnPane(role,snapshot);
      }
      for (const roleId of roles) {
        const role = snapshot.roles.find((r)=>r.roleId===roleId);
        if (!role) continue;
        if (!this.owned[roleId] && activated(role,snapshot) && this.mayReopen(role)) await this.openPane(roleId);
        const pane = this.owned[roleId];
        if (pane) await this.transport.request('pane.report_metadata', {pane_id:pane,source:'coordinator:herdr-layout',title:`${roleId} · ${state(role,snapshot)}`,state_labels:{[state(role,snapshot)==='failed'?'idle':state(role,snapshot)]:`Coordinator ${state(role,snapshot)}`},tokens:{coordinator_state:state(role,snapshot),role:roleId},ttl_ms:10000});
      }
    } catch (error) { if (!(error instanceof ObserverTabClosed)) this.frozen = true; throw error; }
  }
  async compact(snapshot: DashboardSnapshot, only?: WorkerRole): Promise<void> {
    if (this.frozen) throw new Error('Herdr controller frozen.');
    if(snapshot.groupId!==this.options.groupId)throw new Error('Herdr group mismatch.');
    try {
      await this.reconcileTopology(snapshot);
      for (const roleId of roles) {
        if (only && roleId !== only) continue;
        const pane = this.owned[roleId]; const role=snapshot.roles.find((r)=>r.roleId===roleId);
        if (!pane || !role || snapshot.truncated || activated(role,snapshot) || this.pending.has(roleId)) continue;
        if (!await this.occupantMatches(pane,roleId)) { await this.returnPane(roleId,snapshot); continue; }
        await this.transport.request('pane.close',{pane_id:pane});
        this.markClosed(roleId,snapshot);await this.save();
      }
    } catch(error) { if (!(error instanceof ObserverTabClosed)) this.frozen=true; throw error; }
  }
  // Normal lead exit or an explicit close: the whole observation tab goes, including panes the user took over.
  async closeAll(): Promise<void> {
    const tab = this.tab;
    if (tab) {
      try { if ((await this.inventory()).some((p) => p.tab_id === tab)) await this.transport.request('tab.close', { tab_id: tab }); } catch { /* leave the tab as it is */ }
    }
    this.tab = undefined; this.overview = undefined; this.overviewPending = false; this.pending.clear(); this.returned.clear();
    for (const role of roles) delete this.owned[role];
    await this.save();
  }
  private mayReopen(role: Role): boolean {
    const id = role.roleId as WorkerRole;
    if (!reopenAllowed(this.closedAt[id], role)) return false;
    delete this.closedAt[id];
    return true;
  }
  private markClosed(role: WorkerRole, snapshot: DashboardSnapshot): void {
    this.closedAt[role] = closedMarker(snapshot.roles.find((r) => r.roleId === role));
    delete this.owned[role]; this.pending.delete(role);
  }
  private async returnPane(role: WorkerRole, snapshot: DashboardSnapshot): Promise<void> {
    this.returned.add(this.owned[role]!);
    this.markClosed(role, snapshot);
    this.options.onEvent?.({ type: 'pane_returned', role });
    await this.save();
  }
  private async inventory(): Promise<Array<{ pane_id: string; tab_id: string }>> {
    const response = await this.transport.request('pane.list', { workspace_id: this.options.workspaceId });
    if (!Array.isArray(response?.panes)) throw new Error('Invalid Herdr pane inventory.');
    return response.panes.filter((p: any) => typeof p?.pane_id === 'string' && typeof p?.tab_id === 'string');
  }
  // The user closing the observation tab (or its overview pane) ends layout control; a closed role pane or an added
  // foreign pane does not. Nothing is ever rebuilt on its own.
  private async reconcileTopology(snapshot: DashboardSnapshot): Promise<void> {
    const inTab = new Set((await this.inventory()).filter((p) => p.tab_id === this.tab).map((p) => p.pane_id));
    if (!inTab.size) { const tabId = this.tab!; await this.forget(); this.options.onEvent?.({ type: 'tab_closed_by_user', tabId }); throw new ObserverTabClosed('Observation tab was closed by the user; layout control stops.'); }
    if (this.overview && !inTab.has(this.overview)) { const tabId = this.tab!; await this.forget(); this.options.onEvent?.({ type: 'overview_closed_by_user', tabId }); throw new ObserverTabClosed('Overview pane was closed by the user; layout control stops.'); }
    let changed = false;
    for (const role of roles) {
      const pane = this.owned[role];
      if (pane && !inTab.has(pane)) { this.markClosed(role, snapshot); this.options.onEvent?.({ type: 'pane_closed_by_user', role }); changed = true; }
    }
    for (const pane of [...this.returned]) if (!inTab.has(pane)) { this.returned.delete(pane); changed = true; }
    if (changed) await this.save();
  }
  private async forget(): Promise<void> { this.tab = undefined; this.overview = undefined; this.overviewPending = false; this.pending.clear(); this.returned.clear(); for (const role of roles) delete this.owned[role]; await this.save(); }
  private async save():Promise<void>{await this.options.save?.(this.layoutState());}
  private async occupantMatches(paneId: string, role: ObserverRole):Promise<boolean>{
    const expected=this.options.observerArgv(role);
    const result=await this.transport.request('pane.process_info',{pane_id:paneId});
    const processes=result?.process_info?.foreground_processes;
    if(!Array.isArray(processes)||processes.length!==1)return false;
    const argv=processes[0]?.argv;
    return Array.isArray(argv)&&argv.length===expected.length&&argv.every((value:unknown,index:number)=>value===expected[index]);
  }
  private async assertOccupant(paneId: string, role: ObserverRole, wait: boolean):Promise<void>{
    for(let attempt=0;attempt<(wait?25:1);attempt++){
      if(await this.occupantMatches(paneId,role))return;
      if(wait)await delay(100);
    }
    throw new Error('Observer occupant identity unavailable or changed; preserve pane and inspect launch outcome.');
  }
}
