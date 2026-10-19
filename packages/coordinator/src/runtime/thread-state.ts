import { CoordinatorError } from '../errors.js';
export interface ThreadState {id:string;turns:Array<{id:string;status:string}>;}
export function observeThread(raw:unknown,expectedId:string):ThreadState{
  if(!raw||typeof raw!=='object')throw uncertain();
  const response=raw as Record<string,unknown>;const thread=(response.thread??response) as Record<string,unknown>;
  const id=thread.id??thread.threadId;
  if(id!==expectedId||!Array.isArray(thread.turns))throw uncertain();
  const turns=thread.turns.map((value:unknown)=>{
    if(!value||typeof value!=='object')throw uncertain();const turn=value as Record<string,unknown>;const id=turn.id??turn.turnId;
    if(typeof id!=='string'||typeof turn.status!=='string')throw uncertain();return{id,status:turn.status};
  });
  return{id:expectedId,turns};
}
function uncertain():CoordinatorError{return new CoordinatorError('RECONCILIATION_REQUIRED','Runtime thread history cannot be verified.','Read the original thread with turns included before changing durable work state.');}
