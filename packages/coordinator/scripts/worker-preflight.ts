import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {loadRuntimeConfig} from '../src/runtime-config.js';
import {bindingSchema} from '../src/bindings.js';
import {readGitContext} from '../src/git-context.js';
import {McpTools} from '../src/integrations/mcp-client.js';
import {RepositoryTaskClient} from '../src/integrations/cli-task.js';
import {checkWorkerReadiness} from '../src/integrations/worker-readiness.js';
const [path,manifestPath]=process.argv.slice(2);
if(!path||!manifestPath)throw Error('Usage: worker-preflight runtime.json worker-tasks.json');
const config=await loadRuntimeConfig(path);
if(!config.externalTaskObservation)throw Error('An external lead Task observation is required.');
const manifest=z.array(z.object({role:z.enum(['frontend','backend']),binding:bindingSchema,sessionId:z.string().min(1),expiresAt:z.string().datetime()}).strict()).length(2).parse(JSON.parse(await readFile(manifestPath,'utf8')));
if(new Set(manifest.map(w=>w.role)).size!==2||new Set(manifest.map(w=>w.binding.taskRef)).size!==2||new Set(manifest.map(w=>w.binding.worktreePath)).size!==2)throw Error('Workers need distinct roles, Tasks and worktrees.');
const lead=config.repositories.find(r=>r.repositoryId===manifest[0]!.binding.repositoryId);
if(!lead)throw Error('Worker repository is outside the configured project.');
const clients:McpTools[]=[];
try {
 const results=[];
 for(const worker of manifest) {
  const tools=new McpTools();clients.push(tools);await tools.connect(config.taskMcpUrl!);
  const git=await readGitContext(worker.binding.worktreePath);
  const client=new RepositoryTaskClient(tools,worker.binding.repositoryId,git,Date.now,undefined,{taskRef:worker.binding.taskRef,sessionId:worker.sessionId,expiresAt:worker.expiresAt});await client.bind();
  const result=await checkWorkerReadiness({role:worker.role,binding:worker.binding},{taskRef:config.externalTaskObservation.taskRef,worktreePath:lead.worktreePath},{git:readGitContext,task:binding=>client.getTask(binding.taskRef)});
  results.push(result);
 }
 console.log(JSON.stringify({status:'verified',workers:results,modelTurns:0,taskWrites:0}));
}finally{await Promise.all(clients.map(c=>c.close()));}
