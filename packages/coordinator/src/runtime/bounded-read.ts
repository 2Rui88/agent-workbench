import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

// Reads an owner-only regular file under root without following symlinks; undefined means "not evidence".
export async function readOwnedText(path: string, root: string, maxBytes = 32 * 1024 * 1024): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const base = await realpath(root);
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) return undefined;
    const location = relative(base, await realpath(path));
    if (location.startsWith('..') || isAbsolute(location)) return undefined;
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || metadata.dev !== entry.dev || metadata.ino !== entry.ino || metadata.size > maxBytes) return undefined;
    const chunks: Buffer[] = []; let length = 0;
    while (length <= maxBytes) {
      const bytes = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - length));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, length);
      if (bytesRead === 0) break;
      chunks.push(bytes.subarray(0, bytesRead)); length += bytesRead;
    }
    return length > maxBytes ? undefined : Buffer.concat(chunks, length).toString('utf8');
  } catch { return undefined; }
  finally { await handle?.close().catch(() => {}); }
}
