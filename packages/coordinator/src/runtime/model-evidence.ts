import {readOwnedText} from './bounded-read.js';
export interface TurnModelEvidence {model:string;effort:string|null;source:'codex_turn_context'|'claude_transcript';}

export async function readTurnModel(path:string,root:string,threadId:string,turnId:string):Promise<TurnModelEvidence|undefined> {
  try {
    const raw=await readOwnedText(path,root);
    if(raw===undefined)return undefined;
    let original=false;let evidence:TurnModelEvidence|undefined;
    let index=0;
    while(index<raw.length) {
      const end=raw.indexOf('\n',index);
      const line=raw.slice(index,end<0?raw.length:end);
      index=end<0?raw.length:end+1;
      if(!line)continue;
      let record:{type?:string;payload?:{id?:string;turn_id?:string;model?:unknown;effort?:unknown}};
      try{record=JSON.parse(line);}catch{if(end<0)break;return undefined;}
      if(record.type==='session_meta'){if(original||record.payload?.id!==threadId)return undefined;original=true;}
      if(record.type!=='turn_context'||record.payload?.turn_id!==turnId)continue;
      const {model,effort}=record.payload;
      if(!original||typeof model!=='string'||!model||model.length>256||/[\r\n\x00-\x1f]/.test(model))return undefined;
      const next:TurnModelEvidence={model,effort:typeof effort==='string'&&effort.length<=32?effort:null,source:'codex_turn_context'};
      if(evidence&&JSON.stringify(evidence)!==JSON.stringify(next))return undefined;
      evidence=next;
    }
    return original?evidence:undefined;
  }catch{return undefined;}
}
