import { CoordinatorError } from '../errors.js';
import { CliTaskAuthority } from './adapters.js';
import type { TaskAuthority,TaskBinding,TaskRecord } from './adapters.js';
import type { RepositoryTaskClient } from './cli-task.js';

function bindingKey(repositoryId:string,worktreePath:string):string{return JSON.stringify([repositoryId,worktreePath]);}

export class RepositoryAuthorities implements TaskAuthority {
  private readonly entries=new Map<string,{client:RepositoryTaskClient;authority:CliTaskAuthority}>();
  register(client:RepositoryTaskClient):void{
    const key=bindingKey(client.repositoryId,client.git.worktreePath);
    if(this.entries.has(key))throw new CoordinatorError('INVALID_INPUT','Repository worktree is configured more than once.','Keep one Task transport per actual repository and worktree.');
    this.entries.set(key,{client,authority:new CliTaskAuthority(client)});
  }
  checkGate(binding:TaskBinding):Promise<TaskRecord>{return this.lookup(binding).authority.checkGate(binding);}
  async recover(binding:TaskBinding,operationId:string):Promise<TaskRecord>{
    const {client}=this.lookup(binding);const task=await client.getTask(binding.taskRef);
    if(task.version!==binding.expectedVersion)throw new CoordinatorError('TASK_GATE_CLOSED','Recovery task version changed.','Read the latest authority version before claiming.');
    return client.recoverAndStart(binding.taskRef,'lead',operationId);
  }
  async checkpointTask(binding:TaskBinding,operationId:string,checkpoint:unknown):Promise<unknown>{
    const {authority}=this.lookup(binding);await authority.checkGate(binding);
    return authority.checkpoint(binding.taskRef,{expectedVersion:binding.expectedVersion,operationId,checkpoint});
  }
  submit(binding:TaskBinding,payload:unknown):Promise<{ok:boolean;status:'pending_acceptance'}>{return this.lookup(binding).authority.submit(binding,payload);}
  operationResult(binding:TaskBinding,operationId:string):Promise<unknown>{return this.lookup(binding).client.reconcileOperation(operationId);}
  private lookup(binding:TaskBinding){
    const entry=this.entries.get(bindingKey(binding.repositoryId,binding.worktreePath));
    if(!entry||entry.client.git.owner!==binding.owner)throw new CoordinatorError('TASK_GATE_CLOSED','Task transport does not match the actual repository, worktree and Git owner.','Register this exact repository worktree before continuing.');
    return entry;
  }
}
