import { spawn } from 'node:child_process';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [configPath] = process.argv.slice(2);
if (!configPath) throw new Error('Usage: windows-terminal-start <runtime.json>');
if (process.platform !== 'win32') throw new Error('Windows Terminal observer mode is only available on Windows.');
try { await access(resolve(configPath), constants.F_OK); } catch { throw new Error(`Runtime config not found: ${configPath}`); }
async function resolveWindowsTerminal(): Promise<string> {
  const configured = process.env.AGENT_WORKBENCH_WINDOWS_TERMINAL;
  if (configured) {
    try { await access(configured, constants.X_OK); return configured; } catch { throw new Error(`AGENT_WORKBENCH_WINDOWS_TERMINAL does not point to an executable: ${configured}`); }
  }
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn('where.exe', ['wt.exe']);
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error()));
    });
    return 'wt.exe';
  } catch {
    const root = process.env.LOCALAPPDATA;
    if (root) {
      const tools = join(root, 'AgentWorkbench', 'tools');
      try {
        for (const version of await readdir(tools)) {
          if (!version.startsWith('WindowsTerminal-')) continue;
          const versionDir = join(tools, version);
          for (const nested of await readdir(versionDir)) {
            const candidate = join(versionDir, nested, 'wt.exe');
            try { await access(candidate, constants.X_OK); return candidate; } catch { /* continue */ }
          }
        }
      } catch { /* portable installation is optional */ }
    }
  }
  throw new Error('Windows Terminal (wt.exe) is not installed or is not on PATH. Set AGENT_WORKBENCH_WINDOWS_TERMINAL to a portable wt.exe path.');
}

const windowsTerminal = await resolveWindowsTerminal();

const coordinatorRoot = fileURLToPath(new URL('../..', import.meta.url));
const runtime = JSON.parse(await readFile(resolve(configPath), 'utf8')) as { databasePath?: string; groupId?: string };
if (!runtime.databasePath || !runtime.groupId) throw new Error('Runtime config must define databasePath and groupId.');
const stateDir = dirname(resolve(runtime.databasePath));
const launcherDir = join(stateDir, 'windows-terminal');
await mkdir(launcherDir, { recursive: true });
const watcher = resolve(coordinatorRoot, 'dist', 'scripts', 'herdr-watch.js');
const roles = ['overview', 'frontend', 'backend', 'audit', 'advisor'];
for (const role of roles) {
  const script = join(launcherDir, `${role}.ps1`);
  const pidFile = join(launcherDir, `${role}.pid`);
  await writeFile(script, `$ErrorActionPreference = 'Stop'\nSet-Content -LiteralPath '${pidFile.replace(/'/g, "''")}' -Value ([string]$PID) -Encoding ascii\ntry {\n  & node '${watcher.replace(/'/g, "''")}' '${resolve(runtime.databasePath).replace(/'/g, "''")}' '${runtime.groupId.replace(/'/g, "''")}' '${role}'\n} finally {\n  Remove-Item -LiteralPath '${pidFile.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue\n}\n`, { encoding: 'utf8' });
  const title = role === 'overview' ? 'Coordinator overview' : `Coordinator ${role}`;
  const child = spawn(windowsTerminal, ['-w', '0', 'new-tab', '--title', title, 'powershell.exe', '-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', script], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}
const stopScript = join(launcherDir, 'stop.ps1');
await writeFile(stopScript, `$ErrorActionPreference = 'Stop'\n$pidFiles = @(Get-ChildItem -LiteralPath '${launcherDir.replace(/'/g, "''")}' -Filter '*.pid' -ErrorAction SilentlyContinue)\nif ($pidFiles.Count -eq 0) { throw 'No active Windows Terminal observer processes found.' }\nforeach ($file in $pidFiles) {\n  $value = (Get-Content -LiteralPath $file.FullName -Raw).Trim()\n  if ($value -match '^[0-9]+$') { & taskkill.exe /PID $value /T /F | Out-Null }\n  Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue\n}\n`, { encoding: 'utf8' });
console.log(JSON.stringify({ status: 'opened', backend: 'windows-terminal', executable: windowsTerminal, groupId: runtime.groupId, roles, stopScript }));
