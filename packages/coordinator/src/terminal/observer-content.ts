import type { DatabaseSync } from 'node:sqlite';
import type { DashboardSnapshot } from '../dashboard/contracts.js';
import { OBSERVED_ROLES } from '../roles.js';
import { clip } from './frame-renderer.js';

export interface ObserverContent {
  workId: string;
  state: string;
  agent: string;
  goal: string;
  summary: string;
  evidence: string[];
  audit: { state: string; evidence: string[] } | null;
  events: Array<{ at: string; label: string }>;
}

const states: Record<string, string> = {
  queued: '排队中', starting: '启动中', active: '执行中', running: '执行中', started: '执行中', completed: '执行完成',
  failed: '执行失败', cancelled: '已撤销', needs_reconciliation: '等待核对',
  passed: '审计通过', rejected: '审计拒绝', error: '审计异常'
};
const events: Record<string, string> = {
  'turn/started': '开始执行', 'turn/completed': '本轮执行结束',
  'item/started': '开始操作', 'item/completed': '操作结束',
  'item/agentMessage/delta': '正在输出说明', 'item/commandExecution/outputDelta': '命令正在输出',
  'thread/started': '会话就绪', 'thread/status/changed': '会话状态更新',
  'error': '运行异常'
};

function clean(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [已隐藏]')
    .replace(/\b(token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[已隐藏]')
    .replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0,limit) + '…' : text;
}

function record(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length > 32768) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
  } catch { return {}; }
}
function evidence(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0,5).map(item => clean(typeof item === 'string' ? item : (item as { summary?: unknown } | null)?.summary,220)).filter(Boolean);
}

export function readObserverContent(db: DatabaseSync, groupId: string, roleId: string): ObserverContent {
  const has = (table: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  const row = has('scheduled_work') ? db.prepare('SELECT work_id,state,substr(work_json,1,32769) AS work_json,substr(evidence_json,1,32769) AS evidence_json FROM scheduled_work WHERE group_id=? AND role_id=? ORDER BY queued_at DESC,rowid DESC LIMIT 1').get(groupId,roleId) : undefined;
  const work = record(row?.work_json);
  const receipt = record(row?.evidence_json);
  const auditRow = roleId === 'audit' && has('validation_runs') ? db.prepare('SELECT substr(payload_json,1,32769) AS payload_json FROM validation_runs WHERE group_id=? ORDER BY rowid DESC LIMIT 1').get(groupId) : undefined;
  const audit = record(auditRow?.payload_json);
  const eventRows = has('terminal_events') ? db.prepare('SELECT at,method FROM terminal_events WHERE group_id=? AND role_id=? ORDER BY id DESC LIMIT 8').all(groupId,roleId) : [];
  return {
    workId: clean(row?.work_id,100), state: clean(row?.state,64), agent: clean(work.agent,32), goal: clean(work.goal,300),
    summary: clean(receipt.summary,600), evidence: evidence(receipt.evidence),
    audit: typeof audit.state === 'string' ? { state: clean(audit.state,64), evidence: evidence(audit.evidence) } : null,
    events: eventRows.map(item => ({ at: clean(item.at,30), label: events[String(item.method)] ?? '运行事件更新' }))
  };
}

function fitLine(value: string, columns: number): string {
  let width=0;
  let result='';
  for (const char of value) {
    const size=/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}\u3000-\u303f\uff01-\uff60]/u.test(char)?2:1;
    if(width+size>columns-2)return result+'…';
    result+=char;width+=size;
  }
  return result;
}

export function renderObserverContent(content: ObserverContent, viewport?: { columns: number; rows: number }): string {
  if(viewport) {
    const rows=Math.max(4,viewport.rows);
    const columns=Math.max(10,viewport.columns);
    const summary=content.summary || '暂无可读执行回执';
    const first=fitLine(summary,columns);
    const summaryLines=first.endsWith('…')?[first.slice(0,-1),fitLine(summary.slice(first.length-1),columns)]:[first];
    const lines=[`任务：${content.workId || '暂无派发'} · ${states[content.state] ?? '状态未知'}`,
      '执行摘要', ...summaryLines, '验证结果'];
    const auditReserve=content.audit?1:0;
    const count=Math.min(5,Math.max(1,rows-lines.length-auditReserve-2));
    lines.push(...(content.evidence.length?content.evidence.slice(0,count).map(item=>`• ${item}`):['暂无验证回执']));
    if(content.audit)lines.push(states[content.audit.state]??'审计状态未知');
    if(rows-lines.length>=2 && content.events.length)lines.push('最近操作');
    lines.push(...content.events.slice(0,Math.max(0,rows-lines.length)).map(item=>`${clock(item.at)} ${item.label}`));
    return lines.slice(0,rows).map(line=>fitLine(line,columns)).join('\n');
  }
  const lines = [
    `任务：${content.workId || '暂无派发'} · ${states[content.state] ?? '状态未知'}`,
    ...(content.goal ? [`目标：${content.goal}`] : []),
    '', '执行摘要', content.summary || '暂无可读执行回执（历史原生命令输出未保存）',
    '', '验证结果', ...(content.evidence.length ? content.evidence.map(item => `  • ${item}`) : ['  暂无验证回执'])
  ];
  if (content.audit) lines.push('',states[content.audit.state] ?? '审计状态未知', ...content.audit.evidence.map(item => `  • ${item}`));
  lines.push('', '最近操作（新 → 旧）', ...content.events.map(item => `  ${clock(item.at)}  ${item.label}`));
  if (!content.events.length) lines.push('  暂无操作记录');
  return lines.join('\n');
}

// Event times are stored in UTC; observers show the operator's clock (Asia/Taipei, UTC+8, per DESIGN.md).
const clockFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function clock(at: string): string { const instant = new Date(at); return Number.isNaN(instant.getTime()) ? at : clockFormat.format(instant); }

type SnapshotRole = DashboardSnapshot['roles'][number];
export const stateLabel = (state: string | undefined): string => (state ? states[state] ?? '状态未知' : '暂无派发');

// One fixed title row for a role pane: role, state and the verified model. The frame renderer clips it to the width.
export function observerHeader(role: SnapshotRole | undefined, content: ObserverContent): string {
  const dispatch = role?.dispatches[0];
  const flags = role?.waitingHuman ? ` · 待审批 ${role.waitingHuman}` : '';
  return `${role?.roleId ?? '?'} · ${stateLabel(dispatch?.state)}${flags} · ${content.agent || '代理未知'} · ${observerModelLabel(dispatch)}`;
}

// Overview pane: header, then two rows per role (state, agent and model; latest output). Everything fits the viewport.
export function renderOverview(snapshot: DashboardSnapshot, contents: Partial<Record<string, ObserverContent>>, viewport: { columns: number; rows: number }): string[] {
  const columns = Math.max(10, viewport.columns);
  const online = snapshot.roles.filter((r) => OBSERVED_ROLES.includes(r.roleId as never) && r.online).length;
  const waiting = snapshot.roles.reduce((sum, r) => sum + r.waitingHuman, 0);
  const lines = [`總覽 · ${snapshot.groupId} · 在线 ${online}/${OBSERVED_ROLES.length} · 待审批 ${waiting} · 派发 ${snapshot.totals.dispatches}`];
  const widest = Math.max(...OBSERVED_ROLES.map((r) => r.length));
  for (const roleId of OBSERVED_ROLES) {
    const role = snapshot.roles.find((r) => r.roleId === roleId);
    const content = contents[roleId];
    const dispatch = role?.dispatches[0];
    const pad = ' '.repeat(widest - roleId.length);
    lines.push(`${roleId}${pad}  ${stateLabel(dispatch?.state)}${role?.waitingHuman ? `(待审批 ${role.waitingHuman})` : ''} · ${content?.agent || '—'} · ${observerModelLabel(dispatch)}`);
    const latest = content?.summary || (content?.events[0] ? `${clock(content.events[0].at)} ${content.events[0].label}` : '暂无输出');
    lines.push(`${' '.repeat(widest + 2)}最新：${latest}`);
  }
  return lines.slice(0, Math.max(1, viewport.rows)).map((line) => clip(line, columns));
}

const VERIFIED_SOURCES = new Set(['codex_turn_context', 'claude_transcript']);
export function observerModelLabel(dispatch: { turnId?: unknown; actualModel?: unknown; actualEffort?: unknown; actualModelSource?: unknown } | undefined): string {
  if (!dispatch?.turnId || typeof dispatch.actualModel !== 'string' || !dispatch.actualModel || !VERIFIED_SOURCES.has(String(dispatch.actualModelSource))) return '未确认';
  return `${dispatch.actualModel} / ${typeof dispatch.actualEffort === 'string' && dispatch.actualEffort ? dispatch.actualEffort : '思考强度未知'}`;
}
