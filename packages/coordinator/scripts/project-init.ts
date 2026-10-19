import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildScaffold, writeScaffold } from '../src/project-scaffold.js';

const run = promisify(execFile);
const usage = `Usage: npm run project:init -- --group <id> --repo <lead worktree> --repo-id <cli task repository id>
       --frontend <worktree> --backend <worktree> [--memory <project memory file>] [--env-from <existing daemon.env>]
       [--create-worktrees --base <branch>] [--task-mcp-url <url>] [--cli-task-repo <path>]`;

const args = new Map<string, string>(); const flags = new Set<string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const key = argv[i]!;
  if (!key.startsWith('--')) throw new Error(usage);
  if (key === '--create-worktrees') { flags.add(key); continue; }
  const value = argv[++i];
  if (value === undefined || value.startsWith('--')) throw new Error(`${key} needs a value.\n${usage}`);
  args.set(key, value);
}
const need = (key: string): string => { const value = args.get(key); if (!value) throw new Error(`Missing ${key}.\n${usage}`); return value; };
const taskMcpUrl = args.get('--task-mcp-url') ?? 'http://172.16.0.90:47321/mcp';
const input = {
  coordinatorRoot: resolve(fileURLToPath(new URL('..', import.meta.url))),
  group: need('--group'), repo: resolve(need('--repo')), repoId: need('--repo-id'), ...(args.has('--memory') ? { memory: resolve(args.get('--memory')!) } : {}),
  frontend: resolve(need('--frontend')), backend: resolve(need('--backend')),
  taskMcpUrl, taskServerUrl: new URL(taskMcpUrl).origin,
  cliTaskRepo: resolve(args.get('--cli-task-repo') ?? `${homedir()}/playground/cli-session-task-mcp`)
};
if (!input.frontend.endsWith('/frontend') || !input.backend.endsWith('/backend')) throw new Error('Worker worktree paths must end with /frontend and /backend.');

if (flags.has('--create-worktrees')) {
  const base = need('--base');
  for (const role of ['backend', 'frontend'] as const) {
    await run('git', ['-C', input.repo, 'worktree', 'add', '-b', `feat/${input.group}-${role}`, input[role], base]);
    console.log(`worktree ${role}: ${input[role]} (branch feat/${input.group}-${role} from ${base})`);
  }
}

const scaffold = buildScaffold(input);
await writeScaffold(scaffold, args.has('--env-from') ? { envFrom: resolve(args.get('--env-from')!) } : {});
const R = scaffold.runDir;
console.log(`
Created ${R} (0700): runtime.json, daemon.env${args.has('--env-from') ? ' (COORDINATOR_* lines copied)' : ''}, helper scripts.

Remaining steps (see docs/new-project-herdr.md):
  1. Lead agent in ${input.repo}: CLI Task repository_bootstrap/session_context, create + start the lead Task.
  2. Project memory: ${input.memory ?? 'not configured (add projectMemory.path to runtime.json when the business repository has a memory document)'}.
  3. Add workerTaskSpecs (frontend/backend: title, goal, acceptanceCriteria, nextAction) to ${R}/runtime.json.
  4. COORDINATOR_ROLE=lead npm run group-init -- ${R}/runtime.json
  5. Human, real terminal: sh ${R}/human-init.sh
  6. nohup sh ${R}/worker-hold.sh > ${R}/worker-hold.log 2>&1 &   then: npm run worker-task -- ${R}/runtime.json manifest <grant expiry>
     and write workerTasks + externalTaskObservation into runtime.json.
  7. npm run project-preflight -- ${R}/runtime.json ; npm run worker-preflight -- ${R}/runtime.json <manifest.json> ; npm run protocol-preflight -- "$PWD" --claude
  8. nohup sh ${R}/start-daemon.sh > ${R}/daemon.log 2>&1 < /dev/null &
  9. In a Herdr pane, cd into the business repository, start claude and ask it to start coordinating (the skill runs lead:attach);
     ask it to open the observation tab when you want to watch (the skill runs herdr:open)
 10. After the user approves realExecution: add it to runtime.json, restart the daemon, initialize roles, publish the contract, dispatch.`);
