import { DatabaseSync } from 'node:sqlite';
import type { RoleId } from './protocol.js';
interface DispatchObservation {dispatchId:string;workId:string;state:string;requestedModel:string|null;requestedEffort:string|null;actualModel:string|null;turnId:string|null;replacesDispatchId:string|null;}
interface RoleObservation {roleId:RoleId;threadId:string|null;worktreePath:string|null;bindingGeneration:number;queued:number;online:boolean;controlOwner:'human'|'automatic';waitingHuman:number;dispatches:DispatchObservation[];}
export class CoordinatorObserver {
  private readonly db:DatabaseSync;
  constructor(path:string){this.db=new DatabaseSync(path,{readOnly:true});}
  close():void{this.db.close();}
  snapshot(groupId:string):{groupId:string;groupStatus:string;roles:RoleObservation[];messageCounts:Record<string,number>}|undefined{
    const group=this.db.prepare('SELECT group_id,status FROM groups WHERE group_id=?').get(groupId) as {group_id:string;status:string}|undefined;
    if(!group)return undefined;
    const bindings=this.db.prepare('SELECT role_id,thread_id,worktree_path,binding_generation FROM runtime_bindings WHERE group_id=? ORDER BY role_id').all(groupId) as Array<{role_id:RoleId;thread_id:string|null;worktree_path:string|null;binding_generation:number}>;
    const counts=this.db.prepare('SELECT recipient_role,status,count(*) AS count FROM messages WHERE group_id=? GROUP BY recipient_role,status').all(groupId) as Array<{recipient_role:RoleId;status:string;count:number}>;
    const dispatches=this.db.prepare('SELECT dispatch_id,role_id,work_json,state,turn_id FROM scheduled_work WHERE group_id=? ORDER BY queued_at').all(groupId) as Array<{dispatch_id:string;role_id:RoleId;work_json:string;state:string;turn_id:string|null}>;
    const modelRows=this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='runtime_models'").get()?this.db.prepare('SELECT dispatch_id,model,effort,source FROM runtime_models WHERE group_id=?').all(groupId) as Array<{dispatch_id:string;model:string;effort:string|null;source:string}>:[];
    const controls=this.db.prepare('SELECT role_id,mode FROM role_controls WHERE group_id=?').all(groupId) as Array<{role_id:RoleId;mode:'human'|'automatic'}>;
    const presence=this.db.prepare('SELECT role_id,binding_generation,expires_at FROM role_presence WHERE group_id=?').all(groupId) as Array<{role_id:RoleId;binding_generation:number;expires_at:number}>;
    const approvals=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='approval_requests'").get()?this.db.prepare("SELECT json_extract(payload_json,'$.roleId') AS role_id,count(*) AS count FROM approval_requests WHERE group_id=? AND state NOT IN ('replied','stale') GROUP BY role_id").all(groupId) as Array<{role_id:RoleId;count:number}>:[];
    return{groupId:group.group_id,groupStatus:group.status,messageCounts:Object.fromEntries(counts.map((row)=>[`${row.recipient_role}:${row.status}`,row.count])),roles:bindings.map((binding)=>({
      roleId:binding.role_id,threadId:binding.thread_id,worktreePath:binding.worktree_path,bindingGeneration:binding.binding_generation,
      queued:counts.find((row)=>row.recipient_role===binding.role_id&&row.status==='queued')?.count??0,
      online:presence.some((row)=>row.role_id===binding.role_id&&row.binding_generation===binding.binding_generation&&row.expires_at>Date.now()),
      controlOwner:controls.find((row)=>row.role_id===binding.role_id)?.mode??'automatic',waitingHuman:approvals.find((row)=>row.role_id===binding.role_id)?.count??0,
      dispatches:dispatches.filter((row)=>row.role_id===binding.role_id).map((row)=>{const work=JSON.parse(row.work_json) as {id:string;replacesDispatchId?:string;model?:{model:string;effort:string}};return{dispatchId:row.dispatch_id,workId:work.id,state:row.state,requestedModel:work.model?.model??null,requestedEffort:work.model?.effort??null,actualModel:modelRows.find(m=>m.dispatch_id===row.dispatch_id)?.model??null,replacesDispatchId:work.replacesDispatchId??null,turnId:row.turn_id};})
    }))};
  }
}
