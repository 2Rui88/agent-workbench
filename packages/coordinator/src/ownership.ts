import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { lstat, unlink } from 'node:fs/promises';
import { CoordinatorError } from './errors.js';

interface Owner { group_id: string; instance_id: string; pid: number; socket_path: string; socket_ino: number | null; socket_dev: number | null; }

export class CoordinatorOwnership {
  private readonly db: DatabaseSync;
  private readonly instance = randomUUID();
  private acquired = false;
  constructor(databasePath: string, private readonly groupId: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS coordinator_owners(group_id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, pid INTEGER NOT NULL, socket_path TEXT NOT NULL, socket_ino INTEGER, socket_dev INTEGER);');
  }
  async acquire(socketPath: string): Promise<void> {
    let previous: Owner | undefined;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      previous = this.db.prepare('SELECT * FROM coordinator_owners WHERE group_id=?').get(this.groupId) as unknown as Owner | undefined;
      if (previous && this.alive(previous.pid)) throw new CoordinatorError('SERVICE_UNHEALTHY', 'This group already has a live coordinator.', 'Use its existing socket; never replace a live owner.');
      this.db.prepare('INSERT INTO coordinator_owners(group_id,instance_id,pid,socket_path) VALUES(?,?,?,?) ON CONFLICT(group_id) DO UPDATE SET instance_id=excluded.instance_id,pid=excluded.pid,socket_path=excluded.socket_path,socket_ino=NULL,socket_dev=NULL').run(this.groupId, this.instance, process.pid, socketPath);
      this.db.exec('COMMIT'); this.acquired = true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (process.platform === 'win32' || socketPath.startsWith('\\\\.\\pipe\\') || previous?.socket_path !== socketPath) return;
    try {
      const socket = await lstat(socketPath);
      if (!socket.isSocket() || socket.uid !== process.getuid?.() || socket.ino !== previous.socket_ino || socket.dev !== previous.socket_dev) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Existing socket does not match the dead coordinator resource.', 'Inspect endpoint ownership before removing anything.');
      await unlink(socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Preserve the dead owner's evidence when endpoint inspection fails.
        this.db.prepare('UPDATE coordinator_owners SET instance_id=?,pid=?,socket_path=?,socket_ino=?,socket_dev=? WHERE group_id=? AND instance_id=?').run(previous.instance_id,previous.pid,previous.socket_path,previous.socket_ino,previous.socket_dev,this.groupId,this.instance);
        this.acquired=false;throw error;
      }
    }
  }
  async recordSocket(socketPath: string): Promise<void> {
    if (process.platform === 'win32' || socketPath.startsWith('\\\\.\\pipe\\')) return;
    const socket = await lstat(socketPath);
    this.db.prepare('UPDATE coordinator_owners SET socket_ino=?,socket_dev=? WHERE group_id=? AND instance_id=?').run(socket.ino, socket.dev, this.groupId, this.instance);
  }
  close(): void {
    if (this.acquired) this.db.prepare('DELETE FROM coordinator_owners WHERE group_id=? AND instance_id=?').run(this.groupId, this.instance);
    this.db.close();
  }
  private alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  }
}
