import { DatabaseSync } from 'node:sqlite';
import type { RuntimeEvent } from '../runtime/types.js';
import type { RoleId } from '../protocol.js';
export class RuntimeJournal {
  private readonly db:DatabaseSync;
  constructor(path:string) {
    this.db=new DatabaseSync(path);this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS terminal_events(id INTEGER PRIMARY KEY, group_id TEXT NOT NULL, role_id TEXT NOT NULL, at TEXT NOT NULL, method TEXT NOT NULL, thread_id TEXT, turn_id TEXT, source TEXT NOT NULL)');
  }
  record(groupId:string,role:RoleId,event:RuntimeEvent):void {
    if(!['turn/started','turn/completed','item/started','item/completed','thread/status/changed','error'].includes(event.method))return;
    this.db.prepare('INSERT INTO terminal_events(group_id,role_id,at,method,thread_id,turn_id,source) VALUES(?,?,?,?,?,?,?)').run(groupId,role,new Date().toISOString(),event.method,event.threadId?.slice(0,128)??null,event.turnId?.slice(0,128)??null,event.source);
    this.db.prepare('DELETE FROM terminal_events WHERE group_id=? AND role_id=? AND id NOT IN (SELECT id FROM terminal_events WHERE group_id=? AND role_id=? ORDER BY id DESC LIMIT 200)').run(groupId,role,groupId,role);
  }
  read(groupId:string,role:RoleId,limit=20):Array<{id:number;at:string;method:string;thread_id:string|null;turn_id:string|null;source:string}> {
    return this.db.prepare('SELECT id,at,method,thread_id,turn_id,source FROM terminal_events WHERE group_id=? AND role_id=? ORDER BY id DESC LIMIT ?').all(groupId,role,Math.min(Math.max(limit,1),200)) as any;
  }
  close():void {this.db.close();}
}
