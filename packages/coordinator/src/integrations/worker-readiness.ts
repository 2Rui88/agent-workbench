import {CoordinatorError} from '../errors.js';
import type {TaskBinding,TaskRecord} from './adapters.js';
import type {GitContext} from '../git-context.js';
export interface WorkerEnrollment {role:'frontend'|'backend';binding:TaskBinding;}
interface Dependencies {git(path:string):Promise<GitContext>;task(binding:TaskBinding):Promise<TaskRecord>;}
// A writing worker is ready when its own Git identity, Task binding, lease and worktree all agree and differ from the lead's.
export async function checkWorkerReadiness(worker:WorkerEnrollment,lead:{taskRef:string;worktreePath:string},dependencies:Dependencies):Promise<{ready:true;role:string;taskRef:string;worktreePath:string}> {
  const fail=(message:string):never=>{throw new CoordinatorError('TASK_GATE_CLOSED',message,'Bind the worker own Task/worktree/lease before granting writes.');};
  if(worker.binding.taskRef===lead.taskRef||worker.binding.worktreePath===lead.worktreePath)fail('Worker needs an independent task and worktree.');
  const [git,task]=await Promise.all([dependencies.git(worker.binding.worktreePath),dependencies.task(worker.binding)]);
  if(git.owner!==worker.binding.owner||git.worktreePath!==worker.binding.worktreePath||task.id!==worker.binding.taskRef||task.owner!==git.owner||task.repositoryId!==worker.binding.repositoryId||task.worktreePath!==git.worktreePath||task.version!==worker.binding.expectedVersion)fail('Worker Git identity and current Task binding do not match.');
  if(!task.lease.active||task.lease.owner!==git.owner||task.status!=='in_progress'||task.conflicts.length)fail('Worker task lease or conflict gate is not ready.');
  return{ready:true,role:worker.role,taskRef:task.id,worktreePath:git.worktreePath};
}
