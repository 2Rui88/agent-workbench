import assert from 'node:assert/strict';
import test from 'node:test';
import { engineFixture } from './fixtures/engine-fixture.js';
import type { AutomationCommand } from '../src/engine.js';

test('coordinator browser operations hold one lease across owned page cleanup and task service gates', async () => {
  const f=await engineFixture(); let healthy=false; let pages=0; let closed=0;
  (f.options as unknown as {browser:unknown}).browser={source:'mock',allowedOrigins:['http://app.invalid'],healthChecks:[{service:'fixture',check:async()=>healthy}],connect:async()=>({createOwnPage:async()=>{pages++;return{goto:async()=>({title:'isolated mock page'}),close:async()=>{closed++;}};},disconnect:async()=>{}})};
  const {CoordinatorEngine}=await import('../src/engine.js'); await f.engine.close(); const engine=new CoordinatorEngine(f.options);
  const call=(roleId:'frontend'|'audit',name:string,input:unknown)=>engine.execute(engine.authenticate(roleId,f.credentials[roleId],1),name as AutomationCommand,input);
  try {
    await call('frontend','automation_browser_request',{url:'http://app.invalid/test',binding:f.dispatch.binding,operationId:'browser-one'});
    await call('audit','automation_browser_request',{url:'http://app.invalid/audit',binding:f.dispatch.binding,operationId:'browser-two'});
    const claim=await call('frontend','automation_browser_claim',{}) as {requestId:string;leaseToken:string};
    assert.deepEqual(await call('audit','automation_browser_claim',{}),{empty:true});
    await assert.rejects(call('frontend','automation_browser_execute',{requestId:claim.requestId,leaseToken:claim.leaseToken}),{code:'SERVICE_UNHEALTHY'});
    assert.equal(pages,0);
    healthy=true;
    const again=await call('frontend','automation_browser_claim',{}) as {requestId:string;leaseToken:string};
    await call('frontend','automation_browser_execute',{requestId:again.requestId,leaseToken:again.leaseToken});
    assert.equal(pages,1);assert.equal(closed,1);
    assert.ok((await call('audit','automation_browser_claim',{}) as {requestId:string}).requestId);
  }finally{await engine.close();await f.cleanup();}
});

test('browser assertion flow records owned resource references through cleanup',async()=>{
 const f=await engineFixture();await f.engine.close();let assertions=0;
 f.options.browser={source:'mock',allowedOrigins:['http://app.invalid'],healthChecks:[{service:'mock',check:async()=>true}],connect:async()=>({createOwnPage:async()=>({resource:{targetId:'owned-target',contextId:'owned-context'},goto:async()=>({title:'test'}),assert:async(checks)=>{assertions+=checks.length;},close:async()=>{}}),disconnect:async()=>{}})};
 const {CoordinatorEngine}=await import('../src/engine.js');const engine=new CoordinatorEngine(f.options);
 try{
  await engine.execute(f.backend,'automation_browser_request',{url:'http://app.invalid/test',binding:f.dispatch.binding,assertions:[{selector:'#success',state:'visible'}],operationId:'browser-assertion'});
  const claim=await engine.execute(f.backend,'automation_browser_claim',{}) as {requestId:string;leaseToken:string};
  await engine.execute(f.backend,'automation_browser_execute',{requestId:claim.requestId,leaseToken:claim.leaseToken});
  assert.equal(assertions,1);assert.deepEqual(engine.browser.queue.resources(claim.requestId),[{targetId:'owned-target',contextId:'owned-context',cleared:true}]);
 }finally{await engine.close();await f.cleanup();}
});

test('duplicate execute cannot clear ownership of an in-flight browser flow',async()=>{
 const f=await engineFixture();await f.engine.close();let release!:()=>void;let entered!:()=>void;
 let running:Promise<unknown>|undefined;
 const enteredPage=new Promise<void>((resolve)=>{entered=resolve;});const gate=new Promise<void>((resolve)=>{release=resolve;});
 f.options.browser={source:'mock',allowedOrigins:['http://app.invalid'],healthChecks:[{service:'mock',check:async()=>true}],connect:async()=>({createOwnPage:async()=>({goto:async()=>{entered();await gate;return{title:'test'};},close:async()=>{}}),disconnect:async()=>{}})};
 const {CoordinatorEngine}=await import('../src/engine.js');const engine=new CoordinatorEngine(f.options);
 try{
  await engine.execute(f.backend,'automation_browser_request',{url:'http://app.invalid/test',binding:f.dispatch.binding,operationId:'duplicate-browser'});
  const claim=await engine.execute(f.backend,'automation_browser_claim',{}) as {requestId:string;leaseToken:string};const input={requestId:claim.requestId,leaseToken:claim.leaseToken};
  running=engine.execute(f.backend,'automation_browser_execute',input);await enteredPage;
  await assert.rejects(engine.execute(f.backend,'automation_browser_execute',input),{code:'STALE_LEASE'});
  engine.browser.queue.advanceClock(1000000);await engine.execute(engine.authenticate('audit',f.credentials.audit,1),'automation_browser_claim',{});
  await assert.rejects(engine.execute(f.lead,'automation_browser_reconcile',{requestId:claim.requestId,outcome:'completed',evidence:'manual resource clearance assertion',resourcesCleared:true}),{code:'RECONCILIATION_REQUIRED'});
  release();await assert.rejects(running,{code:'STALE_LEASE'});
 }finally{release();await running?.catch(()=>{});await engine.close();await f.cleanup();}
});
