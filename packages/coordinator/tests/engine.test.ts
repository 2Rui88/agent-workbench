import assert from 'node:assert/strict';
import test from 'node:test';
import { engineFixture } from './fixtures/engine-fixture.js';

test('engine starts queued Mock turn once and waits for business receipt before completion', async () => {
  const f = await engineFixture();
  try {
    await f.engine.execute(f.lead, 'automation_role_initialize', { cwd: f.dir });
    await f.engine.execute(f.backend, 'automation_role_initialize', { cwd: f.dir });
    const result = await f.engine.execute(f.lead, 'automation_dispatch', f.dispatch) as { message: { messageId: string } };
    await f.engine.pump(); await f.engine.pump();
    assert.equal(f.engine.scheduler.get(result.message.messageId)?.state, 'active');
    assert.equal(f.runtimes.reduce((sum, runtime) => sum + runtime.providerCalls, 0), 0);
    await assert.rejects(f.engine.execute(f.lead, 'automation_work_complete', { dispatchId: result.message.messageId, summary: 'forged', evidence: ['fake'] }), { code: 'STALE_LEASE' });
    const done = await f.engine.execute(f.backend, 'automation_work_complete', { dispatchId: result.message.messageId, summary: 'Mock checked', evidence: ['isolated mock assertions passed'] });
    assert.deepEqual(done, { status: 'completed', finalAcceptance: 'human_only' });
    assert.equal(f.engine.store.getMessage(result.message.messageId)?.status, 'completed');
    assert.equal(f.engine.scheduler.get(result.message.messageId)?.state, 'completed');
    await f.engine.execute(f.lead, 'automation_dispatch', f.dispatch);
    await f.engine.pump();
    assert.equal(f.engine.scheduler.list('g').length, 1);
  } finally { await f.cleanup(); }
});

test('human takeover of lead freezes automatic starts while retaining durable work', async () => {
  const f = await engineFixture();
  try {
    await f.engine.execute(f.lead, 'automation_role_initialize', { cwd: f.dir });
    await f.engine.execute(f.backend, 'automation_role_initialize', { cwd: f.dir });
    const result = await f.engine.execute(f.lead, 'automation_dispatch', f.dispatch) as { message: { messageId: string } };
    await f.engine.humanControl('independent-human-token', 'lead', true, 'Inspecting lead decisions');
    await f.engine.pump();
    assert.equal(f.engine.scheduler.get(result.message.messageId)?.state, 'queued');
    await f.engine.humanControl('independent-human-token', 'lead', false, 'Lead control returned');
    await f.engine.pump();
    assert.equal(f.engine.scheduler.get(result.message.messageId)?.state, 'active');
  } finally { await f.cleanup(); }
});

test('ordinary message claims cannot steal daemon execution packages', async () => {
  const f = await engineFixture();
  try {
    await f.engine.execute(f.lead, 'automation_role_initialize', { cwd: f.dir });
    await f.engine.execute(f.backend, 'automation_role_initialize', { cwd: f.dir });
    const result = await f.engine.execute(f.lead, 'automation_dispatch', f.dispatch) as { message: { messageId: string } };
    const assistance = f.engine.store.send(f.lead, { type: 'assistance_request', recipientRole: 'backend', payload: { question: 'review' } }, 'assist-one');
    assert.equal(f.engine.store.claim(f.backend, 'ordinary-token', 60000, true)?.messageId, assistance.messageId);
    await f.engine.pump();
    assert.equal(f.engine.scheduler.get(result.message.messageId)?.state, 'active');
  } finally { await f.cleanup(); }
});

test('reconciliation repairs both scheduler and message after an unknown turn start', async () => {
  const f = await engineFixture();
  try {
    await f.engine.execute(f.lead, 'automation_role_initialize', { cwd: f.dir });
    await f.engine.execute(f.backend, 'automation_role_initialize', { cwd: f.dir });
    const backendRuntime = f.runtimes[1]!;
    const start = backendRuntime.startTurn.bind(backendRuntime);
    backendRuntime.startTurn = async () => { throw new Error('connection lost before confirmed start'); };
    const result = await f.engine.execute(f.lead, 'automation_dispatch', f.dispatch) as { message: { messageId: string } };
    await f.engine.pump();
    assert.equal(f.engine.scheduler.get(result.message.messageId)?.state, 'needs_reconciliation');
    await f.engine.execute(f.lead, 'automation_reconcile', { dispatchId: result.message.messageId, outcome: 'not_started', evidence: 'Confirmed no runtime turn was created from controlled failure' });
    assert.equal(f.engine.store.getMessage(result.message.messageId)?.status, 'queued');
    backendRuntime.startTurn = start;
    await f.engine.pump();
    assert.equal(f.engine.scheduler.get(result.message.messageId)?.state, 'active');
  } finally { await f.cleanup(); }
});

test('simultaneous role initialization returns one owned thread', async () => {
  const f=await engineFixture();
  const factory=f.options.runtimeFactory;
  f.options.runtimeFactory=(role,cwd)=>{const handle=factory(role,cwd);handle.runtime.initialize=async()=>{await new Promise((resolve)=>setTimeout(resolve,10));};return handle;};
  try {
    const replies=await Promise.all([f.engine.execute(f.backend,'automation_role_initialize',{cwd:f.dir}),f.engine.execute(f.backend,'automation_role_initialize',{cwd:f.dir})]) as Array<{threadId:string}>;
    assert.equal(replies[0]!.threadId,replies[1]!.threadId);
    assert.equal(f.runtimes.length,1);
  }finally{await f.cleanup();}
});

test('restarting a role cannot silently resume its existing thread in another allowed worktree', async () => {
  const { mkdir }=await import('node:fs/promises');const { join }=await import('node:path');const {CoordinatorEngine}=await import('../src/engine.js');
  const f=await engineFixture();
  await f.engine.execute(f.backend,'automation_role_initialize',{cwd:f.dir});await f.engine.close();
  const other=join(f.dir,'other-worktree');await mkdir(other);const restored=new CoordinatorEngine(f.options);
  try {await assert.rejects(restored.execute(f.backend,'automation_role_initialize',{cwd:other}),{code:'TASK_GATE_CLOSED'});}finally{await restored.close();await f.cleanup();}
});

test('reconciliation cannot requeue a provider-confirmed turn merely from a lead assertion',async()=>{
  const {CoordinatorEngine}=await import('../src/engine.js');const f=await engineFixture();
  await f.engine.execute(f.lead,'automation_role_initialize',{cwd:f.dir});await f.engine.execute(f.backend,'automation_role_initialize',{cwd:f.dir});
  const sent=await f.engine.execute(f.lead,'automation_dispatch',f.dispatch) as {message:{messageId:string}};await f.engine.pump();
  const original=[...f.runtimes];await f.engine.close();f.options.runtimeFactory=(role)=>({runtime:original[role==='lead'?0:1]!,close:async()=>{}});
  const restored=new CoordinatorEngine(f.options);restored.recoverAfterRestart();
  try{
    await restored.execute(f.lead,'automation_role_initialize',{cwd:f.dir});await restored.execute(f.backend,'automation_role_initialize',{cwd:f.dir});
    await assert.rejects(restored.execute(f.lead,'automation_reconcile',{dispatchId:sent.message.messageId,outcome:'not_started',evidence:'lead requests another execution'}),{code:'RECONCILIATION_REQUIRED'});
    assert.equal(restored.scheduler.get(sent.message.messageId)?.state,'needs_reconciliation');
  }finally{await restored.close();await f.cleanup();}
});

test('lost start response cannot requeue a completed but unrecorded runtime turn', async()=>{
  const f=await engineFixture();
  try{
    await f.engine.execute(f.lead,'automation_role_initialize',{cwd:f.dir});await f.engine.execute(f.backend,'automation_role_initialize',{cwd:f.dir});
    const runtime=f.runtimes[1]!;const start=runtime.startTurn.bind(runtime);
    runtime.startTurn=async(input)=>{await start(input);throw new Error('response lost after completed turn');};
    const sent=await f.engine.execute(f.lead,'automation_dispatch',f.dispatch) as {message:{messageId:string}};await f.engine.pump();
    await assert.rejects(f.engine.execute(f.lead,'automation_reconcile',{dispatchId:sent.message.messageId,outcome:'not_started',evidence:'lead asserted no turn receipt'}),{code:'RECONCILIATION_REQUIRED'});
  }finally{await f.cleanup();}
});

test('ordinary messages cannot forge internal execution packages',async()=>{
 const f=await engineFixture();
 try{
  await assert.rejects(f.engine.execute(f.backend,'automation_message_send',{recipientRole:'backend',type:'assistance_request',payload:{kind:'execution_package',...f.dispatch.work},operationId:'forged'}),{code:'FORBIDDEN'});
  assert.equal(f.engine.scheduler.list('g').length,0);
 }finally{await f.cleanup();}
});

test('completed business receipt retries are idempotent and reject changed evidence',async()=>{
 const f=await engineFixture();try{
  await f.engine.execute(f.lead,'automation_role_initialize',{cwd:f.dir});await f.engine.execute(f.backend,'automation_role_initialize',{cwd:f.dir});
  const sent=await f.engine.execute(f.lead,'automation_dispatch',f.dispatch) as {message:{messageId:string}};await f.engine.pump();
  const receipt={dispatchId:sent.message.messageId,summary:'verified',evidence:['test passed']};
  const first=await f.engine.execute(f.backend,'automation_work_complete',receipt);
  assert.deepEqual(await f.engine.execute(f.backend,'automation_work_complete',receipt),first);
  await assert.rejects(f.engine.execute(f.backend,'automation_work_complete',{...receipt,evidence:['different']}),{code:'IDEMPOTENCY_CONFLICT'});
 }finally{await f.cleanup();}
});

test('business receipt waits for runtime termination before releasing the role',async()=>{
 const f=await engineFixture();try{
  await f.engine.execute(f.lead,'automation_role_initialize',{cwd:f.dir});await f.engine.execute(f.backend,'automation_role_initialize',{cwd:f.dir});
  const runtime=f.runtimes[1]!;const read=runtime.readThread.bind(runtime);let terminal=false;
  runtime.readThread=async(id)=>{const observed=await read(id) as {turns:Array<{status:string}>};return{...observed,turns:observed.turns.map((turn)=>({...turn,status:terminal?'completed':'inProgress'}))};};
  const sent=await f.engine.execute(f.lead,'automation_dispatch',f.dispatch) as {message:{messageId:string}};await f.engine.pump();
  const receipt=await f.engine.execute(f.backend,'automation_work_complete',{dispatchId:sent.message.messageId,summary:'business checks passed',evidence:['test passed']}) as {status:string};
  assert.equal(receipt.status,'receipt_recorded');assert.equal(f.engine.scheduler.get(sent.message.messageId)?.state,'active');
  terminal=true;await f.engine.pump();assert.equal(f.engine.scheduler.get(sent.message.messageId)?.state,'completed');
 }finally{await f.cleanup();}
});

test('dispatch rejects allowed paths outside its actual role worktree',async()=>{
 const f=await engineFixture();try{
  await f.engine.execute(f.lead,'automation_role_initialize',{cwd:f.dir});await f.engine.execute(f.backend,'automation_role_initialize',{cwd:f.dir});
  await assert.rejects(f.engine.execute(f.lead,'automation_dispatch',{...f.dispatch,work:{...f.dispatch.work,allowedPaths:['../outside']}}),{code:'PATH_OUTSIDE_ALLOWED_ROOT'});
  assert.equal(f.engine.scheduler.list('g').length,0);
 }finally{await f.cleanup();}
});

test('lead receives a persisted automatic wake turn when a worker requests coordination',async()=>{
 const f=await engineFixture();try{
  await f.engine.execute(f.lead,'automation_role_initialize',{cwd:f.dir});
  const config={...f.dispatch,work:{...f.dispatch.work,id:'lead-plan',roleId:'lead'},operationId:'lead-plan'};
  await f.engine.execute(f.lead,'automation_lead_configure',config);
  await f.engine.execute(f.lead,'automation_lead_configure',config);
  await assert.rejects(f.engine.execute(f.lead,'automation_lead_configure',{...config,work:{...config.work,goal:'changed template'}}),{code:'IDEMPOTENCY_CONFLICT'});
  const message=await f.engine.execute(f.backend,'automation_message_send',{type:'assistance_request',recipientRole:'lead',payload:{question:'resolve API disagreement'},operationId:'need-lead'}) as {messageId:string};
  await f.engine.pump();await f.engine.pump();
  const wake=f.engine.scheduler.list('g').filter((work)=>work.id===`lead-wake:${message.messageId}`);
  assert.equal(wake.length,1);assert.equal(wake[0]!.state,'active');assert.equal(wake[0]!.model?.model,'gpt-6.1-sol');assert.equal(wake[0]!.model?.effort,'high');
 }finally{await f.cleanup();}
});

test('bounded business receipt timeout freezes the dispatch without a new turn',async()=>{
 const f=await engineFixture();f.options.receiptTimeoutMs=5;
 try{
  await f.engine.execute(f.lead,'automation_role_initialize',{cwd:f.dir});await f.engine.execute(f.backend,'automation_role_initialize',{cwd:f.dir});
  const sent=await f.engine.execute(f.lead,'automation_dispatch',f.dispatch) as {message:{messageId:string}};await f.engine.pump();
  await new Promise((resolve)=>setTimeout(resolve,15));await f.engine.pump();await f.engine.pump();
  assert.equal(f.engine.scheduler.get(sent.message.messageId)?.state,'needs_reconciliation');assert.equal(f.engine.budget.status().callsUsed,1);assert.equal(f.engine.budget.status().unknown,1);
 }finally{await f.cleanup();}
});

test('lead cancellation is idempotent and a replacement starts without replaying the old package', async () => {
  const f = await engineFixture();
  try {
    await f.engine.execute(f.lead, 'automation_role_initialize', { cwd:f.dir });
    await f.engine.execute(f.backend, 'automation_role_initialize', { cwd:f.dir });
    await f.engine.execute(f.lead, 'automation_pause', {paused:true});
    const old = await f.engine.execute(f.lead, 'automation_dispatch', f.dispatch) as {message:{messageId:string}};
    const input = {dispatchId:old.message.messageId,evidence:'obsolete Task binding, no turn emitted',operationId:'cancel-old'};
    await assert.rejects(f.engine.execute(f.backend,'automation_cancel_queued',input),{code:'FORBIDDEN'});
    assert.deepEqual(await f.engine.execute(f.lead,'automation_cancel_queued',input),{status:'cancelled',dispatchId:old.message.messageId,finalAcceptance:'human_only'});
    await f.engine.execute(f.lead,'automation_cancel_queued',input);
    const next = await f.engine.execute(f.lead,'automation_dispatch',{...f.dispatch,operationId:'replacement',work:{...f.dispatch.work,id:'replacement'}}) as {message:{messageId:string}};
    await f.engine.execute(f.lead,'automation_pause',{paused:false});
    await f.engine.pump();
    assert.equal(f.engine.scheduler.get(old.message.messageId)?.state,'cancelled');
    assert.equal(f.engine.scheduler.get(next.message.messageId)?.state,'active');
  } finally { await f.cleanup(); }
});

test('human MCP approval is refused once its dispatch is no longer active', async () => {
  const f = await engineFixture();
  let emit:((event:any)=>void)|undefined; let replies=0;
  const factory=f.options.runtimeFactory;
  f.options.runtimeFactory=(role,cwd)=>{
    const h=factory(role,cwd);
    Object.assign(h.runtime,{onServerRequest:(listener:(event:any)=>void)=>{emit=listener;return()=>{};},respondToServerRequest:async()=>{replies++;}});
    return h;
  };
  try {
    await f.engine.execute(f.lead,'automation_role_initialize',{cwd:f.dir});
    await f.engine.execute(f.backend,'automation_role_initialize',{cwd:f.dir});
    const sent=await f.engine.execute(f.lead,'automation_dispatch',f.dispatch) as {message:{messageId:string}};
    await f.engine.pump();
    const run=f.engine.scheduler.get(sent.message.messageId)!;
    const threadId=f.engine.store.groupSnapshot('g')!.roles.find(r=>r.roleId==='backend')!.threadId;
    const params={threadId,turnId:run.turnId,mode:'form',_meta:{codex_approval_kind:'mcp_tool_call'},requestedSchema:{type:'object',properties:{}}};
    emit!({requestId:0,method:'mcpServer/elicitation/request',params,source:'mock'});
    await f.engine.humanRespond('independent-human-token',f.engine.approvals.list('g')[0]!.id,'accept');
    assert.equal(replies,1);
    emit!({requestId:1,method:'mcpServer/elicitation/request',params,source:'mock'});
    const stale=f.engine.approvals.list('g')[0]!.id;
    await f.engine.execute(f.backend,'automation_work_complete',{dispatchId:sent.message.messageId,summary:'finished',evidence:['Mock turn terminal']});
    await assert.rejects(f.engine.humanRespond('independent-human-token',stale,'accept'),{code:'RECONCILIATION_REQUIRED'});
    assert.equal(replies,1);
  } finally {await f.cleanup();}
});

test('lead archives only observed interrupted original turn with a current task gate', async () => {
  const {engineFixture} = await import('./fixtures/engine-fixture.js'); const f = await engineFixture();
  try {
    await f.engine.execute(f.lead,'automation_role_initialize',{cwd:f.dir}); await f.engine.execute(f.backend,'automation_role_initialize',{cwd:f.dir});
    const result = await f.engine.execute(f.lead,'automation_dispatch',f.dispatch) as {message:{messageId:string}};
    await f.engine.pump(); const record = f.engine.scheduler.get(result.message.messageId)!;
    const request = {binding:{...f.dispatch.binding,worktreePath:record.worktree},dispatchId:record.dispatchId,reason:'interrupted',evidence:'watchdog terminal observation',operationId:'archive'};
    await assert.rejects(f.engine.execute(f.backend,'automation_archive_failure',request), {code:'FORBIDDEN'});
    await assert.rejects(f.engine.execute(f.lead,'automation_archive_failure',request), {code:'RECONCILIATION_REQUIRED'});
    const thread = f.engine.store.groupSnapshot('g')!.roles.find(r=>r.roleId==='backend')!.threadId!;
    await f.runtimes[1]!.interruptTurn(thread,record.turnId!); f.engine.scheduler.recoverAfterRestart('g');
    const gate = f.options.taskAuthority.checkGate; f.options.taskAuthority.checkGate = async()=>{throw new Error('expired task lease');};
    await assert.rejects(f.engine.execute(f.lead,'automation_archive_failure',request), /expired task lease/);
    f.options.taskAuthority.checkGate = gate;
    await f.engine.execute(f.lead,'automation_archive_failure',request); await f.engine.execute(f.lead,'automation_archive_failure',request);
    assert.equal(f.engine.scheduler.get(record.dispatchId)?.state,'failed'); assert.equal(f.engine.budget.status().callsUsed,1); assert.equal(f.engine.budget.status().inFlight,0);
    const replacement = {...f.dispatch,operationId:'replacement',work:{...f.dispatch.work,id:'replacement',replacesDispatchId:record.dispatchId}};
    const sent = await f.engine.execute(f.lead,'automation_dispatch',replacement) as {message:{messageId:string}};
    const replay = await f.engine.execute(f.lead,'automation_dispatch',replacement) as {message:{messageId:string}};
    assert.equal(sent.message.messageId,replay.message.messageId);
    await assert.rejects(f.engine.execute(f.lead,'automation_dispatch',{...replacement,operationId:'fork',work:{...replacement.work,id:'fork'}}),{code:'IDEMPOTENCY_CONFLICT'});
  } finally {await f.cleanup();}
});

test('archive fences unavailable, mismatched, live and successful runtime histories', async () => {
  const {engineFixture}=await import('./fixtures/engine-fixture.js');const f=await engineFixture();
  try {
    await f.engine.execute(f.lead,'automation_role_initialize',{cwd:f.dir});await f.engine.execute(f.backend,'automation_role_initialize',{cwd:f.dir});
    const result=await f.engine.execute(f.lead,'automation_dispatch',f.dispatch) as {message:{messageId:string}};await f.engine.pump();const record=f.engine.scheduler.get(result.message.messageId)!;
    f.engine.scheduler.recoverAfterRestart('g');const runtime=f.runtimes[1]!;const thread=f.engine.store.groupSnapshot('g')!.roles.find(r=>r.roleId==='backend')!.threadId!;
    const request={binding:{...f.dispatch.binding,worktreePath:record.worktree},dispatchId:record.dispatchId,reason:'interrupted',evidence:'terminal proof required',operationId:'fenced'};
    for(const history of [null,{threadId:'foreign',turns:[]},{threadId:thread,turns:[{id:record.turnId,status:'completed'}]},{threadId:thread,status:{type:'active'},turns:[{id:record.turnId,status:'interrupted'}]},{threadId:thread,turns:[{id:record.turnId,status:'interrupted'},{id:'other',status:'inProgress'}]},{threadId:thread,turns:[{id:'foreign',status:'interrupted'}]}]) {
      runtime.readThread=async()=>history;await assert.rejects(f.engine.execute(f.lead,'automation_archive_failure',request),{code:'RECONCILIATION_REQUIRED'});
      assert.equal(f.engine.scheduler.get(record.dispatchId)?.state,'needs_reconciliation');
    }
    runtime.readThread=async()=>({threadId:thread,turns:[{id:record.turnId,status:'failed'}]});
    await f.engine.execute(f.lead,'automation_archive_failure',{...request,reason:'runtime_failed'});assert.equal(f.engine.scheduler.get(record.dispatchId)?.state,'failed');
  }finally{await f.cleanup();}
});

test('lost replacement dispatch response cannot fork its outbox lineage and recovers once', async () => {
  const {engineFixture}=await import('./fixtures/engine-fixture.js');const f=await engineFixture();
  try {
    await f.engine.execute(f.lead,'automation_role_initialize',{cwd:f.dir});await f.engine.execute(f.backend,'automation_role_initialize',{cwd:f.dir});
    const original=await f.engine.execute(f.lead,'automation_dispatch',f.dispatch) as {message:{messageId:string}};await f.engine.pump();const record=f.engine.scheduler.get(original.message.messageId)!;
    const thread=f.engine.store.groupSnapshot('g')!.roles.find(r=>r.roleId==='backend')!.threadId!;await f.runtimes[1]!.interruptTurn(thread,record.turnId!);f.engine.scheduler.recoverAfterRestart('g');
    await f.engine.execute(f.lead,'automation_archive_failure',{binding:{...f.dispatch.binding,worktreePath:record.worktree},dispatchId:record.dispatchId,reason:'interrupted',evidence:'verified Mock terminal',operationId:'archive'});
    const enqueue=f.engine.scheduler.enqueue.bind(f.engine.scheduler);f.engine.scheduler.enqueue=()=>{throw new Error('lost scheduler response');};
    const request={...f.dispatch,operationId:'successor',work:{...f.dispatch.work,id:'successor',replacesDispatchId:record.dispatchId}};
    await assert.rejects(f.engine.execute(f.lead,'automation_dispatch',request),/lost scheduler response/);f.engine.scheduler.enqueue=enqueue;
    await assert.rejects(f.engine.execute(f.lead,'automation_dispatch',{...request,operationId:'fork',work:{...request.work,id:'fork'}}),{code:'IDEMPOTENCY_CONFLICT'});
    await f.engine.pump();const replay=await f.engine.execute(f.lead,'automation_dispatch',request) as {message:{messageId:string}};
    assert.equal(f.engine.scheduler.list('g').filter(w=>w.replacesDispatchId===record.dispatchId).length,1);assert.equal(f.engine.scheduler.get(replay.message.messageId)?.state,'active');assert.equal(f.engine.budget.status().callsUsed,2);
  }finally{await f.cleanup();}
});

test('restart replaces a persisted thread the runtime cannot resume only when no work ever started on it', async () => {
  const {CoordinatorEngine}=await import('../src/engine.js');const {MockRuntime}=await import('../src/runtime/mock.js');
  const f=await engineFixture();
  const unresumable=()=>{const runtime=new MockRuntime();runtime.resumeThread=async()=>{throw new Error('no rollout found for thread');};return {runtime,close:async()=>{}};};
  const first=await f.engine.execute(f.backend,'automation_role_initialize',{cwd:f.dir}) as {threadId:string};await f.engine.close();
  const restored=new CoordinatorEngine({...f.options,runtimeFactory:unresumable});
  try {
    const second=await restored.execute(f.backend,'automation_role_initialize',{cwd:f.dir}) as {threadId:string};
    assert.notEqual(second.threadId,first.threadId);
    assert.equal(restored.store.groupSnapshot('g')!.roles.find((role)=>role.roleId==='backend')!.threadId,second.threadId);
  } finally { await restored.close(); await f.cleanup(); }
});

test('restart refuses to replace an unresumable thread that already started work', async () => {
  const {CoordinatorEngine}=await import('../src/engine.js');const {MockRuntime}=await import('../src/runtime/mock.js');
  const f=await engineFixture();
  await f.engine.execute(f.lead,'automation_role_initialize',{cwd:f.dir});
  const first=await f.engine.execute(f.backend,'automation_role_initialize',{cwd:f.dir}) as {threadId:string};
  const result=await f.engine.execute(f.lead,'automation_dispatch',f.dispatch) as {message:{messageId:string}};
  await f.engine.pump(); await f.engine.pump();
  assert.equal(f.engine.scheduler.get(result.message.messageId)?.state,'active');
  await f.engine.close();
  const unresumable=()=>{const runtime=new MockRuntime();runtime.resumeThread=async()=>{throw new Error('no rollout found for thread');};return {runtime,close:async()=>{}};};
  const restored=new CoordinatorEngine({...f.options,runtimeFactory:unresumable});
  try {
    await assert.rejects(restored.execute(f.backend,'automation_role_initialize',{cwd:f.dir}));
    assert.equal(restored.store.groupSnapshot('g')!.roles.find((role)=>role.roleId==='backend')!.threadId,first.threadId);
  } finally { await restored.close(); await f.cleanup(); }
});

test('turn usage that grows during a running turn is recorded once, after the terminal receipt', async () => {
  const {MockRuntime}=await import('../src/runtime/mock.js');
  let reads=0;
  const growing=()=>{const runtime=new MockRuntime();Object.assign(runtime,{readTurnUsage:async()=>({inputTokens:100*++reads,outputTokens:10*reads,cachedInputTokens:0,costUsd:null,source:'codex_notification' as const})});return {runtime,close:async()=>{}};};
  const f=await engineFixture(undefined,{runtimeFactory:growing});
  try {
    await f.engine.execute(f.lead,'automation_role_initialize',{cwd:f.dir});
    await f.engine.execute(f.backend,'automation_role_initialize',{cwd:f.dir});
    const result=await f.engine.execute(f.lead,'automation_dispatch',f.dispatch) as {message:{messageId:string}};
    await f.engine.pump(); await f.engine.pump(); await f.engine.pump();
    assert.equal(f.engine.scheduler.get(result.message.messageId)?.state,'active');
    const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(f.db,{readOnly:true});
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM turn_usage').get()!.n,0);
      await f.engine.execute(f.backend,'automation_work_complete',{dispatchId:result.message.messageId,summary:'done',evidence:['checked']});
      assert.equal(f.engine.scheduler.get(result.message.messageId)?.state,'completed');
      const row=db.prepare('SELECT payload_json FROM turn_usage WHERE dispatch_id=?').get(result.message.messageId) as {payload_json:string};
      assert.equal(JSON.parse(row.payload_json).inputTokens,100*reads);
    } finally { db.close(); }
  } finally { await f.cleanup(); }
});

test('a runtime turn that ended without a business receipt is flagged for reconciliation with its reason', async () => {
  const f=await engineFixture();
  try {
    await f.engine.execute(f.lead,'automation_role_initialize',{cwd:f.dir});
    await f.engine.execute(f.backend,'automation_role_initialize',{cwd:f.dir});
    const result=await f.engine.execute(f.lead,'automation_dispatch',f.dispatch) as {message:{messageId:string}};
    await f.engine.pump(); await f.engine.pump();
    assert.equal(f.engine.scheduler.get(result.message.messageId)?.state,'active','a fresh turn is not judged yet');
    const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(f.db);
    try { db.prepare('UPDATE scheduled_work SET started_at=? WHERE dispatch_id=?').run(Date.now()-60_000,result.message.messageId); } finally { db.close(); }
    await f.engine.pump();
    assert.equal(f.engine.scheduler.get(result.message.messageId)?.state,'needs_reconciliation');
    const {DatabaseSync:Reader}=await import('node:sqlite');const read=new Reader(f.db,{readOnly:true});
    try {
      const row=read.prepare('SELECT evidence_json FROM scheduled_work WHERE dispatch_id=?').get(result.message.messageId) as {evidence_json:string};
      assert.match(row.evidence_json,/ended \(completed\) without a business receipt/);
    } finally { read.close(); }
  } finally { await f.cleanup(); }
});
