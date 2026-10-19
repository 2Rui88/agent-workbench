import { DatabaseSync } from 'node:sqlite';
import { OBSERVED_ROLES } from '../src/roles.js';
import { setTimeout as delay } from 'node:timers/promises';
import { DashboardProjection } from '../src/dashboard/projection.js';
import { observerHeader, readObserverContent, renderObserverContent, renderOverview } from '../src/terminal/observer-content.js';
import { TerminalFrameRenderer } from '../src/terminal/frame-renderer.js';

// Read-only observer for one pane of the observation tab: a role pane (fixed title row, then the role summary)
// or the overview pane. Frames are painted whole and in place; nothing scrolls. On a TTY the renderer wipes the
// screen and scrollback once before the first frame (shell prompt, echoed exec line) and never again.
const [databasePath,groupId,roleId] = process.argv.slice(2);
if (!databasePath || !groupId || !(roleId==='overview' || (OBSERVED_ROLES as readonly string[]).includes(roleId??''))) throw new Error('Usage: herdr-watch <db> <group> <frontend|backend|audit|advisor|overview>');
const projection=new DashboardProjection(databasePath);
const db=new DatabaseSync(databasePath,{readOnly:true});
const renderer=new TerminalFrameRenderer();
let previousText='';
let running=true;
process.on('SIGTERM',()=>{running=false;}); process.on('SIGINT',()=>{running=false;});
try {
  while(running) {
    const snapshot=projection.snapshot(groupId);
    if(!snapshot)throw new Error('Coordinator group is not available.');
    const columns=process.stdout.columns??100;
    const rows=process.stdout.rows??40;
    let lines:string[];
    if(roleId==='overview'){
      const contents=Object.fromEntries(OBSERVED_ROLES.map((role)=>[role,readObserverContent(db,groupId,role)]));
      lines=renderOverview(snapshot,contents,{columns,rows});
    } else {
      const role=snapshot.roles.find((r)=>r.roleId===roleId);
      const content=readObserverContent(db,groupId,roleId!);
      const body=renderObserverContent(content,{columns,rows:Math.max(4,rows-3)}).split('\n');
      lines=[observerHeader(role,content),...body,'只读摘要 · 最终验收由人工决定'];
    }
    const text=lines.join('\n');
    const output=process.stdout.isTTY?renderer.render(lines,columns,rows):(text===previousText?'':text+'\n');
    if(output)process.stdout.write(output);
    previousText=text;
    await delay(1000);
  }
} finally {process.stdout.write(renderer.close());projection.close();db.close();}
