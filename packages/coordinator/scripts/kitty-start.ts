import {mkdtemp,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {loadRuntimeConfig} from '../src/runtime-config.js';
import {assertNotInsideHerdr} from '../src/terminal/layout-lock.js';
assertNotInsideHerdr(process.env);
const [configPath,mode]=process.argv.slice(2);
// Lead sessions attach themselves from a plain claude (lead:attach); this entry only opens an observation Kitty.
if(!configPath||mode!=='--observe-only')throw new Error('Usage: kitty:start <runtime.json> --observe-only  (start the lead as a plain claude session; the skill attaches it)');
await loadRuntimeConfig(configPath);
const root=fileURLToPath(new URL('../..',import.meta.url));
await mkdir(join(root,'.state/kitty'),{recursive:true,mode:0o700});
const dir=await mkdtemp(join(root,'.state/kitty/run-'));
const child=spawn('kitty',['--detach','--config','NONE','--listen-on',`unix:${join(dir,'rc')}`,'-o','allow_remote_control=socket-only','-o','enabled_layouts=splits','--title','Coordinator','/bin/sh',join(root,'scripts/kitty-lead.sh'),resolve(configPath),'--observe-only'],{stdio:'inherit'});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{if(code)process.exitCode=code;});
