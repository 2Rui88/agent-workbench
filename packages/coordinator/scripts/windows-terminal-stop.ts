import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const [configPath] = process.argv.slice(2);
if (!configPath) throw new Error('Usage: windows-terminal-stop <runtime.json>');
if (process.platform !== 'win32') throw new Error('Windows Terminal observer mode is only available on Windows.');
const runtimePath = resolve(configPath);
try { await access(runtimePath, constants.F_OK); } catch { throw new Error(`Runtime config not found: ${configPath}`); }
const runtime = JSON.parse(await readFile(runtimePath, 'utf8')) as { databasePath?: string; groupId?: string };
if (!runtime.databasePath || !runtime.groupId) throw new Error('Runtime config must define databasePath and groupId.');
const launcherDir = join(dirname(resolve(runtime.databasePath)), 'windows-terminal');
const stopScript = join(launcherDir, 'stop.ps1');
try { await access(stopScript, constants.F_OK); } catch { throw new Error(`No Windows Terminal observer session found for group ${runtime.groupId}.`); }
execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', stopScript], { stdio: 'inherit', windowsHide: true });
console.log(JSON.stringify({ status: 'stopped', backend: 'windows-terminal', groupId: runtime.groupId }));
