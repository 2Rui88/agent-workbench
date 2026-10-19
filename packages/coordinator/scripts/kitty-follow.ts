import { mkdir,readFile,writeFile,rename,unlink } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {DashboardProjection} from '../src/dashboard/projection.js';
import {loadRuntimeConfig} from '../src/runtime-config.js';
import type {WorkerRole} from '../src/terminal/herdr-controller.js';
import {KittyClient,KittyController,kittyTabs} from '../src/terminal/kitty-controller.js';
import {acquireLayoutLock,readLayoutLock} from '../src/terminal/layout-lock.js';
import {OBSERVED_ROLES} from '../src/roles.js';
const [configPath,flag]=process.argv.slice(2);
if(!configPath||flag&&flag!=='--compact')throw new Error('Usage: kitty-follow runtime.json [--compact]');
const config=await loadRuntimeConfig(configPath);
const statePath=join(dirname(config.databasePath),'kitty-panes.json');
if(flag==='--compact') {
  const lock=await readLayoutLock(dirname(statePath));
  if(!lock||lock.backend!=='kitty'||lock.groupId!==config.groupId)throw new Error('No running Kitty layout controller for this group.');
  process.kill(lock.pid,0);
  await writeFile(statePath+'.compact','compact\n',{mode:0o600,flag:'wx'});
} else {
  const endpoint=process.env.KITTY_LISTEN_ON,leadWindow=Number(process.env.KITTY_WINDOW_ID);
  if(!endpoint||!Number.isSafeInteger(leadWindow)||leadWindow<=0)throw new Error('Run inside the project-controlled Kitty instance.');
  const client=new KittyClient(endpoint),tabs=await kittyTabs(client),tab=tabs.find(t=>t.windows.some(w=>w.id===leadWindow));
  if(!tab)throw new Error('Calling Kitty window is not in the explicit instance.');
  const context={endpoint,leadWindow,tabId:tab.id,groupId:config.groupId};
  await mkdir(dirname(statePath),{recursive:true,mode:0o700});
  const lock=await acquireLayoutLock(dirname(statePath),config.groupId,'kitty',context);
  let projection:DashboardProjection|undefined;let running=true;
  process.on('SIGTERM',()=>{running=false;});process.on('SIGINT',()=>{});
  const schema=z.object({endpoint:z.string(),leadWindow:z.number().int().positive(),tabId:z.number().int().positive(),groupId:z.literal(config.groupId),panes:z.object({frontend:z.number().int().positive().optional(),backend:z.number().int().positive().optional(),audit:z.number().int().positive().optional(),advisor:z.number().int().positive().optional()}).strict(),closedAt:z.record(z.string(),z.object({dispatchIds:z.array(z.string()),waitingHuman:z.number().int().min(0)}).strict()).default({}),returned:z.array(z.number().int().positive()).default([])}).strict();
  try {
    let saved:z.infer<typeof schema>|undefined;
    try{saved=schema.parse(JSON.parse(await readFile(statePath,'utf8')));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    // A mapping left by an earlier lead in another window is rebound once it owns no windows; closed markers still apply.
    if(saved&&!Object.keys(saved.panes).length)saved={...saved,...context,returned:[]};
    if(saved&&Object.entries(context).some(([key,value])=>saved![key as keyof typeof context]!==value))throw new Error('Kitty mapping belongs to another instance; inspect before rebinding.');
    projection=new DashboardProjection(config.databasePath);
    const panes:Partial<Record<WorkerRole,number>>={};
    for(const role of OBSERVED_ROLES){const id=saved?.panes[role];if(id)panes[role]=id;}
    const controller=new KittyController(client,{...context,cwd:fileURLToPath(new URL('../..',import.meta.url)),observerArgv:role=>[process.execPath,fileURLToPath(new URL('./herdr-watch.js',import.meta.url)),config.databasePath,config.groupId,role],save:async(panes,layout)=>{await writeFile(statePath+'.tmp',JSON.stringify({...context,panes,...layout}),{mode:0o600});await rename(statePath+'.tmp',statePath);},onEvent:(event)=>process.stderr.write(`[Coordinator] ${JSON.stringify(event)}\n`)},panes,{closedAt:saved?.closedAt??{},returned:saved?.returned??[]});
    let ready=false;
    while(running) {
      const snapshot=projection.snapshot(config.groupId);if(!snapshot)throw new Error('Coordinator group missing.');
      let compact=false;
      try{await readFile(statePath+'.compact');compact=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      if(compact){await controller.compact(snapshot);await unlink(statePath+'.compact');}else await controller.sync(snapshot);
      if(!ready&&process.env.COORDINATOR_KITTY_READY_FILE){await writeFile(process.env.COORDINATOR_KITTY_READY_FILE,JSON.stringify(context),{mode:0o600});ready=true;}
      if(process.env.COORDINATOR_LEAD_PID){try{process.kill(Number(process.env.COORDINATOR_LEAD_PID),0);}catch{break;}}
      await delay(1000);
    }
    // The lead exited or its launcher stopped us: observer windows follow it out. A failed controller keeps them for inspection.
    await controller.closeAll();
  }catch(e){if(process.env.COORDINATOR_KITTY_READY_FILE)await writeFile(process.env.COORDINATOR_KITTY_READY_FILE+'.failed','Kitty controller stopped; inspect before restarting.\n',{mode:0o600});throw e;}
  finally{projection?.close();await lock.release();}
}
