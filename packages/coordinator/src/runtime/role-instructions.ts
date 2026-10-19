import type { RoleId } from '../protocol.js';

export interface RoleInstructionInput { role: RoleId; groupId: string; projectMemoryPath?: string; }

// Worker, audit and advisor read the shared project memory; only the lead writes it. Task state and handoff
// live in cli_session_task, never in the memory file.
export function roleInstructions(input: RoleInstructionInput): string {
  const completion = input.role === 'advisor' ? 'Give advice only through automation_advice_complete with the adviceId named in the package; never edit files.' : 'Complete work through automation_work_complete with business evidence; turn completion does not accept a task.';
  const commits = input.role === 'frontend' || input.role === 'backend' ? ' Do not run git commit or other commands that write Git metadata; leave changes uncommitted in the worktree, the lead commits them after audit.' : '';
  const memory = input.projectMemoryPath ? `Shared project memory: read ${input.projectMemoryPath} before starting; it is read-only for you, the lead writes it.` : 'No shared project memory file is configured; rely on the dispatch package and the repository documents.';
  return `Coordinator role: ${input.role}. Coordinator group: ${input.groupId}. ${memory} Task state and handoff are kept in cli_session_task by the lead, not in memory files. ${completion}${commits}`;
}
