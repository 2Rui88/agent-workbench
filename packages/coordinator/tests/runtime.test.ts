import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { HumanApprovalGate } from '../src/approvals.js';
import { AppServerRuntime } from '../src/runtime/app-server.js';
import { MockRuntime } from '../src/runtime/mock.js';

test('rpcOutOfOrder: responses resolve by request id rather than arrival order', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  const runtime = new AppServerRuntime({ input, output });
  const one = runtime.request('one', {}); const two = runtime.request('two', {});
  input.write('{"id":2,"result":{"n":2}}\n{"id":1,"result":{"n":1}}\n');
  assert.deepEqual(await one, { n: 1 }); assert.deepEqual(await two, { n: 2 });
  runtime.dispose();
});

test('disconnectRejectsPending: child exit rejects outstanding RPCs', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  const runtime = new AppServerRuntime({ input, output });
  const pending = runtime.request('waiting', {});
  runtime.disconnect(new Error('child exited'));
  await assert.rejects(pending, /child exited/);
});

test('eventDoesNotCompleteMessage: turn events only reach event listeners', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  const runtime = new AppServerRuntime({ input, output });
  const events: unknown[] = []; runtime.onEvent((event) => events.push(event));
  input.write('{"method":"turn/completed","params":{"threadId":"t1","turnId":"u1"}}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1);
  runtime.dispose();
});

test('serverRequestWaitsForHuman: App Server approval request is held until a human responds', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  const chunks: string[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  const runtime = new AppServerRuntime({ input, output });
  const human = { id: 'human-only-capability-value' };
  const gate = new HumanApprovalGate(human);
  const actor = { groupId: 'g1', roleId: 'backend' as const, bindingGeneration: 1, capabilityId: 'worker' };
  let pendingId: string | number | undefined;
  let approvalId: string | undefined;
  runtime.onServerRequest((request) => {
    pendingId = request.requestId;
    approvalId = gate.request(actor, String(request.requestId), request.params).id;
  });
  input.write('{"jsonrpc":"2.0","id":44,"method":"item/commandExecution/requestApproval","params":{"command":"write"}}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate.list()[0]?.state, 'waiting_human');
  assert.equal(chunks.length, 0);
  assert.throws(() => gate.respond(approvalId!, { id: actor.capabilityId }, { decision: 'approve' }), { code: 'FORBIDDEN' });
  const response = gate.respond(approvalId!, human, { decision: 'approve' });
  await runtime.respondToServerRequest(pendingId!, response.decision);
  assert.match(chunks.join(''), /"id":44,"result":\{"decision":"approve"\}/);
  runtime.dispose();
});

test('turn start always sends the selected model, effort, and worktree explicitly', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  const writes: string[] = [];
  output.on('data', (chunk: Buffer) => writes.push(chunk.toString()));
  const runtime = new AppServerRuntime({ input, output });
  const pending = runtime.startTurn({ threadId: 'thread-1', input: 'implement', model: 'gpt-6-luna', effort: 'high', cwd: '/repo' });
  await new Promise((resolve) => setImmediate(resolve));
  const request = JSON.parse(writes.join('')) as { id: number; method: string; params: Record<string, unknown> };
  assert.equal(request.method, 'turn/start');
  assert.deepEqual({ model: request.params.model, effort: request.params.effort, cwd: request.params.cwd, input: request.params.input }, { model: 'gpt-6-luna', effort: 'high', cwd: '/repo', input: [{ type: 'text', text: 'implement' }] });
  input.write(JSON.stringify({ id: request.id, result: { turn: { id: 'turn-1', status: 'started' } } }) + '\n');
  assert.deepEqual(await pending, { threadId: 'thread-1', turnId: 'turn-1', requestedModel: 'gpt-6-luna', requestedEffort: 'high', status: 'started' });
  runtime.dispose();
});

test('mockDoesNotCallProvider: mock implements runtime locally and exposes requested config', async () => {
  const runtime = new MockRuntime();
  await runtime.initialize();
  const models = await runtime.listModels();
  assert.ok(models.some((entry) => entry.model === 'gpt-6.1-sol'));
  const threadId = await runtime.startThread('/tmp');
  const started = await runtime.startTurn({ threadId, input: 'inspect', model: 'gpt-6-luna', effort: 'high', cwd: '/tmp' });
  assert.equal(started.requestedModel, 'gpt-6-luna'); assert.equal(started.requestedEffort, 'high');
  assert.equal(runtime.providerCalls, 0);
});

test('audit thread startup and resume explicitly retain read-only sandbox and user approval', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  const requests: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  output.on('data', (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString()); requests.push(request);
    input.write(JSON.stringify({ id: request.id, result: { thread: { id: 'audit-thread' } } }) + '\n');
  });
  const runtime = new AppServerRuntime({ input, output, threadPolicy: { sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user' } });
  await runtime.startThread('/repo'); await runtime.resumeThread('audit-thread', '/repo');
  for (const request of requests) assert.deepEqual({ sandbox: request.params.sandbox, approval: request.params.approvalPolicy, reviewer: request.params.approvalsReviewer }, { sandbox: 'read-only', approval: 'on-request', reviewer: 'user' });
  runtime.dispose();
});

test('resume rejects a substituted thread reference',async()=>{
 const input=new PassThrough();const output=new PassThrough();
 output.on('data',(chunk:Buffer)=>{const request=JSON.parse(chunk.toString());input.write(JSON.stringify({id:request.id,result:{thread:{id:'different-thread'}}})+'\n');});
 const runtime=new AppServerRuntime({input,output});
 try{await assert.rejects(runtime.resumeThread('original-thread','/repo'),{code:'RECONCILIATION_REQUIRED'});}finally{runtime.dispose();}
});

test('thread history reads all pages through dedicated turn listing',async()=>{
 const input=new PassThrough();const output=new PassThrough();const calls:string[]=[];
 output.on('data',(chunk:Buffer)=>{const r=JSON.parse(chunk.toString());calls.push(r.method);
   let result:unknown;
   if(r.method==='thread/read'){assert.equal(r.params.includeTurns,false);result={thread:{id:'t',turns:[]}};}
   else if(r.method==='thread/turns/list')result=r.params.cursor?{data:[{id:'b',status:'inProgress'}],nextCursor:null}:{data:[{id:'a',status:'completed'}],nextCursor:'next'};
   input.write(JSON.stringify({id:r.id,result})+'\n');
 });
 const runtime=new AppServerRuntime({input,output});
 try{const value=await runtime.readThread('t') as any;assert.deepEqual(value.thread.turns,[{id:'a',status:'completed'},{id:'b',status:'inProgress'}]);assert.deepEqual(calls,['thread/read','thread/turns/list','thread/turns/list']);}finally{runtime.dispose();}
});

test('initial unmaterialized thread is empty only before this client emits any turn',async()=>{
 const input=new PassThrough();const output=new PassThrough();
 output.on('data',(chunk:Buffer)=>{const r=JSON.parse(chunk.toString());
   if(r.method==='thread/turns/list'){input.write(JSON.stringify({id:r.id,error:{message:'thread fresh is not materialized yet; thread/turns/list is unavailable before first user message'}})+'\n');return;}
   input.write(JSON.stringify({id:r.id,result:r.method==='turn/start'?{turn:{id:'turn',status:'started'}}:{thread:{id:'fresh',turns:[],status:{type:'idle'}}}})+'\n');
 });
 const runtime=new AppServerRuntime({input,output});
 try{await runtime.startThread('/repo');const result=await runtime.readThread('fresh') as any;assert.deepEqual(result.thread.turns,[]);
   await runtime.startTurn({threadId:'fresh',input:'x',model:'fast',effort:'low',cwd:'/repo'});
   await assert.rejects(runtime.readThread('fresh'),{code:'RECONCILIATION_REQUIRED'});
 }finally{runtime.dispose();}
});

test('unavailable, truncated or repeated history cursors never imply empty history',async()=>{
 for(const mode of ['unavailable','repeat','invalid']){
  const input=new PassThrough();const output=new PassThrough();
  output.on('data',(chunk:Buffer)=>{const r=JSON.parse(chunk.toString());
   if(r.method==='thread/read'){input.write(JSON.stringify({id:r.id,result:{thread:{id:'t',turns:[]}}})+'\n');return;}
   input.write(JSON.stringify(mode==='unavailable'?{id:r.id,error:{message:'unavailable'}}:{id:r.id,result:mode==='invalid'?{data:[],nextCursor:23}:{data:[],nextCursor:'same'}})+'\n');
  });
  const runtime=new AppServerRuntime({input,output});try{await assert.rejects(runtime.readThread('t'),{code:'RECONCILIATION_REQUIRED'});}finally{runtime.dispose();}
 }
});

test('nested terminal turn references are normalized for lifecycle observers', () => {
  const input=new PassThrough();const output=new PassThrough();const runtime=new AppServerRuntime({input,output});let turnId:string|undefined;
  runtime.onEvent(event=>{turnId=event.turnId;});
  input.write(JSON.stringify({method:'turn/completed',params:{threadId:'original',turn:{id:'terminal',status:'interrupted'}}})+'\n');
  assert.equal(turnId,'terminal');runtime.dispose();
});
