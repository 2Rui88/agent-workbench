import { resolve } from 'node:path';
import { startLocalAppServer } from '../src/runtime/app-server.js';
import { workerToolPolicy, toolPolicyOverrides } from '../src/runtime/tool-policy.js';

const expected = {coordinator_policy_probe:workerToolPolicy('audit')};
const args = ['-c','features.plugins=false','-c','features.apps=false'];
for (const [id,tools] of Object.entries(expected)) {
  args.push('-c',`mcp_servers.${id}={command="/usr/bin/false",enabled=false}`);
  for (const override of toolPolicyOverrides(id,tools)) args.push('-c',override);
}
args.push('app-server','--listen','stdio://');
const appServer = startLocalAppServer(resolve(process.argv[2] ?? process.cwd()),{args,env:process.env,threadPolicy:{sandbox:'read-only',approvalPolicy:'on-request',approvalsReviewer:'user'}});
try {
  await appServer.runtime.initialize();
  const models = await appServer.runtime.listModels();
  if (models.length === 0) throw new Error('App Server model/list returned no models.');
  const result = await appServer.runtime.request('config/read',{includeLayers:false,cwd:resolve(process.argv[2] ?? process.cwd())}) as {config?:{mcp_servers?:Record<string,{enabled?:boolean;default_tools_approval_mode?:string;enabled_tools?:string[];tools?:Record<string,{approval_mode?:string}>}>}};
  const verified = [];
  for (const [id,tools] of Object.entries(expected)) {
    const server = result.config?.mcp_servers?.[id];
    if (server?.enabled !== false || server.default_tools_approval_mode !== 'prompt' || JSON.stringify(server.enabled_tools) !== JSON.stringify(tools) || tools.some(name=>server.tools?.[name]?.approval_mode !== 'approve')) throw new Error(`Scoped tool policy not effective for ${id}`);
    verified.push({server:id,defaultApproval:'prompt',enabledTools:tools,approvedTools:tools});
  }
  console.log(JSON.stringify({appServer:'connected',modelCount:models.length,policy:verified,modelTurns:0,configWrites:0,evidence:'effective config parsing only; disabled probe servers do not prove tool invocation or audit completion'},null,2));
} finally {await appServer.close();}

if (process.argv.includes('--claude')) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const { claudeRoleLaunch } = await import('../src/runtime/claude-launch.js');
  const options = claudeRoleLaunch({ role: 'advisor', groupId: 'preflight', generation: 1, capability: 'preflight', databasePath: '/dev/null', socketPath: '/dev/null', allowedRoots: [], mcpScriptPath: '/dev/null', inheritedServerIds: [], cwd: resolve(process.argv[2] ?? process.cwd()), readOnly: true, extraReadDirs: [], instructions: 'preflight' }, process.env) as Record<string, unknown>;
  // Identity and catalog only: no MCP servers and no prompt are sent.
  const controller = new AbortController();
  const idle = (async function* () { await new Promise((done) => controller.signal.addEventListener('abort', done, { once: true })); })();
  const handle = query({ prompt: idle as AsyncIterable<never>, options: { ...options, mcpServers: {}, abortController: controller } as never });
  try {
    const account = await handle.accountInfo() as { subscriptionType?: string; tokenSource?: string; apiProvider?: string; email?: string };
    const models = await handle.supportedModels();
    if (!account?.subscriptionType && !account?.email) throw new Error('Claude Agent SDK is not using a logged-in Claude account; run claude /login in a user terminal.');
    if (models.length === 0) throw new Error('Claude supportedModels() returned no models.');
    console.log(JSON.stringify({ claude: 'connected', account: { subscriptionType: account.subscriptionType ?? null, apiProvider: account.apiProvider ?? null }, models: models.map((model) => ({ value: model.value, resolvedModel: model.resolvedModel ?? null, efforts: model.supportedEffortLevels ?? [] })), policy: { settingSources: options.settingSources, strictMcpConfig: options.strictMcpConfig, env: Object.keys(options.env as object).sort(), allowedTools: options.allowedTools, disallowedTools: options.disallowedTools }, modelTurns: 0 }, null, 2));
  } finally { controller.abort(); }
}
