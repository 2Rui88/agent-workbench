# 多 agent 运行时与 advisor 实施计划（计划 B）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 coordinator 的每个托管角色都能选择 Codex 或 Claude 来执行，新增 advisor（咨询加仲裁），按 agent 记录执行证据，并修正 lead 启动脚本和终端窗格的行为；最后用新工作流本身完成一项真实的 Dashboard 改动作为验证。

**Architecture:** 保留现有的 `Runtime` 接口，新增基于 Claude Agent SDK 的 `ClaudeAgentRuntime`，daemon 按角色配置创建对应的运行时。advisor 复用现有的派发、租约、额度和核对链路，额外加一张建议表。lead 的启动、心跳和 MCP 注入统一放进一个 TS 启动器，sh 脚本只负责布局控制器和清理。

**Tech Stack:** Node.js ≥ 24、TypeScript 6、zod 4、`node:sqlite`、`node:test`（通过 tsx 运行）、`@anthropic-ai/claude-agent-sdk@0.3.293`、Codex App Server、Herdr 0.9.3、Kitty 0.48.2。

**Spec:** `docs/superpowers/specs/2026-10-08-multi-agent-runtime-design.md`
**前置计划:** `docs/superpowers/plans/2026-10-08-powercontext-ops.md`（计划 A）必须先完成，再开始本计划的 Task 18。Task 0–17 不依赖计划 A。

## Global Constraints

- 角色：`lead`、`frontend`、`backend`、`audit`、`advisor`；agent：`codex`、`claude`；不写时默认 `codex`。
- 兼容：`mode: "app_server"` 继续可用，`"real"` 是它的别名，内部统一为 `app_server`；不写 `roles`、`leadAgent` 时行为与现在完全一致。
- 现有测试只允许修改以下几项，其余必须原样通过：`tests/herdr.test.ts` 中 "Herdr refuses foreign topology…" 和 "compact must not close an observer pane taken over by the user"；`tests/kitty.test.ts` 中 "Kitty foreign panes and replaced observers freeze…"；涉及启动脚本用法字符串的测试。这些是用户已经确认的行为变更（spec 7.3）。
- 运行时环境变量白名单：`HOME`、`PATH`、`TMPDIR`、`LANG`、`LC_ALL`（Codex 额外允许 `CODEX_HOME`），加上 `COORDINATOR_*` 角色变量和本角色的授权变量；不能传递 `HERDR_*`、`KITTY_*`、`CLAUDE_CODE_*`。
- Claude 托管角色：`settingSources: []`、`strictMcpConfig: true`、显式传入 `env`、开启 `sandbox`；只读角色（audit、advisor，以及外部观察模式下没有登记写入 Task 的角色）禁用 `Edit`、`Write`、`NotebookEdit`。
- PowerContext 只用于记忆。lead 禁用 Handoff 的 7 个工具：`handoff_current_work`、`commit_handoff`、`continue_handoff`、`acknowledge_handoff`、`activate_handoff`、`finalize_handoff`、`get_handoff_report`。
- 本项目的 PowerContext Scope：`scp_2759kw81x6233xpacens49sfrc`（标题与外部引用都是 `codex-session-coordinator`）；CLI Task 的 `repositoryId`：`codex-session-coordinator`。
- advisor 仲裁提示阈值默认 2：同一个 `contractRef` 连续 `rejected` 的审计轮数。
- 缩进 2 空格，函数名 camelCase，文件名 kebab-case；新代码沿用所在文件的紧凑风格。
- 不推送到远程。每个 Task 完成后在本地提交，提交信息末尾带 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- 每个 Task 结束时，`npm run typecheck` 和 `npm test` 都必须通过。

## Review Focus

- **daemon 是在 Claude Code 会话里、或在 Herdr 窗格里启动的。** Claude worker 子进程不能继承 `CLAUDE_CODE_MESSAGING_SOCKET`/`TOKEN` 或 `HERDR_PANE_ID`，否则会连到父会话，或者把状态报告到错误的窗格。→ Task 7 断言 `claudeRoleLaunch` 返回的 `env` 只包含白名单键。
- **Claude 流在没有 `result` 消息时就结束了**（SDK 子进程崩溃、被 kill，或网络断开）。这一轮必须标为 `unknown`，不能是 `completed`，也不能停在 `inProgress` 永远卡住。→ Task 6 增加"流提前结束"和"迭代抛错"两个测试。
- **daemon 重启后，上一个实例遗留的 `inProgress` 轮次。** 恢复会话后，这些轮次必须改为 `unknown`，lead 才能用 `automation_reconcile` 处理，而不是永远提示"已有在途执行"。→ Task 5、Task 6 测试 `resumeThread` 会把遗留轮次标记为 orphan。
- **用户手动关掉窗格后，同一次执行的状态还在不断刷新。** 窗格不能反复重新打开；只有新的派发或新的审批才能重新打开。→ Task 15 测试 completed、active 等状态变化不会重新打开窗格，新的 dispatchId 才会。
- **旧 lead 在接替之后仍然连着 MCP。** 旧 generation 的派发、心跳都必须被拒绝。→ Task 12 测试 rotate 之后旧 actor 调用 `automation_dispatch` 会收到 `FORBIDDEN`/`STALE`。

---

### Task 0: SDK 与协议预检（一次性验证，代码不进仓库）

**目的:** 确认几项设计依赖、但只靠类型定义无法证明的行为，并把结论写进 `docs/verification.md`。需要发起**一次很小的 Claude 调用**（haiku 模型、low 强度、只回复 "OK"），执行前需要用户批准。

**Files:**
- Create（scratchpad，不入库）: `<scratchpad>/sdk-spike/spike.mjs`
- Modify: `docs/verification.md`（追加"2026-10-08 Claude SDK 预检"一节）
- Modify: `docs/superpowers/specs/2026-10-08-multi-agent-runtime-design.md`（按"spec 调整"一节修订）

- [ ] **Step 1: 在 scratchpad 安装 SDK**

```bash
S=/private/tmp/claude-501/-Users-macmini-playground-temp/9add2afe-2be2-4a90-85b0-4ae97aa98307/scratchpad/sdk-spike
mkdir -p "$S" && cd "$S" && npm init -y >/dev/null && npm i -s @anthropic-ai/claude-agent-sdk@0.3.293
```

- [ ] **Step 2: 静态检查 SDK 对 `env` 的处理（不调用模型）**

```bash
cd "$S/node_modules/@anthropic-ai/claude-agent-sdk" && grep -n "process.env" sdk.mjs | head -20
```

记录：传入 `options.env` 时，子进程拿到的是 `options.env` 本身，还是和 `process.env` 合并后的结果。**如果是合并**，Task 7 的白名单就不够用：`ClaudeAgentRuntime` 必须给不在白名单里的键显式传 `undefined`，或者改走 `pathToClaudeCodeExecutable` 加一个包装脚本，用 `env -i` 清空环境。把采用的方案写进 verification.md。

- [ ] **Step 3: 写预检脚本**

```js
// spike.mjs
import { query } from '@anthropic-ai/claude-agent-sdk';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const env = Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const base = { settingSources: [], strictMcpConfig: true, env, cwd: process.cwd(), permissionMode: 'default', allowedTools: [], disallowedTools: ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch'] };
// 1) 不发送 prompt，直接读取模型目录
const ac = new AbortController();
const idle = (async function* () { await new Promise(r => ac.signal.addEventListener('abort', r, { once: true })); })();
const control = query({ prompt: idle, options: { ...base, abortController: ac } });
const models = await control.supportedModels();
ac.abort();
console.log('models', JSON.stringify(models.map(m => ({ value: m.value, resolvedModel: m.resolvedModel, supportsEffort: m.supportsEffort, levels: m.supportedEffortLevels }))));
// 2) 一次很小的调用
const sessionId = crypto.randomUUID();
const seen = {};
for await (const m of query({ prompt: 'Reply with exactly: OK', options: { ...base, sessionId, model: 'claude-haiku-5-5', effort: 'low', maxTurns: 1 } })) {
  if (m.type === 'system' && m.subtype === 'init') Object.assign(seen, { initModel: m.model, apiKeySource: m.apiKeySource, sessionId: m.session_id });
  if (m.type === 'result') Object.assign(seen, { subtype: m.subtype, isError: m.is_error, userMessageUuid: m.user_message_uuid, cost: m.total_cost_usd, modelUsage: m.modelUsage });
}
console.log('turn', JSON.stringify(seen));
// 3) 会话记录的位置和字段
const root = join(homedir(), '.claude', 'projects');
const hit = readdirSync(root).map(d => join(root, d, `${sessionId}.jsonl`)).filter(existsSync);
console.log('transcripts', hit);
const lines = readFileSync(hit[0], 'utf8').trim().split('\n').map(l => JSON.parse(l));
console.log('lines', JSON.stringify(lines.map(l => ({ type: l.type, uuid: l.uuid, sessionId: l.sessionId, model: l.message?.model, contentKind: typeof l.message?.content }))));
```

- [ ] **Step 4: 停下，请用户批准这一次小调用，然后运行**

运行：`cd "$S" && node spike.mjs`

逐项记录：
1. 模型目录不发送 prompt 能否返回，以及各模型的 `value`、`resolvedModel`、`supportedEffortLevels`。
2. `apiKeySource`：是否为本机登录态，例如 `oauth` 或 `/login managed key`，而不是 `ANTHROPIC_API_KEY`。
3. `result.user_message_uuid` 是否等于会话记录中 `type: 'user'` 那一行的 `uuid`。
4. assistant 行是否带 `message.model`，以及是否存在 `<synthetic>` 行。
5. `modelUsage` 的键名，是否为 `inputTokens`、`outputTokens`、`cacheReadInputTokens`、`cacheCreationInputTokens`、`costUSD`。
6. 会话记录中是否出现 effort 字段。

**判定规则：**
- 第 1 项失败：Task 6 的 `listModels` 改为在第一次 `startTurn` 时从 init 消息读取，并且在派发前不再做 Claude 模型校验。这会降低一项门控，需要回到用户确认。
- 第 2 项是 `ANTHROPIC_API_KEY` 或 `none`：停下，向用户报告，不继续 Claude 相关的 Task。
- 第 3 项不相等：Task 4 改为按"`result` 消息之前、最后一条 `type: 'user'` 且内容是字符串的行"来定位本轮。
- 第 6 项一般不会出现：思考强度在证据里记为 `null`，按 spec 显示"未知"。

- [ ] **Step 5: 确认 Codex App Server 的用量通知格式（不调用模型）**

```bash
D=$(mktemp -d) && codex app-server generate-json-schema --out "$D" && grep -rl -i "tokenUsage" "$D" | head && grep -rh -o '"thread/tokenUsage[^"]*"' "$D" | sort -u
```

记录通知方法名，以及 `last` 或增量对象中 input、cached input、output 三个字段的确切名称。Task 8 中 `codexUsageFromNotification` 的字段映射以这里的记录为准。

- [ ] **Step 6: 把结论写进 `docs/verification.md`，并修订 spec**

在 `docs/verification.md` 末尾追加"2026-10-08 Claude SDK 预检"一节，写入上面每一项的实际结果，不包含 token。

按下面的"spec 调整"修订 spec：

- 6.1 增加："本项目的 Scope 落点是 `scp_2759kw81x6233xpacens49sfrc`；协调其他业务项目时，使用该项目自己的 Scope。"
- 5.3 把"同一条派发链路连续被拒绝"改为"同一个 `contractRef` 连续 `rejected` 的审计轮数"。
- 5.4 advisor 的工具增加 `automation_advice_get` 和 `automation_operation_get`，两者都是只读。
- 7.1 把"写入现有的 `UsageLedger`"改为"写入新增的按轮次记录的 `TurnUsageLedger`；`UsageLedger` 保留给单机 MCP 模式使用"。
- 4.5 写明换 lead 时 generation 加一的方式：由人工通过 `human-control lead-rotate` 执行。
- 9.2 写明允许修改的既有测试清单（见 Global Constraints）。

- [ ] **Step 7: 提交**

```bash
git add docs/verification.md docs/superpowers/specs/2026-10-08-multi-agent-runtime-design.md
git commit -q -m "docs: record Claude SDK preflight and refine design

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: 统一角色定义，接入 advisor 角色

**Files:**
- Create: `src/roles.ts`
- Create: `scripts/group-add-role.ts`
- Create: `tests/roles.test.ts`
- Modify: `src/protocol.ts:4`（`RoleId` 改为从 roles 重新导出）
- Modify（把手写的 4 角色 `z.enum`/数组替换为 `roleEnum`/`ROLE_IDS`）: `src/engine.ts:26`、`src/collaboration.ts:10`、`src/auth.ts:9`、`src/ipc.ts:13`、`src/runtime-config.ts:11`、`src/scheduler.ts:43`、`src/store.ts:72,83,112`、`src/dashboard/projection.ts:7,9,40`、`src/dashboard/contracts.ts`（角色枚举）、`scripts/mcp-server.ts:30`、`scripts/client.ts:11`、`scripts/human-control.ts:36`、`scripts/herdr-watch.ts:8`
- Modify: `src/integrations/powercontext.ts:10-15`（advisor 设为可选）
- Modify: `scripts/group-init.ts:15`（新建群组时生成 5 个凭据）
- Modify: `scripts/daemon.ts`（凭据 schema 中 advisor 可选；只认证存在的角色）
- Modify: `web/dashboard.js:15`（`names` 增加 `advisor: '顾问'`）
- Modify: `package.json`（scripts 增加 `"group-add-role": "tsx scripts/group-add-role.ts"`）
- Modify: `src/errors.ts`（`CoordinatorErrorCode` 增加 `'CONFLICT' | 'LEAD_CONFLICT' | 'PROVIDER_UNAVAILABLE'`，后面的 Task 6、10、12 会用到）

**Interfaces:**
- Produces:
  - `ROLE_IDS: readonly ['lead','frontend','backend','audit','advisor']`
  - `CORE_ROLE_IDS: readonly ['lead','frontend','backend','audit']`
  - `OBSERVED_ROLES: readonly ['frontend','backend','audit','advisor']`
  - `type RoleId`、`type CoreRoleId`、`type ObservedRole`、`roleEnum`、`AGENT_KINDS`、`type AgentKind`、`agentEnum`
  - `store.initializeGroup(groupId: string, capabilities: Record<CoreRoleId,string> & Partial<Record<'advisor',string>>): void`
  - `store.addRoleCapability(groupId: string, roleId: 'advisor', token: string): void`（已存在时抛 `CONFLICT`）

- [ ] **Step 1: 写失败测试**

```ts
// tests/roles.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROLE_IDS, CORE_ROLE_IDS, OBSERVED_ROLES, roleEnum, agentEnum } from '../src/roles.js';
import { CoordinatorStore } from '../src/store.js';
import { verifyRoleEnrollment } from '../src/integrations/powercontext.js';

const core = { lead: 'lead-capability-0123456789abcdef012345', frontend: 'frontend-capability-0123456789abcdef', backend: 'backend-capability-0123456789abcdef0', audit: 'audit-capability-0123456789abcdef012' };
const enrollment = (role: string, id: string) => ({ role, projectKey: 'p', scopeId: 's', principal: { type: 'service' as const, id }, authorizationEnv: `PC_${role.toUpperCase()}`, bindingKey: { integration: 'codex-session-coordinator', kind: 'role-session', external_id: `g/${role}/1` }, actions: ['scope.read'] });

test('role registry lists advisor as a daemon-managed observed role', () => {
  assert.deepEqual([...ROLE_IDS], ['lead', 'frontend', 'backend', 'audit', 'advisor']);
  assert.deepEqual([...CORE_ROLE_IDS], ['lead', 'frontend', 'backend', 'audit']);
  assert.deepEqual([...OBSERVED_ROLES], ['frontend', 'backend', 'audit', 'advisor']);
  assert.equal(roleEnum.parse('advisor'), 'advisor');
  assert.throws(() => agentEnum.parse('gpt'));
});

test('existing four-role groups stay valid and advisor can be added exactly once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'roles-'));
  const store = new CoordinatorStore(join(dir, 'db.sqlite'));
  try {
    store.initializeGroup('g', core);
    assert.equal(store.groupSnapshot('g')!.roles.length, 5);
    assert.throws(() => store.assertAuthorized({ groupId: 'g', roleId: 'advisor', bindingGeneration: 1, capabilityId: 'x'.repeat(40) }, 'x'.repeat(40)));
    store.addRoleCapability('g', 'advisor', 'advisor-capability-0123456789abcdef01');
    store.assertAuthorized({ groupId: 'g', roleId: 'advisor', bindingGeneration: 1, capabilityId: 'advisor-capability-0123456789abcdef01' }, 'advisor-capability-0123456789abcdef01');
    assert.throws(() => store.addRoleCapability('g', 'advisor', 'other-capability-0123456789abcdef0123'), { code: 'CONFLICT' });
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('PowerContext enrollment accepts four core roles with optional distinct advisor', () => {
  const four = ['lead', 'frontend', 'backend', 'audit'].map((r) => enrollment(r, `coordinator-${r}`));
  verifyRoleEnrollment(four as never);
  verifyRoleEnrollment([...four, enrollment('advisor', 'coordinator-advisor')] as never);
  assert.throws(() => verifyRoleEnrollment([...four, enrollment('advisor', 'coordinator-audit')] as never), { code: 'INVALID_INPUT' });
  assert.throws(() => verifyRoleEnrollment(four.slice(1) as never), { code: 'INVALID_INPUT' });
});
```

- [ ] **Step 2: 运行测试，确认失败**

运行：`npx tsx --test tests/roles.test.ts`
预期：失败，提示找不到 `../src/roles.js`。

- [ ] **Step 3: 创建 `src/roles.ts`**

```ts
import { z } from 'zod';

export const ROLE_IDS = ['lead', 'frontend', 'backend', 'audit', 'advisor'] as const;
export type RoleId = typeof ROLE_IDS[number];
export const CORE_ROLE_IDS = ['lead', 'frontend', 'backend', 'audit'] as const;
export type CoreRoleId = typeof CORE_ROLE_IDS[number];
export const OBSERVED_ROLES = ['frontend', 'backend', 'audit', 'advisor'] as const;
export type ObservedRole = typeof OBSERVED_ROLES[number];
export const roleEnum = z.enum(ROLE_IDS);
export const AGENT_KINDS = ['codex', 'claude'] as const;
export type AgentKind = typeof AGENT_KINDS[number];
export const agentEnum = z.enum(AGENT_KINDS);
```

把 `src/protocol.ts` 第 4 行替换为：

```ts
export type { RoleId } from './roles.js';
import type { RoleId } from './roles.js';
```

- [ ] **Step 4: 替换各处的手写枚举**

按 Files 列表逐个替换：`z.enum(['lead','frontend','backend','audit'])` 改为 `roleEnum`（从 `./roles.js` 或 `../src/roles.js` 导入）；`['lead','frontend','backend','audit'] as RoleId[]` 这类数组改为 `ROLE_IDS`。`scripts/herdr-watch.ts:8` 中的 `['frontend','backend','audit']` 改为 `OBSERVED_ROLES`。

`store.initializeGroup` 的实现改为：

```ts
  initializeGroup(groupId: string, capabilities: Record<CoreRoleId, string> & Partial<Record<'advisor', string>>): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.createGroup(groupId);
      for (const roleId of ROLE_IDS) { const token = capabilities[roleId as CoreRoleId]; if (token) this.setRoleCapability(groupId, roleId, token); }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  addRoleCapability(groupId: string, roleId: 'advisor', token: string): void {
    this.createGroup(groupId);
    const existing = this.db.prepare('SELECT 1 FROM role_capabilities WHERE group_id=? AND role_id=?').get(groupId, roleId);
    if (existing) throw new CoordinatorError('CONFLICT', 'Role capability already exists.', 'Reuse the existing role credential; never overwrite it.');
    this.setRoleCapability(groupId, roleId, token);
  }
```

`verifyRoleEnrollment` 改为：

```ts
export function verifyRoleEnrollment(roles: RoleEnrollment[]): void {
  const allowed = new Set<RoleId>(ROLE_IDS);
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (!CORE_ROLE_IDS.every((role) => roles.some((item) => item.role === role)) || roles.some((item) => !allowed.has(item.role)) || !unique(roles.map((item) => item.role)) || !unique(roles.map((item) => item.principal.id)) || !unique(roles.map((item) => item.authorizationEnv)) || new Set(roles.map((item) => item.scopeId)).size !== 1 || new Set(roles.map((item) => item.projectKey)).size !== 1 || roles.some((item) => item.principal.type !== 'service')) {
    throw new CoordinatorError('INVALID_INPUT', 'Configure the four core roles, an optional advisor, and distinct service Principals in one project Scope.', 'Enroll roles against the project Scope and actual host session keys.');
  }
}
```

原函数第 11 行之后还有别的条件（被截断的部分），**要原样保留**，并入上面的 `if` 判断。

`scripts/daemon.ts` 的凭据 schema 改为：

```ts
const credentials = z.object({ groupId: z.string(), credentials: z.object({ lead: z.string().min(32), frontend: z.string().min(32), backend: z.string().min(32), audit: z.string().min(32), advisor: z.string().min(32).optional() }).strict() }).strict().parse(await readProtectedJson(config.credentialFile));
```

`for (const role of ['lead','frontend','backend','audit'] as const) engine.authenticate(...)` 改为：

```ts
for (const role of ROLE_IDS) { const token = credentials.credentials[role]; if (token) engine.authenticate(role, token, 1); }
```

`scripts/group-init.ts` 中的 `roles` 改为 `ROLE_IDS`，这样新建群组时会生成 5 个凭据。

- [ ] **Step 5: 新增 `scripts/group-add-role.ts`（给已有群组补 advisor 凭据）**

```ts
import { randomBytes } from 'node:crypto';
import { chmod, rename, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { CoordinatorStore } from '../src/store.js';
import { loadRuntimeConfig, readProtectedJson } from '../src/runtime-config.js';

const [configPath, role] = process.argv.slice(2);
if (!configPath || role !== 'advisor' || process.env.COORDINATOR_ROLE !== 'lead') throw new Error('Usage: COORDINATOR_ROLE=lead npm run group-add-role -- runtime.json advisor');
const config = await loadRuntimeConfig(configPath);
const saved = z.object({ groupId: z.literal(config.groupId), credentials: z.record(z.string(), z.string().min(32)) }).strict().parse(await readProtectedJson(config.credentialFile));
if (saved.credentials.advisor) throw new Error('Advisor credential already exists; reuse it.');
const token = randomBytes(32).toString('base64url');
const temp = `${config.credentialFile}.tmp-${process.pid}`;
await writeFile(temp, `${JSON.stringify({ groupId: saved.groupId, credentials: { ...saved.credentials, advisor: token } }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
const store = new CoordinatorStore(config.databasePath);
try {
  store.addRoleCapability(config.groupId, 'advisor', token);
  await chmod(temp, 0o600);
  await rename(temp, config.credentialFile);
  console.log(JSON.stringify({ groupId: config.groupId, added: 'advisor' }));
} catch (error) { await rm(temp, { force: true }); throw error; } finally { store.close(); }
```

- [ ] **Step 6: 运行测试，确认通过**

运行：`npx tsx --test tests/roles.test.ts && npm run typecheck && npm test`
预期：新测试 PASS，其余测试全部 PASS。

- [ ] **Step 7: 提交**

```bash
git add src/roles.ts src/protocol.ts src/engine.ts src/collaboration.ts src/auth.ts src/ipc.ts src/runtime-config.ts src/scheduler.ts src/store.ts src/dashboard src/integrations/powercontext.ts scripts web/dashboard.js package.json tests/roles.test.ts
git commit -q -m "feat: centralize role registry and add advisor role

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 运行配置与真实执行额度

**Files:**
- Modify: `src/runtime-config.ts`（schema 和 `loadRuntimeConfig`）
- Modify: `src/real-execution.ts`
- Create: `tests/runtime-config-agents.test.ts`

**Interfaces:**
- Consumes: `agentEnum`、`AgentKind`、`RoleId`（Task 1）
- Produces:
  - `RuntimeConfig.leadAgent?: AgentKind`、`leadWorktree?: string`（绝对路径）、`roles?: Partial<Record<'frontend'|'backend'|'audit'|'advisor', { agent: AgentKind }>>`、`advisor?: { suggestAfterRejections: number }`
  - `agentFor(config: Pick<RuntimeConfig,'roles'|'leadAgent'>, role: RoleId): AgentKind`
  - `RealExecutionGrant.choices.advisor?: ModelChoice`、`RealExecutionGrant.advisor?: { maxCalls: number; maxInputCharacters: number }`

- [ ] **Step 1: 写失败测试**

```ts
// tests/runtime-config-agents.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRuntimeConfig, agentFor } from '../src/runtime-config.js';
import { realExecutionSchema, assertRealExecution } from '../src/real-execution.js';

async function write(config: object) {
  const dir = await mkdtemp(join(tmpdir(), 'cfg-')); await mkdir(join(dir, 'repo'));
  const path = join(dir, 'runtime.json');
  await writeFile(path, JSON.stringify({ groupId: 'g', databasePath: 's.sqlite', socketPath: 'c.sock', credentialFile: 'r.json', humanCredentialFile: 'h.json', allowedRoots: ['.'], ...config }));
  return { dir, path };
}
const grant = { authorizationRef: 'a', expiresAt: new Date(Date.now() + 3600_000).toISOString(), taskRefs: ['t'], maxCalls: 2, maxConcurrent: 1, maxInputCharacters: 12000, maxTurnMs: 60000, choices: { frontend: { model: 'm', effort: 'medium' }, backend: { model: 'm', effort: 'medium' }, audit: { model: 'a', effort: 'high' } } };
const work = (roleId: string, model = { model: 'adv', effort: 'high', tier: 'analysis', reason: 'r' }) => ({ id: 'w', roleId, goal: 'g', taskRef: 't', repository: 'r', worktree: '/w', allowedPaths: ['.'], baseline: 'b', contractRef: 'c', acceptanceCriteria: ['a'], verificationCommands: ['v'], dependencies: [], risk: 0, evidenceFailures: 0, paused: false, model }) as never;

test('legacy config loads unchanged and defaults every role to codex', async () => {
  const { dir, path } = await write({});
  try {
    const config = await loadRuntimeConfig(path);
    assert.equal(config.mode, 'mock');
    for (const key of ['roles', 'leadAgent', 'leadWorktree', 'advisor']) assert.equal(key in config, false, key);
    for (const role of ['lead', 'frontend', 'backend', 'audit', 'advisor'] as const) assert.equal(agentFor(config, role), 'codex');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('real mode alias, per-role agents and lead worktree resolution', async () => {
  const { dir, path } = await write({ mode: 'mock', leadAgent: 'claude', leadWorktree: 'repo', roles: { audit: { agent: 'claude' }, advisor: { agent: 'claude' } }, advisor: { suggestAfterRejections: 3 } });
  try {
    const config = await loadRuntimeConfig(path);
    assert.equal(agentFor(config, 'lead'), 'claude');
    assert.equal(agentFor(config, 'frontend'), 'codex');
    assert.equal(agentFor(config, 'audit'), 'claude');
    assert.equal(config.leadWorktree, join(dir, 'repo'));
    assert.equal(config.advisor?.suggestAfterRejections, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
  const alias = await write({ mode: 'real' });
  try { await assert.rejects(loadRuntimeConfig(alias.path), { code: 'TASK_GATE_CLOSED' }); } finally { await rm(alias.dir, { recursive: true, force: true }); }
});

test('lead worktree must stay inside allowed roots', async () => {
  const { dir, path } = await write({ leadWorktree: '/etc' });
  try { await assert.rejects(loadRuntimeConfig(path), { code: 'INVALID_INPUT' }); } finally { await rm(dir, { recursive: true, force: true }); }
});

test('advisor execution needs its own choice and limits', () => {
  const plain = realExecutionSchema.parse(grant);
  assert.throws(() => assertRealExecution(plain, work('advisor')), { code: 'TASK_GATE_CLOSED' });
  assert.throws(() => realExecutionSchema.parse({ ...grant, choices: { ...grant.choices, advisor: { model: 'adv', effort: 'high' } } }));
  const full = realExecutionSchema.parse({ ...grant, choices: { ...grant.choices, advisor: { model: 'adv', effort: 'high' } }, advisor: { maxCalls: 1, maxInputCharacters: 4000 } });
  assertRealExecution(full, work('advisor'));
  assert.throws(() => assertRealExecution(full, work('advisor', { model: 'other', effort: 'high', tier: 'x', reason: 'r' })), { code: 'TASK_GATE_CLOSED' });
});
```

- [ ] **Step 2: 运行测试，确认失败**

运行：`npx tsx --test tests/runtime-config-agents.test.ts`
预期：失败，`agentFor` 未导出。

- [ ] **Step 3: 修改 `src/runtime-config.ts`**

在 `runtimeConfigSchema` 中：
- 把 `mode: z.enum(['mock', 'app_server']).default('mock')` 替换为 `mode: z.enum(['mock', 'app_server', 'real']).default('mock').transform((mode) => mode === 'real' ? 'app_server' as const : mode)`；
- 增加以下字段：

```ts
leadAgent: agentEnum.optional(),
leadWorktree: z.string().min(1).optional(),
roles: z.object({ frontend: roleRuntime, backend: roleRuntime, audit: roleRuntime, advisor: roleRuntime }).partial().strict().optional(),
advisor: z.object({ suggestAfterRejections: z.number().int().min(1).max(10) }).strict().optional(),
```

并在 schema 之前定义 `const roleRuntime = z.object({ agent: agentEnum }).strict();`。

在 `loadRuntimeConfig` 中，`allowedRoots` 解析完成之后插入：

```ts
  if (config.leadWorktree) {
    config.leadWorktree = resolve(root, config.leadWorktree);
    const inside = config.allowedRoots.some((base) => { const rel = relative(base, config.leadWorktree!); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); });
    if (!inside || (config.repositories.length > 0 && !config.repositories.some((repository) => repository.worktreePath === config.leadWorktree))) throw new CoordinatorError('INVALID_INPUT', 'Lead worktree must be a registered repository inside allowed roots.', 'Configure leadWorktree as the lead repository worktree.');
  }
```

`relative`、`isAbsolute` 从 `node:path` 导入。在文件末尾新增：

```ts
export function agentFor(config: Pick<RuntimeConfig, 'roles' | 'leadAgent'>, role: RoleId): AgentKind {
  if (role === 'lead') return config.leadAgent ?? 'codex';
  return config.roles?.[role]?.agent ?? 'codex';
}
```

- [ ] **Step 4: 修改 `src/real-execution.ts`**

```ts
export const realExecutionSchema = z.object({
  authorizationRef: z.string().min(1), expiresAt: z.string().datetime(),
  taskRefs: z.array(z.string().min(1)).min(1),
  maxCalls: z.number().int().min(1).max(8), maxConcurrent: z.number().int().min(1).max(2),
  maxInputCharacters: z.number().int().min(1000).max(24000),
  maxTurnMs: z.number().int().min(1000).max(300000),
  choices: z.object({ frontend: choice, backend: choice, audit: choice, advisor: choice.optional() }).strict(),
  advisor: z.object({ maxCalls: z.number().int().min(1).max(8), maxInputCharacters: z.number().int().min(1000).max(24000) }).strict().optional()
}).strict().refine((grant) => Boolean(grant.choices.advisor) === Boolean(grant.advisor), { message: 'Advisor choice and advisor limits must be granted together.' });
export type RealExecutionGrant = z.infer<typeof realExecutionSchema>;
export function assertRealExecution(grant: RealExecutionGrant | undefined, work: ExecutionPackage): void {
  if (!grant || Date.parse(grant.expiresAt) <= Date.now() || !grant.taskRefs.includes(work.taskRef) || work.roleId === 'lead') throw new CoordinatorError('TASK_GATE_CLOSED', 'Real invocation authorization is absent, expired or outside this task.', 'Keep work queued until the host provides scoped authorization.');
  const advisor = work.roleId === 'advisor';
  if (advisor && (!grant.advisor || !grant.choices.advisor)) throw new CoordinatorError('TASK_GATE_CLOSED', 'Advisor invocation is not authorized.', 'Request a scoped advisor grant before asking for advice.');
  const choice = advisor ? grant.choices.advisor! : grant.choices[work.roleId as 'frontend' | 'backend' | 'audit'];
  if (work.model?.model !== choice.model || work.model.effort !== choice.effort) throw new CoordinatorError('TASK_GATE_CLOSED', 'Model choice is outside this invocation grant.', 'Record failure evidence before requesting a different model grant.');
  const limit = advisor ? grant.advisor!.maxInputCharacters : grant.maxInputCharacters;
  if (JSON.stringify(work).length > limit) throw new CoordinatorError('BUDGET_EXHAUSTED', 'Execution package exceeds the authorized input size.', 'Reduce the package to goal, contract, evidence and blockers.');
}
```

`src/engine.ts` 里 `this.options.realExecution?.choices[request.work.roleId]` 的类型会变成可选，保持原写法即可（advisor 未批准时值为 `undefined`，之后由 `assertRealExecution` 拒绝）。

- [ ] **Step 5: 运行测试，确认通过**

运行：`npx tsx --test tests/runtime-config-agents.test.ts && npm run typecheck && npm test`
预期：全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add src/runtime-config.ts src/real-execution.ts tests/runtime-config-agents.test.ts
git commit -q -m "feat: configure agent per role and scoped advisor grants

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 额度池拆分（advisor 独立计数）

**Files:**
- Modify: `src/budget.ts`
- Modify: `src/engine.ts`（新增 `advisorBudget`、`budgetFor`，替换 `this.budget.*` 的调用处）
- Create: `tests/budget-pools.test.ts`

**Interfaces:**
- Produces: `type BudgetPool = 'mock' | 'app_server' | 'mock_advisor' | 'advisor'`；`engine.advisorBudget: ExecutionBudget`；`automation_status` 的返回值增加 `advisorBudget`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/budget-pools.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionBudget } from '../src/budget.js';

test('advisor pool counts separately from worker pool in the same database', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'budget-'));
  const db = join(dir, 's.sqlite');
  const workers = new ExecutionBudget(db, 'g', { maxCalls: 1, maxConcurrent: 1 }, 'app_server');
  const advisor = new ExecutionBudget(db, 'g', { maxCalls: 1, maxConcurrent: 1 }, 'advisor');
  try {
    workers.reserve('d1', 't1');
    assert.throws(() => workers.reserve('d2', 't2'), { code: 'BUDGET_EXHAUSTED' });
    advisor.reserve('a1', 't3');
    assert.equal(advisor.status().callsUsed, 1);
    assert.equal(workers.status().callsUsed, 1);
    advisor.mark('t3', 'unknown');
    workers.mark('t1', 'completed');
    assert.throws(() => advisor.reserve('a2', 't4'), { code: 'RECONCILIATION_REQUIRED' });
  } finally { workers.close(); advisor.close(); await rm(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 运行测试，确认失败**

运行：`npx tsx --test tests/budget-pools.test.ts`
预期：类型检查报错，`'advisor'` 不能赋给 `'mock' | 'app_server'`；tsx 运行时可能通过，以 `npm run typecheck` 的失败为准。

- [ ] **Step 3: 实现**

`src/budget.ts`：新增 `export type BudgetPool = 'mock' | 'app_server' | 'mock_advisor' | 'advisor';`，把构造函数参数类型和 `status()` 返回值中的 `'mock' | 'app_server'` 都改为 `BudgetPool`。

`src/engine.ts`：
- 字段区新增 `readonly advisorBudget: ExecutionBudget;`；
- 在构造函数中，紧接 `this.budget = …` 之后加入：

```ts
    this.advisorBudget = new ExecutionBudget(options.databasePath, options.groupId, options.runtimeSource === 'app_server' ? { maxCalls: options.realExecution?.advisor?.maxCalls ?? 0, maxConcurrent: 1 } : options.mockBudget ?? { maxCalls: 100, maxConcurrent: 4 }, options.runtimeSource === 'app_server' ? 'advisor' : 'mock_advisor');
```

- 新增私有方法：`private budgetFor(role: RoleId): ExecutionBudget { return role === 'advisor' ? this.advisorBudget : this.budget; }`
- 替换以下调用：`pumpRole` 中所有的 `this.budget.` 改为 `this.budgetFor(role.actor.roleId).`；`finishReceipt` 中的改为 `this.budgetFor(run.actor.roleId).`；`pump` 中活动执行循环里的改为 `this.budgetFor(run.actor.roleId).`；`automation_reconcile` 中的改为 `this.budgetFor(dispatch.roleId).`；
- `recoverAfterRestart` 增加 `this.advisorBudget.recover();`，`close()` 增加 `this.advisorBudget.close();`；
- `automation_status` 的返回值增加 `advisorBudget: this.advisorBudget.status()`。

- [ ] **Step 4: 运行测试，确认通过**

运行：`npx tsx --test tests/budget-pools.test.ts && npm run typecheck && npm test`
预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/budget.ts src/engine.ts tests/budget-pools.test.ts
git commit -q -m "feat: keep advisor invocations in a separate budget pool

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 安全读取的公共函数，以及 Claude 会话记录证据

**Files:**
- Create: `src/runtime/bounded-read.ts`
- Modify: `src/runtime/model-evidence.ts`（改为调用 `readOwnedText`，行为不变；`source` 类型增加 `'claude_transcript'`）
- Create: `src/runtime/claude-evidence.ts`
- Create: `tests/claude-evidence.test.ts`

**Interfaces:**
- Produces:
  - `readOwnedText(path: string, root: string, maxBytes?: number): Promise<string | undefined>`
  - `TurnModelEvidence.source: 'codex_turn_context' | 'claude_transcript'`
  - `findClaudeTranscript(root: string, sessionId: string): Promise<string | undefined>`
  - `readClaudeTurnModel(root: string, sessionId: string, promptUuid: string): Promise<TurnModelEvidence | undefined>`

- [ ] **Step 1: 写失败测试**

```ts
// tests/claude-evidence.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudeTurnModel } from '../src/runtime/claude-evidence.js';

const session = '11111111-2222-4333-8444-555555555555';
const line = (value: object) => JSON.stringify({ sessionId: session, ...value });
const prompt = (uuid: string) => line({ type: 'user', uuid, message: { role: 'user', content: 'do work' } });
const toolResult = (uuid: string) => line({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x' }] } });
const assistant = (model: string) => line({ type: 'assistant', uuid: 'a' + Math.random(), message: { model, content: [] } });

async function project(lines: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'claude-projects-'));
  await mkdir(join(root, '-Users-me-repo'));
  await writeFile(join(root, '-Users-me-repo', `${session}.jsonl`), lines.join('\n') + '\n');
  return root;
}

test('reads one consistent model for the turn and ignores synthetic rows and later turns', async () => {
  const root = await project([prompt('p0'), assistant('claude-haiku-5-5'), prompt('p1'), assistant('claude-opus-5-5'), toolResult('t1'), assistant('<synthetic>'), assistant('claude-opus-5-5'), prompt('p2'), assistant('claude-sonnet-5-5')]);
  try {
    assert.deepEqual(await readClaudeTurnModel(root, session, 'p1'), { model: 'claude-opus-5-5', effort: null, source: 'claude_transcript' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('mixed models, missing prompt, foreign session and malformed lines are not evidence', async () => {
  const mixed = await project([prompt('p1'), assistant('claude-opus-5-5'), assistant('claude-haiku-5-5')]);
  const foreign = await project([prompt('p1'), JSON.stringify({ sessionId: 'other', type: 'assistant', message: { model: 'm' } })]);
  const broken = await project([prompt('p1'), '{oops', assistant('m')]);
  try {
    assert.equal(await readClaudeTurnModel(mixed, session, 'p1'), undefined);
    assert.equal(await readClaudeTurnModel(mixed, session, 'missing'), undefined);
    assert.equal(await readClaudeTurnModel(foreign, session, 'p1'), undefined);
    assert.equal(await readClaudeTurnModel(broken, session, 'p1'), undefined);
    assert.equal(await readClaudeTurnModel(mixed, 'not-a-uuid', 'p1'), undefined);
  } finally { for (const dir of [mixed, foreign, broken]) await rm(dir, { recursive: true, force: true }); }
});

test('symlinked transcripts and a trailing partial line are handled safely', async () => {
  const root = await project([prompt('p1'), assistant('claude-opus-5-5')]);
  const outside = await mkdtemp(join(tmpdir(), 'outside-'));
  try {
    await writeFile(join(root, '-Users-me-repo', `${session}.jsonl`), [prompt('p1'), assistant('claude-opus-5-5'), '{"partial'].join('\n'));
    assert.equal((await readClaudeTurnModel(root, session, 'p1'))?.model, 'claude-opus-5-5');
    await rm(join(root, '-Users-me-repo', `${session}.jsonl`));
    await writeFile(join(outside, 'x.jsonl'), prompt('p1') + '\n' + assistant('m') + '\n');
    await symlink(join(outside, 'x.jsonl'), join(root, '-Users-me-repo', `${session}.jsonl`));
    assert.equal(await readClaudeTurnModel(root, session, 'p1'), undefined);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 运行测试，确认失败**

运行：`npx tsx --test tests/claude-evidence.test.ts`
预期：失败，找不到模块。

- [ ] **Step 3: 抽出 `src/runtime/bounded-read.ts`**

```ts
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
```

`src/runtime/model-evidence.ts` 改为：先 `const raw = await readOwnedText(path, root); if (raw === undefined) return undefined;`，然后保留原有的逐行解析逻辑；删除重复的打开、校验代码；把 `source` 的类型改为 `'codex_turn_context' | 'claude_transcript'`。改完后运行 `npx tsx --test tests/model-evidence.test.ts`，必须原样通过。

- [ ] **Step 4: 实现 `src/runtime/claude-evidence.ts`**

```ts
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { readOwnedText } from './bounded-read.js';
import type { TurnModelEvidence } from './model-evidence.js';

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface TranscriptRecord { type?: string; uuid?: string; sessionId?: string; message?: { model?: unknown; content?: unknown } }

export async function findClaudeTranscript(root: string, sessionId: string): Promise<string | undefined> {
  if (!SESSION.test(sessionId)) return undefined;
  let base: string;
  try { base = await realpath(root); } catch { return undefined; }
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  const matches: string[] = [];
  for (const entry of entries.slice(0, 10_000)) {
    if (!entry.isDirectory()) continue;
    const candidate = join(base, entry.name, `${sessionId}.jsonl`);
    const info = await lstat(candidate).catch(() => undefined);
    if (info) matches.push(candidate);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function isPrompt(record: TranscriptRecord): boolean {
  if (record.type !== 'user') return false;
  const content = record.message?.content;
  return typeof content === 'string' || (Array.isArray(content) && !content.some((block) => (block as { type?: unknown })?.type === 'tool_result'));
}

export async function readClaudeTurnModel(root: string, sessionId: string, promptUuid: string): Promise<TurnModelEvidence | undefined> {
  const path = await findClaudeTranscript(root, sessionId);
  if (!path) return undefined;
  const raw = await readOwnedText(path, root);
  if (raw === undefined) return undefined;
  const lines = raw.split('\n');
  let inTurn = false; const models = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line) continue;
    let record: TranscriptRecord;
    try { record = JSON.parse(line) as TranscriptRecord; } catch { if (index === lines.length - 1) break; return undefined; }
    if (record.sessionId !== undefined && record.sessionId !== sessionId) return undefined;
    if (record.type === 'user' && record.uuid === promptUuid) { if (inTurn) return undefined; inTurn = true; continue; }
    if (!inTurn) continue;
    if (isPrompt(record)) break;
    if (record.type !== 'assistant') continue;
    const model = record.message?.model;
    if (model === '<synthetic>') continue;
    if (typeof model !== 'string' || !model || model.length > 256 || /[\r\n\x00-\x1f]/.test(model)) return undefined;
    models.add(model);
  }
  return inTurn && models.size === 1 ? { model: [...models][0]!, effort: null, source: 'claude_transcript' } : undefined;
}
```

- [ ] **Step 5: 运行测试，确认通过**

运行：`npx tsx --test tests/claude-evidence.test.ts tests/model-evidence.test.ts && npm run typecheck && npm test`
预期：全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add src/runtime/bounded-read.ts src/runtime/model-evidence.ts src/runtime/claude-evidence.ts tests/claude-evidence.test.ts
git commit -q -m "feat: read Claude transcript model evidence safely

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Claude 轮次记录表

**Files:**
- Create: `src/runtime/claude-journal.ts`
- Create: `tests/claude-journal.test.ts`

**Interfaces:**
- Produces:
  - `type ClaudeTurnStatus = 'inProgress' | 'completed' | 'failed' | 'interrupted' | 'unknown'`
  - `interface ClaudeTurnRow { threadId: string; turnId: string; status: ClaudeTurnStatus; promptUuid: string | null; requestedModel: string; requestedEffort: string; initModel: string | null; apiKeySource: string | null; inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; costUsd: number | null; error: string | null }`
  - `class ClaudeTurnJournal`，方法：`createThread(threadId, cwd)`、`thread(threadId): { threadId; cwd; materialized: boolean } | undefined`、`markMaterialized(threadId)`、`startTurn({threadId, turnId, requestedModel, requestedEffort})`、`update(turnId, patch: Partial<ClaudeTurnRow>)`、`turn(turnId)`、`turns(threadId): Array<{ id: string; status: ClaudeTurnStatus }>`、`markOrphans(threadId, liveTurnIds: Set<string>): number`、`close()`

- [ ] **Step 1: 写失败测试**

```ts
// tests/claude-journal.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeTurnJournal } from '../src/runtime/claude-journal.js';

test('journal keeps ordered turns, merges patches and fences orphans after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cj-')); const db = join(dir, 's.sqlite');
  const first = new ClaudeTurnJournal(db);
  try {
    first.createThread('th', '/repo');
    assert.equal(first.thread('th')!.materialized, false);
    first.startTurn({ threadId: 'th', turnId: 't1', requestedModel: 'm', requestedEffort: 'high' });
    first.update('t1', { status: 'completed', promptUuid: 'p1', inputTokens: 10 });
    first.startTurn({ threadId: 'th', turnId: 't2', requestedModel: 'm', requestedEffort: 'high' });
    first.markMaterialized('th');
    assert.deepEqual(first.turns('th'), [{ id: 't1', status: 'completed' }, { id: 't2', status: 'inProgress' }]);
    assert.equal(first.turn('t1')!.inputTokens, 10);
    assert.throws(() => first.createThread('th', '/other'), { code: 'RECONCILIATION_REQUIRED' });
  } finally { first.close(); }
  const second = new ClaudeTurnJournal(db);
  try {
    assert.equal(second.thread('th')!.materialized, true);
    assert.equal(second.markOrphans('th', new Set()), 1);
    assert.equal(second.turn('t2')!.status, 'unknown');
    assert.match(second.turn('t2')!.error!, /restart/i);
  } finally { second.close(); await rm(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 运行测试，确认失败**

运行：`npx tsx --test tests/claude-journal.test.ts`
预期：失败，找不到模块。

- [ ] **Step 3: 实现**

```ts
// src/runtime/claude-journal.ts
import { DatabaseSync } from 'node:sqlite';
import { CoordinatorError } from '../errors.js';

export type ClaudeTurnStatus = 'inProgress' | 'completed' | 'failed' | 'interrupted' | 'unknown';
export interface ClaudeTurnRow { threadId: string; turnId: string; status: ClaudeTurnStatus; promptUuid: string | null; requestedModel: string; requestedEffort: string; initModel: string | null; apiKeySource: string | null; inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; costUsd: number | null; error: string | null; }

export class ClaudeTurnJournal {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS claude_threads(thread_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, materialized INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS claude_turns(turn_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, seq INTEGER NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL);');
  }
  close(): void { this.db.close(); }
  createThread(threadId: string, cwd: string): void {
    const existing = this.thread(threadId);
    if (existing && existing.cwd !== cwd) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Claude session belongs to another worktree.', 'Reconcile and rebind before switching worktrees.');
    this.db.prepare('INSERT OR IGNORE INTO claude_threads(thread_id,cwd,created_at) VALUES(?,?,?)').run(threadId, cwd, new Date().toISOString());
  }
  thread(threadId: string): { threadId: string; cwd: string; materialized: boolean } | undefined {
    const row = this.db.prepare('SELECT thread_id,cwd,materialized FROM claude_threads WHERE thread_id=?').get(threadId) as { thread_id: string; cwd: string; materialized: number } | undefined;
    return row ? { threadId: row.thread_id, cwd: row.cwd, materialized: row.materialized === 1 } : undefined;
  }
  markMaterialized(threadId: string): void { this.db.prepare('UPDATE claude_threads SET materialized=1 WHERE thread_id=?').run(threadId); }
  startTurn(input: { threadId: string; turnId: string; requestedModel: string; requestedEffort: string }): void {
    const row: ClaudeTurnRow = { ...input, status: 'inProgress', promptUuid: null, initModel: null, apiKeySource: null, inputTokens: null, outputTokens: null, cachedInputTokens: null, costUsd: null, error: null };
    const seq = (this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS next FROM claude_turns WHERE thread_id=?').get(input.threadId) as { next: number }).next;
    this.db.prepare('INSERT INTO claude_turns(turn_id,thread_id,seq,status,payload_json) VALUES(?,?,?,?,?)').run(input.turnId, input.threadId, seq, row.status, JSON.stringify(row));
  }
  update(turnId: string, patch: Partial<ClaudeTurnRow>): void {
    const current = this.turn(turnId);
    if (!current) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Claude turn is unknown.', 'Inspect the original turn before updating it.');
    const next = { ...current, ...patch, turnId: current.turnId, threadId: current.threadId };
    this.db.prepare('UPDATE claude_turns SET status=?,payload_json=? WHERE turn_id=?').run(next.status, JSON.stringify(next), turnId);
  }
  turn(turnId: string): ClaudeTurnRow | undefined {
    const row = this.db.prepare('SELECT payload_json FROM claude_turns WHERE turn_id=?').get(turnId) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as ClaudeTurnRow : undefined;
  }
  turns(threadId: string): Array<{ id: string; status: ClaudeTurnStatus }> {
    return (this.db.prepare('SELECT turn_id,status FROM claude_turns WHERE thread_id=? ORDER BY seq').all(threadId) as Array<{ turn_id: string; status: ClaudeTurnStatus }>).map((row) => ({ id: row.turn_id, status: row.status }));
  }
  // A restarted daemon cannot still own a previous instance's in-progress turn.
  markOrphans(threadId: string, liveTurnIds: Set<string>): number {
    let count = 0;
    for (const turn of this.turns(threadId)) if (turn.status === 'inProgress' && !liveTurnIds.has(turn.id)) { this.update(turn.id, { status: 'unknown', error: 'Runtime restarted before a terminal result was observed.' }); count++; }
    return count;
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

运行：`npx tsx --test tests/claude-journal.test.ts && npm run typecheck`
预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add src/runtime/claude-journal.ts tests/claude-journal.test.ts
git commit -q -m "feat: persist Claude turn lifecycle for reconciliation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `ClaudeAgentRuntime`，以及审批请求的接入

**Files:**
- Modify: `package.json`（dependencies 增加 `"@anthropic-ai/claude-agent-sdk": "0.3.293"`），执行 `npm i`
- Modify: `src/runtime/types.ts`（`RuntimeEvent.source` 增加 `'claude_agent'`；新增 `ManagedRuntime`；`Runtime` 增加可选方法 `readTurnUsage`）
- Modify: `src/engine.ts`（`ManagedRuntime` 改为从 types 导入）
- Create: `src/runtime/claude-agent.ts`
- Modify: `src/approval-bridge.ts`（接受 `claude/canUseTool` 方法）
- Create: `tests/claude-runtime.test.ts`

**Interfaces:**
- Consumes: `ClaudeTurnJournal`（Task 5）、`readClaudeTurnModel`（Task 4）
- Produces:
  - `CLAUDE_APPROVAL_METHOD = 'claude/canUseTool'`
  - `interface ClaudeMessage { type: string; subtype?: string; [key: string]: unknown }`
  - `interface ClaudeModelInfo { value: string; resolvedModel?: string; supportsEffort?: boolean; supportedEffortLevels?: string[] }`
  - `interface ClaudeQueryHandle extends AsyncIterable<ClaudeMessage> { interrupt(): Promise<unknown>; supportedModels(): Promise<ClaudeModelInfo[]> }`
  - `type ClaudeQueryFn = (params: { prompt: string | AsyncIterable<never>; options: Record<string, unknown> }) => ClaudeQueryHandle`
  - `class ClaudeAgentRuntime implements Runtime`，构造参数 `{ query: ClaudeQueryFn; journal: ClaudeTurnJournal; baseOptions: Record<string, unknown>; transcriptRoot: string; interruptTimeoutMs?: number }`；另有 `onEvent`、`onServerRequest`、`respondToServerRequest(requestId, result: { decision: 'accept' | 'decline' | 'cancel' })`、`readTurnUsage`
  - `interface TurnUsage { inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; costUsd: number | null; source: 'claude_result' | 'codex_notification' }`（在 `src/runtime/types.ts` 中定义）

- [ ] **Step 1: 写失败测试**

```ts
// tests/claude-runtime.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAgentRuntime, CLAUDE_APPROVAL_METHOD, type ClaudeMessage, type ClaudeQueryFn } from '../src/runtime/claude-agent.js';
import { ClaudeTurnJournal } from '../src/runtime/claude-journal.js';
import { observeThread } from '../src/runtime/thread-state.js';
import { ApprovalBridge } from '../src/approval-bridge.js';

type Script = (options: Record<string, unknown>) => AsyncGenerator<ClaudeMessage>;
function fakeQuery(scripts: Script[], models = [{ value: 'claude-opus-5-5', supportedEffortLevels: ['low', 'medium', 'high'] }]) {
  const calls: Array<Record<string, unknown>> = []; let interrupts = 0;
  const query: ClaudeQueryFn = ({ options }) => {
    calls.push(options);
    const script = typeof options.model === 'string' ? scripts.shift()! : async function* () {};
    const stream = script(options);
    return { [Symbol.asyncIterator]: () => stream, interrupt: async () => { interrupts++; }, supportedModels: async () => models };
  };
  return { query, calls, interrupts: () => interrupts };
}
const success = (uuid: string) => ({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: uuid, total_cost_usd: 0.01, modelUsage: { 'claude-opus-5-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 50, cacheCreationInputTokens: 5, costUSD: 0.01 } } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function setup(scripts: Script[]) {
  const dir = await mkdtemp(join(tmpdir(), 'claude-rt-'));
  const journal = new ClaudeTurnJournal(join(dir, 's.sqlite'));
  const fake = fakeQuery(scripts);
  const runtime = new ClaudeAgentRuntime({ query: fake.query, journal, baseOptions: { settingSources: [] }, transcriptRoot: dir, interruptTimeoutMs: 50 });
  return { dir, journal, fake, runtime, cleanup: async () => { journal.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('first turn creates the session, later turns resume it, and usage is recorded', async () => {
  const s = await setup([async function* () { yield { type: 'system', subtype: 'init', model: 'claude-opus-5-5', apiKeySource: 'oauth' }; yield { type: 'assistant', message: { model: 'claude-opus-5-5' } }; yield success('p1'); }, async function* () { yield success('p2'); }]);
  try {
    assert.deepEqual(await s.runtime.listModels(), [{ model: 'claude-opus-5-5', efforts: ['low', 'medium', 'high'] }]);
    const thread = await s.runtime.startThread('/repo');
    assert.deepEqual(observeThread(await s.runtime.readThread(thread), thread).turns, []);
    const first = await s.runtime.startTurn({ threadId: thread, input: '{"goal":"x"}', model: 'claude-opus-5-5', effort: 'high', cwd: '/repo' });
    await settle();
    const second = await s.runtime.startTurn({ threadId: thread, input: '{}', model: 'claude-opus-5-5', effort: 'high', cwd: '/repo' });
    await settle();
    const modelCalls = s.fake.calls.filter((call) => call.model);
    assert.equal(modelCalls[0]!.sessionId, thread); assert.equal(modelCalls[0]!.resume, undefined);
    assert.equal(modelCalls[1]!.resume, thread); assert.equal(modelCalls[1]!.sessionId, undefined);
    assert.deepEqual(observeThread(await s.runtime.readThread(thread), thread).turns.map((t) => t.status), ['completed', 'completed']);
    assert.deepEqual(await s.runtime.readTurnUsage!(thread, first.turnId), { inputTokens: 100, outputTokens: 20, cachedInputTokens: 55, costUsd: 0.01, source: 'claude_result' });
    assert.equal(s.journal.turn(first.turnId)!.apiKeySource, 'oauth');
    assert.equal(s.journal.turn(second.turnId)!.promptUuid, 'p2');
  } finally { await s.cleanup(); }
});

test('stream without result or with an error is never reported as completed', async () => {
  const s = await setup([async function* () { yield { type: 'assistant', message: { model: 'm' } }; }, async function* () { throw new Error('child exited'); }, async function* () { yield { type: 'result', subtype: 'error_max_turns', is_error: true }; }]);
  try {
    const thread = await s.runtime.startThread('/repo');
    const statuses: string[] = [];
    for (let i = 0; i < 3; i++) { const turn = await s.runtime.startTurn({ threadId: thread, input: 'x', model: 'm', effort: 'high', cwd: '/repo' }); await settle(); statuses.push(s.journal.turn(turn.turnId)!.status); }
    assert.deepEqual(statuses, ['unknown', 'unknown', 'failed']);
  } finally { await s.cleanup(); }
});

test('a second turn cannot start while one is in progress, and interrupt aborts after timeout', async () => {
  let release!: () => void;
  const s = await setup([async function* (options) { await new Promise<void>((resolve) => { release = resolve; (options.abortController as AbortController).signal.addEventListener('abort', () => resolve()); }); if ((options.abortController as AbortController).signal.aborted) throw new Error('aborted'); yield success('p'); }]);
  try {
    const thread = await s.runtime.startThread('/repo');
    const turn = await s.runtime.startTurn({ threadId: thread, input: 'x', model: 'm', effort: 'high', cwd: '/repo' });
    await assert.rejects(s.runtime.startTurn({ threadId: thread, input: 'y', model: 'm', effort: 'high', cwd: '/repo' }), { code: 'RECONCILIATION_REQUIRED' });
    await s.runtime.interruptTurn(thread, turn.turnId);
    await settle();
    assert.equal(s.fake.interrupts(), 1);
    assert.equal(s.journal.turn(turn.turnId)!.status, 'interrupted');
    release?.();
  } finally { await s.cleanup(); }
});

test('resume marks orphaned in-progress turns from a previous instance as unknown', async () => {
  const s = await setup([]);
  try {
    s.journal.createThread('11111111-2222-4333-8444-555555555555', '/repo');
    s.journal.startTurn({ threadId: '11111111-2222-4333-8444-555555555555', turnId: 'old', requestedModel: 'm', requestedEffort: 'high' });
    assert.equal(await s.runtime.resumeThread('11111111-2222-4333-8444-555555555555', '/repo'), '11111111-2222-4333-8444-555555555555');
    assert.equal(s.journal.turn('old')!.status, 'unknown');
    await assert.rejects(s.runtime.resumeThread('11111111-2222-4333-8444-555555555555', '/elsewhere'), { code: 'RECONCILIATION_REQUIRED' });
  } finally { await s.cleanup(); }
});

test('tool permission requests flow through the human approval bridge', async () => {
  const s = await setup([async function* (options) { const decision = await (options.canUseTool as Function)('Bash', { command: 'npm test' }, { signal: new AbortController().signal }); yield { type: 'assistant', message: { model: 'm', decision } }; yield success('p'); }]);
  const bridge = new ApprovalBridge(join(s.dir, 's.sqlite'), 'human-capability-0123456789');
  try {
    const actor = { groupId: 'g', roleId: 'audit' as const, bindingGeneration: 1, capabilityId: 'c' };
    s.runtime.onServerRequest((event) => { bridge.enqueue(actor, 'instance', event.requestId!, event.method, event.params); });
    const thread = await s.runtime.startThread('/repo');
    await s.runtime.startTurn({ threadId: thread, input: 'x', model: 'm', effort: 'high', cwd: '/repo' });
    await settle();
    const [pending] = bridge.list('g');
    assert.equal(pending!.method, CLAUDE_APPROVAL_METHOD);
    assert.deepEqual((pending!.params as { toolName: string }).toolName, 'Bash');
    await bridge.respond(pending!.id, 'human-capability-0123456789', 'accept', 'instance', (id, result) => s.runtime.respondToServerRequest(id, result as { decision: 'accept' }));
    await settle();
    assert.equal(bridge.list('g').length, 0);
    await assert.rejects(s.runtime.respondToServerRequest('missing', { decision: 'accept' }), { code: 'RECONCILIATION_REQUIRED' });
  } finally { bridge.close(); await s.cleanup(); }
});
```

- [ ] **Step 2: 运行测试，确认失败**

运行：`npx tsx --test tests/claude-runtime.test.ts`
预期：失败，找不到模块。

- [ ] **Step 3: 修改 `src/runtime/types.ts`**

```ts
export interface RuntimeEvent { threadId?: string; turnId?: string; requestId?: string | number; method: string; params: unknown; source: 'app_server' | 'mock' | 'claude_agent'; }
export interface TurnUsage { inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; costUsd: number | null; source: 'claude_result' | 'codex_notification'; }
export interface ManagedRuntime { runtime: Runtime; close(): Promise<void>; }
```

在 `Runtime` 接口中增加 `readTurnUsage?(threadId: string, turnId: string): Promise<TurnUsage | undefined>;`。`src/engine.ts` 删除本地的 `interface ManagedRuntime`，改为从 `./runtime/types.js` 导入。

- [ ] **Step 4: 实现 `src/runtime/claude-agent.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { ModelCapability } from '../config.js';
import { CoordinatorError } from '../errors.js';
import { readClaudeTurnModel } from './claude-evidence.js';
import type { ClaudeTurnJournal, ClaudeTurnStatus } from './claude-journal.js';
import type { TurnModelEvidence } from './model-evidence.js';
import type { Runtime, RuntimeEvent, TurnInput, TurnReceipt, TurnUsage } from './types.js';

export const CLAUDE_APPROVAL_METHOD = 'claude/canUseTool';
export interface ClaudeMessage { type: string; subtype?: string; [key: string]: unknown; }
export interface ClaudeModelInfo { value: string; resolvedModel?: string; supportsEffort?: boolean; supportedEffortLevels?: string[]; }
export interface ClaudeQueryHandle extends AsyncIterable<ClaudeMessage> { interrupt(): Promise<unknown>; supportedModels(): Promise<ClaudeModelInfo[]>; }
export type ClaudeQueryFn = (params: { prompt: string | AsyncIterable<never>; options: Record<string, unknown> }) => ClaudeQueryHandle;
export interface ClaudeRuntimeOptions { query: ClaudeQueryFn; journal: ClaudeTurnJournal; baseOptions: Record<string, unknown>; transcriptRoot: string; interruptTimeoutMs?: number; }
type PermissionResult = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string; interrupt?: boolean };
interface PendingApproval { turnId: string; input: Record<string, unknown>; resolve(result: PermissionResult): void; }
interface ActiveTurn { handle: ClaudeQueryHandle; abortController: AbortController; threadId: string; }

const text = (value: unknown): string | null => typeof value === 'string' && value.length <= 512 ? value : null;
const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
function bounded(input: Record<string, unknown>): Record<string, unknown> { const raw = JSON.stringify(input); return raw.length <= 4000 ? input : { truncated: raw.slice(0, 4000) }; }
function usageFrom(modelUsage: unknown): Pick<TurnUsage, 'inputTokens' | 'outputTokens' | 'cachedInputTokens'> {
  if (!modelUsage || typeof modelUsage !== 'object') return { inputTokens: null, outputTokens: null, cachedInputTokens: null };
  let input = 0, output = 0, cached = 0;
  for (const entry of Object.values(modelUsage as Record<string, Record<string, unknown>>)) { input += count(entry.inputTokens) ?? 0; output += count(entry.outputTokens) ?? 0; cached += (count(entry.cacheReadInputTokens) ?? 0) + (count(entry.cacheCreationInputTokens) ?? 0); }
  return { inputTokens: input, outputTokens: output, cachedInputTokens: cached };
}
async function* idle(signal: AbortSignal): AsyncGenerator<never> { await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); }

export class ClaudeAgentRuntime implements Runtime {
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly serverRequestListeners = new Set<(event: RuntimeEvent) => void>();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly approvals = new Map<string, PendingApproval>();
  private models?: ModelCapability[];
  constructor(private readonly options: ClaudeRuntimeOptions) {}
  onEvent(listener: (event: RuntimeEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onServerRequest(listener: (event: RuntimeEvent) => void): () => void { this.serverRequestListeners.add(listener); return () => this.serverRequestListeners.delete(listener); }
  async initialize(): Promise<void> {}
  async listModels(): Promise<ModelCapability[]> {
    if (this.models) return this.models;
    const abortController = new AbortController();
    const handle = this.options.query({ prompt: idle(abortController.signal), options: { ...this.options.baseOptions, abortController } });
    try {
      const listed = await handle.supportedModels();
      this.models = listed.flatMap((entry) => {
        const efforts = entry.supportsEffort === false ? [] : entry.supportedEffortLevels ?? [];
        return [...new Set([entry.value, entry.resolvedModel].filter((id): id is string => Boolean(id)))].map((model) => ({ model, efforts: [...efforts] }));
      });
      return this.models;
    } finally { abortController.abort(); }
  }
  async startThread(cwd: string): Promise<string> { const threadId = randomUUID(); this.options.journal.createThread(threadId, cwd); return threadId; }
  async resumeThread(threadId: string, cwd: string): Promise<string> {
    const thread = this.options.journal.thread(threadId);
    if (!thread || thread.cwd !== cwd) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Runtime resumed an unexpected Claude session.', 'Inspect the original persisted session before proceeding.');
    this.options.journal.markOrphans(threadId, new Set(this.active.keys()));
    return threadId;
  }
  async readThread(threadId: string): Promise<unknown> {
    if (!this.options.journal.thread(threadId)) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Complete runtime turn history is unavailable.', 'Read the original Claude session journal before changing work state.');
    const turns = this.options.journal.turns(threadId);
    return { thread: { id: threadId, status: { type: turns.some((turn) => turn.status === 'inProgress') ? 'active' : 'idle' }, turns } };
  }
  async readTurnModel(threadId: string, turnId: string): Promise<TurnModelEvidence | undefined> {
    const row = this.options.journal.turn(turnId);
    return row?.threadId === threadId && row.promptUuid ? readClaudeTurnModel(this.options.transcriptRoot, threadId, row.promptUuid) : undefined;
  }
  async readTurnUsage(threadId: string, turnId: string): Promise<TurnUsage | undefined> {
    const row = this.options.journal.turn(turnId);
    if (row?.threadId !== threadId || row.status !== 'completed') return undefined;
    return { inputTokens: row.inputTokens, outputTokens: row.outputTokens, cachedInputTokens: row.cachedInputTokens, costUsd: row.costUsd, source: 'claude_result' };
  }
  async startTurn(turn: TurnInput): Promise<TurnReceipt> {
    const thread = this.options.journal.thread(turn.threadId);
    if (!thread) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Claude session is not known to this runtime.', 'Initialize the role before starting work.');
    if (this.options.journal.turns(turn.threadId).some((item) => item.status === 'inProgress')) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Runtime already has an active turn.', 'Reconcile before automatic execution.');
    const turnId = randomUUID(); const abortController = new AbortController();
    this.options.journal.startTurn({ threadId: turn.threadId, turnId, requestedModel: turn.model, requestedEffort: turn.effort });
    const session = thread.materialized ? { resume: turn.threadId } : { sessionId: turn.threadId };
    let handle: ClaudeQueryHandle;
    try { handle = this.options.query({ prompt: turn.input, options: { ...this.options.baseOptions, cwd: turn.cwd, model: turn.model, effort: turn.effort, abortController, canUseTool: this.permission(turn.threadId, turnId), ...session } }); }
    catch { this.options.journal.update(turnId, { status: 'failed', error: 'Claude runtime could not start.' }); throw new CoordinatorError('PROVIDER_UNAVAILABLE', 'Claude runtime could not start a turn.', 'Check local Claude authentication and provider availability.'); }
    this.options.journal.markMaterialized(turn.threadId);
    this.active.set(turnId, { handle, abortController, threadId: turn.threadId });
    void this.consume(turn.threadId, turnId, handle);
    return { threadId: turn.threadId, turnId, requestedModel: turn.model, requestedEffort: turn.effort, status: 'started' };
  }
  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const active = this.active.get(turnId);
    if (!active || active.threadId !== threadId) return;
    await Promise.race([active.handle.interrupt().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, this.options.interruptTimeoutMs ?? 5000))]);
    if (this.active.has(turnId)) active.abortController.abort();
  }
  async respondToServerRequest(requestId: string | number, result: { decision: 'accept' | 'decline' | 'cancel' }): Promise<void> {
    const pending = this.approvals.get(String(requestId));
    if (!pending) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Claude approval request is no longer pending.', 'Inspect the current runtime request; never replay an approval blindly.');
    pending.resolve(result.decision === 'accept' ? { behavior: 'allow', updatedInput: pending.input } : { behavior: 'deny', message: 'Declined by the human reviewer.', interrupt: result.decision === 'cancel' });
  }
  private emit(event: Omit<RuntimeEvent, 'source'>): void { for (const listener of this.listeners) listener({ ...event, source: 'claude_agent' }); }
  private permission(threadId: string, turnId: string) {
    return (toolName: string, input: Record<string, unknown>, context: { signal: AbortSignal }): Promise<PermissionResult> => new Promise((resolve) => {
      const requestId = randomUUID();
      const finish = (result: PermissionResult) => { if (this.approvals.delete(requestId)) resolve(result); };
      this.approvals.set(requestId, { turnId, input, resolve: finish });
      context.signal.addEventListener('abort', () => finish({ behavior: 'deny', message: 'Approval aborted.' }), { once: true });
      const event: RuntimeEvent = { method: CLAUDE_APPROVAL_METHOD, requestId, threadId, turnId, source: 'claude_agent', params: { threadId, turnId, toolName, input: bounded(input) } };
      for (const listener of this.serverRequestListeners) listener(event);
    });
  }
  private async consume(threadId: string, turnId: string, handle: ClaudeQueryHandle): Promise<void> {
    const journal = this.options.journal;
    let terminal: ClaudeTurnStatus = 'unknown';
    this.emit({ method: 'turn/started', threadId, turnId, params: { threadId, turnId } });
    try {
      for await (const message of handle) {
        if (message.type === 'system' && message.subtype === 'init') journal.update(turnId, { initModel: text(message.model), apiKeySource: text(message.apiKeySource) });
        else if (message.type === 'assistant') this.emit({ method: 'item/completed', threadId, turnId, params: { threadId, turnId } });
        else if (message.type === 'result') {
          terminal = message.subtype === 'success' && message.is_error !== true ? 'completed' : 'failed';
          journal.update(turnId, { status: terminal, promptUuid: text(message.user_message_uuid), costUsd: count(message.total_cost_usd), ...usageFrom(message.modelUsage), error: terminal === 'failed' ? text(message.subtype) ?? 'result_error' : null });
        }
      }
      if (terminal === 'unknown') journal.update(turnId, { status: 'unknown', error: 'Stream ended without a result message.' });
    } catch {
      const aborted = this.active.get(turnId)?.abortController.signal.aborted === true;
      terminal = aborted ? 'interrupted' : 'unknown';
      journal.update(turnId, { status: terminal, error: aborted ? 'Interrupted by coordinator.' : 'Claude runtime stream failed; outcome unknown.' });
      if (!aborted) this.emit({ method: 'error', threadId, turnId, params: { threadId, turnId } });
    } finally {
      this.active.delete(turnId);
      for (const [id, pending] of this.approvals) if (pending.turnId === turnId) { this.approvals.delete(id); pending.resolve({ behavior: 'deny', message: 'Turn ended before approval.' }); }
      this.emit({ method: 'turn/completed', threadId, turnId, params: { threadId, turnId, status: terminal } });
    }
  }
}
```

- [ ] **Step 5: 修改 `src/approval-bridge.ts`**

在 `respond` 中，把方法判断从
`(!elicitation && !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(approval.method))`
改为
`(!elicitation && !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'claude/canUseTool'].includes(approval.method))`。
`result` 保持 `{decision}`，`ClaudeAgentRuntime.respondToServerRequest` 接收的正是这个形状。

- [ ] **Step 6: 运行测试，确认通过**

运行：`npx tsx --test tests/claude-runtime.test.ts && npm run typecheck && npm test`
预期：全部 PASS。

- [ ] **Step 7: 提交**

```bash
git add package.json package-lock.json src/runtime/types.ts src/runtime/claude-agent.ts src/approval-bridge.ts src/engine.ts tests/claude-runtime.test.ts
git commit -q -m "feat: add Claude Agent SDK runtime with journaled turns and approvals

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Claude 启动参数、角色说明，以及环境隔离

**Files:**
- Create: `src/runtime/role-instructions.ts`（从 `scripts/daemon.ts` 的 `developerInstructions` 字符串中抽出）
- Create: `src/runtime/claude-launch.ts`
- Modify: `src/runtime/tool-policy.ts`（新增 advisor 策略和 `LEAD_MEMORY_TOOLS`、`HANDOFF_TOOLS`）
- Modify: `scripts/daemon.ts`（改为调用 `roleInstructions`）
- Create: `tests/claude-launch.test.ts`
- Modify: `tests/role-launch.test.ts`（增加 Codex 侧不泄漏终端变量的断言）

**Interfaces:**
- Produces:
  - `roleInstructions(input: { role: RoleId; projectKey: string; scopeId: string; bindingKey: ScopeKey }): string`
  - `HANDOFF_TOOLS: readonly string[]`（7 个）、`LEAD_MEMORY_TOOLS: readonly string[]`
  - `workerToolPolicy('advisor')` 的 coordinator 列表为 `['automation_status','automation_events','automation_operation_get','automation_advice_get','automation_advice_complete']`
  - `interface ClaudeLaunchInput extends RoleLaunchInput { cwd: string; readOnly: boolean; extraReadDirs: string[]; instructions: string }`
  - `claudeRoleLaunch(input: ClaudeLaunchInput, source?: NodeJS.ProcessEnv): Record<string, unknown>`

- [ ] **Step 1: 写失败测试**

```ts
// tests/claude-launch.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeRoleLaunch } from '../src/runtime/claude-launch.js';
import { workerToolPolicy, HANDOFF_TOOLS } from '../src/runtime/tool-policy.js';

const enrollment = (role: string) => ({ role, projectKey: 'p', scopeId: 's', principal: { type: 'service' as const, id: `coordinator-${role}` }, authorizationEnv: `PC_${role.toUpperCase()}`, bindingKey: { integration: 'codex-session-coordinator', kind: 'role-session', external_id: `g/${role}/1` }, actions: ['scope.read'] });
const input = (role: 'audit' | 'frontend' | 'advisor', readOnly: boolean) => ({ role, groupId: 'g', generation: 1, capability: 'role-secret-0123456789abcdef', databasePath: '/state/db', socketPath: '/state/s', allowedRoots: ['/repo'], mcpScriptPath: '/c/dist/scripts/mcp-server.js', powerContextUrl: 'http://127.0.0.1:8787', enrollment: enrollment(role) as never, inheritedServerIds: [], cwd: '/repo', readOnly, extraReadDirs: ['/repo-fe'], instructions: 'Coordinator role.' });
const hostile = { HOME: '/h', PATH: '/bin', LANG: 'C', PC_AUDIT: 'Bearer audit', PC_FRONTEND: 'Bearer fe', PC_ADVISOR: 'Bearer adv', PC_LEAD: 'Bearer lead-should-not-leak', HERDR_PANE_ID: 'w9:p9-herdr-should-not-leak', HERDR_SOCKET_PATH: '/herdr-socket-should-not-leak', KITTY_PID: 'kitty-pid-should-not-leak', CLAUDE_CODE_MESSAGING_TOKEN: 'parent-token-should-not-leak', CLAUDE_CODE_MESSAGING_SOCKET: '/parent-socket-should-not-leak', ANTHROPIC_API_KEY: 'api-key-should-not-leak' };

test('Claude role launch passes an explicit allowlisted environment only', () => {
  const options = claudeRoleLaunch(input('audit', true), hostile) as { env: Record<string, string> };
  assert.deepEqual(Object.keys(options.env).sort(), ['HOME', 'LANG', 'PATH']);
  const serialized = JSON.stringify(options);
  for (const [key, value] of Object.entries(hostile)) if (value.includes('should-not-leak')) assert.equal(serialized.includes(value), false, key);
});

test('read-only roles get no write tools and a write-denied sandbox; workers may write only their worktree', () => {
  const audit = claudeRoleLaunch(input('audit', true), hostile) as Record<string, any>;
  assert.deepEqual(audit.settingSources, []); assert.equal(audit.strictMcpConfig, true);
  for (const tool of ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch']) assert.ok(audit.disallowedTools.includes(tool), tool);
  assert.ok(!audit.allowedTools.includes('Edit'));
  assert.deepEqual(audit.sandbox.filesystem.allowWrite, []);
  assert.equal(audit.sandbox.enabled, true); assert.equal(audit.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(audit.additionalDirectories, ['/repo-fe']);
  const frontend = claudeRoleLaunch(input('frontend', false), hostile) as Record<string, any>;
  assert.ok(frontend.allowedTools.includes('Edit'));
  assert.deepEqual(frontend.sandbox.filesystem.allowWrite, ['/repo']);
});

test('MCP servers carry only this role identity and tool allowlist', () => {
  const advisor = claudeRoleLaunch(input('advisor', true), hostile) as Record<string, any>;
  assert.deepEqual(Object.keys(advisor.mcpServers).sort(), ['coordinator_role', 'powercontext_role']);
  assert.equal(advisor.mcpServers.powercontext_role.headers.Authorization, 'Bearer adv');
  assert.equal(advisor.mcpServers.coordinator_role.env.COORDINATOR_ROLE, 'advisor');
  assert.equal(advisor.mcpServers.coordinator_role.env.COORDINATOR_WORKER_TOOL_POLICY, 'scoped-v1');
  const mcpAllowed = advisor.allowedTools.filter((tool: string) => tool.startsWith('mcp__coordinator_role__')).map((tool: string) => tool.slice('mcp__coordinator_role__'.length));
  assert.deepEqual(mcpAllowed, workerToolPolicy('advisor').coordinator);
  assert.ok(!mcpAllowed.includes('automation_dispatch') && !mcpAllowed.includes('automation_message_send'));
  for (const handoff of HANDOFF_TOOLS) assert.ok(!advisor.allowedTools.includes(`mcp__powercontext_role__${handoff}`));
  assert.throws(() => claudeRoleLaunch(input('advisor', true), { HOME: '/h' }), { code: 'FORBIDDEN' });
});
```

在 `tests/role-launch.test.ts` 末尾追加：

```ts
test('Codex role launch never forwards terminal or parent-agent variables', () => {
  const launch = roleLaunch({ role: 'frontend', groupId: 'g', generation: 1, capability: 'c'.repeat(32), databasePath: '/d', socketPath: '/s', allowedRoots: ['/r'], mcpScriptPath: '/m.js', powerContextUrl: 'http://127.0.0.1:8787', enrollment: { role: 'frontend', projectKey: 'p', scopeId: 's', principal: { type: 'service', id: 'coordinator-frontend' }, authorizationEnv: 'PC_FE', bindingKey: { integration: 'codex-session-coordinator', kind: 'role-session', external_id: 'g/frontend/1' }, actions: ['scope.read'] }, inheritedServerIds: [] }, { HOME: '/h', PATH: '/bin', PC_FE: 'Bearer x', HERDR_PANE_ID: 'w:p', HERDR_ENV: '1', KITTY_PID: '1', CLAUDE_CODE_MESSAGING_TOKEN: 't' });
  for (const key of Object.keys(launch.env)) assert.ok(!/^(HERDR_|KITTY_|CLAUDE_CODE_)/.test(key), key);
});
```

- [ ] **Step 2: 运行测试，确认失败**

运行：`npx tsx --test tests/claude-launch.test.ts tests/role-launch.test.ts`
预期：`claude-launch` 失败（找不到模块）；新增的 Codex 测试应该 PASS，它用来固定现有行为。

- [ ] **Step 3: 修改 `src/runtime/tool-policy.ts`**

```ts
export const HANDOFF_TOOLS = ['handoff_current_work', 'commit_handoff', 'continue_handoff', 'acknowledge_handoff', 'activate_handoff', 'finalize_handoff', 'get_handoff_report'] as const;
const POWERCONTEXT_READ = ['get_scope', 'search_memory', 'search_topic_memory', 'get_topic_memory', 'list_memory_entries', 'get_memory_entry'];
export const LEAD_MEMORY_TOOLS = [...POWERCONTEXT_READ, 'remember_memory'] as const;

export function workerToolPolicy(role: RoleId): { coordinator: string[]; powerContext: string[] } {
  if (role === 'advisor') return { coordinator: ['automation_status', 'automation_events', 'automation_operation_get', 'automation_advice_get', 'automation_advice_complete'], powerContext: [...POWERCONTEXT_READ] };
  const coordinator = ['automation_status', 'automation_events', 'automation_operation_get', 'automation_contract_ack', 'automation_work_complete', 'automation_message_send', 'automation_message_claim', 'automation_message_renew', 'automation_message_complete'];
  if (role === 'audit') coordinator.push('automation_validation_create', 'automation_validation_record');
  return { coordinator, powerContext: [...POWERCONTEXT_READ] };
}
```

在 `toolAnnotations` 中：`readOnly` 增加 `automation_advice_get`，`idempotent` 增加 `automation_advice_complete`。

- [ ] **Step 4: 创建 `src/runtime/role-instructions.ts`**

把 `scripts/daemon.ts` 第 57 行 `developerInstructions` 中的模板字符串原样移过来：

```ts
import type { RoleId } from '../protocol.js';
import type { ScopeKey } from '../integrations/powercontext.js';

export function roleInstructions(input: { role: RoleId; projectKey: string; scopeId: string; bindingKey: ScopeKey }): string {
  return `Coordinator role: ${input.role}. PowerContext project: ${input.projectKey}. The host has already verified role enrollment and binding. Do not call resolve_scope_binding or administration tools. Every PowerContext read must explicitly provide scope_id. Use Scope ${input.scopeId} and host binding key ${JSON.stringify(input.bindingKey)}. Never use Default Scope or a CLI Task session as the PowerContext identity. ${input.role === 'advisor' ? 'Give advice only through automation_advice_complete with the adviceId named in the package; never edit files.' : 'Complete work through automation_work_complete with business evidence; turn completion does not accept a task.'}`;
}
```

`scripts/daemon.ts` 中的对应位置改为 `developerInstructions: roleInstructions(enrollmentFor(role))`，其中 `enrollmentFor = (role) => config.powerContext!.roles.find((item) => item.role === role)!`。对于 frontend、backend、audit，生成的字符串与原来完全一致。

- [ ] **Step 5: 实现 `src/runtime/claude-launch.ts`**

```ts
import { CoordinatorError } from '../errors.js';
import type { RoleLaunchInput } from './role-launch.js';
import { HANDOFF_TOOLS, workerToolPolicy } from './tool-policy.js';

export interface ClaudeLaunchInput extends RoleLaunchInput { cwd: string; readOnly: boolean; extraReadDirs: string[]; instructions: string; }
const BASE_ENV = ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL'];

export function claudeRoleLaunch(input: ClaudeLaunchInput, source: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const authorization = source[input.enrollment.authorizationEnv];
  if (input.enrollment.role !== input.role || !authorization) throw new CoordinatorError('FORBIDDEN', 'Role launch requires its own enrolled credential.', 'Verify the role identity and controlled credential reference.');
  const env: Record<string, string> = {};
  for (const key of BASE_ENV) { const value = source[key]; if (value) env[key] = value; }
  const roleEnv = { COORDINATOR_WORKER_TOOL_POLICY: 'scoped-v1', COORDINATOR_ROLE: input.role, COORDINATOR_GROUP_ID: input.groupId, COORDINATOR_BINDING_GENERATION: String(input.generation), COORDINATOR_CAPABILITY: input.capability, COORDINATOR_DB_PATH: input.databasePath, COORDINATOR_SOCKET_PATH: input.socketPath, COORDINATOR_ALLOWED_ROOTS: JSON.stringify(input.allowedRoots), ...(env.PATH ? { PATH: env.PATH } : {}), ...(env.HOME ? { HOME: env.HOME } : {}) };
  const policy = workerToolPolicy(input.role);
  const mcpTools = [...policy.coordinator.map((tool) => `mcp__coordinator_role__${tool}`), ...policy.powerContext.filter((tool) => !(HANDOFF_TOOLS as readonly string[]).includes(tool)).map((tool) => `mcp__powercontext_role__${tool}`)];
  const builtin = input.readOnly ? ['Read', 'Glob', 'Grep', 'Bash'] : ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'];
  return {
    env,
    settingSources: [],
    strictMcpConfig: true,
    permissionMode: 'default',
    mcpServers: {
      coordinator_role: { type: 'stdio', command: process.execPath, args: [input.mcpScriptPath], env: roleEnv },
      powercontext_role: { type: 'http', url: new URL('/mcp/', input.powerContextUrl).href, headers: { Authorization: authorization } }
    },
    allowedTools: [...builtin, ...mcpTools],
    disallowedTools: [...(input.readOnly ? ['Edit', 'Write', 'NotebookEdit'] : ['NotebookEdit']), 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill'],
    additionalDirectories: [...input.extraReadDirs],
    sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, filesystem: { allowWrite: input.readOnly ? [] : [input.cwd] } },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: input.instructions }
  };
}
```

> 如果 Task 0 Step 2 的结论是 SDK 会把 `options.env` 与 `process.env` 合并，就在这里给 `env` 补上所有不在白名单里的 `process.env` 键，值设为 `undefined`（SDK 的类型允许 `string | undefined`），并在测试里断言这些键存在且值为 `undefined`。

- [ ] **Step 6: 运行测试，确认通过**

运行：`npx tsx --test tests/claude-launch.test.ts tests/role-launch.test.ts && npm run typecheck && npm test`
预期：全部 PASS。

- [ ] **Step 7: 提交**

```bash
git add src/runtime/tool-policy.ts src/runtime/role-instructions.ts src/runtime/claude-launch.ts scripts/daemon.ts tests/claude-launch.test.ts tests/role-launch.test.ts
git commit -q -m "feat: build isolated Claude role launch options

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 按轮次记录用量（两种 agent）

**Files:**
- Create: `src/runtime/turn-usage.ts`
- Modify: `src/runtime/app-server.ts`（记录用量通知，实现 `readTurnUsage`）
- Modify: `src/engine.ts`（在 `finishReceipt` 中写入用量）
- Create: `tests/turn-usage.test.ts`

**Interfaces:**
- Consumes: `TurnUsage`（Task 6）
- Produces:
  - `class TurnUsageLedger { constructor(path); record(input: { groupId; roleId; agent: AgentKind; dispatchId; threadId; turnId; usage: TurnUsage }): void; get(dispatchId): (TurnUsage & { agent: AgentKind }) | undefined; close() }`
  - `codexUsageFromNotification(params: unknown): { turnId: string; usage: TurnUsage } | undefined`
  - `CODEX_USAGE_METHOD`：通知方法名，取 Task 0 Step 5 记录的值（默认 `'thread/tokenUsage/updated'`）

- [ ] **Step 1: 写失败测试**

```ts
// tests/turn-usage.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TurnUsageLedger, codexUsageFromNotification, CODEX_USAGE_METHOD } from '../src/runtime/turn-usage.js';
import { AppServerRuntime } from '../src/runtime/app-server.js';

test('ledger records one row per dispatch and rejects conflicting rewrites', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'));
  const ledger = new TurnUsageLedger(join(dir, 's.sqlite'));
  try {
    const usage = { inputTokens: 10, outputTokens: 2, cachedInputTokens: 3, costUsd: null, source: 'codex_notification' as const };
    ledger.record({ groupId: 'g', roleId: 'frontend', agent: 'codex', dispatchId: 'd', threadId: 't', turnId: 'u', usage });
    ledger.record({ groupId: 'g', roleId: 'frontend', agent: 'codex', dispatchId: 'd', threadId: 't', turnId: 'u', usage });
    assert.deepEqual(ledger.get('d'), { ...usage, agent: 'codex' });
    assert.throws(() => ledger.record({ groupId: 'g', roleId: 'frontend', agent: 'codex', dispatchId: 'd', threadId: 't', turnId: 'u', usage: { ...usage, inputTokens: 99 } }), { code: 'RECONCILIATION_REQUIRED' });
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('codex usage notification maps to per-turn usage', async () => {
  const sample = { threadId: 'th', turnId: 'tu', tokenUsage: { last: { inputTokens: 120, cachedInputTokens: 40, outputTokens: 30 } } };
  assert.deepEqual(codexUsageFromNotification(sample), { turnId: 'tu', usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 40, costUsd: null, source: 'codex_notification' } });
  assert.equal(codexUsageFromNotification({ threadId: 'th' }), undefined);
  const input = new PassThrough(); const output = new PassThrough();
  const runtime = new AppServerRuntime({ input, output });
  input.write(JSON.stringify({ jsonrpc: '2.0', method: CODEX_USAGE_METHOD, params: sample }) + '\n');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await runtime.readTurnUsage('th', 'tu'))?.inputTokens, 120);
  runtime.dispose();
});
```

> `sample` 的字段名必须与 Task 0 Step 5 记录的一致。如果实际 schema 不同，同时修改 `sample` 和 `codexUsageFromNotification`。

- [ ] **Step 2: 运行测试，确认失败**

运行：`npx tsx --test tests/turn-usage.test.ts`
预期：失败，找不到模块。

- [ ] **Step 3: 实现 `src/runtime/turn-usage.ts`**

```ts
import { DatabaseSync } from 'node:sqlite';
import { CoordinatorError } from '../errors.js';
import type { AgentKind, RoleId } from '../roles.js';
import type { TurnUsage } from './types.js';

export const CODEX_USAGE_METHOD = 'thread/tokenUsage/updated';
const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function codexUsageFromNotification(params: unknown): { turnId: string; usage: TurnUsage } | undefined {
  const value = params as { turnId?: unknown; tokenUsage?: { last?: { inputTokens?: unknown; cachedInputTokens?: unknown; outputTokens?: unknown } } } | undefined;
  const last = value?.tokenUsage?.last;
  if (typeof value?.turnId !== 'string' || !last) return undefined;
  return { turnId: value.turnId, usage: { inputTokens: count(last.inputTokens), outputTokens: count(last.outputTokens), cachedInputTokens: count(last.cachedInputTokens), costUsd: null, source: 'codex_notification' } };
}

export class TurnUsageLedger {
  private readonly db: DatabaseSync;
  constructor(path: string) { this.db = new DatabaseSync(path); this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS turn_usage(dispatch_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, role_id TEXT NOT NULL, agent TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, payload_json TEXT NOT NULL, recorded_at TEXT NOT NULL)'); }
  close(): void { this.db.close(); }
  record(input: { groupId: string; roleId: RoleId; agent: AgentKind; dispatchId: string; threadId: string; turnId: string; usage: TurnUsage }): void {
    const payload = JSON.stringify({ ...input.usage, agent: input.agent });
    const existing = this.db.prepare('SELECT payload_json,turn_id FROM turn_usage WHERE dispatch_id=?').get(input.dispatchId) as { payload_json: string; turn_id: string } | undefined;
    if (existing) { if (existing.payload_json !== payload || existing.turn_id !== input.turnId) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Recorded turn usage conflicts with new evidence.', 'Keep the original usage record and inspect the runtime.'); return; }
    this.db.prepare('INSERT INTO turn_usage VALUES(?,?,?,?,?,?,?,?)').run(input.dispatchId, input.groupId, input.roleId, input.agent, input.threadId, input.turnId, payload, new Date().toISOString());
  }
  get(dispatchId: string): (TurnUsage & { agent: AgentKind }) | undefined {
    const row = this.db.prepare('SELECT payload_json FROM turn_usage WHERE dispatch_id=?').get(dispatchId) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as TurnUsage & { agent: AgentKind } : undefined;
  }
}
```

- [ ] **Step 4: 让 `AppServerRuntime` 记录用量通知**

在 `src/runtime/app-server.ts` 中：新增字段 `private readonly usage = new Map<string, TurnUsage>();`；在 `onLine` 中，组装 `event` 之前加入：

```ts
      if (message.method === CODEX_USAGE_METHOD) { const parsed = codexUsageFromNotification(message.params); if (parsed) this.usage.set(parsed.turnId, parsed.usage); }
```

再新增方法 `async readTurnUsage(_threadId: string, turnId: string): Promise<TurnUsage | undefined> { return this.usage.get(turnId); }`。

- [ ] **Step 5: 在 engine 中写入用量**

`src/engine.ts`：新增字段 `private readonly usage: TurnUsageLedger;`，在构造函数中 `this.usage = new TurnUsageLedger(options.databasePath);`，并在 `close()` 中关闭。在 `finishReceipt` 中，`readTurnModel` 那段之后加入：

```ts
      const usage=await runtime.handle.runtime.readTurnUsage?.(runtime.threadId,current.turnId);
      if(usage)this.usage.record({groupId:run.actor.groupId,roleId:run.actor.roleId,agent:this.options.agentFor?.(run.actor.roleId)??'codex',dispatchId:current.dispatchId,threadId:runtime.threadId,turnId:current.turnId,usage});
```

`EngineOptions` 增加 `agentFor?: (role: RoleId) => AgentKind;`。

- [ ] **Step 6: 运行测试，确认通过**

运行：`npx tsx --test tests/turn-usage.test.ts && npm run typecheck && npm test`
预期：全部 PASS。

- [ ] **Step 7: 提交**

```bash
git add src/runtime/turn-usage.ts src/runtime/app-server.ts src/engine.ts tests/turn-usage.test.ts
git commit -q -m "feat: record per-dispatch token usage for both agents

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 运行时工厂、派发时标注 agent，以及 daemon 接线

**Files:**
- Create: `src/runtime/factory.ts`
- Modify: `src/scheduler.ts`（`ExecutionPackage` 增加 `agent?: AgentKind`）
- Modify: `src/engine.ts`（派发时写入 `agent`；`pump` 从 outbox 入队时保留 `agent`）
- Modify: `scripts/daemon.ts`（改用 `createRuntimeFactory`，传入 `agentFor`）
- Create: `tests/runtime-factory.test.ts`

**Interfaces:**
- Consumes: `claudeRoleLaunch`、`roleInstructions`（Task 7）；`ClaudeAgentRuntime`、`ClaudeTurnJournal`（Task 5、6）；`roleLaunch`、`startLocalAppServer`（已有）；`agentFor`（Task 2）
- Produces:
  - `readOnlyRole(config: RuntimeConfig, role: RoleId, cwd: string, now?: number): boolean`
  - `createRuntimeFactory(deps: RuntimeFactoryDeps): (role: RoleId, cwd: string) => ManagedRuntime`
  - `interface RuntimeFactoryDeps { config: RuntimeConfig; credentials: Partial<Record<RoleId, string>>; roleMcpScript: string; inheritedServers: string[]; claudeQuery: ClaudeQueryFn; transcriptRoot: string; env?: NodeJS.ProcessEnv; startCodex?: typeof startLocalAppServer }`

- [ ] **Step 1: 写失败测试**

```ts
// tests/runtime-factory.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeFactory, readOnlyRole } from '../src/runtime/factory.js';
import { ClaudeAgentRuntime } from '../src/runtime/claude-agent.js';
import { MockRuntime } from '../src/runtime/mock.js';
import { engineFixture } from './fixtures/engine-fixture.js';

const enrollment = (role: string) => ({ role, projectKey: 'p', scopeId: 's', principal: { type: 'service', id: `coordinator-${role}` }, authorizationEnv: `PC_${role.toUpperCase()}`, bindingKey: { integration: 'codex-session-coordinator', kind: 'role-session', external_id: `g/${role}/1` }, actions: ['scope.read'] });
const config = (mode: 'mock' | 'app_server') => ({ groupId: 'g', mode, leadMode: 'external', databasePath: '/tmp/x.sqlite', socketPath: '/tmp/s', credentialFile: '/tmp/c', humanCredentialFile: '/tmp/h', allowedRoots: ['/repo'], repositories: [{ repositoryId: 'r', worktreePath: '/repo' }, { repositoryId: 'r', worktreePath: '/fe' }], roles: { audit: { agent: 'claude' }, advisor: { agent: 'claude' } }, workerTasks: [{ role: 'frontend', binding: { taskRef: 'f', owner: 'o', repositoryId: 'r', worktreePath: '/fe', expectedVersion: 1 }, sessionId: 's', expiresAt: new Date(Date.now() + 3600_000).toISOString() }], powerContext: { baseUrl: 'http://127.0.0.1:8787', roles: ['lead', 'frontend', 'backend', 'audit', 'advisor'].map(enrollment) } }) as never;

test('read-only decision covers audit, advisor and unenrolled workers', () => {
  assert.equal(readOnlyRole(config('app_server'), 'audit', '/repo'), true);
  assert.equal(readOnlyRole(config('app_server'), 'advisor', '/repo'), true);
  assert.equal(readOnlyRole(config('app_server'), 'frontend', '/fe'), false);
  assert.equal(readOnlyRole(config('app_server'), 'backend', '/repo'), true);
  assert.equal(readOnlyRole(config('app_server'), 'frontend', '/fe', Date.now() + 7200_000), true);
});

test('factory picks the runtime by role agent and never starts codex for claude roles', () => {
  const codexStarts: string[] = [];
  const env = { HOME: '/h', PATH: '/bin', PC_AUDIT: 'Bearer a', PC_ADVISOR: 'Bearer b', PC_FRONTEND: 'Bearer f' };
  const factory = createRuntimeFactory({ config: config('app_server'), credentials: { audit: 'a'.repeat(40), advisor: 'b'.repeat(40), frontend: 'f'.repeat(40) }, roleMcpScript: '/m.js', inheritedServers: [], claudeQuery: () => { throw new Error('no turn in this test'); }, transcriptRoot: '/tmp', env, startCodex: ((cwd: string) => { codexStarts.push(cwd); return { runtime: new MockRuntime() as never, close: async () => {} }; }) as never });
  const audit = factory('audit', '/repo');
  assert.ok(audit.runtime instanceof ClaudeAgentRuntime);
  factory('frontend', '/fe');
  assert.deepEqual(codexStarts, ['/fe']);
  const mock = createRuntimeFactory({ config: config('mock'), credentials: {}, roleMcpScript: '/m.js', inheritedServers: [], claudeQuery: () => { throw new Error('x'); }, transcriptRoot: '/tmp' });
  assert.ok(mock('audit', '/repo').runtime instanceof MockRuntime);
});

test('dispatch stamps the executing agent and keeps it through the outbox', async () => {
  const f = await engineFixture();
  try {
    (f.options as { agentFor?: (role: string) => string }).agentFor = (role) => role === 'backend' ? 'claude' : 'codex';
    await f.engine.execute(f.backend, 'automation_role_initialize', { cwd: f.dir });
    await f.engine.execute(f.lead, 'automation_dispatch', f.dispatch);
    const [work] = f.engine.scheduler.list('g');
    assert.equal((work as { agent?: string }).agent, 'claude');
  } finally { await f.cleanup(); }
});
```

> `engineFixture` 返回的 `options` 对象就是传给 engine 的那个对象。测试直接修改它，是因为 engine 每次都会读取 `this.options.agentFor`。如果 fixture 里 `options` 被复制过，就给 `engineFixture` 加一个可选参数 `extra?: Partial<EngineOptions>`，合并进 `options` 后再创建 engine。

- [ ] **Step 2: 运行测试，确认失败**

运行：`npx tsx --test tests/runtime-factory.test.ts`
预期：失败，找不到模块。

- [ ] **Step 3: 实现 `src/runtime/factory.ts`**

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RoleId } from '../protocol.js';
import { agentFor, type RuntimeConfig } from '../runtime-config.js';
import type { RoleEnrollment } from '../integrations/powercontext.js';
import { startLocalAppServer } from './app-server.js';
import { ClaudeAgentRuntime, type ClaudeQueryFn } from './claude-agent.js';
import { ClaudeTurnJournal } from './claude-journal.js';
import { claudeRoleLaunch } from './claude-launch.js';
import { MockRuntime } from './mock.js';
import { roleInstructions } from './role-instructions.js';
import { roleLaunch } from './role-launch.js';
import type { ManagedRuntime } from './types.js';

export interface RuntimeFactoryDeps { config: RuntimeConfig; credentials: Partial<Record<RoleId, string>>; roleMcpScript: string; inheritedServers: string[]; claudeQuery: ClaudeQueryFn; transcriptRoot?: string; env?: NodeJS.ProcessEnv; startCodex?: typeof startLocalAppServer; }

export function readOnlyRole(config: RuntimeConfig, role: RoleId, cwd: string, now = Date.now()): boolean {
  if (role === 'audit' || role === 'advisor') return true;
  return Boolean(config.externalTaskObservation) && !config.workerTasks?.some((worker) => worker.role === role && worker.binding.worktreePath === cwd && Date.parse(worker.expiresAt) > now);
}

export function createRuntimeFactory(deps: RuntimeFactoryDeps): (role: RoleId, cwd: string) => ManagedRuntime {
  const { config } = deps;
  const env = deps.env ?? process.env;
  return (role, cwd) => {
    if (config.mode === 'mock') return { runtime: new MockRuntime(), close: async () => {} };
    const enrollment = config.powerContext!.roles.find((item) => item.role === role) as RoleEnrollment;
    const capability = deps.credentials[role];
    if (!enrollment || !capability) throw new Error(`Role ${role} has no enrollment or credential.`);
    const launch = { role, groupId: config.groupId, generation: 1, capability, databasePath: config.databasePath, socketPath: config.socketPath, allowedRoots: config.allowedRoots, mcpScriptPath: deps.roleMcpScript, powerContextUrl: config.powerContext!.baseUrl, enrollment, inheritedServerIds: deps.inheritedServers };
    const readOnly = readOnlyRole(config, role, cwd);
    const instructions = roleInstructions(enrollment);
    if (agentFor(config, role) === 'claude') {
      const journal = new ClaudeTurnJournal(config.databasePath);
      const baseOptions = claudeRoleLaunch({ ...launch, cwd, readOnly, extraReadDirs: config.repositories.map((repository) => repository.worktreePath).filter((path) => path !== cwd), instructions }, env);
      const runtime = new ClaudeAgentRuntime({ query: deps.claudeQuery, journal, baseOptions, transcriptRoot: deps.transcriptRoot ?? join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects') });
      return { runtime, close: async () => { journal.close(); } };
    }
    return (deps.startCodex ?? startLocalAppServer)(cwd, { ...roleLaunch(launch, env), threadPolicy: { sandbox: readOnly ? 'read-only' : 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user', developerInstructions: instructions } });
  };
}
```

- [ ] **Step 4: 派发时写入 agent，入队时保留 agent**

`src/scheduler.ts` 中，`ExecutionPackage` 增加 `agent?: AgentKind;`。

`src/engine.ts`：
- `automation_dispatch` 中，把 `dispatcher.dispatch(actor, …, { ...request.work, worktree: cwd, allowedPaths }, …)` 的第三个参数改为 `{ ...request.work, worktree: cwd, allowedPaths, agent: this.options.agentFor?.(request.work.roleId) ?? 'codex' }`；
- `pump` 中，outbox 入队那一行改为 `this.scheduler.enqueue({ ...work, ...(typeof payload.agent === 'string' ? { agent: payload.agent as AgentKind } : {}), taskBinding: …, model: … }, message.groupId, message.messageId);`。

- [ ] **Step 5: daemon 接线**

`scripts/daemon.ts`：
- `inheritedServers` 只在有角色使用 codex 时才读取：`const anyCodex = ROLE_IDS.some((role) => role !== 'lead' && agentFor(config, role) === 'codex'); const inheritedServers = config.mode === 'app_server' && anyCodex ? await inheritedMcpServerIds() : [];`
- `runtimeFactory: createRuntimeFactory({ config, credentials: credentials.credentials, roleMcpScript, inheritedServers, claudeQuery: query as unknown as ClaudeQueryFn })`，其中 `import { query } from '@anthropic-ai/claude-agent-sdk';`
- `CoordinatorEngine` 的 options 增加 `agentFor: (role) => agentFor(config, role)` 和 `advisor: { suggestAfterRejections: config.advisor?.suggestAfterRejections ?? 2 }`（`advisor` 字段在 Task 11 中使用；这里先加入 `EngineOptions` 的类型：`advisor?: { suggestAfterRejections: number }`）。

- [ ] **Step 6: 运行测试，确认通过**

运行：`npx tsx --test tests/runtime-factory.test.ts && npm run typecheck && npm test && npm run build`
预期：全部 PASS，构建成功。

- [ ] **Step 7: 提交**

```bash
git add src/runtime/factory.ts src/scheduler.ts src/engine.ts scripts/daemon.ts tests/runtime-factory.test.ts tests/fixtures/engine-fixture.ts
git commit -q -m "feat: create role runtimes by configured agent

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: advisor 建议（请求、完成、查询、决定）

**Files:**
- Create: `src/advice.ts`
- Modify: `src/engine.ts`（合并 `adviceSchemas`；新增 4 个命令；把 `automation_work_complete` 的主体抽成 `completeReceipt`）
- Modify: `tests/fixtures/engine-fixture.ts`（加入 advisor 凭据和 actor）
- Create: `tests/advice.test.ts`

**Interfaces:**
- Consumes: `WorkDispatcher`、`scheduler`、`validations`（已有）；`agentFor`（`EngineOptions`）；`advisorBudget`（Task 3）
- Produces:
  - `adviceSchemas`：`automation_advice_request`、`automation_advice_complete`、`automation_advice_get`、`automation_advice_resolve`
  - `interface AdviceRecord { adviceId: string; groupId: string; dispatchId: string; kind: 'consult' | 'arbitration'; question: string; refs: AdviceRefs; state: 'requested' | 'completed' | 'resolved'; agents: { advisor: AgentKind; worker: AgentKind[]; audit: AgentKind[] }; sameSource: boolean; result?: AdviceResult; resolution?: { decision: 'adopted' | 'rejected' | 'partial'; note: string; resolvedAt: string }; createdAt: string }`
  - `class AdviceRegistry { create(record); get(adviceId); byDispatch(dispatchId); complete(adviceId, result); resolve(adviceId, resolution); close() }`
  - `buildAdvicePackage(input: { adviceId: string; kind; question; refs; binding: TaskBinding }): ExecutionPackage`

- [ ] **Step 1: 写失败测试**

```ts
// tests/advice.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { engineFixture } from './fixtures/engine-fixture.js';

async function withAdvisor() {
  const f = await engineFixture();
  const advisor = f.engine.authenticate('advisor', f.credentials.advisor, 1);
  const audit = f.engine.authenticate('audit', f.credentials.audit, 1);
  (f.options as { agentFor?: (role: string) => string }).agentFor = (role) => ['audit', 'advisor', 'backend'].includes(role) ? 'claude' : 'codex';
  // managed lead mode only pumps once the lead runtime exists
  await f.engine.execute(f.lead, 'automation_role_initialize', { cwd: f.dir });
  await f.engine.execute(advisor, 'automation_role_initialize', { cwd: f.dir });
  return { ...f, advisor, audit };
}
const request = (f: Awaited<ReturnType<typeof withAdvisor>>, extra: object = {}) => ({ binding: f.dispatch.binding, kind: 'consult', question: 'Which metric definition is safer?', refs: { contractRef: f.dispatch.work.contractRef, contractRevision: 'v1' }, operationId: 'advice-1', ...extra });

test('consult goes through the advisor queue and lead records a single decision', async () => {
  const f = await withAdvisor();
  try {
    const created = await f.engine.execute(f.lead, 'automation_advice_request', request(f)) as { adviceId: string; dispatchId: string; sameSource: boolean };
    assert.equal(created.sameSource, false);
    assert.deepEqual(await f.engine.execute(f.lead, 'automation_advice_request', request(f)), created, 'idempotent replay');
    await f.engine.pump();
    const [work] = f.engine.scheduler.list('g').filter((item) => item.roleId === 'advisor');
    assert.equal(work!.state, 'active');
    assert.equal(f.engine.advisorBudget.status().callsUsed, 1);
    assert.equal(f.engine.budget.status().callsUsed, 0);
    await assert.rejects(f.engine.execute(f.backend, 'automation_advice_complete', { adviceId: created.adviceId, recommendation: 'x', rationale: 'y', risks: [], confidence: 'high', evidenceRefs: ['e'] }), { code: 'FORBIDDEN' });
    const done = await f.engine.execute(f.advisor, 'automation_advice_complete', { adviceId: created.adviceId, recommendation: 'Use verified rows only', rationale: 'Unverified rows mislead', risks: ['small samples'], confidence: 'medium', evidenceRefs: ['src/dashboard/projection.ts'] }) as { status: string };
    assert.equal(done.status, 'completed');
    const got = await f.engine.execute(f.lead, 'automation_advice_get', { adviceId: created.adviceId }) as { state: string; agents: { advisor: string } };
    assert.equal(got.state, 'completed'); assert.equal(got.agents.advisor, 'claude');
    await f.engine.execute(f.lead, 'automation_advice_resolve', { adviceId: created.adviceId, decision: 'adopted', note: 'Matches spec', operationId: 'resolve-1' });
    await assert.rejects(f.engine.execute(f.lead, 'automation_advice_resolve', { adviceId: created.adviceId, decision: 'rejected', note: 'changed mind', operationId: 'resolve-2' }), { code: 'CONFLICT' });
  } finally { await f.cleanup(); }
});

test('arbitration requires a verdict and never changes the audit record', async () => {
  const f = await withAdvisor();
  try {
    const validation = await f.engine.execute(f.audit, 'automation_validation_create', { contractRef: f.dispatch.work.contractRef, baselineRef: 'base', operationId: 'v1' }) as { validationId: string };
    await f.engine.execute(f.audit, 'automation_validation_record', { validationId: validation.validationId, outcome: 'rejected', evidence: [{ command: 'npm test', outcome: 'failed', summary: 'regression' }] });
    await assert.rejects(f.engine.execute(f.lead, 'automation_advice_request', request(f, { kind: 'arbitration', operationId: 'arb-0' })), { code: 'INVALID_INPUT' });
    const created = await f.engine.execute(f.lead, 'automation_advice_request', request(f, { kind: 'arbitration', refs: { contractRef: f.dispatch.work.contractRef, contractRevision: 'v1', validationIds: [validation.validationId] }, operationId: 'arb-1' })) as { adviceId: string };
    await f.engine.pump();
    await assert.rejects(f.engine.execute(f.advisor, 'automation_advice_complete', { adviceId: created.adviceId, recommendation: 'r', rationale: 'r', risks: [], confidence: 'low', evidenceRefs: ['e'] }), { code: 'INVALID_INPUT' });
    await f.engine.execute(f.advisor, 'automation_advice_complete', { adviceId: created.adviceId, recommendation: 'Overturn', rationale: 'Test was flaky', risks: [], confidence: 'low', evidenceRefs: ['log'], verdict: 'overturn' });
    assert.equal(f.engine.collaboration.validations.get(validation.validationId)!.state, 'rejected');
  } finally { await f.cleanup(); }
});

test('advice requests fail closed without an initialized advisor or with an unknown validation', async () => {
  const f = await engineFixture();
  try {
    await assert.rejects(f.engine.execute(f.lead, 'automation_advice_request', { binding: f.dispatch.binding, kind: 'consult', question: 'q', refs: { contractRef: f.dispatch.work.contractRef, contractRevision: 'v1' }, operationId: 'a' }), { code: 'TASK_GATE_CLOSED' });
  } finally { await f.cleanup(); }
  const g = await withAdvisor();
  try {
    await assert.rejects(g.engine.execute(g.lead, 'automation_advice_request', request(g, { kind: 'arbitration', refs: { contractRef: g.dispatch.work.contractRef, contractRevision: 'v1', validationIds: ['missing'] }, operationId: 'x' })), { code: 'INVALID_INPUT' });
  } finally { await g.cleanup(); }
});
```

修改 `tests/fixtures/engine-fixture.ts`：`credentials` 增加 `advisor: 'advisor-capability-0123456789abcdef01'`；为了兼容第二个参数，`engineFixture` 的签名改为 `engineFixture(mockBudget?, extra: Partial<EngineOptions> = {})`，并把 `extra` 合并进 `options`。

- [ ] **Step 2: 运行测试，确认失败**

运行：`npx tsx --test tests/advice.test.ts`
预期：失败，`automation_advice_request` 是未知命令（`COMMAND_NOT_FOUND`）。

- [ ] **Step 3: 实现 `src/advice.ts`**

```ts
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { bindingSchema } from './bindings.js';
import { CoordinatorError } from './errors.js';
import type { AgentKind } from './roles.js';
import type { ExecutionPackage } from './scheduler.js';
import type { TaskBinding } from './integrations/adapters.js';

const id = z.string().min(1).max(200);
const refsSchema = z.object({ contractRef: id, contractRevision: id, dispatchIds: z.array(id).max(20).default([]), validationIds: z.array(id).max(20).default([]), paths: z.array(z.string().min(1).max(500)).max(20).default([]) }).strict();
export const adviceSchemas = {
  automation_advice_request: z.object({ binding: bindingSchema, kind: z.enum(['consult', 'arbitration']), question: z.string().min(1).max(4000), refs: refsSchema, operationId: id }).strict(),
  automation_advice_complete: z.object({ adviceId: id, recommendation: z.string().min(1).max(8000), rationale: z.string().min(1).max(8000), risks: z.array(z.string().min(1).max(1000)).max(20), confidence: z.enum(['low', 'medium', 'high']), evidenceRefs: z.array(z.string().min(1).max(500)).min(1).max(20), verdict: z.enum(['uphold_rejection', 'overturn', 'needs_more_evidence']).optional() }).strict(),
  automation_advice_get: z.object({ adviceId: id }).strict(),
  automation_advice_resolve: z.object({ adviceId: id, decision: z.enum(['adopted', 'rejected', 'partial']), note: z.string().min(1).max(4000), operationId: id }).strict()
};
export type AdviceRefs = z.infer<typeof refsSchema>;
export type AdviceResult = Omit<z.infer<typeof adviceSchemas.automation_advice_complete>, 'adviceId'> & { completedAt: string };
export interface AdviceRecord { adviceId: string; groupId: string; dispatchId: string; kind: 'consult' | 'arbitration'; question: string; refs: AdviceRefs; state: 'requested' | 'completed' | 'resolved'; agents: { advisor: AgentKind; worker: AgentKind[]; audit: AgentKind[] }; sameSource: boolean; result?: AdviceResult; resolution?: { decision: 'adopted' | 'rejected' | 'partial'; note: string; resolvedAt: string }; createdAt: string; }

export function buildAdvicePackage(input: { adviceId: string; kind: 'consult' | 'arbitration'; question: string; refs: AdviceRefs; binding: TaskBinding }): ExecutionPackage {
  return {
    id: `advice:${input.adviceId}`, roleId: 'advisor', taskRef: input.binding.taskRef, repository: input.binding.repositoryId, worktree: input.binding.worktreePath,
    goal: `Advisor ${input.kind} request ${input.adviceId}. Question: ${input.question}\nEvidence references: ${JSON.stringify(input.refs)}\nWork read-only. Reply exactly once through automation_advice_complete with adviceId ${input.adviceId}${input.kind === 'arbitration' ? ' and a verdict' : ''}.`,
    allowedPaths: input.refs.paths.length ? input.refs.paths : ['.'], baseline: 'advice', contractRef: input.refs.contractRef, contractRevision: input.refs.contractRevision,
    acceptanceCriteria: ['Structured advice recorded through automation_advice_complete'], verificationCommands: ['read-only review'], dependencies: [], risk: 0, evidenceFailures: 0, paused: false
  };
}

export class AdviceRegistry {
  private readonly db: DatabaseSync;
  constructor(path: string) { this.db = new DatabaseSync(path); this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS advice_requests(advice_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, dispatch_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, payload_json TEXT NOT NULL)'); }
  close(): void { this.db.close(); }
  create(record: AdviceRecord): void { this.db.prepare('INSERT INTO advice_requests VALUES(?,?,?,?,?)').run(record.adviceId, record.groupId, record.dispatchId, record.state, JSON.stringify(record)); }
  get(adviceId: string): AdviceRecord | undefined { const row = this.db.prepare('SELECT payload_json FROM advice_requests WHERE advice_id=?').get(adviceId) as { payload_json: string } | undefined; return row ? JSON.parse(row.payload_json) as AdviceRecord : undefined; }
  byDispatch(dispatchId: string): AdviceRecord | undefined { const row = this.db.prepare('SELECT payload_json FROM advice_requests WHERE dispatch_id=?').get(dispatchId) as { payload_json: string } | undefined; return row ? JSON.parse(row.payload_json) as AdviceRecord : undefined; }
  complete(adviceId: string, result: AdviceResult): AdviceRecord {
    const record = this.get(adviceId);
    if (!record) throw new CoordinatorError('INVALID_INPUT', 'Advice request is unknown.', 'Use the adviceId from the execution package.');
    if (record.state !== 'requested') { if (JSON.stringify({ ...record.result, completedAt: '' }) === JSON.stringify({ ...result, completedAt: '' })) return record; throw new CoordinatorError('IDEMPOTENCY_CONFLICT', 'Advice was already completed with different content.', 'Retry the original advice payload.'); }
    if ((record.kind === 'arbitration') !== Boolean(result.verdict)) throw new CoordinatorError('INVALID_INPUT', 'Arbitration advice needs a verdict; consultation advice must not include one.', 'Match the request kind.');
    const next: AdviceRecord = { ...record, state: 'completed', result };
    this.db.prepare("UPDATE advice_requests SET state='completed',payload_json=? WHERE advice_id=? AND state='requested'").run(JSON.stringify(next), adviceId);
    return next;
  }
  resolve(adviceId: string, resolution: NonNullable<AdviceRecord['resolution']>): AdviceRecord {
    const record = this.get(adviceId);
    if (!record || record.state === 'requested') throw new CoordinatorError('TASK_GATE_CLOSED', 'Advice is not ready for a decision.', 'Wait for the advisor result.');
    if (record.state === 'resolved') throw new CoordinatorError('CONFLICT', 'Advice decision was already recorded.', 'Keep the original decision; record follow-up as a new request.');
    const next: AdviceRecord = { ...record, state: 'resolved', resolution };
    this.db.prepare("UPDATE advice_requests SET state='resolved',payload_json=? WHERE advice_id=? AND state='completed'").run(JSON.stringify(next), adviceId);
    return next;
  }
}
```

- [ ] **Step 4: engine 接入**

在 `src/engine.ts` 中：
1. `automationSchemas` 合并 `...adviceSchemas`；新增字段 `readonly advice: AdviceRegistry`，在构造函数中初始化、在 `close()` 中关闭。
2. 把 `case 'automation_work_complete'` 的主体抽成私有方法，原 case 改为调用它：

```ts
  private async completeReceipt(actor: Actor, receipt: { dispatchId: string; summary: string; evidence: string[] }): Promise<{ status: string; finalAcceptance: 'human_only' }> {
    const recorded=this.scheduler.receipt(actor,receipt.dispatchId);
    if(recorded&&JSON.stringify(recorded)!==JSON.stringify(receipt))throw new CoordinatorError('IDEMPOTENCY_CONFLICT','Business receipt differs from its recorded contents.','Retry the original receipt.');
    if(recorded&&this.scheduler.get(receipt.dispatchId)?.state==='completed')return {status:'completed',finalAcceptance:'human_only'};
    const run = this.active.get(receipt.dispatchId);
    if (!run || run.actor.roleId !== actor.roleId || run.actor.bindingGeneration !== actor.bindingGeneration) throw new CoordinatorError('STALE_LEASE', 'No active dispatch belongs to this role binding.', 'Reconcile runtime and message receipts.');
    this.scheduler.recordReceipt(actor,receipt.dispatchId,run.lease.leaseToken,receipt);
    const completed=await this.finishReceipt(run);
    return {status:completed?'completed':'receipt_recorded',finalAcceptance:'human_only'};
  }
```

3. 在 `switch` 中新增：

```ts
      case 'automation_advice_request': {
        if (actor.roleId !== 'lead') throw new CoordinatorError('FORBIDDEN', 'Only lead can request advice.', 'Send the question to lead.');
        const request = adviceSchemas.automation_advice_request.parse(parsed.data);
        const replay = this.collaboration.operations.replay(actor, command, request.operationId, request);
        if (replay.found) return replay.result;
        const role = this.roles.get('advisor');
        if (!role) throw new CoordinatorError('TASK_GATE_CLOSED', 'Advisor role is not initialized.', 'Initialize the advisor runtime and identity.');
        const cwd = await resolveAuthorizedPath(request.binding.worktreePath, this.options.allowedRoots);
        if (cwd !== role.cwd) throw new CoordinatorError('TASK_GATE_CLOSED', 'Advisor worktree does not match the request binding.', 'Initialize the advisor in the lead worktree.');
        if (request.kind === 'arbitration' && request.refs.validationIds.length === 0) throw new CoordinatorError('INVALID_INPUT', 'Arbitration must reference the disputed validation.', 'Attach the rejected validationId.');
        for (const validationId of request.refs.validationIds) { const run = this.collaboration.validations.get(validationId); if (!run || run.groupId !== actor.groupId) throw new CoordinatorError('INVALID_INPUT', 'Referenced validation is unknown.', 'Use validation IDs from this group.'); }
        const workers = request.refs.dispatchIds.map((dispatchId) => { const work = this.scheduler.get(dispatchId); if (!work || work.groupId !== actor.groupId) throw new CoordinatorError('INVALID_INPUT', 'Referenced dispatch is unknown.', 'Use dispatch IDs from this group.'); return (work as { agent?: AgentKind }).agent ?? 'codex'; });
        const agentOf = (role: RoleId): AgentKind => this.options.agentFor?.(role) ?? 'codex';
        const agents = { advisor: agentOf('advisor'), worker: [...new Set(workers)], audit: request.refs.validationIds.length ? [agentOf('audit')] : [] };
        const sameSource = new Set([agents.advisor, ...agents.worker, ...agents.audit]).size === 1 && (agents.worker.length + agents.audit.length) > 0;
        return this.collaboration.operations.run(actor, command, request.operationId, request, async () => {
          const adviceId = randomUUID();
          const binding = { ...request.binding, worktreePath: cwd };
          const work = { ...buildAdvicePackage({ adviceId, kind: request.kind, question: request.question, refs: request.refs, binding }), agent: agents.advisor };
          this.contracts.assertUsable(actor.groupId, 'advisor', work.contractRef, work.contractRevision!);
          const dispatcher = new WorkDispatcher(this.store, this.options.taskAuthority, this.scheduler, this.options.runtimeSource === 'app_server' ? this.options.realExecution?.choices.advisor : undefined);
          const result = await dispatcher.dispatch(actor, binding, work, await role.handle.runtime.listModels(), `${request.operationId}:dispatch`);
          this.advice.create({ adviceId, groupId: actor.groupId, dispatchId: result.message.messageId, kind: request.kind, question: request.question, refs: request.refs, state: 'requested', agents, sameSource, createdAt: new Date().toISOString() });
          return { adviceId, dispatchId: result.message.messageId, state: 'requested', sameSource };
        });
      }
      case 'automation_advice_complete': {
        if (actor.roleId !== 'advisor') throw new CoordinatorError('FORBIDDEN', 'Only the advisor can complete advice.', 'Use the advisor connection.');
        const { adviceId, ...result } = adviceSchemas.automation_advice_complete.parse(parsed.data);
        const record = this.advice.get(adviceId);
        if (!record || record.groupId !== actor.groupId) throw new CoordinatorError('INVALID_INPUT', 'Advice request is unknown.', 'Use the adviceId from the execution package.');
        this.advice.complete(adviceId, { ...result, completedAt: new Date().toISOString() });
        const outcome = await this.completeReceipt(actor, { dispatchId: record.dispatchId, summary: result.recommendation, evidence: result.evidenceRefs });
        if (outcome.status === 'completed') this.store.send(actor, { type: 'test_debug', recipientRole: 'lead', payload: { kind: 'advice_ready', adviceId, adviceKind: record.kind, sameSource: record.sameSource } }, `advice-ready:${adviceId}`);
        return outcome;
      }
      case 'automation_advice_get': {
        if (actor.roleId !== 'lead' && actor.roleId !== 'advisor') throw new CoordinatorError('FORBIDDEN', 'Advice is visible to lead and advisor only.', 'Ask lead for the advice outcome.');
        const record = this.advice.get(adviceSchemas.automation_advice_get.parse(parsed.data).adviceId);
        if (!record || record.groupId !== actor.groupId) throw new CoordinatorError('INVALID_INPUT', 'Advice request is unknown.', 'Use an adviceId from this group.');
        return record;
      }
      case 'automation_advice_resolve': {
        if (actor.roleId !== 'lead') throw new CoordinatorError('FORBIDDEN', 'Only lead records advice decisions.', 'Use the lead connection.');
        const request = adviceSchemas.automation_advice_resolve.parse(parsed.data);
        return this.collaboration.operations.run(actor, command, request.operationId, request, () => this.advice.resolve(request.adviceId, { decision: request.decision, note: request.note, resolvedAt: new Date().toISOString() }));
      }
```

需要导入 `adviceSchemas`、`AdviceRegistry`、`buildAdvicePackage`，以及 `AgentKind`。`case 'automation_work_complete'` 改为 `return this.completeReceipt(actor, parsed.data as { dispatchId: string; summary: string; evidence: string[] });`。

`CONFLICT` 错误码已在 Task 1 中加入 `src/errors.ts`。

- [ ] **Step 5: 运行测试，确认通过**

运行：`npx tsx --test tests/advice.test.ts && npm run typecheck && npm test`
预期：全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add src/advice.ts src/engine.ts src/errors.ts tests/advice.test.ts tests/fixtures/engine-fixture.ts
git commit -q -m "feat: add advisor consultation and arbitration flow

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 异议消息与仲裁提示

**Files:**
- Modify: `src/auth.ts`（消息类型增加 `dispute`、`arbitration_suggested`）
- Modify: `src/collaboration.ts`（`message_send` 的规则；`validation_record` 之后的提示逻辑）
- Modify: `src/validation.ts`（新增 `consecutiveRejections`）
- Modify: `src/engine.ts`（把阈值传给 `CollaborationService`）
- Create: `tests/arbitration.test.ts`

**Interfaces:**
- Produces:
  - `ValidationRegistry.consecutiveRejections(groupId: string, contractRef: string): string[]`（从最近一轮往前数，连续 `rejected` 的 validationId，最新的在前）
  - `CollaborationService` 构造参数增加 `suggestAfterRejections = 2`
  - lead 收件箱消息：`{ type: 'arbitration_suggested', payload: { kind: 'arbitration_suggested', reason: 'consecutive_rejections' | 'dispute', contractRef, validationIds } }`

- [ ] **Step 1: 写失败测试**

```ts
// tests/arbitration.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { engineFixture } from './fixtures/engine-fixture.js';

const reject = async (f: Awaited<ReturnType<typeof engineFixture>>, audit: never, n: number) => {
  const run = await f.engine.execute(audit, 'automation_validation_create', { contractRef: f.dispatch.work.contractRef, baselineRef: `base-${n}`, operationId: `v-${n}` }) as { validationId: string };
  await f.engine.execute(audit, 'automation_validation_record', { validationId: run.validationId, outcome: 'rejected', evidence: [{ command: 'npm test', outcome: 'failed', summary: 'x' }] });
  return run.validationId;
};
const suggestions = (f: Awaited<ReturnType<typeof engineFixture>>) => f.engine.store.leadInbox('g').filter((message) => message.type === 'arbitration_suggested');

test('second consecutive rejection suggests arbitration exactly once per rejection', async () => {
  const f = await engineFixture(); const audit = f.engine.authenticate('audit', f.credentials.audit, 1) as never;
  try {
    await reject(f, audit, 1);
    assert.equal(suggestions(f).length, 0);
    const second = await reject(f, audit, 2);
    assert.equal(suggestions(f).length, 1);
    assert.deepEqual((suggestions(f)[0]!.payload as { validationIds: string[] }).validationIds[0], second);
    await reject(f, audit, 3);
    assert.equal(suggestions(f).length, 2);
  } finally { await f.cleanup(); }
});

test('worker dispute must reference a rejected validation and is routed to lead', async () => {
  const f = await engineFixture(); const audit = f.engine.authenticate('audit', f.credentials.audit, 1) as never;
  try {
    const rejected = await reject(f, audit, 1);
    await assert.rejects(f.engine.execute(f.backend, 'automation_message_send', { type: 'dispute', recipientRole: 'audit', payload: { validationId: rejected, reason: 'flaky' }, operationId: 'd0' }), { code: 'INVALID_INPUT' });
    await assert.rejects(f.engine.execute(f.backend, 'automation_message_send', { type: 'dispute', recipientRole: 'lead', payload: { validationId: 'missing', reason: 'flaky' }, operationId: 'd1' }), { code: 'INVALID_INPUT' });
    await f.engine.execute(f.backend, 'automation_message_send', { type: 'dispute', recipientRole: 'lead', payload: { validationId: rejected, reason: 'flaky test' }, operationId: 'd2' });
    assert.equal((suggestions(f)[0]!.payload as { reason: string }).reason, 'dispute');
    await assert.rejects(f.engine.execute(f.backend, 'automation_message_send', { type: 'arbitration_suggested', recipientRole: 'lead', payload: {}, operationId: 'd3' }), { code: 'FORBIDDEN' });
  } finally { await f.cleanup(); }
});
```

> 如果 `store.leadInbox` 只返回某种状态的消息、或者返回字段与这里不同，就改用 `f.engine.store.events('g', 0, 200)` 按事件类型过滤。用哪一种以 `src/store.ts` 的实际 API 为准，选定后在测试中写死。

- [ ] **Step 2: 运行测试，确认失败**

运行：`npx tsx --test tests/arbitration.test.ts`
预期：失败，`dispute` 不是合法的消息类型（`INVALID_INPUT` 来自 schema，与断言期望的原因不同），或者提示数量不对。

- [ ] **Step 3: 实现**

`src/auth.ts` 和 `src/collaboration.ts` 中的消息类型枚举都改为 `z.enum(['assistance_request','contract_update','test_debug','dispute','arbitration_suggested'])`；`MessageSubmission['type']` 同步更新。

`src/validation.ts` 新增：

```ts
  consecutiveRejections(groupId: string, contractRef: string): string[] {
    const rows = this.db.prepare('SELECT payload_json FROM validation_runs WHERE group_id=? AND contract_id=? ORDER BY rowid DESC LIMIT 50').all(groupId, contractRef) as Array<{ payload_json: string }>;
    const ids: string[] = [];
    for (const row of rows) { const run = JSON.parse(row.payload_json) as ValidationRun; if (run.state !== 'rejected') break; ids.push(run.validationId); }
    return ids;
  }
```

`src/collaboration.ts`：构造函数增加参数 `private readonly suggestAfterRejections = 2`；
- `automation_message_send` 改为：

```ts
      case 'automation_message_send': {
        const { operationId, ...input } = collaborationSchemas[command].parse(raw);
        if (input.payload.kind === 'execution_package') throw new CoordinatorError('FORBIDDEN', 'Execution packages require lead dispatch.', 'Use automation_dispatch after task and runtime binding checks.');
        if (input.type === 'arbitration_suggested') throw new CoordinatorError('FORBIDDEN', 'Arbitration suggestions are issued by the coordinator.', 'Send a dispute to lead instead.');
        if (input.type === 'dispute') {
          const run = typeof input.payload.validationId === 'string' ? this.validations.get(input.payload.validationId) : undefined;
          if (input.recipientRole !== 'lead' || !run || run.groupId !== actor.groupId || run.state !== 'rejected') throw new CoordinatorError('INVALID_INPUT', 'A dispute must go to lead and reference a rejected validation.', 'Attach the rejected validationId.');
          const message = this.store.send(actor, input, operationId);
          this.store.send(actor, { type: 'arbitration_suggested', recipientRole: 'lead', payload: { kind: 'arbitration_suggested', reason: 'dispute', contractRef: run.contractRef, validationIds: [run.validationId], disputeMessageId: message.messageId } }, `${operationId}:arbitration`);
          return message;
        }
        return this.store.send(actor, input, operationId);
      }
```

- `automation_validation_record` 改为：

```ts
      case 'automation_validation_record': {
        const input = collaborationSchemas[command].parse(raw);
        const run = this.validations.record(actor, input.validationId, input.outcome, input.evidence);
        if (run.state === 'rejected') {
          const streak = this.validations.consecutiveRejections(actor.groupId, run.contractRef);
          if (streak.length >= this.suggestAfterRejections) this.store.send(actor, { type: 'arbitration_suggested', recipientRole: 'lead', payload: { kind: 'arbitration_suggested', reason: 'consecutive_rejections', contractRef: run.contractRef, validationIds: streak } }, `arbitration:${run.validationId}`);
        }
        return run;
      }
```

`src/engine.ts` 中 `new CollaborationService(options.databasePath, this.store, this.contracts)` 改为 `new CollaborationService(options.databasePath, this.store, this.contracts, options.advisor?.suggestAfterRejections ?? 2)`。

- [ ] **Step 4: 运行测试，确认通过**

运行：`npx tsx --test tests/arbitration.test.ts && npm run typecheck && npm test`
预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/auth.ts src/collaboration.ts src/validation.ts src/engine.ts tests/arbitration.test.ts
git commit -q -m "feat: route disputes and suggest arbitration after repeated rejections

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: 换 lead（接替与 generation 加一）

**Files:**
- Modify: `src/external-lead.ts`（增加 `agent` 列；接替规则；`lead_successions` 表）
- Modify: `src/store.ts`（新增 `rotateBinding`）
- Modify: `src/durable-scheduler.ts`（新增 `isPaused`）
- Modify: `src/engine.ts`（heartbeat schema 增加 `agent`；新增 `humanRotateLead`）
- Modify: `src/ipc.ts`、`scripts/human-control.ts`（人工命令增加 `lead-rotate`）
- Create: `tests/lead-switch.test.ts`

**Interfaces:**
- Produces:
  - `automation_lead_heartbeat` 输入：`{ sessionRef, cwd, agent?: AgentKind }`
  - `ExternalLead.heartbeat(actor, sessionRef, cwd, agent: AgentKind | null): void`，冲突时抛 `LEAD_CONFLICT`
  - `ExternalLead.successions(): Array<{ at: string; fromSession: string; fromAgent: string | null; toSession: string; toAgent: string | null; generation: number }>`
  - `store.rotateBinding(groupId: string, roleId: RoleId): number`
  - `scheduler.isPaused(groupId: string): boolean`
  - `engine.humanRotateLead(capability: string): Promise<{ generation: number }>`

- [ ] **Step 1: 写失败测试**

```ts
// tests/lead-switch.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { engineFixture } from './fixtures/engine-fixture.js';

test('a second lead session is rejected until paused, expired and rotated; the old lead is fenced', async () => {
  const f = await engineFixture(undefined, { leadMode: 'external' });
  try {
    await f.engine.execute(f.lead, 'automation_lead_heartbeat', { sessionRef: 'codex-1', cwd: f.dir, agent: 'codex' });
    await assert.rejects(f.engine.execute(f.lead, 'automation_lead_heartbeat', { sessionRef: 'claude-1', cwd: f.dir, agent: 'claude' }), { code: 'LEAD_CONFLICT' });
    await assert.rejects(f.engine.humanRotateLead('independent-human-token'), { code: 'TASK_GATE_CLOSED' }, 'must pause first');
    await f.engine.execute(f.lead, 'automation_pause', { paused: true });
    await assert.rejects(f.engine.humanRotateLead('independent-human-token'), { code: 'TASK_GATE_CLOSED' }, 'old presence still fresh');
    f.engine.expireLeadPresenceForTest();
    await assert.rejects(f.engine.humanRotateLead('wrong-human-token'), { code: 'FORBIDDEN' });
    const { generation } = await f.engine.humanRotateLead('independent-human-token');
    assert.equal(generation, 2);
    await assert.rejects(f.engine.execute(f.lead, 'automation_status', {}), (error: { code?: string }) => ['FORBIDDEN', 'STALE_LEASE'].includes(error.code ?? ''));
    const next = f.engine.authenticate('lead', f.credentials.lead, 2);
    await f.engine.execute(next, 'automation_lead_heartbeat', { sessionRef: 'claude-1', cwd: f.dir, agent: 'claude' });
    const [succession] = f.engine.leadSuccessions();
    assert.deepEqual({ from: succession!.fromSession, fromAgent: succession!.fromAgent, to: succession!.toSession, toAgent: succession!.toAgent, generation: succession!.generation }, { from: 'codex-1', fromAgent: 'codex', to: 'claude-1', toAgent: 'claude', generation: 2 });
  } finally { await f.cleanup(); }
});
```

> 需要在 engine 上加两个小方法：`expireLeadPresenceForTest()`（只供测试，把 `external_lead.expires_at` 设为 0），以及 `leadSuccessions()`（返回 `this.externalLead.successions()`）。

- [ ] **Step 2: 运行测试，确认失败**

运行：`npx tsx --test tests/lead-switch.test.ts`
预期：失败，`agent` 字段不被 strict schema 接受（`INVALID_INPUT`）。

- [ ] **Step 3: 实现**

`src/external-lead.ts`：
- 在构造函数里，建表之后执行：`try { this.db.exec('ALTER TABLE external_lead ADD COLUMN agent TEXT'); } catch { /* column exists */ }`，以及 `CREATE TABLE IF NOT EXISTS lead_successions(id INTEGER PRIMARY KEY, group_id TEXT NOT NULL, at TEXT NOT NULL, from_session TEXT NOT NULL, from_agent TEXT, to_session TEXT NOT NULL, to_agent TEXT, generation INTEGER NOT NULL)`；
- `heartbeat` 改为：

```ts
  heartbeat(actor: Actor, sessionRef: string, cwd: string, agent: AgentKind | null = null): void {
    if (actor.roleId !== 'lead' || actor.groupId !== this.groupId) throw new CoordinatorError('FORBIDDEN', 'Only the external lead can register presence.', 'Use the lead connection.');
    const existing = this.snapshot();
    const changed = existing && (existing.session_ref !== sessionRef || existing.worktree_path !== cwd || (existing.agent !== null && agent !== null && existing.agent !== agent));
    if (changed) {
      if (!(actor.bindingGeneration > existing.generation && existing.expires_at <= Date.now())) throw new CoordinatorError('LEAD_CONFLICT', 'Another lead session is registered for this group.', 'Pause, let the previous lead expire, and rotate the lead binding through human-control.');
      this.db.prepare('INSERT INTO lead_successions(group_id,at,from_session,from_agent,to_session,to_agent,generation) VALUES(?,?,?,?,?,?,?)').run(this.groupId, new Date().toISOString(), existing.session_ref, existing.agent, sessionRef, agent, actor.bindingGeneration);
      this.db.prepare('DELETE FROM external_lead WHERE group_id=?').run(this.groupId);
    }
    this.db.prepare('INSERT INTO external_lead(group_id,session_ref,worktree_path,generation,expires_at,agent) VALUES(?,?,?,?,?,?) ON CONFLICT(group_id) DO UPDATE SET generation=excluded.generation,expires_at=excluded.expires_at,agent=COALESCE(external_lead.agent,excluded.agent)').run(this.groupId, sessionRef, cwd, actor.bindingGeneration, Date.now() + 60_000, agent);
  }
```

- `snapshot()` 的 SELECT 增加 `agent`，返回类型增加 `agent: string | null`；新增 `successions()`（按 id 顺序查询 `lead_successions`，字段转为 camelCase）和 `expireForTest()`。

`src/store.ts` 新增：

```ts
  rotateBinding(groupId: string, roleId: RoleId): number {
    this.db.prepare('UPDATE runtime_bindings SET binding_generation=binding_generation+1 WHERE group_id=? AND role_id=?').run(groupId, roleId);
    return (this.db.prepare('SELECT binding_generation FROM runtime_bindings WHERE group_id=? AND role_id=?').get(groupId, roleId) as { binding_generation: number }).binding_generation;
  }
```

`src/durable-scheduler.ts` 新增：`isPaused(groupId: string): boolean { return (this.db.prepare('SELECT status FROM groups WHERE group_id=?').get(groupId) as { status?: string } | undefined)?.status === 'paused'; }`

`src/engine.ts`：
- `automation_lead_heartbeat` 的 schema 改为 `z.object({ sessionRef: z.string().min(1).max(128), cwd: z.string().min(1), agent: agentEnum.optional() }).strict()`，调用处改为 `this.externalLead.heartbeat(actor, input.sessionRef, cwd, input.agent ?? null)`；
- 新增方法：

```ts
  async humanRotateLead(capability: string): Promise<{ generation: number }> {
    this.approvals.authenticate(capability);
    if (this.options.leadMode !== 'external') throw new CoordinatorError('FORBIDDEN', 'Lead rotation applies to external lead mode.', 'Use the configured lead mode.');
    if (!this.scheduler.isPaused(this.options.groupId)) throw new CoordinatorError('TASK_GATE_CLOSED', 'Pause the group before rotating the lead.', 'Run automation_pause and reconcile in-flight work.');
    const presence = this.externalLead.snapshot();
    if (presence && presence.expires_at > Date.now()) throw new CoordinatorError('TASK_GATE_CLOSED', 'The previous lead presence has not expired.', 'Stop the previous lead session and wait for its heartbeat to expire.');
    if (this.scheduler.list(this.options.groupId).some((work) => work.roleId === 'lead' && ['starting', 'leased', 'active', 'needs_reconciliation'].includes(work.state))) throw new CoordinatorError('RECONCILIATION_REQUIRED', 'Lead work is still in flight.', 'Reconcile lead work before rotation.');
    return { generation: this.store.rotateBinding(this.options.groupId, 'lead') };
  }
```

`src/ipc.ts`：human 命令枚举增加 `'lead-rotate'`，处理分支为 `result = await engine.humanRotateLead(input.capability);`。`scripts/human-control.ts` 增加子命令 `lead-rotate`：必须在交互 TTY 中运行，并要求输入 `yes` 确认，与 `init` 的确认方式一致，然后发送这个命令。

- [ ] **Step 4: 运行测试，确认通过**

运行：`npx tsx --test tests/lead-switch.test.ts && npm run typecheck && npm test`
预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/external-lead.ts src/store.ts src/durable-scheduler.ts src/engine.ts src/ipc.ts scripts/human-control.ts tests/lead-switch.test.ts
git commit -q -m "feat: fence lead succession behind pause, expiry and human rotation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: lead 会话启动器（选择 agent、注入 MCP、发送心跳）

**Files:**
- Create: `src/lead-launch.ts`（纯函数：生成命令、参数和配置文件内容）
- Create: `scripts/lead-session.ts`（写配置文件、发送心跳、以继承 TTY 的方式启动 agent）
- Modify: `scripts/herdr-resume.sh`、`scripts/kitty-lead.sh`（最后一行改为调用 lead-session；参数改为 `<runtime> [--agent X] <uuid>`）
- Modify: `scripts/kitty-start.ts`（接受并透传 `--agent`）
- Create: `tests/lead-launch.test.ts`
- Modify: `tests/herdr.test.ts:141`（"resume launcher fails closed…"，更新用法字符串）

**Interfaces:**
- Consumes: `RuntimeConfig`、`agentFor`（Task 2）；`HANDOFF_TOOLS`、`LEAD_MEMORY_TOOLS`（Task 7）；`coordinatorRequest`（`src/ipc.ts`）
- Produces:
  - `interface LeadLaunchInput { agent: AgentKind; sessionId: string; config: RuntimeConfig; generation: number; mcpScriptPath: string; runtimeDir: string; nodePath: string }`
  - `buildLeadLaunch(input): { command: 'codex' | 'claude'; args: string[]; cwd: string; files: Array<{ path: string; content: string }> }`
  - `parseLeadArgs(argv: string[]): { configPath: string; agent?: AgentKind; sessionId: string }`

- [ ] **Step 1: 写失败测试**

```ts
// tests/lead-launch.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLeadLaunch, parseLeadArgs } from '../src/lead-launch.js';
import { HANDOFF_TOOLS } from '../src/runtime/tool-policy.js';

const uuid = '11111111-2222-4333-8444-555555555555';
const config = { groupId: 'g', databasePath: '/rt/s.sqlite', socketPath: '/rt/c.sock', credentialFile: '/rt/roles.json', leadWorktree: '/work/repo', allowedRoots: ['/work'], powerContext: { baseUrl: 'http://127.0.0.1:8787', roles: [{ role: 'lead', authorizationEnv: 'POWERCONTEXT_COORDINATOR_LEAD_AUTHORIZATION' }] } } as never;

test('argument parsing keeps the legacy two-argument form', () => {
  assert.deepEqual(parseLeadArgs(['/rt/runtime.json', uuid]), { configPath: '/rt/runtime.json', sessionId: uuid });
  assert.deepEqual(parseLeadArgs(['/rt/runtime.json', '--agent', 'claude', uuid]), { configPath: '/rt/runtime.json', agent: 'claude', sessionId: uuid });
  assert.throws(() => parseLeadArgs(['/rt/runtime.json', '--agent', 'gpt', uuid]));
  assert.throws(() => parseLeadArgs(['/rt/runtime.json', 'not-a-uuid']));
});

test('claude lead resumes in the lead worktree with injected MCP and denied handoff tools', () => {
  const launch = buildLeadLaunch({ agent: 'claude', sessionId: uuid, config, generation: 2, mcpScriptPath: '/c/dist/scripts/mcp-server.js', runtimeDir: '/rt', nodePath: '/usr/bin/node' });
  assert.equal(launch.command, 'claude'); assert.equal(launch.cwd, '/work/repo');
  assert.deepEqual(launch.args, ['--resume', uuid, '--mcp-config', '/rt/lead/claude-mcp.json', '--settings', '/rt/lead/claude-settings.json']);
  const mcp = JSON.parse(launch.files.find((file) => file.path.endsWith('claude-mcp.json'))!.content);
  assert.equal(mcp.mcpServers.coordinator.env.COORDINATOR_ROLE, 'lead');
  assert.equal(mcp.mcpServers.coordinator.env.COORDINATOR_BINDING_GENERATION, '2');
  assert.equal(mcp.mcpServers.powercontext.headers.Authorization, '${POWERCONTEXT_COORDINATOR_LEAD_AUTHORIZATION}');
  const settings = JSON.parse(launch.files.find((file) => file.path.endsWith('claude-settings.json'))!.content);
  assert.deepEqual(settings.permissions.deny, HANDOFF_TOOLS.map((tool) => `mcp__powercontext__${tool}`));
  assert.ok(!JSON.stringify(launch).includes('Bearer'));
});

test('codex lead resumes with -C, injected coordinator and memory-only PowerContext tools', () => {
  const launch = buildLeadLaunch({ agent: 'codex', sessionId: uuid, config, generation: 1, mcpScriptPath: '/c/m.js', runtimeDir: '/rt', nodePath: '/usr/bin/node' });
  assert.equal(launch.command, 'codex');
  assert.deepEqual(launch.args.slice(0, 4), ['resume', uuid, '-C', '/work/repo']);
  const joined = launch.args.join(' ');
  assert.match(joined, /mcp_servers\.coordinator=\{command="\/usr\/bin\/node"/);
  assert.match(joined, /mcp_servers\.powercontext_lead=\{url="http:\/\/127\.0\.0\.1:8787\/mcp\/",env_http_headers=\{Authorization="POWERCONTEXT_COORDINATOR_LEAD_AUTHORIZATION"\}/);
  for (const handoff of HANDOFF_TOOLS) assert.ok(!joined.includes(handoff));
  assert.deepEqual(launch.files, []);
});

test('missing leadWorktree falls back to the first registered repository, never the coordinator checkout', () => {
  const launch = buildLeadLaunch({ agent: 'codex', sessionId: uuid, config: { ...(config as object), leadWorktree: undefined, repositories: [{ repositoryId: 'r', worktreePath: '/work/biz' }] } as never, generation: 1, mcpScriptPath: '/c/m.js', runtimeDir: '/rt', nodePath: '/usr/bin/node' });
  assert.equal(launch.cwd, '/work/biz');
  assert.throws(() => buildLeadLaunch({ agent: 'codex', sessionId: uuid, config: { ...(config as object), leadWorktree: undefined, repositories: [] } as never, generation: 1, mcpScriptPath: '/c/m.js', runtimeDir: '/rt', nodePath: '/usr/bin/node' }), /leadWorktree/);
});
```

- [ ] **Step 2: 运行测试，确认失败**

运行：`npx tsx --test tests/lead-launch.test.ts`
预期：失败，找不到模块。

- [ ] **Step 3: 实现 `src/lead-launch.ts`**

```ts
import { join } from 'node:path';
import { agentEnum, type AgentKind } from './roles.js';
import type { RuntimeConfig } from './runtime-config.js';
import { HANDOFF_TOOLS, LEAD_MEMORY_TOOLS } from './runtime/tool-policy.js';

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface LeadLaunchInput { agent: AgentKind; sessionId: string; config: RuntimeConfig; generation: number; mcpScriptPath: string; runtimeDir: string; nodePath: string; }

export function parseLeadArgs(argv: string[]): { configPath: string; agent?: AgentKind; sessionId: string } {
  const [configPath, ...rest] = argv;
  let agent: AgentKind | undefined;
  if (rest[0] === '--agent') { agent = agentEnum.parse(rest[1]); rest.splice(0, 2); }
  const sessionId = rest[0];
  if (!configPath || !sessionId || rest.length !== 1 || !SESSION.test(sessionId)) throw new Error('Usage: lead-session <runtime.json> [--agent codex|claude] <session-uuid>');
  return { configPath, ...(agent ? { agent } : {}), sessionId };
}

function leadCwd(config: RuntimeConfig): string {
  const cwd = config.leadWorktree ?? config.repositories?.[0]?.worktreePath;
  if (!cwd) throw new Error('Configure leadWorktree (or a lead repository) before resuming the lead.');
  return cwd;
}

export function buildLeadLaunch(input: LeadLaunchInput): { command: 'codex' | 'claude'; args: string[]; cwd: string; files: Array<{ path: string; content: string }> } {
  const { config } = input;
  const cwd = leadCwd(config);
  const authorizationEnv = config.powerContext?.roles.find((role) => role.role === 'lead')?.authorizationEnv;
  const coordinatorEnv = { COORDINATOR_ROLE: 'lead', COORDINATOR_GROUP_ID: config.groupId, COORDINATOR_DB_PATH: config.databasePath, COORDINATOR_SOCKET_PATH: config.socketPath, COORDINATOR_CREDENTIAL_FILE: config.credentialFile, COORDINATOR_BINDING_GENERATION: String(input.generation) };
  const pcUrl = config.powerContext ? new URL('/mcp/', config.powerContext.baseUrl).href : undefined;
  if (input.agent === 'claude') {
    const dir = join(input.runtimeDir, 'lead');
    const mcp = { mcpServers: { coordinator: { command: input.nodePath, args: [input.mcpScriptPath], env: coordinatorEnv }, ...(pcUrl && authorizationEnv ? { powercontext: { type: 'http', url: pcUrl, headers: { Authorization: `\${${authorizationEnv}}` } } } : {}) } };
    const settings = { permissions: { deny: HANDOFF_TOOLS.map((tool) => `mcp__powercontext__${tool}`) } };
    const mcpPath = join(dir, 'claude-mcp.json'); const settingsPath = join(dir, 'claude-settings.json');
    return { command: 'claude', cwd, args: ['--resume', input.sessionId, '--mcp-config', mcpPath, '--settings', settingsPath], files: [{ path: mcpPath, content: `${JSON.stringify(mcp, null, 2)}\n` }, { path: settingsPath, content: `${JSON.stringify(settings, null, 2)}\n` }] };
  }
  const envToml = Object.entries(coordinatorEnv).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(',');
  const args = ['resume', input.sessionId, '-C', cwd, '-c', `mcp_servers.coordinator={command=${JSON.stringify(input.nodePath)},args=[${JSON.stringify(input.mcpScriptPath)}],env={${envToml}},enabled=true}`];
  if (pcUrl && authorizationEnv) args.push('-c', `mcp_servers.powercontext_lead={url=${JSON.stringify(pcUrl)},env_http_headers={Authorization=${JSON.stringify(authorizationEnv)}},enabled_tools=${JSON.stringify([...LEAD_MEMORY_TOOLS])},enabled=true}`);
  return { command: 'codex', cwd, args, files: [] };
}
```

- [ ] **Step 4: 实现 `scripts/lead-session.ts`**

```ts
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { buildLeadLaunch, parseLeadArgs } from '../src/lead-launch.js';
import { coordinatorRequest } from '../src/ipc.js';
import { loadRuntimeConfig, readProtectedJson } from '../src/runtime-config.js';
import { CoordinatorStore } from '../src/store.js';

const { configPath, agent: requested, sessionId } = parseLeadArgs(process.argv.slice(2));
const config = await loadRuntimeConfig(configPath);
const agent = requested ?? config.leadAgent ?? 'codex';
const runtimeDir = dirname(config.databasePath);
const store = new CoordinatorStore(config.databasePath);
const generation = store.groupSnapshot(config.groupId)?.roles.find((role) => role.roleId === 'lead')?.bindingGeneration ?? 1;
store.close();
const capability = z.object({ groupId: z.literal(config.groupId), credentials: z.record(z.string(), z.string().min(32)) }).parse(await readProtectedJson(config.credentialFile)).credentials.lead!;
const leadEnvPath = join(runtimeDir, 'lead.env');
const leadEnv: Record<string, string> = {};
if (existsSync(leadEnvPath)) {
  await assertPrivateFile(leadEnvPath);
  for (const line of (await readFile(leadEnvPath, 'utf8')).split('\n')) { const match = /^([A-Z0-9_]+)=(?:'([^']*)'|"([^"]*)"|(.*))$/.exec(line.trim()); if (match) leadEnv[match[1]!] = match[2] ?? match[3] ?? match[4] ?? ''; }
}
const mcpScriptPath = fileURLToPath(new URL('./mcp-server.js', import.meta.url));
const launch = buildLeadLaunch({ agent, sessionId, config, generation, mcpScriptPath, runtimeDir, nodePath: process.execPath });
for (const file of launch.files) { await mkdir(dirname(file.path), { recursive: true, mode: 0o700 }); await writeFile(file.path, file.content, { mode: 0o600 }); }
const beat = () => coordinatorRequest(config.socketPath, { channel: 'role', roleId: 'lead', generation, capability, command: 'automation_lead_heartbeat', input: { sessionRef: sessionId, cwd: launch.cwd, agent } }).catch((error: unknown) => { process.stderr.write(`[Coordinator] lead heartbeat failed: ${(error as { code?: string }).code ?? 'UNKNOWN'}\n`); });
await beat();
const timer = setInterval(beat, 20_000);
process.on('SIGINT', () => {});
const child = spawn(launch.command, launch.args, { cwd: launch.cwd, stdio: 'inherit', env: { ...process.env, ...leadEnv } });
const code: number = await new Promise((resolve) => child.on('exit', (exit, signal) => resolve(exit ?? (signal ? 1 : 0))));
clearInterval(timer);
for (const file of launch.files) await rm(file.path, { force: true });
process.exit(code);
```

导入部分补上 `import { existsSync } from 'node:fs';`，并从 `../src/runtime-config.js` 导入 `assertPrivateFile`。

在 `src/runtime-config.ts` 中，把 `readProtectedJson` 里属主和权限检查的那段逻辑抽成导出函数，`readProtectedJson` 改为调用它：

```ts
export async function assertPrivateFile(path: string): Promise<void> {
  const file = await stat(path);
  if (!file.isFile() || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0) throw new CoordinatorError('FORBIDDEN', 'Credential file must be private and owned by this user.', 'Set a protected owner-only credential file.');
}
export async function readProtectedJson(path: string): Promise<unknown> { await assertPrivateFile(path); return JSON.parse(await readFile(path, 'utf8')) as unknown; }
```

- [ ] **Step 5: 修改 sh 启动脚本**

`scripts/herdr-resume.sh`：
- 参数检查改为允许 2 个或 4 个参数，用法改为 `scripts/herdr-resume.sh <runtime.json> [--agent codex|claude] <session-uuid>`；
- UUID 校验对象改为最后一个参数；
- 最后一行 `codex resume "$2" -C "$project_root"` 改为：

```sh
node "$project_root/dist/scripts/lead-session.js" "$@"
```

同时把提示文案中的"Codex 会话"改为"主会话"。`scripts/kitty-lead.sh` 的最后一个分支做同样的修改。`scripts/kitty-start.ts` 接受 `--agent` 并原样传给 `kitty-lead.sh`；UUID 校验改为针对最后一个参数。

更新 `tests/herdr.test.ts:141` 中对用法字符串的断言。

- [ ] **Step 6: 运行测试，确认通过**

运行：`npx tsx --test tests/lead-launch.test.ts tests/herdr.test.ts tests/kitty.test.ts && sh -n scripts/herdr-resume.sh && sh -n scripts/kitty-lead.sh && npm run typecheck && npm test && npm run build`
预期：全部 PASS。

- [ ] **Step 7: 提交**

```bash
git add src/lead-launch.ts src/runtime-config.ts scripts/lead-session.ts scripts/herdr-resume.sh scripts/kitty-lead.sh scripts/kitty-start.ts tests/lead-launch.test.ts tests/herdr.test.ts
git commit -q -m "feat: launch either agent as lead with injected MCP and heartbeat

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: 布局控制器共用一把锁；在 Herdr 内拒绝 `kitty:start`

**Files:**
- Create: `src/terminal/layout-lock.ts`
- Modify: `scripts/herdr-follow.ts`、`scripts/kitty-follow.ts`（改用共用锁）
- Modify: `scripts/kitty-start.ts`（在 Herdr 内拒绝运行）
- Create: `tests/layout-lock.test.ts`

**Interfaces:**
- Produces:
  - `acquireLayoutLock(stateDir: string, groupId: string, backend: 'herdr' | 'kitty', context: Record<string, unknown>): Promise<{ release(): Promise<void> }>`
  - `readLayoutLock(stateDir: string): Promise<{ pid: number; backend: 'herdr' | 'kitty'; groupId: string } | undefined>`
  - `assertNotInsideHerdr(env: NodeJS.ProcessEnv): void`

- [ ] **Step 1: 写失败测试**

```ts
// tests/layout-lock.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLayoutLock, readLayoutLock, assertNotInsideHerdr } from '../src/terminal/layout-lock.js';

test('only one layout controller per group regardless of backend', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'layout-'));
  try {
    const herdr = await acquireLayoutLock(dir, 'g', 'herdr', { pane: 'w:p' });
    await assert.rejects(acquireLayoutLock(dir, 'g', 'kitty', {}), /herdr.*already running/i);
    assert.equal((await readLayoutLock(dir))!.backend, 'herdr');
    await herdr.release();
    const kitty = await acquireLayoutLock(dir, 'g', 'kitty', {});
    await kitty.release();
    await writeFile(join(dir, 'layout-controller.lock'), JSON.stringify({ pid: 999999, backend: 'kitty', groupId: 'g' }));
    await assert.rejects(acquireLayoutLock(dir, 'g', 'herdr', {}), /stale/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('kitty start refuses to run inside Herdr', () => {
  assert.throws(() => assertNotInsideHerdr({ HERDR_ENV: '1' }), /herdr:resume/);
  assertNotInsideHerdr({ KITTY_PID: '1' });
});
```

- [ ] **Step 2: 运行测试，确认失败**

运行：`npx tsx --test tests/layout-lock.test.ts`
预期：失败，找不到模块。

- [ ] **Step 3: 实现**

```ts
// src/terminal/layout-lock.ts
import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const LOCK = 'layout-controller.lock';
export async function readLayoutLock(stateDir: string): Promise<{ pid: number; backend: 'herdr' | 'kitty'; groupId: string } | undefined> {
  try { return JSON.parse(await readFile(join(stateDir, LOCK), 'utf8')); } catch { return undefined; }
}
export async function acquireLayoutLock(stateDir: string, groupId: string, backend: 'herdr' | 'kitty', context: Record<string, unknown>): Promise<{ release(): Promise<void> }> {
  const path = join(stateDir, LOCK);
  const handle = await open(path, 'wx', 0o600).catch(async () => {
    const holder = await readLayoutLock(stateDir);
    let alive = false;
    try { if (holder?.pid) { process.kill(holder.pid, 0); alive = true; } } catch { alive = false; }
    throw new Error(alive ? `Layout controller (${holder!.backend}, pid ${holder!.pid}) is already running for this group.` : 'Layout controller lock is stale; inspect the recorded process and pane mapping before removing it.');
  });
  await handle.writeFile(JSON.stringify({ pid: process.pid, backend, groupId, ...context }));
  return { release: async () => { await handle.close(); await unlink(path).catch(() => {}); } };
}
export function assertNotInsideHerdr(env: NodeJS.ProcessEnv): void {
  if (env.HERDR_ENV === '1') throw new Error('已在 Herdr 中运行：请改用 npm run herdr:resume，避免另起一个 Kitty 实例和第二个布局控制器。');
}
```

在 `scripts/herdr-follow.ts` 中，把 `open(lockPath,'wx',…)` 那段替换为 `const lock = await acquireLayoutLock(dirname(statePath), config.groupId, 'herdr', context);`，`finally` 中改为 `await lock.release()`。`scripts/kitty-follow.ts` 做同样的修改，backend 为 `'kitty'`；它的 `--compact` 分支改为读取 `readLayoutLock(dirname(statePath))`，并核对 `backend === 'kitty'` 且 `groupId` 一致。`scripts/kitty-start.ts` 在最前面调用 `assertNotInsideHerdr(process.env)`。

- [ ] **Step 4: 运行测试，确认通过**

运行：`npx tsx --test tests/layout-lock.test.ts tests/herdr.test.ts tests/kitty.test.ts && npm run typecheck && npm test`
预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/terminal/layout-lock.ts scripts/herdr-follow.ts scripts/kitty-follow.ts scripts/kitty-start.ts tests/layout-lock.test.ts
git commit -q -m "feat: share one layout controller lock across Herdr and Kitty

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: 窗格生命周期（手动关闭、只有新调用才重新打开、交还给用户）

**Files:**
- Modify: `src/terminal/herdr-controller.ts`
- Modify: `src/terminal/kitty-controller.ts`
- Modify: `scripts/herdr-follow.ts`（持久化 `closedAt`、`returned`；处理 compact 请求文件）
- Create: `scripts/herdr-compact.ts`
- Modify: `package.json`（增加 `"herdr:compact": "node dist/scripts/herdr-compact.js"`）
- Modify: `tests/herdr.test.ts`、`tests/kitty.test.ts`（按 Global Constraints 允许的范围修改，并新增用例）

**Interfaces:**
- Consumes: `OBSERVED_ROLES`（Task 1）、`acquireLayoutLock`、`readLayoutLock`（Task 14）
- Produces:
  - `type WorkerRole = ObservedRole`（两个控制器都用这个类型）
  - `interface ClosedMarker { dispatchIds: string[]; waitingHuman: number }`
  - Herdr 和 Kitty 控制器的构造参数增加 `closed?: Partial<Record<WorkerRole, ClosedMarker>>`、`returned?: Array<string | number>`；`options.save` 的签名改为 `(panes, readyRoles, state: { closedAt; returned }) => Promise<void>`；`options.onEvent?: (event: { type: 'pane_closed_by_user' | 'pane_returned'; role: WorkerRole }) => void`
  - `compact(snapshot, only?: WorkerRole): Promise<void>`

- [ ] **Step 1: 写失败测试（追加到 `tests/herdr.test.ts`，并替换 Global Constraints 中列出的两个旧用例）**

```ts
test('user may close an owned pane at any time; it reopens only for a new dispatch or approval', async () => {
  const f = await engineFixture(); const h = harness(); const projection = new DashboardProjection(f.db);
  try {
    const snapshot = projection.snapshot('g')!;
    const backend = snapshot.roles.find((r) => r.roleId === 'backend')!;
    backend.dispatches.push({ dispatchId: 'd1', workId: 'w', state: 'active', requestedModel: 'm', requestedEffort: 'medium', actualModel: null, turnId: 't' });
    await h.controller.sync(snapshot);
    const pane = h.controller.panes().backend!;
    h.panes.delete(pane);
    await h.controller.sync(snapshot);
    assert.equal(h.controller.panes().backend, undefined, 'closed while active is accepted');
    backend.dispatches[0]!.state = 'completed';
    await h.controller.sync(snapshot); await h.controller.sync(snapshot);
    assert.equal(h.calls.filter((c) => c.method === 'pane.split').length, 1, 'same execution never reopens');
    backend.dispatches.unshift({ dispatchId: 'd2', workId: 'w2', state: 'queued', requestedModel: 'm', requestedEffort: 'medium', actualModel: null, turnId: null });
    await h.controller.sync(snapshot);
    assert.equal(h.calls.filter((c) => c.method === 'pane.split').length, 2, 'new dispatch reopens');
    h.panes.delete(h.controller.panes().backend!);
    await h.controller.sync(snapshot);
    backend.waitingHuman = 1;
    await h.controller.sync(snapshot);
    assert.equal(h.calls.filter((c) => c.method === 'pane.split').length, 3, 'new approval reopens');
  } finally { projection.close(); await f.cleanup(); }
});

test('foreign panes are ignored and a replaced observer is returned, never closed', async () => {
  const f = await engineFixture(); const p = new DashboardProjection(f.db); const h = harness();
  try {
    const s = p.snapshot('g')!; s.roles.find((r) => r.roleId === 'audit')!.waitingHuman = 1;
    await h.controller.sync(s);
    h.panes.add('w-test:p-user');
    await h.controller.sync(s);
    assert.ok(h.calls.every((c) => c.params.pane_id !== 'w-test:p-user'), 'foreign pane untouched');
    const auditPane = h.controller.panes().audit!;
    h.takeover();
    await h.controller.sync(s);
    assert.equal(h.controller.panes().audit, undefined);
    assert.ok(h.panes.has(auditPane), 'returned pane stays open');
    assert.equal(h.calls.filter((c) => c.method === 'pane.close').length, 0);
    s.roles.find((r) => r.roleId === 'audit')!.waitingHuman = 2;
    await h.controller.sync(s);
    assert.notEqual(h.controller.panes().audit, auditPane, 'next invocation creates a new pane');
  } finally { p.close(); await f.cleanup(); }
});

test('missing lead pane still stops layout control', async () => {
  const f = await engineFixture(); const p = new DashboardProjection(f.db); const h = harness();
  try { h.panes.delete('w-test:p-main'); await assert.rejects(h.controller.sync(p.snapshot('g')!), /lead/i); } finally { p.close(); await f.cleanup(); }
});

test('compact can target one idle role and records it as closed', async () => {
  const f = await engineFixture(); const p = new DashboardProjection(f.db); const h = harness();
  try {
    const s = p.snapshot('g')!;
    for (const role of ['frontend', 'backend']) s.roles.find((r) => r.roleId === role)!.dispatches.push({ dispatchId: role, workId: 'w', state: 'completed', requestedModel: 'm', requestedEffort: 'medium', actualModel: null, turnId: 't' });
    for (const role of ['frontend', 'backend']) s.roles.find((r) => r.roleId === role)!.dispatches[0]!.state = 'active';
    await h.controller.sync(s);
    for (const role of ['frontend', 'backend']) s.roles.find((r) => r.roleId === role)!.dispatches[0]!.state = 'completed';
    await h.controller.compact(s, 'frontend');
    assert.equal(h.controller.panes().frontend, undefined);
    assert.ok(h.controller.panes().backend);
    await h.controller.sync(s);
    assert.equal(h.controller.panes().frontend, undefined, 'compacted role stays closed for the same execution');
  } finally { p.close(); await f.cleanup(); }
});
```

删除旧用例 "Herdr refuses foreign topology and retains uncertain or waiting-human panes" 中关于外来窗格的断言，只保留"等待人工处理的窗格不会被 compact 收起"这一部分。旧用例 "compact must not close an observer pane taken over by the user" 改为：断言 `compact` 不会 reject、没有 `pane.close` 调用，并且该角色已经不在 `panes()` 中。`tests/kitty.test.ts` 中 "Kitty foreign panes and replaced observers freeze…" 按同样的语义改写，并新增一条 Kitty 版的"手动关闭后只有新调用才重新打开"用例（复用该文件已有的 harness，断言 `launch` 调用次数）。

- [ ] **Step 2: 运行测试，确认失败**

运行：`npx tsx --test tests/herdr.test.ts tests/kitty.test.ts`
预期：新用例失败（当前实现会冻结）。

- [ ] **Step 3: 修改 `HerdrController`**

主要改动：

```ts
import { OBSERVED_ROLES, type ObservedRole } from '../roles.js';
export type WorkerRole = ObservedRole;
export interface ClosedMarker { dispatchIds: string[]; waitingHuman: number; }
const roles: WorkerRole[] = [...OBSERVED_ROLES];
```

- `Options` 增加 `onEvent?(event: { type: 'pane_closed_by_user' | 'pane_returned'; role: WorkerRole }): void;`；`save` 的签名改为 `save?(panes, readyRoles, state: { closedAt: Partial<Record<WorkerRole, ClosedMarker>>; returned: string[] }): Promise<void>`。
- 构造函数增加参数 `closed: Partial<Record<WorkerRole, ClosedMarker>> = {}`、`returned: string[] = []`，保存为 `this.closedAt` 和 `this.returned`（Set）。
- `assertTopology()` 改为 `reconcileTopology()`：

```ts
  private async reconcileTopology(snapshot: DashboardSnapshot): Promise<void> {
    const response = await this.transport.request('pane.list', {});
    if (!Array.isArray(response?.panes)) throw new Error('Invalid Herdr pane inventory.');
    const present = new Set(response.panes.filter((p: any) => p.tab_id === this.options.tabId).map((p: any) => p.pane_id as string));
    if (!present.has(this.options.leadPane)) throw new Error('Herdr lead pane is missing; stop layout control and preserve the workspace.');
    for (const role of roles) {
      const pane = this.owned[role];
      if (pane && !present.has(pane)) { this.markClosed(role, snapshot); this.options.onEvent?.({ type: 'pane_closed_by_user', role }); }
    }
  }
  private markClosed(role: WorkerRole, snapshot: DashboardSnapshot): void {
    const state = snapshot.roles.find((r) => r.roleId === role);
    this.closedAt[role] = { dispatchIds: state?.dispatches.map((d) => d.dispatchId) ?? [], waitingHuman: state?.waitingHuman ?? 0 };
    delete this.owned[role]; this.pending.delete(role);
  }
  private reopenAllowed(role: Role): boolean {
    const marker = this.closedAt[role.roleId as WorkerRole];
    if (!marker) return true;
    const fresh = role.dispatches.some((d) => !marker.dispatchIds.includes(d.dispatchId)) || role.waitingHuman > marker.waitingHuman;
    if (fresh) delete this.closedAt[role.roleId as WorkerRole];
    return fresh;
  }
```

- `sync` 的开头改为 `await this.reconcileTopology(snapshot);`。对每个自有窗格做身份检查时，`pending` 中的窗格仍然调用 `assertObserver(role, true)`，失败就抛出（启动结果未知，必须冻结）；非 `pending` 的窗格改为：

```ts
        try { await this.assertObserver(role, false); }
        catch { this.returned.add(this.owned[role]!); this.markClosed(role, snapshot); this.options.onEvent?.({ type: 'pane_returned', role }); }
```

  然后执行 `await this.save();`。
- 创建窗格的条件改为 `if (!this.owned[roleId] && activated(role, snapshot) && this.reopenAllowed(role))`。分屏的目标改为在 `existing` 中排除 `this.returned` 里的窗格。
- `compact(snapshot, only?)`：开头调用 `reconcileTopology`；每个角色先判断 `only && roleId !== only` 时跳过；身份检查失败时按"交还"处理，不抛错；关闭窗格之后调用 `this.markClosed(roleId, snapshot)`，不再直接 `delete this.owned[roleId]`。
- `save()` 改为传第三个参数 `{ closedAt: this.closedAt, returned: [...this.returned] }`。

`KittyController` 按相同的逻辑修改：lead 窗口缺失、tab 缺失或 layout 不是 `splits` 时仍然抛出；自有窗口缺失就记为已关闭；外来窗口忽略；观察器身份不对就交还；`active()` 判断之外再加上 `reopenAllowed`。

- [ ] **Step 4: 持久化与 compact 请求**

`scripts/herdr-follow.ts`：
- `schema` 中 `panes` 增加 `advisor: z.string().optional()`，并新增 `closedAt: z.record(z.string(), z.object({ dispatchIds: z.array(z.string()), waitingHuman: z.number().int().min(0) }).strict()).default({})`、`returned: z.array(z.string()).default([])`；
- 构造 `HerdrController` 时传入 `saved?.closedAt`、`saved?.returned`；`save` 回调把这两个字段一起写盘；
- 主循环中检查 `statePath + '.compact'`：读取文件内容（角色名，或者为空表示全部），执行 `controller.compact(snapshot, role || undefined)`，然后删除这个文件，逻辑与 `kitty-follow.ts` 相同；
- `onEvent` 回调写一行到 stderr（会进入 controller.log），格式为 `[Coordinator] <type> <role>`。

`scripts/herdr-compact.ts`：

```ts
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { OBSERVED_ROLES } from '../src/roles.js';
import { loadRuntimeConfig } from '../src/runtime-config.js';
import { readLayoutLock } from '../src/terminal/layout-lock.js';

const [configPath, flag, role] = process.argv.slice(2);
if (!configPath || (flag && (flag !== '--role' || !OBSERVED_ROLES.includes(role as never)))) throw new Error('Usage: herdr-compact <runtime.json> [--role frontend|backend|audit|advisor]');
const config = await loadRuntimeConfig(configPath);
const stateDir = dirname(config.databasePath);
const lock = await readLayoutLock(stateDir);
if (!lock || lock.backend !== 'herdr' || lock.groupId !== config.groupId) throw new Error('No running Herdr layout controller for this group.');
process.kill(lock.pid, 0);
await writeFile(join(stateDir, 'herdr-panes.json.compact'), role ?? '', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ requested: 'compact', role: role ?? 'idle-all' }));
```

`scripts/kitty-follow.ts` 做同样的持久化修改（`panes` 增加 advisor，新增 `closedAt`、`returned`）。

- [ ] **Step 5: 运行测试，确认通过**

运行：`npx tsx --test tests/herdr.test.ts tests/kitty.test.ts && npm run typecheck && npm test && npm run build`
预期：全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add src/terminal/herdr-controller.ts src/terminal/kitty-controller.ts scripts/herdr-follow.ts scripts/kitty-follow.ts scripts/herdr-compact.ts package.json tests/herdr.test.ts tests/kitty.test.ts
git commit -q -m "feat: let users close observer panes and reopen only on new work

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Mock 端到端场景（Claude lead、Codex 前后端、Claude audit 和 advisor）

**Files:**
- Create: `tests/multi-agent-scenario.test.ts`

**Interfaces:**
- Consumes: Task 1–12 的全部接口。

- [ ] **Step 1: 写测试**

```ts
// tests/multi-agent-scenario.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { engineFixture } from './fixtures/engine-fixture.js';

test('claude lead + codex workers + claude audit/advisor complete reject -> dispute -> advice -> pass', async () => {
  const agents: Record<string, 'codex' | 'claude'> = { lead: 'claude', frontend: 'codex', backend: 'codex', audit: 'claude', advisor: 'claude' };
  const f = await engineFixture(undefined, { leadMode: 'external', agentFor: (role) => agents[role]!, advisor: { suggestAfterRejections: 2 } });
  const audit = f.engine.authenticate('audit', f.credentials.audit, 1);
  const advisor = f.engine.authenticate('advisor', f.credentials.advisor, 1);
  try {
    await f.engine.execute(f.lead, 'automation_lead_heartbeat', { sessionRef: 'claude-lead', cwd: f.dir, agent: 'claude' });
    for (const actor of [f.backend, advisor]) await f.engine.execute(actor, 'automation_role_initialize', { cwd: f.dir });
    const dispatched = await f.engine.execute(f.lead, 'automation_dispatch', f.dispatch) as { message: { messageId: string } };
    await f.engine.pump();
    const work = f.engine.scheduler.get(dispatched.message.messageId)!;
    assert.equal((work as { agent?: string }).agent, 'codex');
    await f.engine.execute(f.backend, 'automation_work_complete', { dispatchId: work.dispatchId, summary: 'implemented', evidence: ['npm test passed'] });
    const v1 = await f.engine.execute(audit, 'automation_validation_create', { contractRef: f.dispatch.work.contractRef, baselineRef: 'base', operationId: 'v1' }) as { validationId: string };
    await f.engine.execute(audit, 'automation_validation_record', { validationId: v1.validationId, outcome: 'rejected', evidence: [{ command: 'npm test', outcome: 'failed', summary: 'edge case' }] });
    await f.engine.execute(f.backend, 'automation_message_send', { type: 'dispute', recipientRole: 'lead', payload: { validationId: v1.validationId, reason: 'spec allows this' }, operationId: 'dispute-1' });
    const suggestion = f.engine.store.leadInbox('g').find((m) => m.type === 'arbitration_suggested');
    assert.ok(suggestion);
    const advice = await f.engine.execute(f.lead, 'automation_advice_request', { binding: f.dispatch.binding, kind: 'arbitration', question: 'Is the rejection valid?', refs: { contractRef: f.dispatch.work.contractRef, contractRevision: 'v1', dispatchIds: [work.dispatchId], validationIds: [v1.validationId] }, operationId: 'arb' }) as { adviceId: string; sameSource: boolean };
    assert.equal(advice.sameSource, false, 'codex worker vs claude audit/advisor');
    await f.engine.pump();
    await f.engine.execute(advisor, 'automation_advice_complete', { adviceId: advice.adviceId, recommendation: 'Uphold; fix edge case', rationale: 'Contract requires it', risks: [], confidence: 'high', evidenceRefs: ['contract v1'], verdict: 'uphold_rejection' });
    await f.engine.execute(f.lead, 'automation_advice_resolve', { adviceId: advice.adviceId, decision: 'adopted', note: 'Repair in backend', operationId: 'resolve' });
    const v2 = await f.engine.execute(audit, 'automation_validation_create', { contractRef: f.dispatch.work.contractRef, baselineRef: 'base-2', operationId: 'v2' }) as { validationId: string };
    await f.engine.execute(audit, 'automation_validation_record', { validationId: v2.validationId, outcome: 'passed', evidence: [{ command: 'npm test', outcome: 'passed', summary: 'all green' }] });
    assert.equal(f.engine.collaboration.validations.get(v1.validationId)!.state, 'rejected', 'history retained');
    assert.equal(f.engine.advisorBudget.status().callsUsed, 1);
  } finally { await f.cleanup(); }
});
```

- [ ] **Step 2: 运行测试**

运行：`npx tsx --test tests/multi-agent-scenario.test.ts`
预期：PASS。如果失败，说明 Task 1–12 之间有接口没有对上：按失败信息修正对应 Task 中的实现，不能改测试的预期。

- [ ] **Step 3: 全量回归并提交**

```bash
npm run typecheck && npm test && npm run build
git add tests/multi-agent-scenario.test.ts
git commit -q -m "test: cover mixed-agent reject, dispute, advice and pass scenario

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: 预检（不调用模型）

**Files:**
- Modify: `scripts/protocol-preflight.ts`（增加 `--claude` 段）
- Modify: `scripts/project-preflight.ts`（覆盖可选的 advisor）

- [ ] **Step 1: Claude 预检**

在 `scripts/protocol-preflight.ts` 末尾，当 `process.argv.includes('--claude')` 时：
- 用 `claudeRoleLaunch` 构造只读 advisor 的 `baseOptions`，授权变量缺失时传一个占位值 `'preflight'`；
- 创建 `ClaudeAgentRuntime`，journal 使用临时 sqlite；
- 调用 `listModels()`；
- 输出 `{ claude: 'connected', modelCount, policy: { settingSources: [], strictMcpConfig: true, allowedTools, disallowedTools }, modelTurns: 0 }`；
- 模型数量为 0 时抛错。

运行：`npm run protocol-preflight -- "$PWD" --claude`
预期：Codex 段和 Claude 段都成功，`modelTurns: 0`。

- [ ] **Step 2: Codex 预检（版本漂移确认）**

运行：`npm run protocol-preflight`
预期：成功；把实际的 `modelCount` 和工具策略回读结果记下来，在 Task 21 中写进 README。

- [ ] **Step 3: project-preflight**

确认 `scripts/project-preflight.ts` 会遍历 `config.powerContext.roles`；包含 advisor 时也会检查它的 `/v1/access/me` 和 `/v1/access/check`。如果代码里写死了 4 个角色，改为遍历配置中的角色。用 Mock 配置运行一次，确认参数解析正常。

- [ ] **Step 4: 提交**

```bash
npm run typecheck && npm test && npm run build
git add scripts/protocol-preflight.ts scripts/project-preflight.ts
git commit -q -m "feat: preflight Claude runtime and advisor identity without model turns

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: 身份与 MCP 登记（运维；前提是计划 A 已完成）

**Files:**
- Modify（外部，每一步都要用户确认）：`~/playground/powercontext/principals.json`；PowerContext Access 绑定；`~/.claude.json`（通过 `claude mcp add`）；`~/.claude/skills/`
- Create（私有，不入库）：`<runtimeDir>/lead.env`（`0600`）

- [ ] **Step 1: 备份**

运行：`cd ~/playground/powercontext && .venv/bin/python ops/pc_backup.py backup --reason pre-principal-add --operation coordinator-principals-20261008`
预期：`problems: []`。

- [ ] **Step 2: 生成两条新凭据（停下，请用户确认）**

用 Python 生成随机 token，并原子地追加到 `principals.json` 的 `credentials` 数组。两条记录分别为：
- `{"credential_id":"coordinator-lead-v1","principal_type":"service","principal_id":"coordinator-lead","description":"Coordinator lead","collaborative_writer":true}`
- `{"credential_id":"coordinator-advisor-v1","principal_type":"service","principal_id":"coordinator-advisor","description":"Coordinator advisor","collaborative_writer":false}`

token 只写入文件，不输出到终端；写入后确认文件权限仍为 `0600`。然后运行：

```bash
~/.local/share/uv/tools/powercontext/bin/python ~/playground/powercontext/multi_principal_server.py --env-file ~/playground/powercontext/.env --data-dir "$HOME/Library/Application Support/powercontext" --credentials-file ~/playground/powercontext/principals.json --check
```

- [ ] **Step 3: 重启服务（停下，请用户确认时机）**

```bash
launchctl kickstart -k gui/$(id -u)/com.local.powercontext-multi-principal
sleep 3 && cd ~/playground/powercontext && .venv/bin/python ops/verify_access.py
```

预期：9 行全部 `ok`。

- [ ] **Step 4: 确认 Access API 的请求格式（只读）**

```bash
D=$HOME/.local/share/uv/tools/powercontext/lib/python3.12/site-packages/powercontext
grep -n -A12 'path="/v1/access/bindings/create"' $D/http/_generated/operations.py | head -20
grep -n -B2 -A25 "class CreateAccessBindingRequest\|class AccessBindingCreate" $D/http/_generated/schema.py | head -60
grep -n "bootstrap_access\|def _bootstrap" ~/playground/powercontext/multi_principal_server.py
```

记录请求字段名，以及 `--bootstrap-access` 会同步哪些 Principal。如果它会把 coordinator Principal 同步到全部 Scope，把这一点写进最后的报告，并建议以后不要再运行它，或者改为只同步 `codex-macmini` 和 `zcode-macmini`。改不改由用户决定，本计划不修改那个脚本。

- [ ] **Step 5: 为项目 Scope 授权（停下，请用户确认具体请求）**

用 `dashboard-admin` 凭据（或者已有授权能力的 Principal）调用 `/v1/access/bindings/create`，目标 Scope 为 `scp_2759kw81x6233xpacens49sfrc`：
- `coordinator-lead`：viewer、contributor、reviewer，`idempotency_key` 为 `coordinator-lead-scp_2759-v1-<role>`；
- `coordinator-advisor`：viewer，`idempotency_key` 为 `coordinator-advisor-scp_2759-v1-viewer`。

脚本放在 scratchpad 中，凭据从 `principals.json` 读取，输出时不包含 token。

- [ ] **Step 6: 建立 role-session 绑定，并核验允许项和拒绝项**

按 README 第 5 节的核验顺序执行：`/health/ready` → 每个角色 `/v1/access/me` → 精确解析 `{integration:"codex-session-coordinator", kind:"role-session", external_id:"<group>/lead/<gen>"}` 和 `.../advisor/1`（`allow_default=false`）→ `/v1/access/check`。检查这三项：
- advisor 写入：拒绝；
- lead 委派：拒绝；
- lead 写入记忆：允许。

绑定的建立方式以现有 `assertRoleHostBinding` 和 `PowerContextProjectClient.verify` 的实际调用为准。具体调用哪个接口，先读 `src/integrations/powercontext.ts` 中 `verify` 的实现，再照它执行。

- [ ] **Step 7: Claude 侧登记 MCP 和复制 skill（停下，请用户确认）**

```bash
claude mcp add --scope user --transport http cli_session_task http://172.16.0.90:47321/mcp
for s in task-recovery submit-for-acceptance dependency-validation dependency-repair; do [ -e ~/.claude/skills/$s ] || cp -R ~/.codex/skills/$s ~/.claude/skills/$s; done
claude mcp list
```

然后在本仓库的私有运行目录中创建 `lead.env`，内容为 `POWERCONTEXT_COORDINATOR_LEAD_AUTHORIZATION='Bearer <coordinator-lead token>'`，权限 `0600`。token 由脚本从 `principals.json` 中读取并写入，不在终端显示。

- [ ] **Step 8: 配对看板**

请用户在 `http://172.16.0.90:47321/board?repo=codex-session-coordinator` 上生成配对码；在本 Claude 会话中调用 `board_pair` 工具完成配对，然后确认能看到这个仓库的任务列表。

---

### Task 19: Skill 与文档

**Files:**
- Modify: `skills/codex-session-coordinator/SKILL.md`、`skills/codex-session-coordinator/references/operations.md`
- Modify: `README.md`（第 1、5、6、8、9、11、13 节）

- [ ] **Step 1: 更新 Skill（两方通用）**

- `description` 改为 "Coordinate one lead with frontend, backend, audit and advisor workers running on Codex or Claude…"；
- 增加以下几段：
  - 角色与 agent 的对应关系（`roles.<role>.agent`、`leadAgent`）；
  - lead 启动：`herdr:resume -- <runtime> --agent claude|codex <uuid>`，心跳由启动器负责发送；
  - advisor：consult 和 arbitration 两种，`arbitration_suggested` 只是提示，仲裁结果不改审计状态；
  - 换 lead：pause → 等心跳过期 → `human-control lead-rotate` → 新 lead 启动；
  - 不使用 PowerContext Handoff；
  - 窗格可以手动关闭，只有新调用才重新打开，也可以用 `herdr:compact`。
- 工具名同时给出两种写法：Codex 下是 `automation_*`，Claude 下是 `mcp__coordinator__automation_*`。
- 记忆写入时的 agent 标记（spec 4.6）：先从 PowerContext MCP 的 `tools/list` 中读出 `remember_memory` 的 inputSchema（用 lead 身份发一次只读的 `tools/list` 请求）。如果它支持 metadata 或 attributes 一类的字段，Skill 就规定把 `{agent, model, effort}` 写进这个字段；如果不支持，就规定正文以 `[agent=<agent> model=<model> effort=<effort>]` 开头。确认的结论写进 Skill，并记入 `docs/verification.md`。
- Scope 落点：本项目使用 `scp_2759kw81x6233xpacens49sfrc`；协调其他业务项目时，使用该项目自己的 Scope，不允许回退到 Default。

**不要覆盖** `~/.codex/skills/codex-session-coordinator`。仓库内的版本更新后，在交付说明中告诉用户：用 `diff -r` 比较两个版本，确认后再由用户决定是否同步到 Codex 侧。Claude 侧的 `~/.claude/skills/codex-session-coordinator` 不存在时可以直接复制。

- [ ] **Step 2: 更新 README**

- 第 1 节：角色表增加 advisor，并增加"执行方"一列。
- 第 5 节：配置表增加 `leadAgent`、`leadWorktree`、`roles`、`advisor`、`realExecution.advisor`、`realExecution.choices.advisor`。
- 第 6 节：给出两种 agent 的模型示例，标明 Claude 的模型目录以 `supportedModels()` 的实际结果为准。
- 第 8 节：增加入口选择表（Kitty 里套 Herdr 的情况）、窗格生命周期说明，以及 `herdr:compact`。
- 第 9 节：增加 Claude 的 MCP 登记方式、`lead.env` 和 `lead-session`。
- 第 11 节：增加 `LEAD_CONFLICT`、`PROVIDER_UNAVAILABLE`、Claude 鉴权来源异常。
- 第 13 节：更新已验证版本（Codex CLI 0.161.0、Herdr 0.9.3、Kitty 0.48.2、Claude Code 2.1.294）和测试数量，删掉"Claude Code CLI 接入留待后续"。

- [ ] **Step 3: 提交**

```bash
git add skills README.md
git commit -q -m "docs: document dual-agent workflow, advisor and lead launcher

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 20: 真实验证——用新工作流实现 Dashboard 的"执行方展示"

**目的:** 按 spec 9.1，Dashboard 的执行方展示由 worker 实现，lead（本会话，Claude）不直接写这部分代码。

**Files（由 worker 修改）:**
- backend：`src/dashboard/contracts.ts`、`src/dashboard/projection.ts`、`tests/dashboard-model.test.ts`
- frontend：`web/dashboard.html`、`web/dashboard.js`、`web/dashboard.css`、`tests/dashboard.test.ts`

- [ ] **Step 1: 准备 worktree 和 Task（停下，请用户确认）**

```bash
git worktree add -b feat/dashboard-agent-backend ../codex-coordinator-workers/backend feat/multi-agent-runtime
git worktree add -b feat/dashboard-agent-frontend ../codex-coordinator-workers/frontend feat/multi-agent-runtime
```

通过 `cli_session_task` MCP，按 `task-recovery` skill 的流程完成以下事项：
- 用 `git config user.name` 的原始值作为 owner，为 lead、frontend、backend 各登记一个 Task（`repositoryId: codex-session-coordinator`）；
- 对每个 Task 完成冲突检查、attach/start 和租约验证；
- 把 Task ID、sessionId 和过期时间写入新的私有 runtime 配置。

- [ ] **Step 2: 创建运行配置（私有，不入库）**

新建目录 `.state/multi-agent-20261008/`（权限 `0700`），复制 `config/app-server.example.json` 作为 `runtime.json`，然后填写：
- `mode: "real"`、`leadMode: "external"`、`leadAgent: "claude"`；
- `leadWorktree` 为本仓库的路径；
- `roles`：frontend 和 backend 为 codex，audit 和 advisor 为 claude；
- `repositories`：本仓库加两个 worker worktree；
- `workerTasks`：两条记录；
- `externalTaskObservation`：lead Task 的信息；
- `powerContext.roles`：5 个角色，`scopeId` 均为 `scp_2759kw81x6233xpacens49sfrc`，`bindingKey.external_id` 为 `multi-agent-20261008/<role>/1`。

然后执行：

```bash
COORDINATOR_ROLE=lead npm run group-init -- .state/multi-agent-20261008/runtime.json
```

接着请用户在自己的终端中执行 `npm run human-control -- .state/multi-agent-20261008/runtime.json init`。

- [ ] **Step 3: 预检**

```bash
npm run project-preflight -- "$PWD/.state/multi-agent-20261008/runtime.json"
npm run worker-preflight -- "$PWD/.state/multi-agent-20261008/runtime.json" "$PWD/.state/multi-agent-20261008/worker-tasks.json"
npm run protocol-preflight -- "$PWD" --claude
```

预期：全部通过。任何一项失败都先修复，不扩大权限、不换身份重试。

- [ ] **Step 4: 申请真实执行额度（停下，等用户批准）**

向用户列出拟批准的 `realExecution`：
- `taskRefs`：lead、frontend、backend 三个 Task；
- `maxCalls: 6`、`maxConcurrent: 2`、`maxInputCharacters: 16000`、`maxTurnMs: 300000`；
- `choices`：frontend 和 backend 用 `gpt-6-luna` + medium；audit 用 `claude-opus-5-5` + high；advisor 用 `claude-opus-5-5` + high；
- `advisor: { maxCalls: 2, maxInputCharacters: 8000 }`；
- 有效期 4 小时。

模型名以 Task 17 预检得到的实际模型目录为准。用户批准后写入配置，`authorizationRef` 记为用户这次批准的引用。

- [ ] **Step 5: 启动**

daemon 在 Herdr 的一个 tab 中前台运行：`npm run daemon -- .state/multi-agent-20261008/runtime.json`。Dashboard 在另一个 tab 中运行，端口 25426。

请用户在 Herdr 的主窗格中退出当前会话，然后执行：

```bash
npm run herdr:resume -- "$PWD/.state/multi-agent-20261008/runtime.json" --agent claude <本会话 UUID>
```

恢复会话后确认三件事：`/mcp` 中能看到 `coordinator` 和 `powercontext`；Handoff 工具已被禁用；`automation_status` 显示 lead 在线。

- [ ] **Step 6: 发布契约并派发**

1. 用 `automation_role_initialize` 初始化 frontend、backend（在各自的 worktree 中）、audit 和 advisor（在 lead 的 worktree 中）。
2. 用 `automation_contract_publish` 发布契约 `dashboard-agent-view-v1`，内容包括：
   - 快照中每条派发、审计记录新增的字段：`agent`、`actualModel`、`actualEffort`、`actualModelSource`（取值 `codex_turn_context` 或 `claude_transcript`）、`usage`（`inputTokens`、`outputTokens`、`cachedInputTokens`、`costUsd`、`costEstimated`）；
   - 角色列表增加 advisor；
   - 顶层新增 `comparison: Array<{ agent; roleId; dispatches; firstPassRate; avgRepairRounds; avgDurationMs; inputTokens; outputTokens; adviceAdoptionRate; sampleSize }>`，只统计已核对过的完成记录；
   - advice 列表中带 `sameSource`。
   `affectedRoles` 为 frontend、backend、audit。
3. 各角色用 `automation_contract_ack` 确认契约。
4. 用 `automation_dispatch` 分别向 backend 和 frontend 派发任务，范围与验收标准按本 Task 的 Files 列表和 spec 7.2 编写。验证命令为 `npm run typecheck`、`npm test`、`npm run build`。
5. 至少发起一次 advisor 咨询，问题为"对比面板的指标定义，以及小样本时怎么提示"。

- [ ] **Step 7: 观察、审计和返修**

- 在 Herdr 中确认窗格按 frontend、backend 依次出现，之后出现 audit 和 advisor。手动关掉一个已经完成的窗格，确认它不会重新打开；下一次派发时它会重新出现。
- audit 用 `automation_validation_create` 和 `automation_validation_record` 记录审计结论。如果被拒绝，按 spec 5.3 的流程处理（异议或仲裁提示 → 是否发起仲裁由 lead 决定），然后返修并重新审计。
- 用 `automation_model_refresh` 核对实际模型：Codex 的记录来源应为 `codex_turn_context`，Claude 的应为 `claude_transcript`。

- [ ] **Step 8: 合并 worker 的结果，并做页面测试**

审计通过后，在本分支上 `git merge --no-ff feat/dashboard-agent-backend feat/dashboard-agent-frontend`。然后：
- 运行 `npm run typecheck && npm test && npm run build`；
- 按 README 第 10 节，用共享的 Edge CDP 打开 `http://127.0.0.1:25426/`，在 390px 宽度下检查 agent 标签、同源仲裁标记、对比面板和样本量提示，确认没有溢出、没有页面错误。

- [ ] **Step 9: 提交验收**

- 用 `automation_task_checkpoint` 写入 checkpoint，内容包括各执行方的 agent、模型、审计结论、建议是否被采纳以及用量；
- 用 `automation_submit_for_acceptance` 把任务提交到 `pending_acceptance`；
- 最终验收由用户在看板上完成。

---

### Task 21: 收尾核验

- [ ] **Step 1: 全量检查**

运行：`npm run typecheck && npm test && npm run build && sh -n scripts/herdr-resume.sh && sh -n scripts/kitty-lead.sh`
预期：全部通过，记录测试总数。

- [ ] **Step 2: 写验证记录**

在 `docs/verification.md` 中新增"2026-10-08 多 agent 运行时"一节，写入：
- 每个 Task 的测试结果；
- 真实验证的 dispatch、validation、advice ID，以及两种 agent 的实际模型证据和用量；
- 窗格手动关闭和重新打开的实测结果；
- 没有验证的项目，例如真实执行中途 daemon 崩溃后的恢复、Kitty 动态入口的真实 PTY 测试。

- [ ] **Step 3: 提交并更新代码图谱**

```bash
git add docs/verification.md && git commit -q -m "docs: record multi-agent runtime verification

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

然后用 codebase-memory-mcp 的 `index_repository` 重建本仓库索引，并用 `search_graph` 查询 `ClaudeAgentRuntime`、`AdviceRegistry`、`buildLeadLaunch`，确认能查到，同时核对索引对应的 commit。不推送远程；推送和合并由用户决定。
