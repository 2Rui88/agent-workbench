import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [configPath] = process.argv.slice(2);
if (!configPath) throw new Error('Usage: windows-terminal-start <runtime.json>');
if (process.platform !== 'win32') throw new Error('Windows Terminal observer mode is only available on Windows.');
try { await access(resolve(configPath), constants.F_OK); } catch { throw new Error(`Runtime config not found: ${configPath}`); }
try { await new Promise<void>((resolvePromise, reject) => { const child = spawn('where.exe', ['wt.exe']); child.once('error', reject); child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error())); }); } catch { throw new Error('Windows Terminal (wt.exe) is not installed or is not on PATH.'); }

const coordinatorRoot = fileURLToPath(new URL('../..', import.meta.url));
const runtime = JSON.parse(await (await import('node:fs/promises')).readFile(resolve(configPath), 'utf8')) as { databasePath?: string; groupId?: string };
if (!runtime.databasePath || !runtime.groupId) throw new Error('Runtime config must define databasePath and groupId.');
const stateDir = dirname(resolve(runtime.databasePath));
const launcherDir = join(stateDir, 'windows-terminal');
await mkdir(launcherDir, { recursive: true });
const watcher = resolve(coordinatorRoot, 'dist', 'scripts', 'herdr-watch.js');
const roles = ['overview', 'frontend', 'backend', 'audit', 'advisor'];
for (const role of roles) {
  const script = join(launcherDir, `${role}.ps1`);
  await writeFile(script, `$ErrorActionPreference = 'Stop'\n& node '${watcher.replace(/'/g, "''")}' '${resolve(runtime.databasePath).replace(/'/g, "''")}' '${runtime.groupId.replace(/'/g, "''")}' '${role}'\n`, { encoding: 'utf8' });
  const title = role === 'overview' ? 'Coordinator overview' : `Coordinator ${role}`;
  const child = spawn('wt.exe', ['-w', '0', 'new-tab', '--title', title, 'powershell.exe', '-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', script], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}
console.log(JSON.stringify({ status: 'opened', backend: 'windows-terminal', groupId: runtime.groupId, roles }));
