import { execFileSync, spawn } from 'node:child_process';
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
const roles = ['overview', 'frontend', 'backend', 'audit', 'advisor'] as const;
const escapedLauncherDir = launcherDir.replace(/'/g, "''");
const cleanupCommand = `$root='${escapedLauncherDir}'; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'powershell.exe' -and $_.ProcessId -ne $PID -and $_.CommandLine -like ('*' + $root + '*') } | ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F | Out-Null }`;
try {
  execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cleanupCommand], { stdio: 'ignore', windowsHide: true });
} catch {
  // A previous observer session may not exist. Starting a fresh session remains valid.
}
const launchArgsByRole = new Map<string, string[]>();
for (const role of roles) {
  const script = join(launcherDir, `${role}.ps1`);
  const pidFile = join(launcherDir, `${role}.pid`);
  await writeFile(script, `$ErrorActionPreference = 'Stop'\nSet-Content -LiteralPath '${pidFile.replace(/'/g, "''")}' -Value ([string]$PID) -Encoding ascii\ntry {\n  & node '${watcher.replace(/'/g, "''")}' '${resolve(runtime.databasePath).replace(/'/g, "''")}' '${runtime.groupId.replace(/'/g, "''")}' '${role}'\n} finally {\n  Remove-Item -LiteralPath '${pidFile.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue\n}\n`, { encoding: 'utf8' });
  const title = role === 'overview' ? 'Coordinator overview' : `Coordinator ${role}`;
  launchArgsByRole.set(role, ['--title', title, 'powershell.exe', '-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', script]);
}
// Keep the observer in one Windows Terminal tab and use panes. The overview is
// the left pane; the four role panes are stacked on the right, which preserves
// the Kitty operator workflow without requiring Kitty on Windows.
const overview = launchArgsByRole.get('overview')!;
const paneArgs = [
  '-w', 'new', 'new-tab', ...overview,
  ';', 'split-pane', '-H', '-s', '0.65', ...(launchArgsByRole.get('frontend')!),
  ';', 'split-pane', '-V', '-s', '0.50', ...(launchArgsByRole.get('backend')!),
  ';', 'split-pane', '-V', '-s', '0.50', ...(launchArgsByRole.get('audit')!),
  ';', 'split-pane', '-V', '-s', '0.50', ...(launchArgsByRole.get('advisor')!),
];
const child = spawn(windowsTerminal, paneArgs, { detached: true, stdio: 'ignore', windowsHide: true });
child.unref();
const stopScript = join(launcherDir, 'stop.ps1');
await writeFile(stopScript, `$ErrorActionPreference = 'Stop'\n$root = '${escapedLauncherDir}'\n$pidFiles = @(Get-ChildItem -LiteralPath $root -Filter '*.pid' -ErrorAction SilentlyContinue)\n$processIds = @($pidFiles | ForEach-Object { $value = (Get-Content -LiteralPath $_.FullName -Raw).Trim(); if ($value -match '^[0-9]+$') { [int]$value } })\n$processIds += @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'powershell.exe' -and $_.ProcessId -ne $PID -and $_.CommandLine -like ('*' + $root + '*') } | Select-Object -ExpandProperty ProcessId)\n$processIds = @($processIds | Sort-Object -Unique)\nif ($processIds.Count -eq 0) { throw 'No active Windows Terminal observer processes found.' }\nforeach ($processId in $processIds) { & taskkill.exe /PID $processId /T /F | Out-Null; if ($LASTEXITCODE -ne 0) { $global:LASTEXITCODE = 0 } }\nGet-ChildItem -LiteralPath $root -Filter '*.pid' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue\n`, { encoding: 'utf8' });
console.log(JSON.stringify({
  status: 'opened',
  backend: 'windows-terminal-pane',
  layout: 'overview-left-roles-right',
  executable: windowsTerminal,
  groupId: runtime.groupId,
  roles,
  stopScript,
}));
