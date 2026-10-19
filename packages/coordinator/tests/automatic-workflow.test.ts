import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { CoordinatorEngine } from '../src/engine.js';
import { startCoordinatorSocket } from '../src/ipc.js';
import { engineFixture } from './fixtures/engine-fixture.js';
import type { RoleId } from '../src/protocol.js';

test('four role MCP workflow: parallel work, assistance, browser queue, rejected audit, upgrade, repair and human-gated submission', async () => {
  const f=await engineFixture();await f.engine.close();let submissions=0;let ownPages=0;let closedPages=0;
  f.options.taskAuthority.submit=async(binding,payload)=>{assert.equal(binding.repositoryId,'repo');assert.equal((payload as {expectedVersion:number}).expectedVersion,1);submissions++;f.options.taskAuthority.checkGate=async()=>{throw new Error('Task moved to pending acceptance');};return{ok:true,status:'pending_acceptance'};};
  f.options.browser={source:'mock',allowedOrigins:['http://workflow.invalid'],healthChecks:[{service:'mock app',check:async()=>true}],connect:async()=>({createOwnPage:async()=>{ownPages++;return{goto:async()=>({title:'Mock workflow'}),close:async()=>{closedPages++;}};},disconnect:async()=>{}})};
  const engine=new CoordinatorEngine(f.options);const socket=join(f.dir,'full-flow.sock');const service=await startCoordinatorSocket(engine,socket,10);
  const clients=new Map<RoleId,Client>();
  const call=async(role:RoleId,name:string,input:Record<string,unknown>={})=>{
    const result=await clients.get(role)!.callTool({name,arguments:input});
    if(result.isError)throw new Error(`Role ${role} failed ${name}: ${JSON.stringify(result.content)}`);
    const block=result.content.find((part)=>part.type==='text');assert.ok(block?.type==='text');return JSON.parse(block.text);
  };
  const wait=async(id:string)=>{const until=Date.now()+3000;while(engine.scheduler.get(id)?.state!=='active'&&Date.now()<until)await new Promise((resolve)=>setTimeout(resolve,10));assert.equal(engine.scheduler.get(id)?.state,'active');};
  const complete=async(role:RoleId,id:string,summary='isolated verification passed')=>call(role,'automation_work_complete',{dispatchId:id,summary,evidence:['Mock command and contract assertions recorded']});
  const dispatch=async(roleId:'frontend'|'backend'|'audit',id:string,contractId:string,revision:string,baseline:string,risk=1,evidenceFailures=0)=>call('lead','automation_dispatch',{binding:f.dispatch.binding,work:{...f.dispatch.work,id,roleId,contractRef:contractId,contractRevision:revision,baseline,risk,evidenceFailures},operationId:`dispatch-${id}`});
  try{
    for(const role of ['lead','frontend','backend','audit'] as const){
      const client=new Client({name:`workflow-${role}`,version:'0.1.0'});clients.set(role,client);
      await client.connect(new StdioClientTransport({command:process.execPath,args:['--import','tsx','scripts/mcp-server.ts'],cwd:process.cwd(),env:{PATH:process.env.PATH??'',HOME:f.dir,COORDINATOR_ROLE:role,COORDINATOR_GROUP_ID:'g',COORDINATOR_CAPABILITY:f.credentials[role],COORDINATOR_SOCKET_PATH:socket,COORDINATOR_DB_PATH:join(f.dir,'must-not-be-created.sqlite')},stderr:'ignore'}));
    }
    await call('lead','automation_status'); // Protocol preflight before the workflow.
    for(const role of ['lead','frontend','backend','audit'] as const)await call(role,'automation_role_initialize',{cwd:f.dir});
    const v1=await call('lead','automation_contract_publish',{artifactRef:'workflow-api',revision:'v1',digest:'sha256:v1',baselineRef:'baseline-1',compatibility:'breaking',affectedRoles:['frontend','backend','audit'],operationId:'publish-v1'});
    for(const role of ['frontend','backend','audit'] as const)await call(role,'automation_contract_ack',{contractId:v1.contractId,revision:'v1'});
    const front=await dispatch('frontend','frontend-v1',v1.contractId,'v1','baseline-1');const back=await dispatch('backend','backend-v1',v1.contractId,'v1','baseline-1');
    await wait(front.message.messageId);await wait(back.message.messageId);
    assert.equal(engine.scheduler.list('g').filter((item)=>item.state==='active').length,2);
    assert.equal(front.model.model,'gpt-6-luna');assert.equal(back.model.effort,'high');
    const duplicate=await dispatch('frontend','frontend-v1',v1.contractId,'v1','baseline-1');assert.equal(duplicate.message.messageId,front.message.messageId);
    const assistance=await call('frontend','automation_message_send',{type:'assistance_request',recipientRole:'backend',payload:{question:'confirm nullable field contract'},operationId:'assist-api'});
    const received=await call('backend','automation_message_claim');assert.equal(received.messageId,assistance.messageId);
    await call('backend','automation_message_complete',{messageId:received.messageId,leaseToken:received.leaseToken,result:{summary:'nullable is rejected',evidence:['v1 contract']}});
    await call('frontend','automation_browser_request',{url:'http://workflow.invalid/frontend',binding:f.dispatch.binding,operationId:'browser-fe'});
    await call('audit','automation_browser_request',{url:'http://workflow.invalid/audit',binding:f.dispatch.binding,operationId:'browser-audit'});
    const browser=await call('frontend','automation_browser_claim');assert.deepEqual(await call('audit','automation_browser_claim'),{empty:true});
    await call('frontend','automation_browser_execute',{requestId:browser.requestId,leaseToken:browser.leaseToken});
    const auditBrowser=await call('audit','automation_browser_claim');await call('audit','automation_browser_execute',{requestId:auditBrowser.requestId,leaseToken:auditBrowser.leaseToken});
    assert.equal(ownPages,2);assert.equal(closedPages,2);
    await complete('frontend',front.message.messageId);await complete('backend',back.message.messageId);
    const audit1=await dispatch('audit','audit-v1',v1.contractId,'v1','baseline-1');await wait(audit1.message.messageId);assert.equal(audit1.model.model,'gpt-6.1-sol');
    const failed=await call('audit','automation_validation_create',{contractRef:v1.contractId,baselineRef:'baseline-1',operationId:'audit-cycle-1'});
    await call('audit','automation_validation_record',{validationId:failed.validationId,outcome:'rejected',evidence:[{command:'schema regression',outcome:'failed',summary:'null field was accepted'}]});
    await complete('audit',audit1.message.messageId,'behavior audit rejected with reproduction');
    const rejected=await clients.get('lead')!.callTool({name:'automation_submit_for_acceptance',arguments:{binding:f.dispatch.binding,dispatchIds:[front.message.messageId,back.message.messageId,audit1.message.messageId],validationId:failed.validationId,contractRef:v1.contractId,baselineRef:'baseline-1',operationId:'submit-rejected'}});assert.equal(rejected.isError,true);assert.equal(submissions,0);
    const v2=await call('lead','automation_contract_publish',{artifactRef:'workflow-api',revision:'v2',digest:'sha256:v2',baselineRef:'baseline-2',compatibility:'breaking',affectedRoles:['frontend','backend','audit'],operationId:'publish-v2'});
    for(const role of ['frontend','backend','audit'] as const)await call(role,'automation_contract_ack',{contractId:v2.contractId,revision:'v2'});
    const front2=await dispatch('frontend','frontend-v2',v2.contractId,'v2','baseline-2');const repair=await dispatch('backend','backend-repair',v2.contractId,'v2','baseline-2',3,2);
    assert.equal(repair.model.model,'gpt-6.1-sol');assert.equal(repair.model.effort,'xhigh');
    await wait(front2.message.messageId);await wait(repair.message.messageId);await complete('frontend',front2.message.messageId);await complete('backend',repair.message.messageId);
    const normal=await dispatch('backend','backend-default-restored',v2.contractId,'v2','baseline-2');assert.equal(normal.model.model,'gpt-6-luna');assert.equal(normal.model.effort,'high');await wait(normal.message.messageId);await complete('backend',normal.message.messageId);
    const audit2=await dispatch('audit','audit-v2',v2.contractId,'v2','baseline-2');await wait(audit2.message.messageId);
    const passed=await call('audit','automation_validation_create',{contractRef:v2.contractId,baselineRef:'baseline-2',operationId:'audit-cycle-2'});
    await call('audit','automation_validation_record',{validationId:passed.validationId,outcome:'passed',evidence:[{command:'schema regression',outcome:'passed',summary:'new baseline rejects null correctly'}]});await complete('audit',audit2.message.messageId);
    const packet={binding:f.dispatch.binding,dispatchIds:[front2.message.messageId,repair.message.messageId,normal.message.messageId,audit2.message.messageId],validationId:passed.validationId,contractRef:v2.contractId,baselineRef:'baseline-2',operationId:'submit-passed'};
    const submitted=await call('lead','automation_submit_for_acceptance',packet);assert.equal(submitted.status,'pending_acceptance');assert.equal(submitted.finalAcceptance,'human_only');assert.equal(submitted.source,'mock');
    await call('lead','automation_submit_for_acceptance',packet);assert.equal(submissions,1);
    const status=await call('lead','automation_status');assert.equal(status.budget.callsUsed,7);assert.equal(status.budget.source,'mock');assert.equal(status.dispatches.filter((item:{state:string})=>item.state!=='completed').length,0);
    const tools=await clients.get('lead')!.listTools();assert.equal(tools.tools.some((item)=>item.name.includes('accept')&&!item.name.includes('submit_for')),false);
    assert.equal(engine.collaboration.validations.get(failed.validationId)?.state,'rejected');
    assert.ok((await call('lead','automation_events',{afterSequence:0})).length>0);
    const {access}=await import('node:fs/promises');await assert.rejects(access(join(f.dir,'must-not-be-created.sqlite')));
  }finally{await Promise.all([...clients.values()].map((client)=>client.close()));await service.close();await f.cleanup();}
});

test('scoped worker MCP catalog denies control tools and reports honest annotations', async () => {
  const f=await engineFixture(); const service=await startCoordinatorSocket(f.engine,join(f.dir,'scoped.sock'),1000);
  const client=new Client({name:'scoped-audit',version:'1'});
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,args:['--import','tsx','scripts/mcp-server.ts'],cwd:process.cwd(),env:{PATH:process.env.PATH??'',HOME:f.dir,COORDINATOR_ROLE:'audit',COORDINATOR_GROUP_ID:'g',COORDINATOR_CAPABILITY:f.credentials.audit,COORDINATOR_SOCKET_PATH:join(f.dir,'scoped.sock'),COORDINATOR_WORKER_TOOL_POLICY:'scoped-v1'},stderr:'ignore'}));
    const catalog=await client.listTools(); assert.equal(catalog.tools.length,11);
    assert.equal(catalog.tools.find(t=>t.name==='automation_status')?.annotations?.readOnlyHint,true);
    assert.equal(catalog.tools.find(t=>t.name==='automation_message_claim')?.annotations?.idempotentHint,false);
    assert.equal(catalog.tools.some(t=>t.name==='automation_dispatch'),false);
    await assert.rejects(client.callTool({name:'automation_archive_failure',arguments:{}}), /not found/);
  } finally {await client.close();await service.close();await f.cleanup();}
});

test('Mock interrupted recovery, explicit replacement, rejected audit and repair submit only pending acceptance', async () => {
  const f=await engineFixture({maxCalls:5,maxConcurrent:1}); const audit=f.engine.authenticate('audit',f.credentials.audit,1); let submits=0;
  f.options.taskAuthority.submit=async()=>{submits++;return{ok:true,status:'pending_acceptance'};};
  const call=(actor:typeof f.lead,name:Parameters<typeof f.engine.execute>[1],input:unknown)=>f.engine.execute(actor,name,input);
  const dispatch=async(roleId:'backend'|'audit',id:string,replacesDispatchId?:string)=>{
    const result=await call(f.lead,'automation_dispatch',{...f.dispatch,operationId:id,work:{...f.dispatch.work,id,roleId,...(replacesDispatchId?{replacesDispatchId}:{})}}) as {message:{messageId:string}};
    await f.engine.pump(); return result.message.messageId;
  };
  const complete=(actor:typeof f.lead,id:string)=>call(actor,'automation_work_complete',{dispatchId:id,summary:'verified Mock business receipt',evidence:['isolated test passed']});
  try {
    for(const actor of [f.lead,f.backend,audit])await call(actor,'automation_role_initialize',{cwd:f.dir});
    const original=await dispatch('backend','original'); const record=f.engine.scheduler.get(original)!;
    const thread=f.engine.store.groupSnapshot('g')!.roles.find(r=>r.roleId==='backend')!.threadId!;
    f.engine.approvals.enqueue(f.backend,'original-runtime',0,'mcpServer/elicitation/request',{threadId:thread,turnId:record.turnId});
    await f.runtimes[1]!.interruptTurn(thread,record.turnId!); f.engine.scheduler.recoverAfterRestart('g');
    await call(f.lead,'automation_archive_failure',{binding:{...f.dispatch.binding,worktreePath:record.worktree},dispatchId:original,reason:'interrupted',evidence:'Mock runtime confirms interrupted',operationId:'archive-mock'});
    assert.equal(f.engine.approvals.list('g').length,0); assert.equal(f.engine.budget.status().callsUsed,1);
    const replacement=await dispatch('backend','replacement',original); await complete(f.backend,replacement);
    const audit1=await dispatch('audit','audit-1');
    const rejected=await call(audit,'automation_validation_create',{contractRef:f.dispatch.work.contractRef,baselineRef:'base',operationId:'reject-cycle'}) as {validationId:string};
    await call(audit,'automation_validation_record',{validationId:rejected.validationId,outcome:'rejected',evidence:[{command:'Mock regression',outcome:'failed',summary:'reproduced defect'}]}); await complete(audit,audit1);
    const packet={binding:f.dispatch.binding,dispatchIds:[replacement,audit1],validationId:rejected.validationId,contractRef:f.dispatch.work.contractRef,baselineRef:'base',operationId:'submit'};
    await assert.rejects(call(f.lead,'automation_submit_for_acceptance',packet),{code:'TASK_GATE_CLOSED'}); assert.equal(submits,0);
    const repair=await dispatch('backend','bounded-repair'); await complete(f.backend,repair);
    const audit2=await dispatch('audit','audit-2');
    const passed=await call(audit,'automation_validation_create',{contractRef:f.dispatch.work.contractRef,baselineRef:'base',operationId:'pass-cycle'}) as {validationId:string};
    await call(audit,'automation_validation_record',{validationId:passed.validationId,outcome:'passed',evidence:[{command:'Mock regression',outcome:'passed',summary:'repair verified'}]}); await complete(audit,audit2);
    const current={...packet,validationId:passed.validationId,dispatchIds:[replacement,repair,audit2]};
    await assert.rejects(call(f.lead,'automation_submit_for_acceptance',{...current,dispatchIds:[original,repair,audit2]}),{code:'TASK_GATE_CLOSED'});
    await assert.rejects(call(f.lead,'automation_submit_for_acceptance',{...current,dispatchIds:[repair,audit2]}),{code:'TASK_GATE_CLOSED'});
    assert.equal((await call(f.lead,'automation_submit_for_acceptance',current) as {status:string}).status,'pending_acceptance');
    assert.equal(submits,1); assert.equal(f.engine.budget.status().callsUsed,5); assert.equal(f.engine.budget.status().unknown,0);
    const {DashboardProjection}=await import('../src/dashboard/projection.js'); const projection=new DashboardProjection(f.db);
    try {const snapshot=projection.snapshot('g')!; const rows=snapshot.roles.flatMap(r=>r.dispatches); assert.equal(rows.find(r=>r.dispatchId===original)?.state,'failed');assert.equal(rows.find(r=>r.dispatchId===replacement)?.replacesDispatchId,original);assert.equal(snapshot.roles.find(r=>r.roleId==='backend')?.waitingHuman,0);assert.equal(snapshot.totals.dispatches,5);}finally{projection.close();}
  }finally{await f.cleanup();}
});
