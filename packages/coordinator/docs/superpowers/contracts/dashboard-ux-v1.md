# 契约 dashboard-ux-v1：Dashboard 易用性（全宽布局与有效信息展示）

- revision: `r4`（r3 → r4：用户要求显示时区统一为 Asia/Taipei（UTC+8），新增导出 `formatTime`；r2 → r3：按审计 93104b2a 明确审计条目契约引用的显示方式（快照契约条目没有 contractId，不做关联）与排序同值规则；r1 → r2：lead 用真实数据截图复核 r1 实现后澄清第 2 节——时间字段是 ISO 字符串、工作项不截短、右侧栏单列、摘要条与 390px 卡片的具体形态；第 1 节不变）
- 基线：`feat/multi-agent-runtime@455f0b0`（frontend、backend worktree 的起点；此后主分支只有文档与脚手架改动，未触及 dashboard）
- 依据：试点简报 `docs/superpowers/pilots/2026-10-09-dashboard-ux.md`；`DESIGN.md` 约束（只读、无写按钮、无外部资源与 localStorage、未知值明确标注、focus-visible、reduced-motion、forced-colors、表格可键盘聚焦）
- 受影响角色：backend（生产者）、frontend（消费者）、audit（审计）
- 兼容性：`compatible`（`schemaVersion` 保持 1，只新增字段）

## 1. 快照字段（backend：`src/dashboard/contracts.ts`、`src/dashboard/projection.ts`、`tests/dashboard-model.test.ts`）

派发记录 `roles[].dispatches[]` 新增 4 个字段，已有字段含义不变：

| 字段 | 类型 | 来源与规则 |
| --- | --- | --- |
| `queuedAt` | `string \| null` | `scheduled_work.queued_at`（epoch 毫秒）转 ISO 8601（UTC，`toISOString()`）；非有限数为 `null` |
| `startedAt` | `string \| null` | `scheduled_work.started_at` 同上；未开始为 `null` |
| `completedAt` | `string \| null` | `messages.completed_at`（`messages.message_id = dispatch_id`），原值须能被 `Date.parse` 解析，否则为 `null`；没有对应消息为 `null` |
| `durationMs` | `number \| null` | 仅当 `state = 'completed'`、不是对账完成、`startedAt` 与 `completedAt` 都有值且差值 ≥ 0 时为 `completedAt - startedAt`；其余一律 `null` |

- **对账完成**：`scheduled_work.evidence_json` 解析后 `outcome === 'completed'`（由 `automation_reconcile` 写入；正常回执写入的是含 `dispatchId/summary` 的回执，没有 `outcome`）。对账完成的派发 `completedAt` 照常输出，`durationMs` 为 `null`（对账时间不代表执行结束时间）。`evidence_json` 为空或无法解析时按非对账处理。
- `failed` 等非 `completed` 状态的 `durationMs` 为 `null`（归档时间不代表执行结束时间）。
- 不输出 `evidence_json` 的任何内容；继续保证快照不含原始工作包、回执正文与凭据。
- 现有排序（`queued_at DESC, rowid DESC`，最多 100 条）不变。

测试（SQLite fixture 行为测试，直接调用 `DashboardProjection.snapshot`）至少覆盖：

1. 正常回执完成：4 个字段都有值，`durationMs` 等于两时间差；
2. 缺值：排队未开始的派发 `startedAt/completedAt/durationMs` 为 `null`，`queuedAt` 有值；
3. 对账完成：`completedAt` 有值、`durationMs` 为 `null`；
4. `failed`：`durationMs` 为 `null`；
5. 快照 JSON 不含 `evidence_json` 中的标记串。

## 2. 页面（frontend：`web/dashboard.html`、`web/dashboard.js`、`web/dashboard.css`、`tests/dashboard.test.ts`、`DESIGN.md` 的 Layout/Components 段）

### 2.1 全宽布局

- 去掉 `.shell` 的 1480px 上限，左右保留 16～24px 边距（`clamp` 即可）。
- ≥1600px：摘要指标条通栏；其下两栏，主列为任务队列，右侧栏依次为协同会话、契约、审计（右侧栏宽度约 380～460px，区块内单列）。
- 1024～1599px：单列，区块内多列（会话卡网格自动填充；契约与审计并排）。
- 780～1023px：单列，会话卡两列，契约与审计上下排列。
- <780px：单列；任务队列改为卡片列表（见 2.6）。
- 不得用 `overflow: hidden`（含 `overflow-x`）掩盖溢出；任何宽度下无页面级横向滚动。

### 2.2 任务队列信息密度

- 全部角色的派发合并为一个列表，按 `queuedAt` 倒序；`queuedAt` 为 `null` 的排在最后，同值保持快照原顺序（按 `roles` 展开后的全局顺序，不是角色内序号）。
- 列：角色、工作项、状态、模型、开始时间、耗时、Turn。
- 时间字段 `queuedAt/startedAt/completedAt` 是 **ISO 8601 字符串**（不是数字），一律用 `Date.parse` 解析；解析失败按缺失处理。排序、开始时间、进行中耗时都基于解析结果。
- 工作项（`workId`，人类可读名，如 `dashboard-ux-v1-frontend-r1`）**完整显示、允许换行，不截短**；Turn 等 UUID 类标识显示前 8 位，完整值放 `title`；空值显示"未知"/"未执行"。
- 替代关系：有 `replacesDispatchId` 时在工作项后加短标记"替代上一次"，`title` 给被替代 ID。
- 模型一格（`modelCell(dispatch)`）：
  - 运行时已确认且 `actualModel === requestedModel` 且 `actualEffort === requestedEffort`：合并为 `gpt-6-sol · medium ✓`，`title` 注明证据来源；
  - 已确认但模型或强度不同：分开显示"请求 X · e / 实际 Y · e2"，用 warn 色并配文字"不一致"；
  - 已确认但实际强度缺失：显示"实际 Y · 强度未知"，不合并；
  - 有 Turn 未确认：显示"请求 X · e · 实际未确认"；无 Turn：显示"请求 X · e · 未执行"。
- 运行时已确认 = 有非空 `turnId` 与非空 `actualModel`，且 `actualModelSource` 为 `codex_turn_context` **或** `claude_transcript`（`runtimeModelLabel` 同步修正）。
- 状态徽标（`statusBadge(state)`，均配中文文字）：`completed` 已回执（good）、`starting/active` 执行中（accent）、`queued` 排队（中性）、`needs_reconciliation` 待核对（warn）、`failed` 执行失败（bad）、`cancelled` 已撤销 / `stale` 已失效（muted）；未知状态显示原值并用 muted，不得用 good。
- 开始时间：`startedAt` 按 zh-CN / Asia/Taipei（UTC+8）显示（当天可省略日期，`title` 给完整时间）；`null` 显示"未开始"。
- 页面上**所有**显示的时间（开始时间、快照时间、主会话有效期、授权到期、核验时间）都经同一个导出函数 `formatTime` 按 Asia/Taipei 格式化，结果不随运行机器时区变化；快照数据本身保持 UTC ISO。
- 耗时（`durationLabel(dispatch, capturedAt)`）：有 `durationMs` 时显示（如 `12分05秒`、`48秒`、`1小时03分`）；`starting/active` 且有 `startedAt` 时显示"进行中 N分"（按 `capturedAt - startedAt`）；对账完成或其他情况显示"—"并在 `title` 说明原因（如"对账完成，无可靠耗时"）；字段缺失（旧快照）显示"未知"。

### 2.3 协同会话

- 区块标题旁显示一次共同 Scope（全部 `projectAccess` 的 `scopeId` 相同时）；不一致时各卡分别显示。
- ≥1600px 右侧栏内会话卡**单列**；1024～1599px 会话卡网格自动填充（`repeat(auto-fill, minmax(260px, 1fr))` 或等效）。
- 卡片常显：角色、在线/离线（离线用 warn，配文字）、阻塞（有阻塞时显示阻塞码）、线程短 ID（前 8 位）、工作树末两级目录、待审批数（>0 时突出）。
- 其余（完整线程 ID、完整工作树、Principal、核验时间、控制权、排队、失效审批、代数）放原生 `<details>`，**所有宽度默认折叠**；常显行不得在详情里重复。

### 2.4 契约与审计

- 契约：文件名（`artifactRef` 的 basename）+ 修订号 + 兼容性；完整 `artifactRef` 与基线放 `title` 或 `<details>`。
- 审计：结论徽标 `passed` 通过（good）/ `rejected` 拒绝（bad）/ `error` 异常（warn）/ `running` 审计中（accent）/ 其他显示原值（muted）；显示周期；`contractRef` 是契约 ID（UUID），快照的契约条目不含该 ID，**不做关联**，显示"契约 <前 8 位>"，`title` 给全量；基线串截短显示，`title` 给全量。

### 2.5 摘要指标条

- 派发、契约、审计、调用观察压缩为**一条**指标条（单个容器内的四个紧凑项，≥780px 一行、<780px 两行两列），每项高度不超过约 56px，不再是四张大卡片。
- 调用观察主数字显示"已用 / 上限"（如 `2 / 6`，取 `budget.callsUsed` 与 `runtime.limits.maxCalls`），任一缺失显示"未知"；进行中、结果未知、授权到期等次要信息放 `title` 或指标条下方的一行次要文字，不得撑高指标项。

### 2.6 390px

- 任务队列为卡片列表，不再横向滚动整表。每张卡紧凑排布：第 1 行角色 + 状态徽标（同行两端对齐），第 2 行工作项，第 3 行模型（同 2.2 规则），第 4 行"开始时间 · 耗时"；Turn 可省略或放 `title`。字段如需标签，标签必须真实渲染（不得依赖未设置的 `data-label`）。
- 390px 整页高度应明显低于改造前（改造前 4257px，同一份数据）。
- 会话卡默认折叠详情。
- 整页无横向溢出，无页面错误。

### 2.7 实现与测试要求

- 格式化、排序、分组逻辑写成 `web/dashboard.js` 的导出纯函数，测试直接导入调用，不得用源码正则断言。至少导出并测试：`runtimeModelLabel`、`modelCell`、`statusBadge`、`auditBadge`、`durationLabel`、`sortDispatches`（输入快照 `roles`，输出带角色的扁平行）、`shortId`、`tailPath`、`commonScope`、`cardScope`、`formatTime`（测试须在非 UTC+8 的 `TZ` 下也成立）。
- 字段缺失（旧快照没有时间字段）时降级为"未知"，不抛错。
- `durationLabel`：`failed` / `cancelled` / `stale` 显示"—"并在 `title` 说明"未完成，无耗时"；只有字段整体缺失（旧快照）才显示"未知"。
- 审计条目：徽标只包住结论文字，不包住 validationId；契约引用按 2.4 显示。
- 继续遵守 DESIGN.md：只读、无外部资源与 localStorage、focus-visible、reduced-motion、forced-colors、可横向滚动区域可键盘聚焦；徽标颜色不单独承载含义。更新 DESIGN.md 的 Layout 段以反映全宽与断点。

## 3. 验证

- worker：`npm run typecheck`；backend `node --import tsx --test tests/dashboard-model.test.ts`；frontend `node --import tsx --test tests/dashboard.test.ts`。
- lead（沙箱外）：`npm test`、`npm run build`；页面在 1920/1440/390 截图，检查无页面级横向溢出、无页面错误。
- audit：对照本契约逐条核对 worker diff 与测试，结论 `passed` / `rejected`（行为缺陷）/ `error`（基础设施问题）。
