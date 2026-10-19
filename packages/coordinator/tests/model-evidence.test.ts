import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm,truncate,mkdir,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readTurnModel} from '../src/runtime/model-evidence.js';

test('only original session and matching per-turn context proves runtime model; thread defaults do not', async()=>{
  const root=await mkdtemp(join(tmpdir(),'runtime-model-'));const path=join(root,'rollout.jsonl');
  const line=(type:string,payload:unknown)=>JSON.stringify({type,payload})+'\n';
  try {
    await writeFile(path,line('session_meta',{id:'thread'})+line('turn_context',{turn_id:'turn',model:'gpt-6.1-sol',effort:'high',secret:'DO_NOT_RETURN'}));
    assert.deepEqual(await readTurnModel(path,root,'thread','turn'),{model:'gpt-6.1-sol',effort:'high',source:'codex_turn_context'});
    assert.equal(await readTurnModel(path,root,'foreign','turn'),undefined);assert.equal(await readTurnModel(path,root,'thread','other'),undefined);
    assert.equal(await readTurnModel(path,join(root,'other'),'thread','turn'),undefined);
    await writeFile(path,line('session_meta',{id:'thread',model:'thread-default'}));assert.equal(await readTurnModel(path,root,'thread','turn'),undefined);
    await writeFile(path,line('session_meta',{id:'thread'})+line('turn_context',{turn_id:'turn',model:'one',effort:'low'})+line('turn_context',{turn_id:'turn',model:'two',effort:'low'}));assert.equal(await readTurnModel(path,root,'thread','turn'),undefined);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('runtime model evidence persists to SQLite, HTTP DTO and observer without raw logs', async()=>{
  const {engineFixture}=await import('./fixtures/engine-fixture.js');const f=await engineFixture();
  const {DashboardProjection}=await import('../src/dashboard/projection.js');const {CoordinatorObserver}=await import('../src/observer.js');
  try {
    await f.engine.execute(f.lead,'automation_role_initialize',{cwd:f.dir});await f.engine.execute(f.backend,'automation_role_initialize',{cwd:f.dir});
    const sent=await f.engine.execute(f.lead,'automation_dispatch',f.dispatch) as {message:{messageId:string}};await f.engine.pump();const dispatch=f.engine.scheduler.get(sent.message.messageId)!;
    f.runtimes[1]!.readTurnModel=async()=>({model:'gpt-6.1-sol',effort:'high',source:'codex_turn_context'});
    await f.engine.execute(f.lead,'automation_model_refresh',{binding:{...f.dispatch.binding,worktreePath:dispatch.worktree},dispatchId:dispatch.dispatchId});
    const projection=new DashboardProjection(f.db);const observer=new CoordinatorObserver(f.db);
    try {
      const row=projection.snapshot('g')!.roles.flatMap(r=>r.dispatches).find(d=>d.dispatchId===dispatch.dispatchId)!;
      assert.equal(row.actualModel,'gpt-6.1-sol');assert.equal(row.actualEffort,'high');assert.equal(row.actualModelSource,'codex_turn_context');
      assert.equal(observer.snapshot('g')!.roles.flatMap(r=>r.dispatches)[0]!.actualModel,'gpt-6.1-sol');
      assert.ok(!JSON.stringify(row).includes('rollout'));
    }finally{projection.close();observer.close();}
    await assert.rejects(f.engine.execute(f.backend,'automation_model_refresh',{binding:f.dispatch.binding,dispatchId:dispatch.dispatchId}),{code:'FORBIDDEN'});
  }finally{await f.cleanup();}
});

test('malformed earlier records and control-character model names never become model evidence',async()=>{
 const root=await mkdtemp(join(tmpdir(),'model-invalid-'));const path=join(root,'rollout.jsonl');
 try {
  await writeFile(path,JSON.stringify({type:'session_meta',payload:{id:'thread'}})+'\nnot-json\n'+JSON.stringify({type:'turn_context',payload:{turn_id:'turn',model:'model',effort:'high'}})+'\n');
  assert.equal(await readTurnModel(path,root,'thread','turn'),undefined);
  await writeFile(path,JSON.stringify({type:'session_meta',payload:{id:'thread'}})+'\n'+JSON.stringify({type:'turn_context',payload:{turn_id:'turn',model:'model\nINJECTED',effort:'high'}})+'\n');assert.equal(await readTurnModel(path,root,'thread','turn'),undefined);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('reads at most 32 MiB plus one byte and rejects oversized evidence',async()=>{
 const root=await mkdtemp(join(tmpdir(),'model-size-'));const path=join(root,'rollout.jsonl');
 try {
  const prefix=JSON.stringify({type:'session_meta',payload:{id:'thread'}})+'\n'+JSON.stringify({type:'turn_context',payload:{turn_id:'turn',model:'bounded',effort:'low'}})+'\n';
  await writeFile(path,prefix+' '.repeat(32*1024*1024-prefix.length));
  assert.deepEqual(await readTurnModel(path,root,'thread','turn'),{model:'bounded',effort:'low',source:'codex_turn_context'});
  await truncate(path,32*1024*1024+1);
  assert.equal(await readTurnModel(path,root,'thread','turn'),undefined);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('file reader errors, non-files, and final symlinks fail closed',async()=>{
 const root=await mkdtemp(join(tmpdir(),'model-reader-'));const directory=join(root,'directory');const target=join(root,'target.jsonl');const link=join(root,'link.jsonl');
 try {
  await mkdir(directory);await writeFile(target,JSON.stringify({type:'session_meta',payload:{id:'thread'}})+'\n');await symlink(target,link);
  assert.equal(await readTurnModel(join(root,'missing.jsonl'),root,'thread','turn'),undefined);
  assert.equal(await readTurnModel(directory,root,'thread','turn'),undefined);
  assert.equal(await readTurnModel(link,root,'thread','turn'),undefined);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('same-owner FIFO without a writer returns without blocking open',{skip:process.platform==='win32'},async()=>{
  const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const exec=promisify(execFile);
  const root=await mkdtemp(join(tmpdir(),'model-fifo-'));const path=join(root,'rollout.fifo');
  try {
    await exec('mkfifo',[path]);
    const script=`import {readTurnModel} from './src/runtime/model-evidence.ts';const result=await readTurnModel(process.argv[1],process.argv[2],'thread','turn');if(result!==undefined)process.exit(1);console.log('non-file rejected');`;
    const result=await exec(process.execPath,['--import','tsx','--input-type=module','-e',script,path,root],{cwd:process.cwd(),timeout:1500});
    assert.match(result.stdout,/non-file rejected/);
  }finally{await rm(root,{recursive:true,force:true});}
});
