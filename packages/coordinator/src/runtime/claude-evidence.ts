import { lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { readOwnedText } from './bounded-read.js';
import type { TurnModelEvidence } from './model-evidence.js';

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface TranscriptRecord { type?: string; uuid?: string; sessionId?: string; effort?: unknown; message?: { model?: unknown; content?: unknown } }

export async function findClaudeTranscript(root: string, sessionId: string): Promise<string | undefined> {
  if (!SESSION.test(sessionId)) return undefined;
  let base: string;
  try { base = await realpath(root); } catch { return undefined; }
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  const matches: string[] = [];
  for (const entry of entries.slice(0, 10_000)) {
    if (!entry.isDirectory()) continue;
    const candidate = join(base, entry.name, `${sessionId}.jsonl`);
    if (await lstat(candidate).catch(() => undefined)) matches.push(candidate);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

// Claude Code writes "[Request interrupted by user…]" as a user record when a turn is interrupted; it is not a prompt.
const INTERRUPTION_MARKER = /^\[Request interrupted by user[^\]]*\]$/;
function isPrompt(record: TranscriptRecord): boolean {
  if (record.type !== 'user') return false;
  const content = record.message?.content;
  if (typeof content === 'string') return !INTERRUPTION_MARKER.test(content.trim());
  if (!Array.isArray(content) || content.some((block) => (block as { type?: unknown })?.type === 'tool_result')) return false;
  const texts = content.map((block) => (block as { type?: unknown; text?: unknown })?.type === 'text' ? String((block as { text?: unknown }).text ?? '').trim() : null);
  return !(texts.length > 0 && texts.every((text) => text !== null && INTERRUPTION_MARKER.test(text)));
}

// Parses every line of the session; a malformed line (other than a trailing partial write) invalidates the transcript.
async function readRecords(root: string, sessionId: string): Promise<TranscriptRecord[] | undefined> {
  const path = await findClaudeTranscript(root, sessionId);
  if (!path) return undefined;
  const raw = await readOwnedText(path, root);
  if (raw === undefined) return undefined;
  const lines = raw.split('\n'); const records: TranscriptRecord[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line) continue;
    let record: TranscriptRecord;
    try { record = JSON.parse(line) as TranscriptRecord; } catch { if (index === lines.length - 1) break; return undefined; }
    if (record.sessionId !== undefined && record.sessionId !== sessionId) return undefined;
    records.push(record);
  }
  return records;
}

export async function listPromptUuids(root: string, sessionId: string): Promise<string[] | undefined> {
  const records = await readRecords(root, sessionId);
  return records?.filter((record) => isPrompt(record) && typeof record.uuid === 'string').map((record) => record.uuid!);
}

export async function readClaudeTurnModel(root: string, sessionId: string, promptUuid: string): Promise<TurnModelEvidence | undefined> {
  const records = await readRecords(root, sessionId);
  if (!records) return undefined;
  let inTurn = false; const models = new Set<string>(); const efforts = new Set<unknown>();
  for (const record of records) {
    if (record.type === 'user' && record.uuid === promptUuid) { if (inTurn) return undefined; inTurn = true; continue; }
    if (!inTurn) continue;
    if (isPrompt(record)) break;
    if (record.type !== 'assistant') continue;
    const model = record.message?.model;
    if (model === '<synthetic>') continue;
    if (typeof model !== 'string' || !model || model.length > 256 || /[\r\n\x00-\x1f]/.test(model)) return undefined;
    models.add(model); efforts.add(record.effort);
  }
  if (!inTurn || models.size !== 1) return undefined;
  const [effort] = [...efforts];
  return { model: [...models][0]!, effort: efforts.size === 1 && typeof effort === 'string' && effort.length <= 32 ? effort : null, source: 'claude_transcript' };
}
