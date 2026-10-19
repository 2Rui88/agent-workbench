import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CoordinatorObserver } from '../src/observer.js';
import { CoordinatorStore } from '../src/store.js';

test('group bootstrap provisions five role capabilities without printing them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coordinator-bootstrap-'));
  const dbPath = join(dir, 'state.sqlite');
  const credentialPath = join(dir, 'credentials.json');
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/group-init.ts'], {
      cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir, COORDINATOR_GROUP_ID: 'bootstrap', COORDINATOR_ROLE: 'lead', COORDINATOR_DB_PATH: dbPath, COORDINATOR_CREDENTIAL_FILE: credentialPath }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
    const saved = JSON.parse(await readFile(credentialPath, 'utf8')) as { credentials: Record<string, string> };
    assert.deepEqual(Object.keys(saved.credentials).sort(), ['advisor', 'audit', 'backend', 'frontend', 'lead']);
    assert.ok(Object.values(saved.credentials).every((token) => !result.stdout.includes(token)));
    const store = new CoordinatorStore(dbPath);
    store.assertAuthorized({ groupId: 'bootstrap', roleId: 'lead', bindingGeneration: 1, capabilityId: 'lead' }, saved.credentials.lead!);
    store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('four-pane observer reads status and per-role queue counts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coordinator-observer-'));
  const path = join(dir, 'state.sqlite');
  const store = new CoordinatorStore(path);
  store.createGroup('observe');
  store.send({ groupId: 'observe', roleId: 'lead', bindingGeneration: 1, capabilityId: 'lead' }, { type: 'assistance_request', recipientRole: 'audit', payload: { request: 'inspect' } }, 'observe-op');
  store.close();
  const observer = new CoordinatorObserver(path);
  try {
    const snapshot = observer.snapshot('observe');
    assert.equal(snapshot?.roles.find((role) => role.roleId === 'audit')?.queued, 1);
    assert.equal(snapshot?.messageCounts['audit:queued'], 1);
  } finally { observer.close(); await rm(dir, { recursive: true, force: true }); }
});


test('runtime config bootstrap uses its group, private credentials and database together', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coordinator-config-bootstrap-'));
  try {
    const configPath = join(dir, 'runtime.json');
    const credentialPath = join(dir, 'roles.json');
    await writeFile(configPath, JSON.stringify({ groupId: 'configured-group', mode: 'mock', databasePath: 'state.sqlite', socketPath: 'coordinator.sock', credentialFile: 'roles.json', humanCredentialFile: 'human.json', allowedRoots: ['.'] }));
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/group-init.ts', configPath], { cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir, COORDINATOR_ROLE: 'lead' } });
    assert.equal(result.status, 0, result.stderr);
    const saved = JSON.parse(await readFile(credentialPath, 'utf8'));
    assert.equal(saved.groupId, 'configured-group');
    assert.equal((await stat(join(dir, 'state.sqlite'))).mode & 0o777, 0o600);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('read-only observer shows requested model, effort, turn and unresolved execution state',async()=>{
  const {engineFixture}=await import('./fixtures/engine-fixture.js');const f=await engineFixture();
  try{
    await f.engine.execute(f.lead,'automation_role_initialize',{cwd:f.dir});await f.engine.execute(f.backend,'automation_role_initialize',{cwd:f.dir});
    const sent=await f.engine.execute(f.lead,'automation_dispatch',f.dispatch) as {message:{messageId:string}};await f.engine.pump();
    const observer=new CoordinatorObserver(f.db);
    try{
      const snapshot=observer.snapshot('g') as unknown as {roles:Array<{roleId:string;dispatches:Array<{dispatchId:string;state:string;requestedModel:string;requestedEffort:string;turnId:string}>}>};
      const work=snapshot.roles.find((item)=>item.roleId==='backend')!.dispatches[0]!;
      assert.equal(work.dispatchId,sent.message.messageId);assert.equal(work.state,'active');assert.equal(work.requestedModel,'gpt-6-luna');assert.equal(work.requestedEffort,'high');assert.ok(work.turnId);
    }finally{observer.close();}
  }finally{await f.cleanup();}
});
