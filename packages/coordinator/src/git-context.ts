import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { CoordinatorError } from './errors.js';
const execute = promisify(execFile);
export interface GitContext { owner: string; email: string; worktreePath: string; head: string; }
export async function readGitContext(cwd: string): Promise<GitContext> {
  const args = [['config', 'user.name'], ['config', 'user.email'], ['rev-parse', '--show-toplevel'], ['rev-parse', 'HEAD']];
  const result = await Promise.all(args.map(async (items) => (await execute('git', ['-C', cwd, ...items], { maxBuffer: 64 * 1024 })).stdout.trim()));
  if (!result[0] || !result[1]) throw new CoordinatorError('TASK_GATE_CLOSED', 'Git owner identity is missing.', 'Configure the repository Git identity before task binding.');
  return { owner: result[0], email: result[1], worktreePath: await realpath(result[2]!), head: result[3]! };
}
