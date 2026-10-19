import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const modulePath = '../src/terminal/observer-content.js';
const observer = await import(modulePath).catch(() => ({})) as {
  readObserverContent?: (db: DatabaseSync, group: string, role: string) => any;
  renderObserverContent?: (content: any) => string;
};
function fixture(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE scheduled_work(group_id TEXT,role_id TEXT,work_id TEXT,state TEXT,work_json TEXT,evidence_json TEXT,queued_at INTEGER);
    CREATE TABLE validation_runs(group_id TEXT,payload_json TEXT);
    CREATE TABLE terminal_events(id INTEGER,group_id TEXT,role_id TEXT,at TEXT,method TEXT);`);
  return db;
}

test('observer displays real role receipt and only that group and role', () => {
  assert.equal(typeof observer.readObserverContent, 'function');
  const db = fixture();
  try {
    const insert = db.prepare('INSERT INTO scheduled_work VALUES(?,?,?,?,?,?,?)');
    insert.run('g','frontend','ui','completed',JSON.stringify({goal:'修复模型显示'}),JSON.stringify({summary:'显示实际模型已确认',evidence:['152项测试通过']}),1);
    insert.run('g','backend','secret','completed','{}',JSON.stringify({summary:'OTHER ROLE'}),9);
    insert.run('other','frontend','secret','completed','{}',JSON.stringify({summary:'OTHER GROUP'}),10);
    const content = observer.readObserverContent!(db,'g','frontend');
    const text = observer.renderObserverContent!(content);
    assert.match(text,/修复模型显示/);
    assert.match(text,/显示实际模型已确认/);
    assert.match(text,/152项测试通过/);
    assert.doesNotMatch(text,/OTHER ROLE|OTHER GROUP/);
    assert.match(text,/执行完成/);
  } finally { db.close(); }
});

test('small pane still shows summary and verification without scrolling them away', () => {
  assert.equal(typeof observer.readObserverContent, 'function');
  const db=fixture();
  try {
    db.prepare('INSERT INTO scheduled_work VALUES(?,?,?,?,?,?,?)').run('g','frontend','ui','completed','{}',JSON.stringify({summary:'已完成模型显示。'.repeat(100),evidence:['152 tests passed','Typecheck passed','Build passed']}),1);
    const render=observer.renderObserverContent as (content:any,options:{columns:number;rows:number})=>string;
    const text=render(observer.readObserverContent!(db,'g','frontend'),{columns:45,rows:9});
    assert.ok(text.split('\n').length<=9);
    assert.match(text,/已完成模型显示/);
    assert.match(text,/152 tests passed/);
  }finally{db.close();}
});

test('observer bounds receipt, audit evidence and events and strips terminal controls', () => {
  assert.equal(typeof observer.readObserverContent, 'function');
  const db = fixture();
  try {
    db.prepare('INSERT INTO scheduled_work VALUES(?,?,?,?,?,?,?)').run('g','audit','review','completed','{}',JSON.stringify({summary:'safe\x1b[2J\x1b]52;c;BAD\x07\u202eevil'+ 'x'.repeat(2000),evidence:Array.from({length:12},(_,i)=>`evidence${i}`)}),1);
    db.prepare('INSERT INTO validation_runs VALUES(?,?)').run('g',JSON.stringify({state:'passed',evidence:[{summary:'路径隔离验证通过'},{summary:'FIFO验证通过'}]}));
    for(let i=0;i<12;i++)db.prepare('INSERT INTO terminal_events VALUES(?,?,?,?,?)').run(i,'g','audit',String(i),'item/completed');
    const c = observer.readObserverContent!(db,'g','audit');
    assert.equal(c.evidence.length,5);
    assert.equal(c.events.length,8);
    assert.equal(c.events[0].at,'11');
    assert.ok(c.summary.length<=601);
    const text = observer.renderObserverContent!(c);
    assert.doesNotMatch(text.replace(/\n/g,''),/[\x00-\x1f\x7f-\x9f\u202e]/);
    assert.doesNotMatch(text,/BAD/);
    assert.match(text,/审计通过/);
    assert.match(text,/FIFO验证通过/);
  } finally { db.close(); }
});

test('observer marks malformed or missing records without inventing success', () => {
  assert.equal(typeof observer.readObserverContent, 'function');
  const db=fixture();
  try {
    db.prepare('INSERT INTO scheduled_work VALUES(?,?,?,?,?,?,?)').run('g','backend','repair','running','{','{',1);
    const text=observer.renderObserverContent!(observer.readObserverContent!(db,'g','backend'));
    assert.match(text,/暂无可读执行回执/);
    assert.match(text,/执行中/);
    assert.doesNotMatch(text,/执行完成|审计通过/);
    db.exec('DROP TABLE terminal_events; DROP TABLE validation_runs');
    assert.doesNotThrow(()=>observer.readObserverContent!(db,'g','frontend'));
  }finally{db.close();}
});

test('observer labels running dispatch states and shows event times in Asia/Taipei', () => {
  const db = fixture();
  try {
    db.prepare('INSERT INTO scheduled_work VALUES(?,?,?,?,?,?,?)').run('g','backend','repair','active','{}',null,1);
    db.prepare('INSERT INTO terminal_events VALUES(?,?,?,?,?)').run(1,'g','backend','2026-10-09T01:48:43.000Z','turn/completed');
    const text = observer.renderObserverContent!(observer.readObserverContent!(db,'g','backend'));
    assert.match(text,/repair · 执行中/);
    assert.match(text,/09:48:43/);
    assert.doesNotMatch(text,/01:48:43/);
    db.prepare("UPDATE scheduled_work SET state='starting'").run();
    assert.match(observer.renderObserverContent!(observer.readObserverContent!(db,'g','backend')),/启动中/);
  } finally { db.close(); }
});

test('observer model label accepts verified evidence from both agents', async () => {
  const { observerModelLabel } = await import(modulePath) as { observerModelLabel: (d: unknown) => string };
  assert.equal(observerModelLabel({ turnId: 't', actualModel: 'gpt-6-luna', actualEffort: 'medium', actualModelSource: 'codex_turn_context' }), 'gpt-6-luna / medium');
  assert.equal(observerModelLabel({ turnId: 't', actualModel: 'claude-sonnet-5-5', actualEffort: 'high', actualModelSource: 'claude_transcript' }), 'claude-sonnet-5-5 / high');
  assert.equal(observerModelLabel({ turnId: 't', actualModel: 'claude-sonnet-5-5', actualEffort: null, actualModelSource: 'claude_transcript' }), 'claude-sonnet-5-5 / 思考强度未知');
  assert.equal(observerModelLabel({ turnId: 't', actualModel: 'x', actualModelSource: 'requested' }), '未确认');
  assert.equal(observerModelLabel(undefined), '未确认');
});

test('role header and overview show state, executing agent and verified model for every observed role', async () => {
  const { observerHeader, renderOverview } = await import(modulePath) as { observerHeader: (role: any, content: any) => string; renderOverview: (snapshot: any, contents: any, viewport: { columns: number; rows: number }) => string[] };
  const db = fixture();
  try {
    db.prepare('INSERT INTO scheduled_work VALUES(?,?,?,?,?,?,?)').run('g','frontend','ui','active',JSON.stringify({agent:'codex',goal:'g'}),JSON.stringify({summary:'正在改导航'}),1);
    db.prepare('INSERT INTO terminal_events VALUES(?,?,?,?,?)').run(1,'g','backend','2026-10-09T01:48:43.000Z','turn/started');
    const content = observer.readObserverContent!(db,'g','frontend');
    assert.equal(content.agent, 'codex');
    const dispatch = { dispatchId: 'd', workId: 'ui', state: 'active', requestedModel: 'm', requestedEffort: 'medium', actualModel: 'gpt-6-luna', actualEffort: 'medium', actualModelSource: 'codex_turn_context', turnId: 't' };
    const role = (roleId: string, dispatches: unknown[] = [], waitingHuman = 0) => ({ roleId, threadId: null, worktreePath: null, bindingGeneration: 1, queued: 0, online: roleId === 'frontend', controlOwner: 'automatic', waitingHuman, dispatches });
    const header = observerHeader(role('frontend', [dispatch], 1), content);
    assert.equal(header, 'frontend · 执行中 · 待审批 1 · codex · gpt-6-luna / medium');
    assert.equal(observerHeader(role('audit'), observer.readObserverContent!(db,'g','audit')), 'audit · 暂无派发 · 代理未知 · 未确认');
    const snapshot = { groupId: 'g', roles: [role('lead'), role('frontend', [dispatch]), role('backend'), role('audit'), role('advisor')], totals: { dispatches: 1, contracts: 0, audits: 0 } };
    const contents = Object.fromEntries(['frontend','backend','audit','advisor'].map((r) => [r, observer.readObserverContent!(db,'g',r)]));
    const lines = renderOverview(snapshot, contents, { columns: 80, rows: 20 });
    assert.equal(lines[0], '總覽 · g · 在线 1/4 · 待审批 0 · 派发 1');
    assert.equal(lines[1], 'frontend  执行中 · codex · gpt-6-luna / medium');
    assert.equal(lines[2], '          最新：正在改导航');
    assert.equal(lines[3], 'backend   暂无派发 · — · 未确认');
    assert.match(lines[4]!, /最新：09:48:43 开始执行/);
    assert.equal(lines.length, 9);
    assert.equal(renderOverview(snapshot, contents, { columns: 20, rows: 4 }).length, 4, 'never taller than the pane');
    assert.ok(renderOverview(snapshot, contents, { columns: 20, rows: 4 }).every((line) => line.length <= 20));
  } finally { db.close(); }
});
