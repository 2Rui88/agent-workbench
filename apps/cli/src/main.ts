import { execFileSync, spawn } from 'node:child_process';
import { access, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

interface ServiceSpec { name: string; cwd: string; command: string; args: string[]; enabled?: boolean; env?: Record<string, string>; }
interface WorkbenchConfig { projectId: string; dataDir: string; gateway?: { host: string; port: number }; coordinatorRuntimePath?: string; services?: ServiceSpec[]; repositories?: Array<{ id: string; path: string }>; }
interface ServiceState { name: string; pid: number; command: string; startedAt: string; logPath: string; }
interface StateFile { services: ServiceState[]; updatedAt: string; }

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const configPath = process.env.AGENT_WORKBENCH_CONFIG ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'AgentWorkbench', 'config.json');
const arg = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };

async function readConfig(): Promise<WorkbenchConfig> {
  const path = arg('--config') ?? configPath;
  return JSON.parse(await readFile(path, 'utf8')) as WorkbenchConfig;
}

async function statePath(config: WorkbenchConfig): Promise<string> {
  const directory = resolve(config.dataDir);
  await mkdir(directory, { recursive: true });
  return join(directory, 'services.json');
}

async function readState(config: WorkbenchConfig): Promise<{ path: string; state: StateFile }> {
  const path = await statePath(config);
  try { return { path, state: JSON.parse(await readFile(path, 'utf8')) as StateFile }; }
  catch { return { path, state: { services: [], updatedAt: new Date(0).toISOString() } }; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function commandExists(command: string): boolean {
  try { execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function supportsRequiredNode(): boolean {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return (major ?? 0) > 24 || ((major ?? 0) === 24 && (minor ?? 0) >= 19);
}

async function init(): Promise<void> {
  const path = arg('--config') ?? configPath;
  await mkdir(dirname(path), { recursive: true });
  try { await access(path, constants.F_OK); throw new Error(`Config already exists: ${path}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const config: WorkbenchConfig = {
    projectId: 'my-app',
    dataDir: resolve(join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'AgentWorkbench')),
    gateway: { host: '127.0.0.1', port: 47321 },
    coordinatorRuntimePath: resolve(join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'AgentWorkbench', 'coordinator', 'runtime.json')),
    services: [
      {
        name: 'task-service', cwd: resolve(root, 'packages', 'task-service'), command: process.execPath,
        args: [resolve(root, 'packages/task-service/dist/server/main.js')], enabled: true,
        env: { TASK_MCP_HOST: '127.0.0.1', TASK_MCP_PORT: '47321', TASK_MCP_DATA_DIR: resolve(join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'AgentWorkbench', 'task-service')) }
      },
      {
        name: 'coordinator', cwd: root, command: process.execPath,
        args: [resolve(root, 'packages/coordinator/dist/scripts/daemon.js'), resolve(join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'AgentWorkbench', 'coordinator', 'runtime.json'))], enabled: false
      }
    ],
    repositories: []
  };
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  console.log(`Created ${path}`);
  console.log('Task Service is enabled by default. Build it, then run: agent-platform start --service task-service');
  console.log('Complete coordinator runtime initialization, set its enabled flag to true, then run: agent-platform start --service coordinator');
}

async function initCoordinator(): Promise<void> {
  const config = await readConfig();
  const runtimePath = resolve(config.coordinatorRuntimePath ?? join(resolve(config.dataDir), "coordinator", "runtime.json"));
  await mkdir(dirname(runtimePath), { recursive: true });
  try {
    await access(runtimePath, constants.F_OK);
    throw new Error(`Coordinator runtime already exists: ${runtimePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const runtimeDirectory = dirname(runtimePath);
  const runtime = {
    groupId: config.projectId,
    mode: "mock",
    databasePath: join(runtimeDirectory, "state.sqlite"),
    // The coordinator maps this portable path to a Windows Named Pipe.
    socketPath: join(runtimeDirectory, "coordinator.sock"),
    credentialFile: join(runtimeDirectory, "roles.json"),
    humanCredentialFile: join(runtimeDirectory, "human.json"),
    allowedRoots: [root],
    repositories: []
  };
  await writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  execFileSync(process.execPath, [resolve(root, "packages/coordinator/dist/scripts/group-init.js"), runtimePath], {
    cwd: resolve(root, "packages/coordinator"),
    env: { ...process.env, COORDINATOR_ROLE: "lead", COORDINATOR_GROUP_ID: config.projectId },
    stdio: "inherit"
  });
  console.log(`Created Coordinator runtime: ${runtimePath}`);
  console.log("Next: run human-control init for the separate human approval credential, then enable coordinator in the workbench config.");
}

async function enableCoordinator(): Promise<void> {
  const path = arg("--config") ?? configPath;
  const config = await readConfig();
  const runtimePath = resolve(config.coordinatorRuntimePath ?? join(resolve(config.dataDir), "coordinator", "runtime.json"));
  const runtime = JSON.parse(await readFile(runtimePath, "utf8")) as { humanCredentialFile?: string };
  if (!runtime.humanCredentialFile) throw new Error("Coordinator runtime has no humanCredentialFile.");
  await access(resolve(dirname(runtimePath), runtime.humanCredentialFile));
  const coordinator = config.services?.find((service) => service.name === "coordinator");
  if (!coordinator) throw new Error("Coordinator service is missing from the workbench config.");
  coordinator.enabled = true;
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  console.log(`Enabled coordinator in ${path}`);
}

async function start(): Promise<void> {
  const config = await readConfig();
  const selected = arg('--service');
  const services = (config.services ?? []).filter((service) => selected ? service.name === selected : service.enabled !== false);
  if (!services.length) throw new Error('No services configured. Run init and add services to the config.');
  const { path, state } = await readState(config);
  const next: ServiceState[] = [...state.services.filter((service) => alive(service.pid))];
  for (const service of services) {
    if (next.some((running) => running.name === service.name)) continue;
    await access(resolve(service.cwd));
    const entrypoint = service.args[0];
    if (service.command === process.execPath && entrypoint) await access(resolve(entrypoint));
    if (service.name === 'coordinator' && entrypoint && service.args[1]) await access(resolve(service.args[1]));
    const logPath = join(resolve(config.dataDir), `${service.name}.log`);
    const output = await open(logPath, 'a');
    const child = spawn(service.command, service.args, {
      cwd: resolve(service.cwd),
      env: { ...process.env, ...service.env },
      detached: true,
      windowsHide: true,
      stdio: ['ignore', output.fd, output.fd],
      shell: false
    });
    if (!child.pid) throw new Error(`Unable to start service ${service.name}.`);
    child.unref();
    await output.close();
    next.push({ name: service.name, pid: child.pid, command: `${service.command} ${service.args.join(' ')}`, startedAt: new Date().toISOString(), logPath });
    console.log(`Started ${service.name} (PID ${child.pid})`);
  }
  await writeFile(path, `${JSON.stringify({ services: next, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

async function stop(): Promise<void> {
  const config = await readConfig();
  const { path, state } = await readState(config);
  for (const service of state.services) {
    if (!alive(service.pid)) continue;
    if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(service.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(service.pid, 'SIGTERM');
    console.log(`Stopped ${service.name} (PID ${service.pid})`);
  }
  await writeFile(path, `${JSON.stringify({ services: [], updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

async function status(): Promise<void> {
  const config = await readConfig();
  const { state } = await readState(config);
  console.log(JSON.stringify({ projectId: config.projectId, services: state.services.map((service) => ({ ...service, running: alive(service.pid) })) }, null, 2));
}

async function doctor(): Promise<void> {
  const checks = [
    { name: 'platform', ok: process.platform === 'win32', detail: process.platform },
    { name: 'node', ok: supportsRequiredNode(), detail: `${process.version} (requires >=24.19.0)` },
    { name: 'git', ok: commandExists('git'), detail: 'required for worktree validation' },
    { name: 'powershell', ok: process.platform !== 'win32' || commandExists('powershell'), detail: 'required for Windows Runtime' },
      { name: 'kitty', ok: process.platform === 'win32' || commandExists('kitty'), detail: process.platform === 'win32' ? (commandExists('kitty') ? 'available' : 'optional; kitty:start falls back to Windows Terminal') : 'required for Kitty mode' },
    { name: 'windows-terminal', ok: true, detail: 'optional host; Kitty and Coordinator do not require wt.exe' },
    { name: 'task-service-source', ok: await access(join(root, 'packages', 'task-service', 'package.json')).then(() => true, () => false), detail: 'migrated package present' },
    { name: 'coordinator-source', ok: await access(join(root, 'packages', 'coordinator', 'package.json')).then(() => true, () => false), detail: 'migrated package present' }
  ];
  console.log(JSON.stringify({ ok: checks.every((check) => check.ok), checks }, null, 2));
  if (!checks.every((check) => check.ok)) process.exitCode = 1;
}

const command = process.argv[2] ?? 'help';
try {
  if (command === 'init') await init();
  else if (command === 'init-coordinator') await initCoordinator();
  else if (command === 'enable-coordinator') await enableCoordinator();
  else if (command === 'start') await start();
  else if (command === 'stop') await stop();
  else if (command === 'status') await status();
  else if (command === 'doctor') await doctor();
  else console.log('Usage: agent-platform <init|init-coordinator|enable-coordinator|start|stop|status|doctor> [--config path]');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
