# 契约 dashboard-agent-view-v1：Dashboard 执行方展示

- revision: `r3`（r1 → r2：按 advisor 咨询 9e74620f 修订对比面板口径；r2 → r3：按审计 9060d8f9 明确归属、替代链计数、分数字段、显示精度与测试要求）
- 基线：`feat/multi-agent-runtime@2748e23`（frontend、backend worktree 的起点）
- 依据：spec §7.2、§9.1；`DESIGN.md` 的约束不变（只读、未知值明确标注、390px 下无溢出）
- 受影响角色：backend（生产者）、frontend（消费者）、audit（审计）

## 1. 快照字段（backend：`src/dashboard/contracts.ts`、`src/dashboard/projection.ts`）

`schemaVersion` 保持 `1`，只做向后兼容的新增，已有字段的含义不变。

### 1.1 派发记录 `roles[].dispatches[]` 新增

| 字段 | 类型 | 来源 |
| --- | --- | --- |
| `agent` | `'codex' \| 'claude' \| null` | `scheduled_work.work_json.agent`；没有时为 `null`（旧记录） |
| `actualModelSource` | `'codex_turn_context' \| 'claude_transcript' \| null` | `runtime_models.source`，原值透传 |
| `usage` | `{ inputTokens, outputTokens, cachedInputTokens, costUsd: number \| null; costEstimated: boolean; source: string } \| null` | `turn_usage.payload_json`；没有记录时为 `null` |

- `costEstimated`：Claude 的 `costUsd` 来自 SDK 结果，是客户端估算值，为 `true`；Codex 没有费用，`costUsd` 为 `null`，`costEstimated` 为 `false`。
- 已有字段 `actualModel`、`actualEffort` 保持不变，Claude 记录同样填充。

### 1.2 角色列表

`roles` 继续按 `ROLE_IDS` 输出，包括 `advisor`（已经是 5 个角色，补测试覆盖）。

### 1.3 建议记录：顶层新增 `advice`

```ts
advice: Array<{ adviceId: string; kind: 'consult' | 'arbitration'; state: 'requested' | 'completed' | 'resolved';
  agents: { advisor: string; worker: string[]; audit: string[] }; sameSource: boolean;
  verdict: string | null; decision: 'adopted' | 'rejected' | 'partial' | null }>
```

来源 `advice_requests.payload_json`，最多 100 条，按 rowid 倒序；不输出问题正文、建议正文和备注（与"不显示原始消息正文"一致）。表不存在时为 `[]`。

### 1.4 顶层新增 `comparison`

```ts
comparison: {
  rows: Array<{ agent: string; roleId: string; models: string[]; dispatches: number; verifiedSamples: number;
    contractSamples: number; firstPass: { passed: number; total: number }; firstPassRate: number | null; repairSamples: number; avgRepairRounds: number | null;
    durationSamples: number; avgDurationMs: number | null;
    usageSamples: number; avgInputTokens: number | null; avgOutputTokens: number | null;
    needsReconciliation: number; failed: number;
    adviceSamples: number; adviceAdoptionRate: number | null; adviceCounts: { adopted: number; partial: number; rejected: number } }>;
  excluded: { mixedContract: number; mixedChain: number; unverified: number; superseded: number };
  minSamples: number;
  tokenCaliber: { codex: string; claude: string };
}
```

口径（只统计已核对的记录）：

- **已核对样本**：`scheduled_work.state = 'completed'`，同时有 `work_receipts` 回执和 `runtime_models` 实际模型记录，并且 `agent` 不为 `null`；缺任一项的 `completed` 派发计入 `excluded.unverified`。
- **替代链**：凡是被后继派发（另一条派发的 `work_json.replacesDispatchId` 指向它）取代的派发，不论自身状态，都不算样本，各计入 `excluded.superseded` 一次。链末端的后继派发若与链上任一前驱的 `agent` 不同，也不算样本，计入 `excluded.mixedChain`（按派发计数）。
- 分组键：`agent × roleId`，行序固定：先按 `agent` 名升序，再按 `ROLE_IDS` 顺序；**不按任何指标排序**。`models`：该分组已核对样本的 `actualModel/actualEffort` 去重列表（形如 `gpt-6-luna/medium`）。
- `dispatches`：该分组的全部派发数（不论状态）；`verifiedSamples`：已核对样本数；`needsReconciliation`、`failed`：该分组 `state` 为 `needs_reconciliation`、`failed`（含已归档的失败）的派发数。
- **契约归属**（firstPassRate、avgRepairRounds，仅 frontend、backend）：只看该契约（`work_json.contractRef`）下**角色为 frontend 或 backend** 的非取消派发，lead、audit、advisor 的派发不参与判断。这些派发全部属于同一个非 `null` 的 `agent` 和同一个 `roleId` 时，契约归属该分组；否则（含任一派发 `agent` 为 `null`、或同时有 frontend 和 backend）不进任何分组，计入 `excluded.mixedContract`（按契约计数）。没有 frontend/backend 派发的契约不参与统计，也不计数。`contractSamples`：归属该分组、且至少有一轮已关闭审计的契约数。
- `firstPass`：`total` 为归属契约中至少有一轮非 `error` 已关闭审计的契约数，`passed` 为其中第 1 个非 `error` 轮结果为 `passed` 的契约数（首轮为 `error` 时以其后第一个非 `error` 轮为准）。`firstPassRate` = `passed / total`，`total` 为 0 时为 `null`。
- `avgRepairRounds`：只统计最终已 `passed` 的归属契约，取其 `rejected` 轮数的平均值（`error` 轮不计入）；没有时为 `null`。
- `avgDurationMs`：已核对样本从 `scheduled_work.started_at`（毫秒）到同 ID 派发消息 `messages.completed_at`（`message_id = dispatch_id`）的平均值。经过对账完成的派发（`event_log` 中有该消息的 `message.reconciled` 事件）不计入，因为其 `completed_at` 是对账时刻。`durationSamples` 为实际计入的样本数；为 0 时 `avgDurationMs` 为 `null`。
- `avgInputTokens`、`avgOutputTokens`：已核对样本中对应字段不为 `null` 的样本的每样本均值，`usageSamples` 为计入的样本数；缺失不当作 0，为 0 个样本时为 `null`。
- `tokenCaliber`：固定文案，说明两种 agent 的 token 口径不同：`codex` 为"input 含缓存命中"，`claude` 为"input 不含缓存，缓存读写单独计"。
- `adviceAdoptionRate`、`adviceCounts`、`adviceSamples`：仅对 advisor 分组。在已 `resolved` 的建议中统计三种 decision 的计数；采纳率为 `(adopted + 0.5 × partial) / adviceSamples`，`adviceSamples` 为已 resolved 的建议数；为 0 时采纳率为 `null`。非 advisor 分组的三项为 `0`、`null`、全 0。
- `minSamples`：固定为 `5`，作用于每个指标**自己的**样本数：firstPassRate 用 `firstPass.total`，avgRepairRounds 用 `repairSamples`（最终已 passed 的归属契约数；`contractSamples` 不再用于判断），耗时用 `durationSamples`，token 用 `usageSamples`，采纳率用 `adviceSamples`。这只是展示下限，不代表统计显著性。

## 2. 页面（frontend：`web/dashboard.html`、`web/dashboard.js`、`web/dashboard.css`）

- **agent 标签**：任务队列每行显示 `agent · 实际模型 · 实际思考强度`，例如 `codex · gpt-6-luna · medium`；需要时可在其后用 ` · ` 追加确认状态（如 `运行时已确认`），但前三段格式固定。`runtimeModelLabel` 同时接受 `codex_turn_context` 和 `claude_transcript` 作为已确认来源；agent 为 `null` 时显示"agent 未知"。
- **用量**：队列行显示 token；`costUsd` 有值时显示费用，`costEstimated` 为 `true` 时标注"估算"；`usage` 为 `null` 或 `costUsd` 为 `null` 时对应项显示"未知"。顶部摘要不再固定写"Token / 费用未知"，改为显示已知 token 合计（input、output）和已知费用合计，并注明各自的未知条数。
- **建议记录**：在"审计与返修"旁边或下方列出 advice，显示 kind、state、三方 agent、verdict、decision。`sameSource` 为 `true` 时显示"同源仲裁"（consult 显示"同源建议"），用 warn 配色并配文字。
- **执行方对比面板**：新增只读面板，按 `comparison.rows` 的固定行序展示，不提供排序。每个指标按自己的样本数（见 1.4 `minSamples`）判断：达到阈值时比例显示为整数百分比；未达阈值时，firstPassRate 显示 `firstPass.passed/firstPass.total`，采纳率显示 `采纳 a · 部分 p · 未采纳 r`（直接取 `adviceCounts`，不从比例反推）。avgRepairRounds 保留 1 位小数，avgDurationMs 按秒取整显示（满 60 秒显示为分秒），token 均值取整；未达阈值时数值后加"样本 n"。所有行用统一的中性样式，不用颜色、高亮或图标表达优劣；`null` 显示"无数据"。每行显示 `models` 列表。面板常驻说明："任务不是随机分配的，样本少，不构成优劣结论"；token 列旁显示 `tokenCaliber` 的口径差异；advisor 行注明"采纳率只反映 lead 的取舍，不代表建议质量"。面板下方显示 `excluded` 四项计数，以及各行的待核对、失败计数。表头 `th` 带 `scope="col"`。
- 遵守 `DESIGN.md`：不加写操作按钮；表格可横向滚动且可键盘聚焦；390px 宽度下无页面级横向溢出，且**不得**用 `overflow-x: hidden` 等方式隐藏溢出，应让内容本身适配。

## 3. 验收

- backend：`tests/dashboard-model.test.ts` 用含真实行（scheduled_work、work_receipts、runtime_models、turn_usage、validation_runs、advice_requests、messages、event_log）的 SQLite fixture 做行为测试，至少覆盖：audit/advisor 派发不影响契约归属；同时有 frontend 与 backend 的契约计入 mixedContract；`agent` 为 `null` 的派发；替代链（被取代的前驱不论状态都计入 superseded、同 agent 后继计为样本、跨 agent 后继计入 mixedChain）；首轮 error 以其后第一个非 error 轮为准；返修轮数只统计最终 passed；经对账完成的派发不计耗时；缺失用量不当作 0；partial 记 0.5 及 adviceCounts；`firstPass` 分子分母；1.1 的 agent、usage、costEstimated；1.3 的 advice 映射；固定行序；advisor 角色存在。
- frontend：从 `web/dashboard.js` 导出纯函数（标签、用量、对比单元格格式化等），`tests/dashboard.test.ts` 直接调用并断言输出，不用源码正则代替行为测试。至少覆盖：两种已确认来源与 agent 未知的标签；同源建议/同源仲裁标记；未达阈值时显示 `firstPass` 分数和采纳计数而不是百分比；达到阈值显示整数百分比；小数与耗时的显示精度；`costUsd` 为 `null` 显示"未知"；摘要的已知合计与未知条数；常驻说明与口径提示文本；`null` 显示"无数据"。
- 两边都通过 `npm run typecheck`、`npm test`、`npm run build`。worker 沙箱若无法运行测试（tsx IPC 管道 `listen EPERM`），可就该测试命令申请审批，由用户决定；lead 会复跑全部验证。
- 只修改各自 allowedPaths 内的文件。
