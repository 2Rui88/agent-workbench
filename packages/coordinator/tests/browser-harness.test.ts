import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectOwnedTarget } from '../src/browser/harness.js';

test('controlled Harness entrypoint keeps existing Edge routing and excludes role secrets',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'coordinator-harness-'));const entry=join(dir,'entry.mjs');
 await writeFile(entry,`import assert from 'node:assert/strict';let script='';process.stdin.on('data',c=>script+=c);process.stdin.on('end',()=>{assert.equal(process.env.EDGE_CDP_URL,'http://127.0.0.1:9222');assert.equal(process.env.BH_REQUIRE_EXISTING_DAEMON,'1');assert.equal(process.env.BH_RECORD,'0');assert.equal(process.env.COORDINATOR_TEST_SECRET,undefined);assert.equal(process.env.BU_REMOTE_ID,undefined);assert.ok(script.includes('switch_tab("owned-target", activate=False)'));console.log('COORDINATOR_HARNESS_RESULT='+JSON.stringify({title:'owned inspection'}));});`);
 const previous=process.env.COORDINATOR_TEST_SECRET;process.env.COORDINATOR_TEST_SECRET='isolated-test-value';
 try{assert.deepEqual(await inspectOwnedTarget({entrypointPath:entry,homePath:dir,cdpEndpoint:'http://127.0.0.1:9222'},'owned-target'),{title:'owned inspection'});}
 finally{if(previous===undefined)delete process.env.COORDINATOR_TEST_SECRET;else process.env.COORDINATOR_TEST_SECRET=previous;await rm(dir,{recursive:true,force:true});}
});
