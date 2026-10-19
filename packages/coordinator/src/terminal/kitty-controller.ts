import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { DashboardSnapshot } from '../dashboard/contracts.js';
import { closedMarker, reopenAllowed, type ClosedMarker, type LayoutEvent, type WorkerRole } from './herdr-controller.js';
import { OBSERVED_ROLES } from '../roles.js';
import { placeObserver } from './observer-layout.js';

export interface KittyWindow { id:number; foreground_processes:Array<{cmdline:string[]}>; }
export interface KittyTab {id:number;layout:string;windows:KittyWindow[];}
export interface KittyTransport {run(args:string[]):Promise<string>;}
export class KittyClient implements KittyTransport {
  constructor(private readonly endpoint:string,private readonly executable='kitty') {
    if(!endpoint.startsWith('unix:/')&&!endpoint.startsWith('tcp:'))throw new Error('Kitty requires an explicit local Unix socket or loopback TCP endpoint.');
  }
  async run(args:string[]):Promise<string> {
    try {return (await promisify(execFile)(this.executable,['@','--to',this.endpoint,'--use-password','never',...args],{timeout:5000,maxBuffer:2_000_000})).stdout.trim();}
    catch {throw new Error('Kitty request failed or outcome unknown; inspect owned windows before restarting.');}
  }
}
interface Options {groupId:string;leadWindow:number;tabId:number;cwd:string;observerArgv(role:WorkerRole):string[];save?(panes:Partial<Record<WorkerRole,number>>,state:KittyLayoutState):Promise<void>;onEvent?(event:LayoutEvent):void;}
export interface KittyLayoutState { closedAt: Partial<Record<WorkerRole, ClosedMarker>>; returned: number[]; }
const roles:WorkerRole[]=[...OBSERVED_ROLES];
function active(role:DashboardSnapshot['roles'][number],snapshot:DashboardSnapshot):boolean {
  return role.waitingHuman>0||role.dispatches.some(d=>['queued','starting','leased','active','needs_reconciliation'].includes(d.state))||Boolean(snapshot.runtime?.blocks[role.roleId]);
}
function state(role:DashboardSnapshot['roles'][number],snapshot:DashboardSnapshot):string {
  if(role.waitingHuman||snapshot.runtime?.blocks[role.roleId]||role.dispatches.some(d=>d.state==='needs_reconciliation'))return 'blocked';
  if(role.dispatches.some(d=>['active','starting','leased'].includes(d.state)))return 'working';
  return role.dispatches.find(d=>d.state!=='cancelled')?.state==='failed'?'failed':'idle';
}
export async function kittyTabs(transport:KittyTransport):Promise<KittyTab[]> {
  const data:unknown=JSON.parse(await transport.run(['ls']));
  if(!Array.isArray(data))throw new Error('Invalid Kitty inventory.');
  const tabs=data.flatMap(os=>os.tabs??[]) as KittyTab[];
  if(tabs.some(t=>!Number.isInteger(t.id)||!Array.isArray(t.windows)))throw new Error('Invalid Kitty tab inventory.');
  return tabs;
}
export class KittyController {
  private owned:Partial<Record<WorkerRole,number>>;
  private frozen=false;
  private titles=new Map<number,string>();
  private readonly closedAt:Partial<Record<WorkerRole,ClosedMarker>>;
  private readonly returned:Set<number>;
  constructor(private readonly transport:KittyTransport,private readonly options:Options,saved:Partial<Record<WorkerRole,number>>={},layout:Partial<KittyLayoutState>={}) {
    this.owned={...saved};const ids=Object.values(saved);
    if(ids.includes(options.leadWindow)||new Set(ids).size!==ids.length)throw new Error('Invalid Kitty owned window mapping.');
    this.closedAt={...layout.closedAt};this.returned=new Set(layout.returned??[]);
  }
  panes():Partial<Record<WorkerRole,number>> {return {...this.owned};}
  layoutState():KittyLayoutState {return {closedAt:{...this.closedAt},returned:[...this.returned]};}
  // Lead loss, a missing tab or a changed layout stops control; user-closed owned windows and foreign windows do not.
  private async topology(snapshot?:DashboardSnapshot):Promise<KittyTab> {
    const tab=(await kittyTabs(this.transport)).find(t=>t.id===this.options.tabId);
    if(!tab||tab.layout!=='splits'||!tab.windows.some(w=>w.id===this.options.leadWindow))throw new Error('Kitty lead window, tab or layout changed; preserve user layout.');
    if(snapshot){
      let changed=false;
      for(const role of roles){const id=this.owned[role];if(id&&!tab.windows.some(w=>w.id===id)){this.markClosed(role,snapshot);this.options.onEvent?.({type:'pane_closed_by_user',role});changed=true;}}
      for(const id of [...this.returned])if(!tab.windows.some(w=>w.id===id)){this.returned.delete(id);changed=true;}
      if(changed)await this.save();
    }
    return tab;
  }
  private async observerMatches(role:WorkerRole):Promise<boolean> {
    const argv=this.options.observerArgv(role);
    const w=(await this.topology()).windows.find(w=>w.id===this.owned[role]);const p=w?.foreground_processes;
    return Boolean(p?.length===1&&p[0]?.cmdline.length===argv.length&&p[0].cmdline.every((a,i)=>a===argv[i]));
  }
  private async observer(role:WorkerRole,wait=false):Promise<void> {
    for(let n=0;n<(wait?25:1);n++) {
      if(await this.observerMatches(role))return;
      if(wait)await delay(100);
    }
    throw new Error('Kitty observer occupant changed or unavailable; preserve window.');
  }
  private markClosed(role:WorkerRole,snapshot:DashboardSnapshot):void {
    const id=this.owned[role];if(id)this.titles.delete(id);
    this.closedAt[role]=closedMarker(snapshot.roles.find(r=>r.roleId===role));delete this.owned[role];
  }
  private async returnWindow(role:WorkerRole,snapshot:DashboardSnapshot):Promise<void> {
    this.returned.add(this.owned[role]!);this.markClosed(role,snapshot);this.options.onEvent?.({type:'pane_returned',role});await this.save();
  }
  private mayReopen(role:DashboardSnapshot['roles'][number]):boolean {
    const id=role.roleId as WorkerRole;
    if(!reopenAllowed(this.closedAt[id],role))return false;
    delete this.closedAt[id];return true;
  }
  private async save():Promise<void>{await this.options.save?.(this.panes(),this.layoutState());}
  async sync(snapshot:DashboardSnapshot):Promise<void> {
    if(this.frozen)throw new Error('Kitty controller frozen; inspect before restarting.');
    if(snapshot.groupId!==this.options.groupId)throw new Error('Kitty group mismatch.');
    try {
      await this.topology(snapshot);
      for(const role of roles)if(this.owned[role]&&!await this.observerMatches(role))await this.returnWindow(role,snapshot);
      for(const roleId of roles) {
        const role=snapshot.roles.find(r=>r.roleId===roleId);if(!role)continue;
        if(!this.owned[roleId]&&active(role,snapshot)&&this.mayReopen(role)) {
          const place=placeObserver(roleId,this.owned,this.options.leadWindow);
          const out=await this.transport.run(['launch','--match',`id:${this.options.tabId}`,'--next-to',`id:${place.target}`,'--location',place.direction==='right'?'vsplit':'hsplit','--keep-focus','--cwd',this.options.cwd,'--title',`Coordinator ${roleId}`,'--',...this.options.observerArgv(roleId)]);
          const id=Number(out);if(!Number.isSafeInteger(id)||id<=0||id===this.options.leadWindow||Object.values(this.owned).includes(id))throw new Error('Unknown Kitty launch result; reconcile before retry.');
          this.owned[roleId]=id;await this.save();
          if(place.above)await this.transport.run(['action','--match',`id:${id}`,'move_window','up']);
          await this.observer(roleId,true);
        }
        const id=this.owned[roleId];if(id) {
          const title=`${roleId} · ${state(role,snapshot)}`;
          if(this.titles.get(id)!==title){await this.transport.run(['set-window-title','--match',`id:${id}`,title]);this.titles.set(id,title);}
        }
      }
    }catch(error){this.frozen=true;throw error;}
  }
  // Normal lead exit: close every window still running this group's observer; windows the user took over stay.
  // The lead window may already be gone, so read the tab directly instead of checking topology.
  async closeAll():Promise<void> {
    const tab=(await kittyTabs(this.transport).catch(()=>[])).find(t=>t.id===this.options.tabId);
    for(const role of roles) {
      const id=this.owned[role];if(!id)continue;
      const argv=this.options.observerArgv(role);const p=tab?.windows.find(w=>w.id===id)?.foreground_processes;
      if(p?.length===1&&p[0]?.cmdline.length===argv.length&&p[0].cmdline.every((a,i)=>a===argv[i]))await this.transport.run(['close-window','--match',`id:${id}`]).catch(()=>{});
      this.titles.delete(id);delete this.owned[role];
    }
    await this.save();
  }
  async compact(snapshot:DashboardSnapshot,only?:WorkerRole):Promise<void> {
    if(this.frozen||snapshot.groupId!==this.options.groupId)throw new Error('Kitty controller frozen or group mismatch.');
    try {
      await this.topology(snapshot);
      for(const roleId of roles) {
        if(only&&roleId!==only)continue;
        const id=this.owned[roleId],role=snapshot.roles.find(r=>r.roleId===roleId);
        if(!id||!role||snapshot.truncated||active(role,snapshot))continue;
        if(!await this.observerMatches(roleId)){await this.returnWindow(roleId,snapshot);continue;}
        await this.transport.run(['close-window','--match',`id:${id}`]);this.markClosed(roleId,snapshot);await this.save();
      }
    }catch(error){this.frozen=true;throw error;}
  }
}
