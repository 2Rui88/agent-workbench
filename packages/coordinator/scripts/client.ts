import { z } from 'zod';
import { roleEnum } from '../src/roles.js';
import { automationSchemas,type AutomationCommand } from '../src/engine.js';
import { coordinatorRequest } from '../src/ipc.js';
import { loadRuntimeConfig,readProtectedJson } from '../src/runtime-config.js';
import { CoordinatorError } from '../src/errors.js';
const [path,role,command,json='{}',mode]=process.argv.slice(2);
try {
  if(!path||!role||!command)throw new Error('Usage: client runtime.json lead|frontend|backend|audit|advisor schema|command [json] [--dry-run]');
  if(command==='schema')console.log(JSON.stringify({ok:true,commands:Object.fromEntries(Object.entries(automationSchemas).map(([name,schema])=>[name,z.toJSONSchema(schema,{io:'input'})]))}));
  else {
    const actorRole=roleEnum.parse(role); const schema=automationSchemas[command as AutomationCommand];
    if(!schema)throw new CoordinatorError('COMMAND_NOT_FOUND','Unknown coordinator command.','Use the schema command to inspect available commands.');
    const input=schema.parse(JSON.parse(json));
    if(mode==='--dry-run')console.log(JSON.stringify({ok:true,command,normalizedInput:input,sideEffects:false}));
    else {
      const config=await loadRuntimeConfig(path);
      const saved=process.env.COORDINATOR_CAPABILITY?undefined:z.object({groupId:z.literal(config.groupId),credentials:z.record(z.string(),z.string().min(32))}).parse(await readProtectedJson(config.credentialFile));
      const capability=process.env.COORDINATOR_CAPABILITY??saved?.credentials[actorRole];
      if(!capability)throw new CoordinatorError('FORBIDDEN','Role capability is unavailable.','Supply the controlled role credential.');
      const result=await coordinatorRequest(config.socketPath,{channel:'role',roleId:actorRole,generation:Number(process.env.COORDINATOR_BINDING_GENERATION??1),capability,command:command as AutomationCommand,input});
      console.log(JSON.stringify({ok:true,result}));
    }
  }
}catch(error){
  const known=error instanceof CoordinatorError;
  console.log(JSON.stringify({ok:false,error:{code:known?error.code:'INVALID_INPUT',message:known?error.message:'Invalid client arguments or configuration.',nextAction:known?error.nextAction:'Inspect command schema and project configuration.'}}));process.exitCode=1;
}
