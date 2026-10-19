import assert from 'node:assert/strict';
import test from 'node:test';
import { ApprovalBridge } from '../src/approval-bridge.js';
const actor = { groupId: 'g', roleId: 'backend' as const, bindingGeneration: 1, capabilityId: 'worker' };
test('approval bridge rejects role credentials and preserves numeric RPC request IDs', async () => {
  const bridge = new ApprovalBridge(':memory:', 'independent-human-capability');
  try {
    const request = bridge.enqueue(actor, 'runtime-one', 19, 'item/commandExecution/requestApproval', { command: 'npm test' });
    await assert.rejects(bridge.respond(request.id, 'worker', 'accept', 'runtime-one', async () => {}), { code: 'FORBIDDEN' });
    let responded: unknown;
    await bridge.respond(request.id, 'independent-human-capability', 'decline', 'runtime-one', async (id, result) => { responded = { id, result }; });
    assert.deepEqual(responded, { id: 19, result: { decision: 'decline' } });
    await assert.rejects(bridge.respond(request.id, 'independent-human-capability', 'accept', 'runtime-one', async () => {}), { code: 'RECONCILIATION_REQUIRED' });
  } finally { bridge.close(); }
});
test('changed runtime or unknown approval write cannot be replayed', async () => {
  const bridge = new ApprovalBridge(':memory:', 'human');
  try {
    const request = bridge.enqueue(actor, 'runtime-one', 'rpc-id', 'item/fileChange/requestApproval', {});
    await assert.rejects(bridge.respond(request.id, 'human', 'accept', 'runtime-two', async () => {}), { code: 'RECONCILIATION_REQUIRED' });
    await assert.rejects(bridge.respond(request.id, 'human', 'accept', 'runtime-one', async () => { throw new Error('disconnected'); }), /disconnected/);
    assert.equal(bridge.list('g')[0]?.state, 'unknown');
    await assert.rejects(bridge.respond(request.id, 'human', 'accept', 'runtime-one', async () => {}), { code: 'RECONCILIATION_REQUIRED' });
  } finally { bridge.close(); }
});

test('MCP tool approval uses elicitation action and empty form content', async () => {
  const bridge = new ApprovalBridge(':memory:', 'human');
  try {
    const request = bridge.enqueue(actor, 'runtime', 0, 'mcpServer/elicitation/request', {mode:'form',_meta:{codex_approval_kind:'mcp_tool_call'},requestedSchema:{type:'object',properties:{}}});
    let response:unknown;
    await bridge.respond(request.id,'human','accept','runtime',async(id,result)=>{response={id,result};});
    assert.deepEqual(response,{id:0,result:{action:'accept',content:{}}});
    const form = bridge.enqueue(actor,'runtime',1,'mcpServer/elicitation/request',{mode:'form',requestedSchema:{type:'object',properties:{secret:{type:'string'}}}});
    await assert.rejects(bridge.respond(form.id,'human','accept','runtime',async()=>{}),{code:'INVALID_INPUT'});
    await bridge.respond(form.id,'human','cancel','runtime',async(_,result)=>{assert.deepEqual(result,{action:'cancel'});});
  } finally {bridge.close();}
});
