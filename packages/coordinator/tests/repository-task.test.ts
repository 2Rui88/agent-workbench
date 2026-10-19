import assert from 'node:assert/strict';
import test from 'node:test';
import { RepositoryTaskClient } from '../src/integrations/cli-task.js';
import { CliTaskAuthority } from '../src/integrations/adapters.js';
const git = { owner: 'Exact Git Name', email: 'git@example.test', worktreePath: '/actual/worktree', head: 'abc' };
const recovery = { task: { task_id: 'task', repository_id: 'repo', owner: git.owner, status: 'in_progress', version: 5, scopes: [{ scope_type: 'worktree_path', scope_value: git.worktreePath }] }, active_lease: { session_id: 'session', expires_at: '2099-01-01T00:00:00Z' }, lease_session: { owner: git.owner, worktree_path: git.worktreePath } };
const envelope = (data: Record<string, unknown>) => ({ ok: true, data });

test('Task client binds exact Git identity and gates lease on current transport session', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = new RepositoryTaskClient({ call: async (name, args) => {
    calls.push({ name, args });
    if (name === 'session_context') return envelope({ session_id: 'session', repository_id: 'repo', worktree_path: git.worktreePath });
    if (name === 'task_recovery_get') return envelope({ recovery });
    return envelope({ conflict: { level: 'none' } });
  } }, 'repo', git);
  await client.bind();
  assert.equal(calls[0]?.args.owner, git.owner);
  const authority = new CliTaskAuthority(client);
  assert.equal((await authority.checkGate({ taskRef: 'task', owner: git.owner, repositoryId: 'repo', worktreePath: git.worktreePath, expectedVersion: 5 })).lease.active, true);
  recovery.active_lease.session_id = 'other-session';
  await assert.rejects(authority.checkGate({ taskRef: 'task', owner: git.owner, repositoryId: 'repo', worktreePath: git.worktreePath, expectedVersion: 5 }), { code: 'TASK_GATE_CLOSED' });
  await assert.rejects(client.recoverAndStart('task', 'backend', 'start-op'), { code: 'TASK_GATE_CLOSED' });
  assert.equal(calls.some((call) => call.name === 'task_start'), false);
  recovery.active_lease.session_id = 'session';
});

test('unknown task mutation queries durable result instead of repeating the write', async () => {
  const calls: string[] = [];
  const client = new RepositoryTaskClient({ call: async (name) => {
    calls.push(name);
    if (name === 'session_context') return envelope({ session_id: 'session', repository_id: 'repo', worktree_path: git.worktreePath });
    if (name === 'task_checkpoint') throw new Error('transport disconnected');
    if (name === 'operation_result_get') return envelope({ found: true });
    throw new Error('unexpected');
  } }, 'repo', git);
  await client.bind();
  const input = { operationId: 'op', expectedVersion: 5, checkpoint: { current_state: 'testing' } };
  await assert.rejects(client.checkpoint('task', input), /transport disconnected/);
  await assert.rejects(client.checkpoint('task', input), { code: 'RECONCILIATION_REQUIRED' });
  assert.equal(calls.filter((name) => name === 'task_checkpoint').length, 1);
  assert.equal(calls.filter((name) => name === 'operation_result_get').length, 1);
});

test('repository task discovery permits another worktree but execution gate requires actual binding', async () => {
  const candidate = { ...recovery, task: { ...recovery.task, scopes: [{ scope_type: 'worktree_path', scope_value: '/old/worktree' }] } };
  const client = new RepositoryTaskClient({ call: async (name) => name === 'session_context' ? envelope({ session_id: 'session', repository_id: 'repo', worktree_path: git.worktreePath }) : name === 'task_recovery_get' ? envelope({ recovery: candidate }) : envelope({ conflict: { level: 'none' } }) }, 'repo', git);
  await client.bind();
  assert.equal((await client.getTask('task')).id, 'task');
  await assert.rejects(new CliTaskAuthority(client).checkGate({ taskRef: 'task', owner: git.owner, repositoryId: 'repo', worktreePath: git.worktreePath, expectedVersion: 5 }), { code: 'TASK_GATE_CLOSED' });
});

test('repository operations refresh local host evidence before gate checks and writes',async()=>{
 const order:string[]=[];
 const client=new RepositoryTaskClient({call:async(name)=>{order.push(name);if(name==='session_context')return envelope({session_id:'session',repository_id:'repo',worktree_path:git.worktreePath});if(name==='task_recovery_get')return envelope({recovery});if(name==='task_conflicts')return envelope({conflict:{level:'none'}});return envelope({status:'in_progress'});}},'repo',git,Date.now,async(session,task,operation)=>{assert.equal(session,'session');assert.equal(task,'task');order.push(`evidence:${operation}`);});
 await client.bind();await client.getTask('task');await client.checkpoint('task',{expectedVersion:5,operationId:'checkpoint',checkpoint:{current_state:'test'}});
 assert.ok(order.indexOf('evidence:checkpoint')<order.indexOf('task_conflicts'));
 assert.equal(order.filter((entry)=>entry==='evidence:checkpoint').length,2);
 assert.equal(order.at(-1),'task_checkpoint');
});

test('same repository in distinct worktrees keeps separate authority transports',async()=>{
 const {RepositoryAuthorities}=await import('../src/integrations/repository-authorities.js');const registry=new RepositoryAuthorities();
 const make=async(path:string)=>{const local={...git,worktreePath:path};const client=new RepositoryTaskClient({call:async(name)=>name==='session_context'?envelope({session_id:path,repository_id:'repo',worktree_path:path}):name==='task_recovery_get'?envelope({recovery:{...recovery,task:{...recovery.task,scopes:[{scope_type:'worktree_path',scope_value:path}]},active_lease:{session_id:path,expires_at:'2099-01-01T00:00:00Z'},lease_session:{owner:git.owner,worktree_path:path}}}):envelope({conflict:{level:'none'}})},'repo',local);await client.bind();registry.register(client);};
 await make('/repo/worktree-a');await make('/repo/worktree-b');
 for(const path of ['/repo/worktree-a','/repo/worktree-b'])assert.equal((await registry.checkGate({taskRef:'task',owner:git.owner,repositoryId:'repo',worktreePath:path,expectedVersion:5})).worktreePath,path);
 await assert.rejects(async()=>registry.checkGate({taskRef:'task',owner:git.owner,repositoryId:'repo',worktreePath:'/repo/unregistered',expectedVersion:5}),{code:'TASK_GATE_CLOSED'});
});
