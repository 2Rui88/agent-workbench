import { access, constants } from 'node:fs/promises';
import { loadRuntimeConfig } from '../src/runtime-config.js';
import { readGitContext } from '../src/git-context.js';
import { McpTools } from '../src/integrations/mcp-client.js';
import { requireHealthyServices } from '../src/preflight.js';

// Real-mode project preflight: the Task MCP answers, every registered worktree has a Git identity, and the shared
// project memory file (when configured) is readable. No model turn, no Task write.
const path = process.argv[2];
if (!path) throw new Error('Usage: npm run project-preflight -- /path/to/runtime.json');
const config = await loadRuntimeConfig(path);
if (!config.taskMcpUrl) throw new Error('Configure taskMcpUrl before the project preflight.');
await requireHealthyServices([{ service: 'CLI Session Task MCP', check: async () => {
  const tools = new McpTools();
  try { await tools.connect(config.taskMcpUrl!); return true; } catch { return false; } finally { await tools.close().catch(() => {}); }
} }]);
const repositories = await Promise.all(config.repositories.map(async (repository) => ({ repositoryId: repository.repositoryId, ...await readGitContext(repository.worktreePath) })));
let projectMemory: { path: string; readable: true } | null = null;
if (config.projectMemory) { await access(config.projectMemory.path, constants.R_OK); projectMemory = { path: config.projectMemory.path, readable: true }; }
console.log(JSON.stringify({ status: 'verified', taskMcpUrl: config.taskMcpUrl, repositories, projectMemory, taskLeaseChecked: false, modelTurns: 0, projectWrites: 0 }, null, 2));
