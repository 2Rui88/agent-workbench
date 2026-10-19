import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { engineFixture } from './fixtures/engine-fixture.js';
import { coordinatorRequest, startCoordinatorSocket } from '../src/ipc.js';
import type { AutomationCommand } from '../src/engine.js';

test('shared coordinator commands publish contracts, route assistance and preserve audit cycles over Unix IPC', async () => {
  const f = await engineFixture(); const path = join(f.dir, 'workflow.sock'); const service = await startCoordinatorSocket(f.engine, path, 10);
  const call = (roleId: 'lead' | 'frontend' | 'backend' | 'audit', command: string, input: unknown) => coordinatorRequest(path, { channel: 'role', roleId, generation: 1, capability: f.credentials[roleId], command: command as AutomationCommand, input });
  try {
    const contract = await call('lead', 'automation_contract_publish', { artifactRef: 'api-v2', revision: 'v2', digest: 'hash-v2', baselineRef: 'base-v2', compatibility: 'breaking', affectedRoles: ['frontend','backend','audit'], operationId: 'contract-v2' }) as { contractId: string };
    const retry = await call('lead', 'automation_contract_publish', { artifactRef: 'api-v2', revision: 'v2', digest: 'hash-v2', baselineRef: 'base-v2', compatibility: 'breaking', affectedRoles: ['frontend','backend','audit'], operationId: 'contract-v2' }) as { contractId: string };
    assert.equal(retry.contractId, contract.contractId);
    await call('frontend', 'automation_contract_ack', { contractId: contract.contractId, revision: 'v2' });
    const message = await call('frontend', 'automation_message_send', { type: 'assistance_request', recipientRole: 'backend', payload: { question: 'field semantics' }, operationId: 'assistance-one' }) as { messageId: string };
    const claimed = await call('backend', 'automation_message_claim', {}) as { messageId: string; leaseToken: string };
    assert.equal(claimed.messageId, message.messageId);
    await call('backend', 'automation_message_complete', { messageId: claimed.messageId, leaseToken: claimed.leaseToken, result: { summary: 'field contract clarified', evidence: ['api-v2 definition'] } });
    const run = await call('audit', 'automation_validation_create', { contractRef: contract.contractId, baselineRef: 'base-v2', operationId: 'validation-v2' }) as { validationId: string };
    await assert.rejects(call('backend', 'automation_validation_record', { validationId: run.validationId, outcome: 'passed', evidence: [{ command: 'test', outcome: 'passed', summary: 'forged' }] }), { code: 'FORBIDDEN' });
    const recorded = await call('audit', 'automation_validation_record', { validationId: run.validationId, outcome: 'rejected', evidence: [{ command: 'test', outcome: 'failed', summary: 'schema mismatch' }] }) as { state: string };
    assert.equal(recorded.state, 'rejected');
    const events = await call('lead', 'automation_events', { afterSequence: 0 }) as Array<{ sequence: number }>;
    assert.ok(events.length > 0);
  } finally { await service.close(); await f.cleanup(); }
});

test('pending acceptance gate refuses missing audit evidence and never exposes acceptance', async () => {
  const f = await engineFixture(); const path = join(f.dir,'acceptance.sock'); const service = await startCoordinatorSocket(f.engine,path,10);
  try {
    await assert.rejects(coordinatorRequest(path,{channel:'role',roleId:'lead',generation:1,capability:f.credentials.lead,command:'automation_submit_for_acceptance' as AutomationCommand,input:{binding:f.dispatch.binding,dispatchIds:['not-completed'],validationId:'not-passed',contractRef:f.dispatch.work.contractRef,baselineRef:'base',operationId:'submit-one'}}),{code:'TASK_GATE_CLOSED'});
  } finally {await service.close();await f.cleanup();}
});

test('repository Task recovery and checkpoint are routed through lead-only durable operations',async()=>{
 const f=await engineFixture();let recoveries=0;let checkpoints=0;
 f.options.taskAuthority.recover=async(binding)=>{recoveries++;return{id:binding.taskRef,owner:binding.owner,repositoryId:binding.repositoryId,worktreePath:binding.worktreePath,version:2,status:'in_progress',lease:{active:true,owner:binding.owner},conflicts:[]};};
 f.options.taskAuthority.checkpointTask=async()=>{checkpoints++;return{status:'in_progress',version:3};};
 try{
  const request={binding:f.dispatch.binding,operationId:'recover-task'};
  await assert.rejects(f.engine.execute(f.backend,'automation_task_recover',request),{code:'FORBIDDEN'});
  await f.engine.execute(f.lead,'automation_task_recover',request);await f.engine.execute(f.lead,'automation_task_recover',request);assert.equal(recoveries,1);
  const checkpoint={binding:{...f.dispatch.binding,expectedVersion:2},operationId:'checkpoint-task',checkpoint:{current_state:'Mock tested'}};
  await f.engine.execute(f.lead,'automation_task_checkpoint',checkpoint);await f.engine.execute(f.lead,'automation_task_checkpoint',checkpoint);assert.equal(checkpoints,1);
 }finally{await f.cleanup();}
});
