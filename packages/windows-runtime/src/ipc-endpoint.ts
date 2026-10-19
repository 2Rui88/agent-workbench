export type IpcEndpoint =
  | { type: 'named-pipe'; name: string }
  | { type: 'tcp'; host: '127.0.0.1'; port: number };

const PIPE_PREFIX = '\\\\.\\pipe\\';

export function namedPipe(name: string): IpcEndpoint {
  const clean = name.trim().replace(/^\\\\\.\\pipe\\/i, '');
  if (!/^[a-zA-Z0-9._-]{1,200}$/.test(clean)) {
    throw new Error('Named pipe name must contain only letters, numbers, dot, underscore or hyphen.');
  }
  return { type: 'named-pipe', name: `${PIPE_PREFIX}${clean}` };
}

export function localhostTcp(port: number): IpcEndpoint {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid localhost TCP port.');
  return { type: 'tcp', host: '127.0.0.1', port };
}
