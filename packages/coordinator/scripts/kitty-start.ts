import {mkdtemp,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {writeFile} from 'node:fs/promises';
import {loadRuntimeConfig} from '../src/runtime-config.js';
import {assertNotInsideHerdr} from '../src/terminal/layout-lock.js';
assertNotInsideHerdr(process.env);
const [configPath,mode]=process.argv.slice(2);
// Lead sessions attach themselves from a plain claude (lead:attach); this entry only opens an observation Kitty.
if(!configPath||mode!=='--observe-only')throw new Error('Usage: kitty:start <runtime.json> --observe-only  (start the lead as a plain claude session; the skill attaches it)');
await loadRuntimeConfig(configPath);
try { execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['kitty'], {stdio:'ignore'}); }
catch {
  if (process.platform === 'win32' && process.env.AGENT_WORKBENCH_KITTY_STRICT !== '1') {
    const fallback = fileURLToPath(new URL('./windows-terminal-start.js', import.meta.url));
    const child = spawn(process.execPath, [fallback, resolve(configPath)], { stdio: 'inherit', windowsHide: true });
    const code = await new Promise<number | null>((resolvePromise, reject) => {
      child.once('error', reject);
      child.once('exit', (exitCode) => resolvePromise(exitCode));
    });
    process.exitCode = code ?? 1;
    process.exit();
  }
  throw new Error('Kitty executable not found. On Windows, kitty:start falls back to the native Windows Terminal observer backend; set AGENT_WORKBENCH_KITTY_STRICT=1 to require Kitty explicitly.');
}
const root=fileURLToPath(new URL('../..',import.meta.url));
await mkdir(join(root,'.state/kitty'),{recursive:true,mode:0o700});
const dir=await mkdtemp(join(root,'.state/kitty/run-'));
if (process.platform !== 'win32') {
  const child=spawn('kitty',['--detach','--config','NONE','--listen-on',`unix:${join(dir,'rc')}`,'-o','allow_remote_control=socket-only','-o','enabled_layouts=splits','--title','Coordinator','/bin/sh',join(root,'scripts/kitty-lead.sh'),resolve(configPath),'--observe-only'],{stdio:'inherit'});
  child.on('error',error=>{console.error(error.message);process.exitCode=1;});
  child.on('exit',code=>{if(code)process.exitCode=code;});
} else {
  const reservation=createServer();
  const port=await new Promise<number>((resolvePromise,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',()=>{const address=reservation.address();if(!address||typeof address==='string'){reject(new Error('Unable to reserve a local Kitty control port.'));return;}reservation.close(error=>error?reject(error):resolvePromise(address.port));});});
  const endpoint=`tcp:localhost:${port}`;
  const launcher=join(dir,'kitty-lead.ps1');
  const script=`$ErrorActionPreference = 'Stop'
$runtime = $args[0]
$coordinatorRoot = $args[1]
$log = Join-Path (Split-Path -Parent $runtime) 'kitty-controller.log'
$env:COORDINATOR_LEAD_PID = [string]$PID
$controller = Start-Process -FilePath (Get-Command node).Source -ArgumentList @((Join-Path $coordinatorRoot 'dist/scripts/kitty-follow.js'), $runtime) -WorkingDirectory $coordinatorRoot -PassThru -RedirectStandardOutput $log -RedirectStandardError ($log + '.err')
try {
  if (Get-Command claude -ErrorAction SilentlyContinue) { & claude } else { throw 'Claude CLI was not found in PATH.' }
} finally {
  if ($controller -and !$controller.HasExited) { Stop-Process -Id $controller.Id -Force -ErrorAction SilentlyContinue }
}
`;
  await writeFile(launcher,script,{encoding:'utf8'});
  const child=spawn('kitty',['--detach','--config','NONE','--listen-on',endpoint,'-o','allow_remote_control=socket-only','-o','enabled_layouts=splits','--title','Coordinator','powershell.exe','-NoLogo','-NoExit','-ExecutionPolicy','Bypass','-File',launcher,resolve(configPath),root],{stdio:'inherit',windowsHide:true,env:{...process.env,KITTY_LISTEN_ON:endpoint}});
  child.on('error',error=>{console.error(`Kitty Windows launch failed: ${error.message}`);process.exitCode=1;});
  child.on('exit',code=>{if(code)process.exitCode=code;});
}
