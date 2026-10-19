import { spawn } from 'node:child_process';
import { CoordinatorError } from '../errors.js';
export interface HarnessSettings { entrypointPath:string;homePath:string;cdpEndpoint:string; }

// Only a fixed inspection is accepted here. Agent-supplied Python is never executed.
export function inspectOwnedTarget(settings:HarnessSettings,targetId:string):Promise<unknown>{
  return new Promise((resolve,reject)=>{
    const inherited=Object.fromEntries(['PATH','HOME','TMPDIR','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy'].flatMap((key)=>process.env[key]===undefined?[]:[[key,process.env[key]]]));
    const env={...inherited,EDGE_CDP_URL:settings.cdpEndpoint,BU_CDP_URL:settings.cdpEndpoint,BH_HOME:settings.homePath,BH_REQUIRE_EXISTING_DAEMON:'1',BH_RECORD:'0',BH_TAB_MARKER:'0'};
    for(const key of ['BU_NAME','BU_BROWSER_ID','BU_REMOTE_ID','BU_AUTOSPAWN','BU_CDP_WS','BROWSER_HARNESS_HOME'])delete (env as Record<string,string|undefined>)[key];
    const child=spawn(process.execPath,[settings.entrypointPath],{env,stdio:['pipe','pipe','pipe']});let stdout='';
    const timer=setTimeout(()=>{child.kill('SIGTERM');},15000);
    child.stdout.on('data',(chunk:Buffer)=>{stdout+=chunk.toString();if(Buffer.byteLength(stdout)>1024*1024)child.kill('SIGTERM');});
    child.stderr.resume();
    child.once('error',()=>{clearTimeout(timer);reject(new CoordinatorError('SERVICE_UNHEALTHY','Controlled Browser Harness could not start.','Check the configured existing Edge tool daemon.'));});
    child.once('exit',(code)=>{
      clearTimeout(timer);
      if(code!==0){reject(new CoordinatorError('SERVICE_UNHEALTHY','Browser Harness inspection failed closed.','Verify the existing daemon and explicit Edge endpoint; do not start another browser.'));return;}
      try{const line=stdout.split('\n').find((row)=>row.startsWith('COORDINATOR_HARNESS_RESULT='));if(!line)throw new Error();resolve(JSON.parse(line.slice('COORDINATOR_HARNESS_RESULT='.length)));}catch{reject(new CoordinatorError('RECONCILIATION_REQUIRED','Harness inspection returned no verified result.','Inspect the owned target before repeating.'));}
    });
    const script=`import json\nswitch_tab(${JSON.stringify(targetId)}, activate=False)\nprint("COORDINATOR_HARNESS_RESULT=" + json.dumps(page_info()))\n`;
    child.stdin.end(script);
  });
}
