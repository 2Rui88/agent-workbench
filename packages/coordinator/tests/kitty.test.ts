import assert from 'node:assert/strict';
import test from 'node:test';
import { KittyController, type KittyTransport, type KittyTab } from '../src/terminal/kitty-controller.js';
import { engineFixture } from './fixtures/engine-fixture.js';
import { DashboardProjection } from '../src/dashboard/projection.js';

function harness() {
  const tab:KittyTab={id:10,layout:'splits',windows:[{id:1,foreground_processes:[{cmdline:['codex']}]}]};
  const calls:string[][]=[];
  const run:KittyTransport['run']=async(args)=>{
    calls.push(args);
    if(args[0]==='ls')return JSON.stringify([{tabs:[tab]}]);
    if(args[0]==='launch') {const id=tab.windows.length+1;const start=args.indexOf('--')+1;tab.windows.push({id,foreground_processes:[{cmdline:args.slice(start)}]});return String(id);}
    if(args[0]==='close-window')tab.windows=tab.windows.filter(w=>w.id!==Number(args[2]!.split(':')[1]));
    return '';
  };
  const options={groupId:'g',leadWindow:1,tabId:10,cwd:'/tmp',observerArgv:(role:string)=>['node','observer','db','g',role]};
  return {tab,calls,options,transport:{run},controller:new KittyController({run},options)};
}
test('Kitty activation 1->3->4, restart reuse and compact preserve lead and focus',async()=>{
  const f=await engineFixture();const p=new DashboardProjection(f.db);const h=harness();
  try {
    const s=p.snapshot('g')!;await h.controller.sync(s);assert.equal(h.tab.windows.length,1);
    for(const r of s.roles.filter(r=>r.roleId==='frontend'||r.roleId==='backend'))r.dispatches.push({dispatchId:r.roleId,workId:'w',state:'active',requestedModel:'fast',requestedEffort:'medium',actualModel:null,turnId:'t'});
    await h.controller.sync(s);await h.controller.sync(s);assert.equal(h.tab.windows.length,3);
    s.roles.find(r=>r.roleId==='audit')!.dispatches.push({...s.roles.find(r=>r.roleId==='frontend')!.dispatches[0]!,dispatchId:'audit'});
    await h.controller.sync(s);assert.equal(h.tab.windows.length,4);
    const resumed=new KittyController(h.transport,h.options,h.controller.panes());await resumed.sync(s);assert.equal(h.calls.filter(c=>c[0]==='launch').length,3);
    assert.ok(h.calls.filter(c=>c[0]==='launch').every(c=>c.includes('--keep-focus')&&c.includes('--match')&&c.includes('id:10')));
    await resumed.compact(s);assert.equal(h.tab.windows.length,4);
    for(const r of s.roles)for(const d of r.dispatches)d.state='completed';await resumed.compact(s);assert.deepEqual(h.tab.windows.map(w=>w.id),[1]);
  }finally{p.close();await f.cleanup();}
});
test('Kitty ignores foreign panes and returns replaced observers without closing user resources',async()=>{
 const f=await engineFixture();const p=new DashboardProjection(f.db);
 try {
  const h=harness(),s=p.snapshot('g')!;h.tab.windows.push({id:9,foreground_processes:[{cmdline:['vim']}]});await h.controller.sync(s);assert.equal(h.calls.filter(c=>c[0]==='close-window'||c[0]==='launch').length,0);
  const h2=harness();s.roles.find(r=>r.roleId==='backend')!.dispatches.push({dispatchId:'b',workId:'w',state:'active',requestedModel:'fast',requestedEffort:'medium',actualModel:null,turnId:'t'});await h2.controller.sync(s);h2.tab.windows[1]!.foreground_processes=[{cmdline:['vim']}];s.roles.find(r=>r.roleId==='backend')!.dispatches[0]!.state='completed';await h2.controller.compact(s);assert.equal(h2.tab.windows.length,2);assert.equal(h2.controller.panes().backend,undefined);assert.equal(h2.calls.filter(c=>c[0]==='close-window').length,0);
 }finally{p.close();await f.cleanup();}
});
test('Kitty user close reopens only for new work',async()=>{
 const f=await engineFixture();const p=new DashboardProjection(f.db);
 try {
  const h=harness(),s=p.snapshot('g')!;const backend=s.roles.find(r=>r.roleId==='backend')!;
  backend.dispatches.push({dispatchId:'b1',workId:'w',state:'active',requestedModel:'fast',requestedEffort:'medium',actualModel:null,turnId:'t'});
  await h.controller.sync(s);const launches=()=>h.calls.filter(c=>c[0]==='launch').length;assert.equal(launches(),1);
  h.tab.windows=h.tab.windows.filter(w=>w.id===1);await h.controller.sync(s);assert.equal(h.controller.panes().backend,undefined);
  backend.dispatches[0]!.state='completed';await h.controller.sync(s);assert.equal(launches(),1);
  backend.dispatches.unshift({dispatchId:'b2',workId:'w2',state:'queued',requestedModel:'fast',requestedEffort:'medium',actualModel:null,turnId:null});await h.controller.sync(s);assert.equal(launches(),2);
  h.tab.windows=h.tab.windows.filter(w=>w.id!==1);await assert.rejects(h.controller.sync(s),/lead/i);
 }finally{p.close();await f.cleanup();}
});
test('Kitty layout keeps lead and advisor on the left and frontend, backend, audit in order on the right',async()=>{
  const f=await engineFixture();const p=new DashboardProjection(f.db);const h=harness();
  try {
    const s=p.snapshot('g')!;
    const activate=async(role:string)=>{s.roles.find(r=>r.roleId===role)!.dispatches.push({dispatchId:role,workId:'w',state:'active',requestedModel:'fast',requestedEffort:'medium',actualModel:null,turnId:'t'});await h.controller.sync(s);};
    await activate('audit');await activate('advisor');await activate('frontend');await activate('backend');
    const panes=h.controller.panes();
    const at=(c:string[],flag:string)=>c[c.indexOf(flag)+1];
    const launches=h.calls.filter(c=>c[0]==='launch').map(c=>[at(c,'--next-to'),at(c,'--location')]);
    assert.deepEqual(launches,[['id:1','vsplit'],['id:1','hsplit'],[`id:${panes.audit}`,'hsplit'],[`id:${panes.frontend}`,'hsplit']]);
    assert.deepEqual(h.calls.filter(c=>c[0]==='action'),[['action','--match',`id:${panes.frontend}`,'move_window','up']],'frontend opened after audit moves above it');
  }finally{p.close();await f.cleanup();}
});

test('Kitty lead exit closes only windows still running this group observer, even after the lead window is gone',async()=>{
  const f=await engineFixture();const p=new DashboardProjection(f.db);const h=harness();
  try {
    const s=p.snapshot('g')!;
    for(const r of s.roles.filter(r=>r.roleId==='frontend'||r.roleId==='backend'))r.dispatches.push({dispatchId:r.roleId,workId:'w',state:'active',requestedModel:'m',requestedEffort:'medium',actualModel:null,turnId:'t'});
    await h.controller.sync(s);
    const panes=h.controller.panes();
    h.tab.windows.find(w=>w.id===panes.backend)!.foreground_processes=[{cmdline:['vim']}];
    h.tab.windows=h.tab.windows.filter(w=>w.id!==1);
    await h.controller.closeAll();
    assert.deepEqual(h.calls.filter(c=>c[0]==='close-window').map(c=>c[2]),[`id:${panes.frontend}`]);
    assert.ok(h.tab.windows.some(w=>w.id===panes.backend),'a window the user took over is left alone');
    assert.deepEqual(h.controller.panes(),{});
  } finally {p.close();await f.cleanup();}
});
