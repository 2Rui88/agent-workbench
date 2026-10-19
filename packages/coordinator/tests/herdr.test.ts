import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HerdrController, ObserverTabClosed, OBSERVER_LABELS, SPLIT_RATIOS, observerTabLabel, type HerdrLayoutState } from '../src/terminal/herdr-controller.js';
import { HerdrClient, requireHerdrContext } from '../src/terminal/herdr-client.js';
import { RuntimeJournal } from '../src/terminal/runtime-journal.js';
import { AppServerRuntime } from '../src/runtime/app-server.js';
import { engineFixture } from './fixtures/engine-fixture.js';
import { DashboardProjection } from '../src/dashboard/projection.js';
import { CoordinatorEngine } from '../src/engine.js';
import { MockRuntime } from '../src/runtime/mock.js';

const MAIN_TAB = 'w-test:t-main';
const MAIN_PANE = 'w-test:p-main';
const argvFor = (role: string) => ['node', '/tmp/herdr-watch.js', 'db', 'g', role];

// A fake Herdr server: one main tab with the lead pane, tabs created on demand, panes split inside their tab.
function harness(saved: Partial<HerdrLayoutState> = {}, overrides: Record<string, (params: Record<string, unknown>) => any> = {}) {
  const calls: Array<{method: string; params: Record<string, unknown>}> = [];
  const panes = new Map<string, string>([[MAIN_PANE, MAIN_TAB]]);
  const tabs = new Map<string, string>([[MAIN_TAB, '1']]);
  const occupants = new Map<string, string>();
  const replaced = new Set<string>();
  let paneCount = 0; let tabCount = 0;
  let state: HerdrLayoutState | undefined;
  const request = async (method: string, params: Record<string, unknown>): Promise<any> => {
    calls.push({method, params});
    if (method in overrides) return overrides[method]!(params);
    if (method === 'pane.list') return {panes: [...panes].map(([pane_id, tab_id]) => ({pane_id, tab_id}))};
    if (method === 'tab.create') { const tab_id = `w-test:t-${++tabCount}`; tabs.set(tab_id, String(params.label)); const pane_id = `w-test:p-${++paneCount}`; panes.set(pane_id, tab_id); return {tab: {tab_id, label: params.label}, root_pane: {pane_id, tab_id}}; }
    if (method === 'tab.close') { for (const [pane, tab] of [...panes]) if (tab === params.tab_id) panes.delete(pane); tabs.delete(params.tab_id as string); return {}; }
    if (method === 'pane.split') { const tab = panes.get(params.target_pane_id as string); if (!tab) throw new Error('no such pane'); const pane_id = `w-test:p-${++paneCount}`; panes.set(pane_id, tab); return {pane: {pane_id, tab_id: tab}}; }
    if (method === 'pane.close') panes.delete(params.pane_id as string);
    if (method === 'pane.send_input') occupants.set(params.pane_id as string, (params.text as string).match(/'(frontend|backend|audit|advisor|overview)'$/)?.[1] ?? 'unknown');
    if (method === 'pane.process_info') return {process_info:{foreground_processes:[replaced.has(params.pane_id as string) ? {name:'vim',argv:['vim']} : {name:'node',argv:argvFor(occupants.get(params.pane_id as string) ?? 'unknown')}]}};
    return {};
  };
  const controller = new HerdrController({request}, {groupId:'g', workspaceId:'w-test', cwd:'/tmp', observerArgv: argvFor, save: async (s) => { state = s; }}, saved);
  return {controller, calls, panes, tabs, request, state: () => state, closePane: (pane: string) => panes.delete(pane), closeTab: (tab: string) => { for (const [pane, t] of [...panes]) if (t === tab) panes.delete(pane); tabs.delete(tab); }, takeover: (pane: string) => replaced.add(pane), mainPanes: () => [...panes].filter(([, tab]) => tab === MAIN_TAB).map(([pane]) => pane)};
}
const dispatch = (dispatchId: string, state = 'active') => ({dispatchId, workId:'work', state, requestedModel:'fast', requestedEffort:'medium', actualModel:null, turnId:'turn'});

test('open creates one labelled tab with the fixed five-pane layout and never splits the main tab', async () => {
  const f = await engineFixture(); const h = harness(); const p = new DashboardProjection(f.db);
  try {
    const tab = await h.controller.open(p.snapshot('g')!);
    const created = h.calls.find((c) => c.method === 'tab.create')!;
    assert.deepEqual(created.params, {workspace_id:'w-test', cwd:'/tmp', label: observerTabLabel('g'), focus:false});
    assert.equal(observerTabLabel('g'), '流水線協同 · g');
    assert.equal(h.tabs.get(tab), '流水線協同 · g');
    assert.deepEqual(h.mainPanes(), [MAIN_PANE], 'the main session tab keeps exactly its one pane');
    assert.equal([...h.panes.values()].filter((t) => t === tab).length, 5);
    const panes = h.controller.panes();
    const splits = h.calls.filter((c) => c.method === 'pane.split').map((c) => [c.params.target_pane_id, c.params.direction, c.params.ratio]);
    const overview = h.state()!.overviewPane!;
    assert.deepEqual(splits, [[overview, 'right', 0.3], [overview, 'down', 0.5], [panes.frontend, 'down', 0.33], [panes.backend, 'down', 0.5]], 'frontend right of the overview first (full-height right column, ~70% wide); advisor below the overview; backend and audit stacked in thirds');
    assert.equal(SPLIT_RATIOS.overviewRight, 0.3);
    assert.ok(h.calls.filter((c) => c.method === 'pane.split' || c.method === 'tab.create').every((c) => c.params.focus === false));
    assert.deepEqual(h.calls.filter((c) => c.method === 'pane.rename').map((c) => c.params.label), ['總覽', 'frontend', 'advisor', 'backend', 'audit']);
    const methods = h.calls.map((c) => c.method);
    assert.ok(methods.lastIndexOf('pane.split') < methods.indexOf('pane.rename') && methods.lastIndexOf('pane.split') < methods.indexOf('pane.send_input'), 'every pane is split before any observer is launched');
    assert.deepEqual(h.calls.filter((c) => c.method === 'pane.send_input').map((c) => c.params.pane_id), [overview, panes.frontend, panes.advisor, panes.backend, panes.audit]);
    assert.equal(OBSERVER_LABELS.overview, '總覽');
    const inputs = h.calls.filter((c) => c.method === 'pane.send_input').map((c) => c.params.text);
    assert.match(inputs[0] as string, /^exec 'node' '\/tmp\/herdr-watch\.js' 'db' 'g' 'overview'$/);
    assert.equal(h.calls.filter((c) => c.method === 'layout.apply').length, 0, 'must never replace live PTYs');
    assert.equal(h.state()!.observerTab, tab); assert.deepEqual(h.state()!.readyRoles.sort(), ['advisor', 'audit', 'backend', 'frontend']);
  } finally { p.close(); await f.cleanup(); }
});

test('sync reports role state on each pane without creating anything while the five panes stand', async () => {
  const f = await engineFixture(); const h = harness(); const p = new DashboardProjection(f.db);
  try {
    const s = p.snapshot('g')!; await h.controller.open(s);
    await f.engine.execute(f.lead, 'automation_role_initialize', {cwd:f.dir}); await f.engine.execute(f.backend, 'automation_role_initialize', {cwd:f.dir});
    const before = h.calls.filter((c) => c.method === 'pane.split').length;
    const snapshot = p.snapshot('g')!;
    for (const role of ['frontend','backend']) snapshot.roles.find((r)=>r.roleId===role)!.dispatches.push(dispatch(role));
    await h.controller.sync(snapshot); await h.controller.sync(snapshot);
    assert.equal(h.calls.filter((c) => c.method === 'pane.split').length, before);
    assert.ok(h.calls.filter((c)=>c.method==='pane.report_metadata').every((c)=>Object.keys(c.params.state_labels as object).every((key)=>['idle','working','blocked','done','unknown'].includes(key))));
    const latest = h.calls.filter((c) => c.method === 'pane.report_metadata' && c.params.pane_id === h.controller.panes().backend).at(-1)!;
    assert.equal(latest.params.title, 'backend · working');
  } finally { p.close(); await f.cleanup(); }
});

test('a role pane the user closes stays closed for the same execution and reopens inside the tab for newer work', async () => {
  const f = await engineFixture(); const h = harness(); const p = new DashboardProjection(f.db);
  try {
    const s = p.snapshot('g')!; const backend = s.roles.find((r) => r.roleId === 'backend')!;
    backend.dispatches.push(dispatch('d1'));
    const tab = await h.controller.open(s);
    const splits = () => h.calls.filter((c) => c.method === 'pane.split').length;
    h.closePane(h.controller.panes().backend!);
    await h.controller.sync(s);
    assert.equal(h.controller.panes().backend, undefined, 'closed while active is accepted');
    backend.dispatches[0]!.state = 'completed';
    await h.controller.sync(s); await h.controller.sync(s);
    assert.equal(splits(), 4, 'same execution never reopens');
    backend.dispatches.unshift(dispatch('d2', 'queued'));
    await h.controller.sync(s);
    assert.equal(splits(), 5, 'new dispatch reopens');
    assert.equal(h.panes.get(h.controller.panes().backend!), tab, 'reopened inside the observation tab');
    assert.deepEqual(h.mainPanes(), [MAIN_PANE]);
    h.closePane(h.controller.panes().backend!); await h.controller.sync(s);
    backend.waitingHuman = 1; await h.controller.sync(s);
    assert.equal(splits(), 6, 'new approval reopens');
  } finally { p.close(); await f.cleanup(); }
});

test('the user closing the observation tab stops layout control without rebuilding anything', async () => {
  const f = await engineFixture(); const h = harness(); const p = new DashboardProjection(f.db);
  try {
    const s = p.snapshot('g')!; const tab = await h.controller.open(s);
    h.closeTab(tab);
    const before = h.calls.length;
    await assert.rejects(h.controller.sync(s), ObserverTabClosed);
    assert.ok(h.calls.slice(before).every((c) => c.method === 'pane.list'), 'only the inventory is read');
    assert.equal(h.controller.observerTab(), undefined); assert.deepEqual(h.controller.panes(), {});
    assert.equal(h.state()!.observerTab, undefined);
    await assert.rejects(h.controller.sync(s), /not open/);
    assert.equal(h.calls.filter((c) => c.method === 'tab.create').length, 1, 'never recreated on its own');
  } finally { p.close(); await f.cleanup(); }
});

test('closing the overview pane also stops control; closeAll closes the whole tab even with a taken-over pane', async () => {
  const f = await engineFixture(); const p = new DashboardProjection(f.db);
  try {
    const a = harness(); const s = p.snapshot('g')!; const tab = await a.controller.open(s);
    a.closePane(a.state()!.overviewPane!);
    await assert.rejects(a.controller.sync(s), /Overview pane/);
    assert.ok(a.tabs.has(tab), 'remaining panes are left to the user');
    const b = harness(); const tabB = await b.controller.open(s);
    b.takeover(b.controller.panes().backend!);
    await b.controller.closeAll();
    assert.deepEqual(b.calls.filter((c) => c.method === 'tab.close').map((c) => c.params.tab_id), [tabB]);
    assert.equal(b.tabs.has(tabB), false); assert.deepEqual(b.mainPanes(), [MAIN_PANE]);
    assert.deepEqual(b.controller.panes(), {}); assert.equal(b.state()!.observerTab, undefined);
    await b.controller.closeAll();
    assert.equal(b.calls.filter((c) => c.method === 'tab.close').length, 1, 'a second close is a no-op');
  } finally { p.close(); await f.cleanup(); }
});

test('compact closes only idle owned role panes and keeps the overview, waiting-human and taken-over panes', async () => {
  const f = await engineFixture(); const h = harness(); const p = new DashboardProjection(f.db);
  try {
    const s = p.snapshot('g')!;
    s.roles.find((r) => r.roleId === 'audit')!.waitingHuman = 1;
    for (const role of ['frontend', 'backend']) s.roles.find((r) => r.roleId === role)!.dispatches.push(dispatch(role, 'completed'));
    const tab = await h.controller.open(s);
    h.takeover(h.controller.panes().backend!);
    await h.controller.compact(s);
    const panes = h.controller.panes();
    assert.equal(panes.frontend, undefined); assert.equal(panes.advisor, undefined);
    assert.ok(panes.audit, 'waiting for a human stays'); assert.equal(panes.backend, undefined, 'taken over pane is returned, not closed');
    assert.equal(h.calls.filter((c) => c.method === 'pane.close').length, 2);
    assert.ok(h.panes.has(h.state()!.overviewPane!) && h.tabs.has(tab));
    await h.controller.sync(s);
    assert.equal(h.controller.panes().frontend, undefined, 'compacted role stays closed for the same execution');
    await h.controller.compact(s, 'audit'); assert.ok(h.controller.panes().audit);
  } finally { p.close(); await f.cleanup(); }
});

test('a replaced observer is returned to the user, never closed, and new work gets a new pane', async () => {
  const f = await engineFixture(); const p = new DashboardProjection(f.db); const h = harness();
  try {
    const s = p.snapshot('g')!; const audit = s.roles.find((r) => r.roleId === 'audit')!; audit.waitingHuman = 1;
    await h.controller.open(s);
    const auditPane = h.controller.panes().audit!;
    h.takeover(auditPane);
    await h.controller.sync(s);
    assert.equal(h.controller.panes().audit, undefined);
    assert.ok(h.panes.has(auditPane), 'returned pane stays open');
    assert.equal(h.calls.filter((c) => c.method === 'pane.close').length, 0);
    audit.waitingHuman = 2;
    await h.controller.sync(s);
    assert.ok(h.controller.panes().audit && h.controller.panes().audit !== auditPane, 'next invocation creates a new pane');
    const before = h.calls.length; await h.controller.sync(s);
    assert.ok(h.calls.slice(before).every((c) => c.params.pane_id !== auditPane), 'returned pane is never touched again');
  } finally { p.close(); await f.cleanup(); }
});

test('a saved tab that is still open with our overview is adopted; a foreign one is refused', async () => {
  const f = await engineFixture(); const p = new DashboardProjection(f.db);
  try {
    const s = p.snapshot('g')!;
    const first = harness(); const tab = await first.controller.open(s); const saved = first.state()!;
    first.closePane(first.controller.panes().advisor!);
    const second = harness(saved);
    second.panes.clear(); for (const [pane, t] of first.panes) second.panes.set(pane, t); second.tabs.set(tab, 'x');
    for (const role of ['frontend', 'backend', 'audit']) second.calls.push({method:'seed', params:{}}); // keep call list non-empty for clarity
    // occupants are unknown to the second harness: seed them through the same send_input path the first used
    for (const c of first.calls.filter((c) => c.method === 'pane.send_input')) await second.request('pane.send_input', c.params);
    assert.equal(await second.controller.open(s), tab);
    assert.equal(second.calls.filter((c) => c.method === 'tab.create').length, 0, 'the open tab is reused');
    assert.equal(second.calls.filter((c) => c.method === 'pane.split').length, 1, 'only the missing advisor pane is recreated');
    const foreign = harness(saved);
    foreign.panes.clear(); for (const [pane, t] of first.panes) foreign.panes.set(pane, t); foreign.tabs.set(tab, 'x');
    foreign.takeover(saved.overviewPane!);
    await assert.rejects(foreign.controller.open(s), /overview pane is not ours/);
  } finally { p.close(); await f.cleanup(); }
});

test('ambiguous tab or split outcome freezes the controller without repeating the mutation', async () => {
  const f = await engineFixture(); const p = new DashboardProjection(f.db); let creates = 0;
  try {
    const s = p.snapshot('g')!;
    const h = harness({}, {'tab.create': () => { creates++; throw new Error('timeout outcome unknown'); }});
    await assert.rejects(h.controller.open(s), /timeout/); await assert.rejects(h.controller.open(s), /frozen/i); assert.equal(creates, 1);
    assert.throws(() => requireHerdrContext({HERDR_ENV:'1'}), /pane|context/i);
    assert.throws(() => requireHerdrContext({}), /Herdr/i);
  } finally { p.close(); await f.cleanup(); }
});

test('pending observer launch is persisted and restart does not repeat unknown input', async () => {
  const f = await engineFixture(); const p = new DashboardProjection(f.db);
  try {
    const s = p.snapshot('g')!; let sends = 0;
    const h = harness({}, {'pane.send_input': () => { sends++; throw new Error('unknown send outcome'); }});
    await assert.rejects(h.controller.open(s), /unknown send/);
    assert.ok(h.state()!.observerTab, 'the created tab is recorded before the shell is told anything');
    assert.equal(h.calls.filter((c) => c.method === 'pane.split').length, 4, 'all splits happen before the first observer launch');
    assert.equal(Object.keys(h.state()!.panes).length, 4, 'every created role pane is recorded');
    assert.deepEqual(h.state()!.readyRoles, [], 'no role pane is verified yet');
    assert.equal(h.state()!.overviewPane, undefined, 'the unverified overview is never recorded as ours');
    const resumed = harness(h.state()!, {'pane.send_input': () => { sends++; throw new Error('unknown send outcome'); }});
    resumed.panes.clear(); for (const [pane, t] of h.panes) resumed.panes.set(pane, t);
    await assert.rejects(resumed.controller.open(s), /not ours/);
    assert.equal(sends, 1);
  } finally { p.close(); await f.cleanup(); }
});

test('persisted role mapping cannot alias the overview or another role pane', () => {
  const transport = {request: async () => ({})}; const options = {groupId:'g', workspaceId:'w', cwd:'/tmp', observerArgv: () => []};
  assert.throws(() => new HerdrController(transport, options, {overviewPane:'w:p1', panes:{backend:'w:p1'}}), /mapping/);
  assert.throws(() => new HerdrController(transport, options, {panes:{frontend:'w:p', backend:'w:p'}}), /mapping/);
});

test('Herdr socket validates response ID and distinguishes RPC errors from success',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'herdr-rpc-'));const socket=join(dir,'s');
  const server=createServer((connection)=>connection.once('data',(data)=>{const req=JSON.parse(String(data));connection.end(JSON.stringify(req.method==='bad'?{id:req.id,error:{code:'bad',message:'refused'}}:{id:req.id,result:{pong:true}})+'\n');}));
  await new Promise<void>((resolve)=>server.listen(socket,resolve));
  try{const client=new HerdrClient(socket);assert.deepEqual(await client.request('ping',{}),{pong:true});await assert.rejects(client.request('bad',{}),/refused/);}finally{await new Promise<void>((resolve)=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});

test('runtime notifications enter bounded terminal journal without raw message or secrets',async()=>{
  const f=await engineFixture();const input=new PassThrough();const output=new PassThrough();const runtime=new AppServerRuntime({input,output});
  const journal=new RuntimeJournal(f.db);
  try{runtime.onEvent((event)=>journal.record('g','backend',event));
    input.write(JSON.stringify({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{type:'agentMessage',text:'SECRET'}}})+'\n');
    const rows=journal.read('g','backend');assert.equal(rows.length,1);assert.equal(rows[0]!.method,'item/completed');assert.ok(!JSON.stringify(rows).includes('SECRET'));
    for(let i=0;i<210;i++)journal.record('g','backend',{method:'turn/completed',threadId:'thread',turnId:String(i),source:'mock',params:{secret:'NEVER'}});
    assert.equal(journal.read('g','backend',300).length,200);
  }finally{runtime.dispose();journal.close();await f.cleanup();}
});

test('engine captures runtime lifecycle notifications for terminal observers',async()=>{
  const f=await engineFixture();let listener:((event:any)=>void)|undefined;
  const runtime=Object.assign(new MockRuntime(),{onEvent(fn:(event:any)=>void){listener=fn;return()=>{};}});
  const engine=new CoordinatorEngine({...f.options,runtimeFactory:()=>({runtime,close:async()=>{}})});
  const journal=new RuntimeJournal(f.db);
  try{await engine.execute(f.backend,'automation_role_initialize',{cwd:f.dir});
    listener?.({method:'turn/completed',source:'mock',threadId:'t',turnId:'v',params:{}});
    assert.equal(journal.read('g','backend').length,1);
  }finally{journal.close();await engine.close();await f.cleanup();}
});

test('archived failure retains owned pane using supported metadata state and explicit failure title', async () => {
  const f=await engineFixture();const p=new DashboardProjection(f.db);const h=harness();
  try {
    const s=p.snapshot('g')!;const role=s.roles.find(r=>r.roleId==='audit')!;
    role.dispatches.push({dispatchId:'failed',workId:'failed',state:'active',requestedModel:null,requestedEffort:null,actualModel:null,turnId:'turn'});
    await h.controller.open(s);role.dispatches[0]!.state='failed';role.waitingHuman=0;role.staleApprovals=1;await h.controller.sync(s);
    const report=h.calls.filter(c=>c.method==='pane.report_metadata'&&c.params.pane_id===h.controller.panes().audit).at(-1)!;
    assert.match(String(report.params.title),/failed/);assert.ok(Object.keys(report.params.state_labels as object).every(key=>['idle','working','blocked','done','unknown'].includes(key)));
    assert.equal(h.calls.some(c=>c.method==='pane.close'||c.method==='layout.apply'||c.method==='tab.close'),false);
  }finally{p.close();await f.cleanup();}
});

test('historical unreconciled audit remains blocked even after a newer completion', async () => {
  const f=await engineFixture();const projection=new DashboardProjection(f.db);const h=harness();
  try {
    const snapshot=projection.snapshot('g')!;const audit=snapshot.roles.find(r=>r.roleId==='audit')!;
    const d={dispatchId:'pending',workId:'pending',state:'active',requestedModel:null,requestedEffort:null,actualModel:null,turnId:'pending-turn'};
    audit.dispatches.push(d);await h.controller.open(snapshot);
    audit.dispatches=[{...d,dispatchId:'current',state:'completed'}, {...d,state:'needs_reconciliation'}];
    await h.controller.sync(snapshot);
    assert.equal(h.calls.filter(c=>c.method==='pane.report_metadata'&&c.params.pane_id===h.controller.panes().audit).at(-1)!.params.title,'audit · blocked');
  }finally{projection.close();await f.cleanup();}
});

// Script-level: the controller opens the tab, writes the ready file and closes the tab when the lead process exits.
test('layout controller opens the tab on start and closes it when the lead process exits', async () => {
  const f = await engineFixture(); const dir = await mkdtemp(join(tmpdir(), 'herdr-exit-'));
  const watcher = fileURLToPath(new URL('../scripts/herdr-watch.js', import.meta.url));
  // The fake server cannot know which role a pane runs, so it answers every process_info with the argv the controller expects for that role.
  const roleByPane = new Map<string, string>();
  const socket = join(dir, 's'); const closed: string[] = []; const panes = new Map<string, string>([['w:p-main', 'w:t-main']]); let count = 0;
  const server = createServer((connection) => connection.once('data', (data) => {
    const req = JSON.parse(String(data)); let result: unknown = {};
    if (req.method === 'pane.list') result = { panes: [...panes].map(([pane_id, tab_id]) => ({ pane_id, tab_id })) };
    else if (req.method === 'tab.create') { const pane_id = `w:p-${++count}`; panes.set(pane_id, 'w:t-obs'); result = { tab: { tab_id: 'w:t-obs' }, root_pane: { pane_id, tab_id: 'w:t-obs' } }; }
    else if (req.method === 'pane.split') { const pane_id = `w:p-${++count}`; panes.set(pane_id, panes.get(req.params.target_pane_id)!); result = { pane: { pane_id, tab_id: panes.get(pane_id) } }; }
    else if (req.method === 'pane.send_input') roleByPane.set(req.params.pane_id, String(req.params.text).match(/'(\w+)'$/)![1]!);
    else if (req.method === 'pane.process_info') result = { process_info: { foreground_processes: [{ name: 'node', argv: [process.execPath, watcher, f.db, 'g', roleByPane.get(req.params.pane_id) ?? 'none'] }] } };
    else if (req.method === 'tab.close') { closed.push(req.params.tab_id); for (const [pane, tab] of [...panes]) if (tab === req.params.tab_id) panes.delete(pane); }
    connection.end(JSON.stringify({ id: req.id, result }) + '\n');
  }));
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const lead = spawn(process.execPath, ['-e', 'setTimeout(()=>{},2500)']);
  try {
    const runtime = join(dir, 'runtime.json'); const ready = join(dir, 'ready.json');
    await writeFile(runtime, JSON.stringify({ groupId: 'g', databasePath: f.db, socketPath: join(dir, 'c.sock'), credentialFile: 'roles.json', humanCredentialFile: 'human.json', allowedRoots: [dir] }));
    const follow = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../scripts/herdr-follow.ts', import.meta.url)), runtime], {
      env: { ...process.env, HERDR_ENV: '1', HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: 'w:p-main', HERDR_TAB_ID: 'w:t-main', HERDR_WORKSPACE_ID: 'w', COORDINATOR_LEAD_PID: String(lead.pid), COORDINATOR_HERDR_READY_FILE: ready }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; follow.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve) => { const timer = setTimeout(() => { follow.kill(); resolve(null); }, 20000); follow.on('exit', (c) => { clearTimeout(timer); resolve(c); }); });
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(await readFile(ready, 'utf8')), { status: 'ready', observerTab: 'w:t-obs', workspaceId: 'w' });
    assert.deepEqual(closed, ['w:t-obs']);
    assert.deepEqual([...panes.keys()], ['w:p-main'], 'the main tab is untouched');
    const saved = JSON.parse(await readFile(join(dirname(f.db), 'herdr-panes.json'), 'utf8'));
    assert.equal(saved.observerTab, undefined); assert.deepEqual(saved.panes, {});
  } finally { lead.kill(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); await f.cleanup(); }
});
