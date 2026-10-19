import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { writeFile,access } from 'node:fs/promises';
import { engineFixture } from './fixtures/engine-fixture.js';
import { startCoordinatorSocket } from '../src/ipc.js';
const execute=promisify(execFile);
const args=['--import','tsx','scripts/client.ts'];

test('real CLI schema and dry-run return JSON without a config or credentials',async()=>{
 const schema=JSON.parse((await execute(process.execPath,[...args,'/missing/config.json','lead','schema'])).stdout);
 assert.ok(schema.commands.automation_dispatch);assert.ok(schema.commands.automation_task_recover);
 assert.equal(schema.commands.automation_message_claim.required?.includes('leaseMs')??false,false);
 const dry=JSON.parse((await execute(process.execPath,[...args,'/missing/config.json','backend','automation_message_claim','{}','--dry-run'])).stdout);
 assert.equal(dry.sideEffects,false);assert.equal(dry.normalizedInput.leaseMs,60000);
});

test('real CLI uses its scoped environment credential over Unix IPC without opening group credentials',async()=>{
 const f=await engineFixture();const socket=join(f.dir,'client.sock');const service=await startCoordinatorSocket(f.engine,socket,20);
 const config=join(f.dir,'runtime.json');const absent=join(f.dir,'not-created-credentials.json');
 await writeFile(config,JSON.stringify({groupId:'g',mode:'mock',databasePath:f.db,socketPath:socket,credentialFile:absent,humanCredentialFile:join(f.dir,'absent-human.json'),allowedRoots:[f.dir]}));
 try{
  const result=JSON.parse((await execute(process.execPath,[...args,config,'backend','automation_message_send',JSON.stringify({type:'assistance_request',recipientRole:'lead',payload:{question:'CLI protocol'},operationId:'cli-message'})],{env:{PATH:process.env.PATH,COORDINATOR_CAPABILITY:f.credentials.backend}})).stdout);
  assert.equal(result.ok,true);assert.equal(result.result.senderRole,'backend');assert.equal(result.result.recipientRole,'lead');
  await assert.rejects(access(absent));
 }finally{await service.close();await f.cleanup();}
});
