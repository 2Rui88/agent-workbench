import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { bindingSchema } from '../bindings.js';
import { BrowserQueue } from './queue.js';
import { runBrowserRequest } from './runner.js';
import type { BrowserDriver } from './runner.js';
import { requireHealthyServices } from '../preflight.js';
import type { HealthCheck } from '../preflight.js';
import type { TaskAuthority, TaskBinding } from '../integrations/adapters.js';
import type { Actor } from '../protocol.js';
import { CoordinatorError } from '../errors.js';

export interface BrowserSettings { source:'mock'|'edge_cdp';inspectWithHarness?:(targetId:string)=>Promise<unknown>;allowedOrigins:string[];healthChecks:HealthCheck[];connect:()=>Promise<BrowserDriver&{disconnect():Promise<void>;inspectResources?(ids:string[]):Promise<string[]>}>; }
export const browserSchemas={
  automation_browser_request:z.object({url:z.string().url(),tool:z.enum(['playwright','browser_harness']).default('playwright'),assertions:z.array(z.object({selector:z.string().min(1),state:z.enum(['visible','hidden','text']),text:z.string().optional()}).strict()).default([]),binding:bindingSchema,operationId:z.string().min(1)}).strict(),
  automation_browser_claim:z.object({leaseMs:z.number().int().min(1000).max(300000).default(60000)}).strict(),
  automation_browser_execute:z.object({requestId:z.string().min(1),leaseToken:z.string().min(1)}).strict(),
  automation_browser_reconcile:z.object({requestId:z.string().min(1),outcome:z.enum(['completed','not_started','unknown']),evidence:z.string().min(8),resourcesCleared:z.boolean().default(false)}).strict()
};
export type BrowserCommand=keyof typeof browserSchemas;
export class BrowserService {
  readonly queue:BrowserQueue;
  private readonly executing=new Set<string>();
  constructor(path:string,private readonly groupId:string,private readonly authority:TaskAuthority,private readonly settings?:BrowserSettings){this.queue=new BrowserQueue(path);}
  close():void{this.queue.close();}
  recover():void{this.queue.recover(this.groupId);}
  async execute(actor:Actor,name:BrowserCommand,raw:unknown):Promise<unknown>{
    if(name==='automation_browser_request'){
      const input=browserSchemas[name].parse(raw);this.assertTarget(input.url);await this.authority.checkGate(input.binding);
      return this.queue.enqueue(actor.groupId,actor.roleId,{url:input.url,binding:input.binding,assertions:input.assertions,tool:input.tool},input.operationId);
    }
    if(name==='automation_browser_claim')return this.queue.claim(actor.roleId,randomUUID(),browserSchemas[name].parse(raw).leaseMs,actor.groupId,actor.bindingGeneration)??{empty:true};
    if(name==='automation_browser_reconcile'){
      const input=browserSchemas[name].parse(raw);
      if(actor.roleId!=='lead'||this.queue.get(input.requestId)?.groupId!==actor.groupId)throw new CoordinatorError('FORBIDDEN','Only lead can reconcile this group browser operation.','Submit the resource inspection evidence to lead.');
      if(input.outcome!=='unknown'&&!input.resourcesCleared)throw new CoordinatorError('RECONCILIATION_REQUIRED','Owned browser resources have not been confirmed cleaned up.','Inspect the owned pages and contexts before freeing the shared browser lease.');
      if(this.executing.has(input.requestId))throw new CoordinatorError('RECONCILIATION_REQUIRED','Browser operation is still executing.','Wait for the owned process to stop before reconciliation.');
      const resources=this.queue.resources(input.requestId);
      if(input.outcome!=='unknown'&&this.settings?.source==='edge_cdp'&&resources.length){
        const connection=await this.settings.connect();
        try{if(!connection.inspectResources|| (await connection.inspectResources(resources.map((resource)=>resource.targetId))).length)throw new CoordinatorError('RECONCILIATION_REQUIRED','Owned targets are still present or cannot be inspected.','Inspect and clean only the recorded task targets.');}finally{await connection.disconnect();}
      }
      this.queue.reconcile(input.requestId,input.outcome,input.evidence);return{ok:true};
    }
    const input=browserSchemas.automation_browser_execute.parse(raw);
    this.queue.assertActorLease(actor,input.requestId,input.leaseToken);
    const request=this.queue.get(input.requestId)!;const payload=request.payload as {url:string;binding:TaskBinding;assertions:import('./runner.js').BrowserAssertion[];tool:'playwright'|'browser_harness'};
    this.assertTarget(payload.url);
    let driver:Awaited<ReturnType<BrowserSettings['connect']>>|undefined;let started=false;
    if(this.executing.has(input.requestId))throw new CoordinatorError('STALE_LEASE','Browser request is already executing.','Wait for its durable receipt before repeating.');
    this.executing.add(input.requestId);
    try{
      await this.authority.checkGate(payload.binding);
      if(!this.settings?.healthChecks.length)throw new CoordinatorError('SERVICE_UNHEALTHY','Browser checks require service health preflight.','Configure the task dependencies before testing.');
      await requireHealthyServices(this.settings.healthChecks);
      this.queue.markStarted(input.requestId,input.leaseToken);started=true;
      driver=await this.settings.connect();
      let harnessResult:unknown;
      if(payload.tool==='browser_harness'&&!this.settings.inspectWithHarness)throw new CoordinatorError('TASK_GATE_CLOSED','Controlled Harness inspection is not configured.','Configure the approved existing tool directory.');
      const result=await runBrowserRequest({driver,url:payload.url,healthChecks:[],assertions:payload.assertions,afterNavigation:async(resource)=>{if(payload.tool==='browser_harness'){if(!resource)throw new CoordinatorError('RECONCILIATION_REQUIRED','Harness needs an owned target reference.','Inspect task resource registration.');harnessResult=await this.settings!.inspectWithHarness!(resource.targetId);}},onCreated:(resource)=>this.queue.resourceCreated(input.requestId,input.leaseToken,resource),onClosed:(resource)=>this.queue.resourceClosed(input.requestId,resource)});
      await driver.disconnect();driver=undefined;
      this.queue.finish(input.requestId,input.leaseToken,'completed');
      return{requestId:input.requestId,source:this.settings.source,result,...(payload.tool==='browser_harness'?{harnessResult}:{})};
    }catch(error){
      if(!started)this.queue.releaseBeforeStart(input.requestId,input.leaseToken);
      else this.queue.flagUncertain(input.requestId,input.leaseToken);
      throw error;
    }finally{try{await driver?.disconnect();}finally{this.executing.delete(input.requestId);}}
  }
  private assertTarget(url:string):void{
    const target=new URL(url);
    if(target.username||target.password||!['http:','https:'].includes(target.protocol)||!this.settings?.allowedOrigins.includes(target.origin))throw new CoordinatorError('FORBIDDEN','Browser target is not in the approved origin list.','Configure an explicit task origin; never choose another browser.');
  }
}
