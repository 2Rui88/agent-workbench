import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { OBSERVED_ROLES } from '../src/roles.js';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { DashboardProjection } from '../src/dashboard/projection.js';
import { HerdrClient, requireHerdrContext } from '../src/terminal/herdr-client.js';
import { HerdrController, ObserverTabClosed, type HerdrLayoutState, type WorkerRole } from '../src/terminal/herdr-controller.js';
import { acquireLayoutLock } from '../src/terminal/layout-lock.js';
import { loadRuntimeConfig } from '../src/runtime-config.js';

// Layout controller for one group's observation tab. Started by herdr:open on the user's explicit request; it
// opens the tab, keeps the role panes in step with the queue, and closes the whole tab when the lead exits, when
// herdr:close asks, or when it is stopped. The user closing the tab ends control without rebuilding anything.
const [configPath]=process.argv.slice(2);
if(!configPath)throw new Error('Usage: herdr-follow <runtime.json>');
const context=requireHerdrContext(process.env);
const config=await loadRuntimeConfig(configPath);
const stateDir=dirname(config.databasePath);
const statePath=join(stateDir,'herdr-panes.json');
await mkdir(stateDir,{recursive:true,mode:0o700});
const lock=await acquireLayoutLock(stateDir,config.groupId,'herdr',{socketPath:context.socketPath,workspaceId:context.workspaceId});
const schema=z.object({socketPath:z.string(),workspaceId:z.string(),groupId:z.string(),observerTab:z.string().optional(),overviewPane:z.string().optional(),panes:z.object({frontend:z.string().optional(),backend:z.string().optional(),audit:z.string().optional(),advisor:z.string().optional()}).strict(),readyRoles:z.array(z.enum(OBSERVED_ROLES)),closedAt:z.record(z.string(),z.object({dispatchIds:z.array(z.string()),waitingHuman:z.number().int().min(0)}).strict()).default({}),returned:z.array(z.string()).default([])}).strict();
const watcher=fileURLToPath(new URL('./herdr-watch.js',import.meta.url));
const log=(line:string)=>process.stderr.write(`[herdr-follow ${new Date().toISOString()}] ${line}\n`);
let running=true;
process.on('SIGTERM',()=>{running=false;});
// Ctrl-C in the lead TUI interrupts a model turn, not the layout controller.
process.on('SIGINT',()=>{});
const readyFile=process.env.COORDINATOR_HERDR_READY_FILE;
let projection:DashboardProjection|undefined;
let opened=false;
try {
  projection=new DashboardProjection(config.databasePath);
  let saved: z.infer<typeof schema>|undefined;
  // A mapping written by an older controller (lead pane based) or an unreadable one is not reused: it owns nothing we can verify.
  try{saved=schema.parse(JSON.parse(await readFile(statePath,'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')log(`ignoring unreadable pane mapping: ${(error as Error).message.split("\n")[0]}`);}
  // A mapping from another Herdr server or workspace, or from another group, is not reused; its closed markers are dropped too.
  if(saved&&(saved.groupId!==config.groupId||saved.socketPath!==context.socketPath||saved.workspaceId!==context.workspaceId))saved=undefined;
  const client=new HerdrClient(context.socketPath);
  const savedPanes:Partial<Record<WorkerRole,string>>={};
  for(const role of OBSERVED_ROLES){const id=saved?.panes[role];if(id)savedPanes[role]=id;}
  const initial:Partial<HerdrLayoutState>=saved?{...(saved.observerTab?{observerTab:saved.observerTab}:{}),...(saved.overviewPane?{overviewPane:saved.overviewPane}:{}),panes:savedPanes,readyRoles:saved.readyRoles,closedAt:saved.closedAt,returned:saved.returned}:{};
  const controller=new HerdrController(client,{groupId:config.groupId,workspaceId:context.workspaceId,cwd:resolve(fileURLToPath(new URL('../..',import.meta.url))),observerArgv:(role)=>[process.execPath,watcher,config.databasePath,config.groupId,role],save:async(state)=>{const temp=statePath+'.tmp';await writeFile(temp,JSON.stringify({socketPath:context.socketPath,workspaceId:context.workspaceId,groupId:config.groupId,...state}),{mode:0o600});await rename(temp,statePath);},onEvent:(event)=>log(JSON.stringify(event))},initial);
  const snapshotNow=()=>{const snapshot=projection!.snapshot(config.groupId);if(!snapshot)throw new Error('Configured coordinator group is missing.');return snapshot;};
  const tab=await controller.open(snapshotNow());
  opened=true;
  await lock.update({observerTab:tab});
  if(readyFile)await writeFile(readyFile,JSON.stringify({status:'ready',observerTab:tab,workspaceId:context.workspaceId}),{mode:0o600});
  const request=async(suffix:string)=>readFile(statePath+suffix,'utf8').catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return undefined;throw e;});
  let reason='stopped by signal';
  while(running) {
    try { await controller.sync(snapshotNow()); }
    catch(error){ if(error instanceof ObserverTabClosed){log(error.message);reason='closed by user';break;} throw error; }
    const compact=await request('.compact');
    if(compact!==undefined){const only=OBSERVED_ROLES.find((role)=>role===compact.trim());await controller.compact(snapshotNow(),only);await unlink(statePath+'.compact');}
    if(await request('.close')!==undefined){await unlink(statePath+'.close');reason='closed on request';break;}
    if(process.env.COORDINATOR_LEAD_PID){try{process.kill(Number(process.env.COORDINATOR_LEAD_PID),0);}catch{reason='lead exited';break;}}
    await delay(1000);
  }
  // Everything except a user-closed tab ends with the whole observation tab closed.
  if(reason!=='closed by user')await controller.closeAll();
  log(reason);
} catch(error) {
  if(readyFile&&!opened)await writeFile(readyFile+'.failed',`${(error as Error).message}\n`,{mode:0o600});
  throw error;
} finally {projection?.close();await lock.release();}
