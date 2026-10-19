import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CoordinatorError } from '../errors.js';
const execute = promisify(execFile);

export interface HostEvidenceSettings { cliRepositoryPath:string; serverUrl:string; }
export function hostEvidenceCollector(settings:HostEvidenceSettings,worktreePath:string){
  return async(sessionId:string,taskId:string,operation:'checkpoint'|'submit'):Promise<void>=>{
    try{
      await execute('npm',['--prefix',settings.cliRepositoryPath,'run','evidence','--','collect','--server',settings.serverUrl,'--session',sessionId,'--task',taskId,'--worktree',worktreePath,'--operation',operation],{timeout:60000,maxBuffer:1024*1024});
    }catch{
      throw new CoordinatorError('TASK_GATE_CLOSED','Local signed host evidence could not be refreshed.','Verify the configured Task CLI and registered host key before retrying.');
    }
  };
}
