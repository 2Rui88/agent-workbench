import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { roleEnum } from '../src/roles.js';
import { coordinatorRequest } from '../src/ipc.js';
import { loadRuntimeConfig, readProtectedJson } from '../src/runtime-config.js';

const configPath = process.argv[2]; const command = process.argv[3] ?? 'approvals';
if (!configPath) throw new Error('Usage: npm run human-control -- runtime.json init|approvals|respond|takeover|release|lead-rotate [request-id|role]');
const config = await loadRuntimeConfig(configPath);
if (command === 'init') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Human credential initialization requires an interactive user terminal.');
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try { if ((await prompt.question('Create the separate human control credential? Type yes: ')).trim() !== 'yes') process.exit(1); }
  finally { prompt.close(); }
  await mkdir(dirname(config.humanCredentialFile), { recursive: true, mode: 0o700 });
  await writeFile(config.humanCredentialFile, JSON.stringify({ capability: randomBytes(32).toString('base64url') }), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ status: 'created', credentialPath: config.humanCredentialFile }));
} else {
  const human = z.object({ capability: z.string().min(32) }).strict().parse(await readProtectedJson(config.humanCredentialFile));
  const send = (action: 'approvals' | 'respond' | 'takeover' | 'release' | 'lead-rotate', input: unknown) => coordinatorRequest(config.socketPath, { channel: 'human', capability: human.capability, command: action, input });
  if (command === 'approvals') console.log(JSON.stringify(await send('approvals', {}), null, 2));
  else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Human decisions require an interactive user terminal.');
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try {
      if (command === 'respond') {
        const id = process.argv[4]; if (!id) throw new Error('Provide the exact approval request ID.');
        const requests = await send('approvals', {}) as Array<{ id: string }>;
        const item = requests.find((request) => request.id === id); if (!item) throw new Error('Approval not found.');
        process.stderr.write(`${JSON.stringify(item, null, 2)}\n`);
        const decision = z.enum(['accept', 'decline', 'cancel']).parse((await prompt.question('Decision (accept/decline/cancel): ')).trim());
        console.log(JSON.stringify(await send('respond', { approvalId: id, decision })));
      } else if (command === 'takeover' || command === 'release') {
        const roleId = roleEnum.parse(process.argv[4]);
        const evidence = (await prompt.question('Record current thread state and reason for handover: ')).trim();
        console.log(JSON.stringify(await send(command, { roleId, evidence })));
      } else if (command === 'lead-rotate') {
        if ((await prompt.question('Rotate the lead binding? The previous lead connection will stop working. Type yes: ')).trim() !== 'yes') process.exit(1);
        console.log(JSON.stringify(await send('lead-rotate', {})));
      } else throw new Error('Unknown human control command.');
    } finally { prompt.close(); }
  }
}
