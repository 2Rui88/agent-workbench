import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertPrivateFile } from './runtime-config.js';

export interface ScaffoldInput {
  coordinatorRoot: string; group: string; repo: string; repoId: string; memory?: string;
  frontend: string; backend: string; taskMcpUrl: string; taskServerUrl: string; cliTaskRepo: string;
}
export interface ScaffoldFile { name: string; content: string; mode: number; }
export interface Scaffold { runDir: string; runtimePath: string; files: ScaffoldFile[]; }

const GROUP = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

// Builds the private runtime directory for a new collaboration group: Claude lead, Codex frontend/backend,
// Claude audit/advisor. The shared project memory is a document inside the business repository (projectMemory).
export function buildScaffold(input: ScaffoldInput): Scaffold {
  if (!GROUP.test(input.group)) throw new Error('group must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}.');
  const runDir = join(input.coordinatorRoot, '.state', input.group);
  const runtimePath = join(runDir, 'runtime.json');
  const runtime = {
    groupId: input.group, mode: 'real', leadMode: 'external', leadAgent: 'claude', leadWorktree: input.repo,
    roles: { frontend: { agent: 'codex' }, backend: { agent: 'codex' }, audit: { agent: 'claude' }, advisor: { agent: 'claude' } },
    databasePath: 'state.sqlite', socketPath: 'c.sock', credentialFile: 'roles.json', humanCredentialFile: 'human.json',
    allowedRoots: [input.repo, input.frontend, input.backend],
    repositories: [input.repo, input.frontend, input.backend].map((worktreePath) => ({ repositoryId: input.repoId, worktreePath })),
    taskMcpUrl: input.taskMcpUrl,
    taskHostEvidence: { cliRepositoryPath: input.cliTaskRepo, serverUrl: input.taskServerUrl },
    ...(input.memory ? { projectMemory: { path: input.memory } } : {})
  };
  const npm = (args: string) => `cd ${quote(input.coordinatorRoot)}\nexec npm run ${args}\n`;
  const sh = (body: string) => `#!/bin/sh\nset -eu\n${body}`;
  const runtimeArg = quote(runtimePath);
  const scripts: Record<string, string> = {
    'start-daemon.sh': sh(`set -a\n. ${quote(join(runDir, 'daemon.env'))}\nset +a\n${npm(`daemon -- ${runtimeArg}`)}`),
    'human-init.sh': sh(`# Human only, in a real terminal.\n${npm(`human-control -- ${runtimeArg} init`)}`),
    'human-approvals.sh': sh(`# Human only, in a real terminal: lists pending approvals.\n${npm(`human-control -- ${runtimeArg} approvals`)}`),
    'lead-rotate.sh': sh(`# Human only, in a real terminal, after pausing and letting the old lead heartbeat expire.\n${npm(`human-control -- ${runtimeArg} lead-rotate`)}`),
    'worker-hold.sh': sh(`# Long-running: creates (first run) and holds the frontend/backend worker Task leases.\n${npm(`worker-task -- ${runtimeArg} hold`)}`),
    'renew-workers.sh': sh(`# Ask the running worker-hold to renew both worker leases (every ~20 minutes during long turns).\ncd ${quote(input.coordinatorRoot)}\nnpm run -s worker-task -- ${runtimeArg} frontend renew\nnpm run -s worker-task -- ${runtimeArg} backend renew\n`)
  };
  return {
    runDir, runtimePath,
    files: [{ name: 'runtime.json', content: `${JSON.stringify(runtime, null, 2)}\n`, mode: 0o600 }, ...Object.entries(scripts).map(([name, content]) => ({ name, content, mode: 0o700 }))]
  };
}

// Creates the run directory (0700) and its files; never overwrites an existing group.
// daemon.env receives only COORDINATOR_* lines copied from an existing private env file.
export async function writeScaffold(scaffold: Scaffold, options: { envFrom?: string }): Promise<void> {
  const exists = await stat(scaffold.runDir).then(() => true, () => false);
  if (exists) throw new Error(`Run directory ${scaffold.runDir} already exists; refusing to overwrite an existing group.`);
  await mkdir(scaffold.runDir, { recursive: true, mode: 0o700 });
  await chmod(scaffold.runDir, 0o700);
  for (const file of scaffold.files) { await writeFile(join(scaffold.runDir, file.name), file.content, { mode: file.mode }); await chmod(join(scaffold.runDir, file.name), file.mode); }
  let env = '# Extra COORDINATOR_* environment for the daemon (optional).\n';
  if (options.envFrom) {
    await assertPrivateFile(options.envFrom);
    env += (await readFile(options.envFrom, 'utf8')).split('\n').filter((line) => /^COORDINATOR_[A-Z_]+=/.test(line)).join('\n') + '\n';
  }
  await writeFile(join(scaffold.runDir, 'daemon.env'), env, { mode: 0o600 });
  await chmod(join(scaffold.runDir, 'daemon.env'), 0o600);
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
