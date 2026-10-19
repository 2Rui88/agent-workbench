const confirmedSource = (source) => source === 'codex_turn_context' || source === 'claude_transcript';
const clean = (value) => typeof value === 'string' && value.trim() ? value.trim() : '';
const timeValue = (value) => { if (typeof value === 'number' && Number.isFinite(value)) return value; if (typeof value === 'string') { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; } return null; };
export function shortId(value) { const v = clean(value); return v ? v.slice(0, 8) : '未知'; }
export function workLabel(value) { return clean(value) || '未知'; }
export function budgetLabel(budget = {}, limits = {}) { const used = Number.isFinite(budget.callsUsed) ? budget.callsUsed : null; const max = Number.isFinite(limits.maxCalls) ? limits.maxCalls : null; return used !== null && max !== null ? `${used} / ${max}` : '未知'; }
export function tailPath(value) { const v = clean(value).replace(/[\\/]+$/, ''); if (!v) return '未知'; return v.split(/[\\/]/).slice(-2).join('/'); }
// Snapshot times are UTC; every displayed time uses the operator's clock, Asia/Taipei (UTC+8).
const clockFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Taipei' });
export function formatTime(value) { const instant = new Date(value); return Number.isNaN(instant.getTime()) ? '时间未知' : clockFormat.format(instant); }
export function runtimeModelLabel(dispatch) {
  const hasTurn = typeof dispatch?.turnId === 'string' && dispatch.turnId.trim().length > 0;
  const actualModel = typeof dispatch?.actualModel === 'string' ? dispatch.actualModel.trim() : '';
  const confirmed = hasTurn && actualModel.length > 0 && confirmedSource(dispatch.actualModelSource);
  if (!hasTurn) return '未执行';
  if (!confirmed) return '未确认';
  const actualEffort = typeof dispatch.actualEffort === 'string' && dispatch.actualEffort.trim() ? dispatch.actualEffort.trim() : '未知';
  return `${actualModel} / 实际 ${actualEffort} · 运行时已确认`;
}
export function modelCell(dispatch = {}) {
  const requestedModel = clean(dispatch.requestedModel) || '未知'; const requestedEffort = clean(dispatch.requestedEffort) || '未知';
  const hasTurn = Boolean(clean(dispatch.turnId)); const actualModel = clean(dispatch.actualModel); const confirmed = hasTurn && actualModel && confirmedSource(dispatch.actualModelSource);
  if (!hasTurn) return { text: `请求 ${requestedModel} · ${requestedEffort} · 未执行`, tone: 'muted', title: '尚未分配 Turn' };
  if (!confirmed) return { text: `请求 ${requestedModel} · ${requestedEffort} · 实际未确认`, tone: 'muted', title: '运行时模型尚未确认' };
  const actualEffort = clean(dispatch.actualEffort);
  if (!actualEffort) return { text: `实际 ${actualModel} · 强度未知`, tone: 'warn', title: `证据来源：${dispatch.actualModelSource}` };
  if (actualModel === requestedModel && actualEffort === requestedEffort) return { text: `${actualModel} · ${actualEffort} ✓`, tone: 'good', title: `证据来源：${dispatch.actualModelSource}` };
  return { text: `请求 ${requestedModel} · ${requestedEffort} / 实际 ${actualModel} · ${actualEffort} · 不一致`, tone: 'warn', title: `证据来源：${dispatch.actualModelSource}` };
}
const statusNames = { completed: '已回执', starting: '执行中', active: '执行中', queued: '排队', needs_reconciliation: '待核对', failed: '执行失败', cancelled: '已撤销', stale: '已失效' };
export function statusBadge(state) { const key = clean(state); const tones = { completed: 'good', starting: 'accent', active: 'accent', queued: 'muted', needs_reconciliation: 'warn', failed: 'bad', cancelled: 'muted', stale: 'muted' }; return { text: statusNames[key] || key || '未知', tone: tones[key] || 'muted' }; }
export function auditBadge(state) { const key = clean(state); const names = { passed: '通过', rejected: '拒绝', error: '异常', running: '审计中' }; const tones = { passed: 'good', rejected: 'bad', error: 'warn', running: 'accent' }; return { text: names[key] || key || '未知', tone: tones[key] || 'muted' }; }
const TIME_FIELDS = ['queuedAt', 'startedAt', 'completedAt', 'durationMs'];
const formatDuration = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); if (s >= 3600) return `${Math.floor(s / 3600)}小时${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}分`; if (s >= 60) return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`; return `${s}秒`; };
export function durationLabel(dispatch = {}, capturedAt = Date.now()) {
  if (Number.isFinite(dispatch.durationMs)) return { text: formatDuration(dispatch.durationMs), title: '已记录耗时' };
  if (dispatch.state === 'queued') return { text: '—', title: '尚未开始' };
  if (['failed', 'cancelled', 'stale'].includes(dispatch.state)) return { text: '—', title: '未完成，无可靠耗时' };
  // Old snapshots predate the time fields entirely; a single present field means a new snapshot with honest nulls.
  if (TIME_FIELDS.every((key) => dispatch[key] === undefined)) return { text: '未知', title: '旧快照缺少耗时字段' };
  const startedAt = timeValue(dispatch.startedAt);
  if (['starting', 'active'].includes(dispatch.state)) return startedAt !== null ? { text: `进行中 ${Math.max(0, Math.floor(((timeValue(capturedAt) ?? Date.now()) - startedAt) / 60000))}分`, title: '按快照时间估算' } : { text: '—', title: '缺少开始时间' };
  if (dispatch.state === 'needs_reconciliation') return { text: '—', title: '待核对，无可靠耗时' };
  if (dispatch.state === 'completed') return { text: '—', title: startedAt !== null ? '对账完成，无可靠耗时' : '缺少开始时间' };
  return { text: '—', title: '无可靠耗时' };
}
export function sortDispatches(roles = []) { let globalIndex = 0; return roles.flatMap((role) => (Array.isArray(role?.dispatches) ? role.dispatches : []).map((dispatch) => ({ role, dispatch, index: globalIndex++ }))).sort((a, b) => { const aq = timeValue(a.dispatch.queuedAt); const bq = timeValue(b.dispatch.queuedAt); return (bq === null ? -Infinity : bq) - (aq === null ? -Infinity : aq) || a.index - b.index; }); }

function startDashboard() {
  const $ = (selector) => document.querySelector(selector);
  const text = (value, fallback = '未知') => typeof value === 'string' && value.trim() ? value : fallback;
  const count = (value) => Number.isFinite(value) ? String(value) : '未知';
  const names = { lead: '主会话', frontend: '前端', backend: '后端', audit: '测试审计', advisor: '顾问', queued: '排队', starting: '启动中', active: '执行中', needs_reconciliation: '待核对', completed: '已回执', cancelled: '已撤销', failed: '执行失败', stale: '已失效', passed: '通过', rejected: '返修', running: '审计中', error: '失败' };
  const label = (value) => names[value] ?? text(value);
  const node = (tag, value, className) => { const element = document.createElement(tag); element.textContent = value; if (className) element.className = className; return element; };
  const date = formatTime;
  let last = null; let busy = false;
  function render(snapshot) {
    $('#group-line').textContent = `${text(snapshot.groupId)} · ${label(snapshot.groupStatus)}`;
    $('#lead-mode').textContent = ({ external: '外部主会话', managed: '托管主会话' })[snapshot.lead.mode] ?? '主会话未知';
    $('#lead-session').textContent = `引用：${text(snapshot.lead.sessionRef)}`;
    $('#lead-expiry').textContent = snapshot.lead.expiresAt ? `有效期至 ${date(snapshot.lead.expiresAt)}` : '有效期未知';
    for (const key of ['dispatches', 'contracts', 'audits']) $(`#total-${key}`).textContent = count(snapshot.totals[key]);
    $('#budget-summary').textContent = budgetLabel(snapshot.budget || {}, snapshot.runtime?.limits || {});
    $('#budget-detail').textContent = snapshot.budget ? `${text(snapshot.budget.source)} · ${count(snapshot.budget.inFlight)} 进行中 · ${count(snapshot.budget.unknown)} 结果未知` : '调用上限未知';
    $('#budget-detail').title = snapshot.runtime ? `并行上限 ${count(snapshot.runtime.limits.maxConcurrent)} · 授权到期 ${snapshot.runtime.grantExpiresAt ? date(snapshot.runtime.grantExpiresAt) : '未知'}` : '调用上限未知';
    const rows = sortDispatches(snapshot.roles); const capturedAt = timeValue(snapshot.capturedAt) ?? Date.now();
    const queue = document.createDocumentFragment();
    for (const { role, dispatch } of rows) {
      const row = document.createElement('tr');
      const status = statusBadge(dispatch.state); const model = modelCell(dispatch); const duration = durationLabel(dispatch, capturedAt); const started = timeValue(dispatch.startedAt) !== null ? date(dispatch.startedAt) : '未开始';
      const work = node('span', `${workLabel(dispatch.workId)}${dispatch.replacesDispatchId ? ' · 替代上一次' : ''}`); work.title = dispatch.replacesDispatchId ? `被替代：${dispatch.replacesDispatchId}` : clean(dispatch.workId); const state = node('span', status.text, `badge ${status.tone}`); const modelNode = node('span', model.text, `badge ${model.tone}`); modelNode.title = model.title; const startedNode = node('span', started); startedNode.title = timeValue(dispatch.startedAt) !== null ? date(dispatch.startedAt) : '未开始'; const durationNode = node('span', duration.text); durationNode.title = duration.title; const turn = node('span', dispatch.turnId ? shortId(dispatch.turnId) : '未执行'); turn.title = clean(dispatch.turnId) || '未执行';
      row.append(node('td', label(role.roleId)), node('td', ''), node('td', ''), node('td', ''), node('td', ''), node('td', ''), node('td', '')); ['角色','工作项','状态','模型','开始','耗时','Turn'].forEach((label, index) => { row.children[index].dataset.label = `${label}：`; }); row.children[1].append(work); row.children[2].append(state); row.children[3].append(modelNode); row.children[4].append(startedNode); row.children[5].append(durationNode); row.children[6].append(turn);
      queue.append(row);
    }
    $('#queue-rows').replaceChildren(queue); $('#queue-empty').hidden = rows.length !== 0;
    const suffix = snapshot.truncated ? ' · 部分列表已截断' : '';
    $('#queue-count').textContent = `${rows.length} 条当前记录 / ${count(snapshot.totals.dispatches)} 条总数${suffix}`;
    $('#scope-summary').textContent = `任务状态与交接以 cli_session_task 为准 · 主会话 ${snapshot.lead?.mode === 'external' ? '外部接入' : text(snapshot.lead?.mode)}`;
    const roles = document.createDocumentFragment();
    for (const role of snapshot.roles) {
      const card = node('article', '', 'role'); const title = node('div', '', 'title');
      title.append(node('strong', label(role.roleId)), node('span', role.online ? '在线' : '离线', role.online ? 'online' : 'offline'));
      const details = document.createElement('details'); const summary = node('summary', '更多详情'); details.append(summary, node('p', `线程：${text(role.threadId)} · 工作树：${text(role.worktreePath)}`), node('p', `控制：${role.controlOwner === 'human' ? '人工' : '自动'} · 排队 ${count(role.queued)} · 失效审批 ${count(role.staleApprovals ?? 0)} · 代数 ${count(role.bindingGeneration)}`));
      const pending = Number(role.waitingHuman) > 0; card.append(title, node('p', `阻塞：${snapshot.runtime ? text(snapshot.runtime.blocks?.[role.roleId], '无已报告阻塞') : '未知'}`), node('p', `线程：${shortId(role.threadId)} · 工作树：${tailPath(role.worktreePath)}`), node('p', `待审批：${count(role.waitingHuman)}`, pending ? 'pending' : ''), details); roles.append(card);
    }
    $('#role-grid').replaceChildren(roles);
    for (const [key, selector] of [['contracts', '#contract-list'], ['audits', '#audit-list']]) {
      const items = document.createDocumentFragment();
      for (const item of snapshot[key]) {
        const entry = document.createElement('li');
        if (key === 'contracts') { const ref = text(item.artifactRef); entry.title = `${ref} · 基线 ${text(item.baselineRef)}`; entry.append(node('strong', `${ref.split('/').pop()} · ${text(item.revision)}`), node('span', `兼容性：${text(item.compatibility)}`)); }
        else { const badge = auditBadge(item.state); const heading = node('strong', text(item.validationId)); heading.append(document.createTextNode(' · ')); heading.append(node('span', badge.text, `badge ${badge.tone}`)); const contract = node('span', `契约 ${shortId(item.contractRef)} · 周期 ${count(item.cycle)}`); contract.title = `契约 ${text(item.contractRef)}`; const baseline = node('span', `基线 ${shortId(item.baselineRef)}`); baseline.title = `基线 ${text(item.baselineRef)}`; entry.append(heading, contract, baseline); }
        items.append(entry);
      }
      $(selector).replaceChildren(items); $(`#${key}-empty`).hidden = snapshot[key].length !== 0;
      $(`#${key}-count`).textContent = `${snapshot[key].length} 条当前记录 / ${count(snapshot.totals[key])} 条总数${suffix}`;
    }
    $('#captured-at').textContent = `快照时间：${date(snapshot.capturedAt)}`;
  }
  async function refresh() {
    if (busy) return; busy = true; $('#retry').disabled = true;
    try {
      const response = await fetch('/api/snapshot', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const snapshot = await response.json();
      if (snapshot?.schemaVersion !== 1 || !Array.isArray(snapshot.roles) || !Array.isArray(snapshot.contracts) || !Array.isArray(snapshot.audits) || !snapshot.totals || !snapshot.lead || snapshot.roles.some((role) => !Array.isArray(role.dispatches))) throw new Error('快照格式错误');
      render(snapshot); last = snapshot;
      $('#refresh-status').dataset.state = 'fresh'; $('#refresh-status').textContent = `数据已更新 · ${date(snapshot.capturedAt)} · 来源 ${text(snapshot.source)}`;
    } catch (error) {
      $('#refresh-status').dataset.state = last ? 'stale' : 'error';
      $('#refresh-status').textContent = last ? `刷新失败，保留 ${date(last.capturedAt)} 的过期快照。${error.message}` : `首次快照读取失败：${error.message}`;
    } finally { busy = false; $('#retry').disabled = false; }
  }
  $('#retry').addEventListener('click', refresh); void refresh(); window.setInterval(refresh, 2000);
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') startDashboard();
