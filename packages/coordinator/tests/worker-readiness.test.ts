import assert from 'node:assert/strict';
import test from 'node:test';
import {checkWorkerReadiness} from '../src/integrations/worker-readiness.js';
const task={id:'worker',owner:'jande',repositoryId:'repo',worktreePath:'/workers/frontend',version:2,status:'in_progress',lease:{active:true,owner:'jande'},conflicts:[]};
const enrollment={role:'frontend' as const,binding:{taskRef:'worker',owner:'jande',repositoryId:'repo',worktreePath:'/workers/frontend',expectedVersion:2}};

test('worker readiness requires a distinct worktree, task and lease',async()=>{
  const dependencies={git:async()=>({owner:'jande',email:'git@example.test',worktreePath:'/workers/frontend',head:'head'}),task:async()=>task};
  assert.equal((await checkWorkerReadiness(enrollment,{taskRef:'lead',worktreePath:'/lead'},dependencies)).ready,true);
  await assert.rejects(checkWorkerReadiness({...enrollment,binding:{...enrollment.binding,taskRef:'lead'}},{taskRef:'lead',worktreePath:'/lead'},dependencies),/independent/);
  await assert.rejects(checkWorkerReadiness(enrollment,{taskRef:'lead',worktreePath:'/workers/frontend'},dependencies),/independent/);
  await assert.rejects(checkWorkerReadiness(enrollment,{taskRef:'lead',worktreePath:'/lead'},{...dependencies,task:async()=>({...task,lease:{active:false,owner:'jande'}})}),/lease/);
});

test('dispatch passes authoritative Task binding to worker gate and rechecks before starting',async()=>{
  const {engineFixture}=await import('./fixtures/engine-fixture.js');const f=await engineFixture();let checks=0;
  f.options.verifyWorker=async(work)=>{checks++;assert.equal(work.taskBinding?.taskRef,'task');if(checks>1)throw Error('worker lease expired');};
  try {
    await f.engine.execute(f.lead,'automation_role_initialize',{cwd:f.dir});await f.engine.execute(f.backend,'automation_role_initialize',{cwd:f.dir});
    const sent=await f.engine.execute(f.lead,'automation_dispatch',f.dispatch) as {message:{messageId:string}};
    await f.engine.pump();assert.equal(f.engine.scheduler.get(sent.message.messageId)?.state,'queued');assert.equal(f.engine.budget.status().callsUsed,0);assert.equal(checks,2);
  }finally{await f.cleanup();}
});

test('runtime config cannot authorize workers sharing the lead Task or a missing repository',async()=>{
 const {runtimeConfigSchema,loadRuntimeConfig}=await import('../src/runtime-config.js');const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const dir=await mkdtemp(join(tmpdir(),'worker-config-'));const path=join(dir,'runtime.json');
 try {
  const base={groupId:'g',mode:'mock',leadMode:'external',databasePath:'db',socketPath:'socket',credentialFile:'roles',humanCredentialFile:'human',allowedRoots:[dir],repositories:[{repositoryId:'repo',worktreePath:'/lead'},{repositoryId:'repo',worktreePath:'/workers/frontend'},{repositoryId:'repo',worktreePath:'/workers/backend'}],externalTaskObservation:{taskRef:'lead',sessionId:'host',expiresAt:new Date(Date.now()+60000).toISOString()}};
  const workers=[{role:'frontend',binding:enrollment.binding,sessionId:'front',expiresAt:base.externalTaskObservation.expiresAt},{role:'backend',binding:{...enrollment.binding,taskRef:'back',worktreePath:'/workers/backend'},sessionId:'back',expiresAt:base.externalTaskObservation.expiresAt}];
  await writeFile(path,JSON.stringify({...base,workerTasks:workers}));assert.equal((await loadRuntimeConfig(path)).workerTasks?.length,2);
  await writeFile(path,JSON.stringify({...base,workerTasks:[{...workers[0],binding:{...enrollment.binding,taskRef:'lead'}},workers[1]]}));await assert.rejects(loadRuntimeConfig(path),/independent/);
  await writeFile(path,JSON.stringify({...base,repositories:[base.repositories[0]],workerTasks:workers}));await assert.rejects(loadRuntimeConfig(path),/registered/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('runtime rejects normalized and symlink aliases between worker worktrees',async()=>{
  const {loadRuntimeConfig}=await import('../src/runtime-config.js');
  const {mkdtemp,mkdir,symlink,writeFile,rm}=await import('node:fs/promises');
  const {join}=await import('node:path');const {tmpdir}=await import('node:os');
  const dir=await mkdtemp(join(tmpdir(),'worker-alias-'));const path=join(dir,'runtime.json');
  try {
    for(const name of ['lead','shared'])await mkdir(join(dir,name));
    await symlink(join(dir,'shared'),join(dir,'alias'));
    const expiresAt=new Date(Date.now()+60000).toISOString();
    const base={groupId:'g',mode:'mock',leadMode:'external',databasePath:'db',socketPath:'socket',credentialFile:'roles',humanCredentialFile:'human',allowedRoots:[dir],repositories:[{repositoryId:'repo',worktreePath:'lead'},{repositoryId:'repo',worktreePath:'shared'}],externalTaskObservation:{taskRef:'lead',sessionId:'host',expiresAt}};
    for(const alias of ['./shared','alias']) {
      const workerTasks=[{role:'frontend',binding:{...enrollment.binding,worktreePath:'shared'},sessionId:'front',expiresAt},{role:'backend',binding:{...enrollment.binding,taskRef:'back',worktreePath:alias},sessionId:'back',expiresAt}];
      await writeFile(path,JSON.stringify({...base,workerTasks}));
      await assert.rejects(loadRuntimeConfig(path),/independent/);
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});
