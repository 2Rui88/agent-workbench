# 试点简报：Dashboard 易用性（全宽布局与有效信息展示）

给新的 lead 会话：这是第一次用 `project:init` 流程把协同工作流用在实际工作上。先读本文件，再读 `docs/new-project-herdr.md` 和 skill `codex-session-coordinator`。用户确认的方向：页面使用全宽，优化有效信息的展示，其余按本简报的建议。

## 已完成的准备（2026-10-09，上一个 lead 会话）

| 项 | 状态 |
| --- | --- |
| 运行目录 | `.state/dashboard-ux-20261009`（`project:init` 生成，0700） |
| worker worktree | `~/playground/dashboard-ux-workers/frontend`（分支 `feat/dashboard-ux-20261009-frontend`）、`…/backend`（`feat/dashboard-ux-20261009-backend`），均从 `feat/multi-agent-runtime@455f0b0` 拉出，已 `npm ci` |
| `workerTaskSpecs` | 已写入 runtime.json |
| `group-init` | 已完成（`roles.json`） |
| PowerContext | Scope `scp_2759kw81x6233xpacens49sfrc` 授权沿用；5 个角色会话键已登记（`pc-bind-roles.sh`） |
| `project-preflight` | 通过 |
| 改造前截图 | `docs/superpowers/pilots/2026-10-09-dashboard-ux/before/`（1920、1440、390，`-top` 与 `-full`；改造后在同目录 `after/`。原 `.state` 运行目录与截图脚本 `shot.mjs` 已在试点收尾后删除） |

上一轮"执行方展示"的 worker 改动在 `feat/dashboard-agent-backend@00c4d3a`、`feat/dashboard-agent-frontend@35d4c69`，未通过审计、未合并，**本试点不基于它们**。

## 走查结论（改造前）

- 1920px：`.shell` 最大宽度 1480px，两侧各留约 220px；所有区块单列堆叠，整页 2555px，首屏只见任务队列。
- 任务队列：按角色分组而非时间；无开始时间、耗时；工作项内嵌"替代 <完整 UUID>"，把一行撑成 2～3 行；Turn 列全量 UUID；请求模型与运行时模型两列多数相同；audit/advisor 显示"未确认"（`web/dashboard.js` 的 `runtimeModelLabel` 只认 `codex_turn_context`，不认 `claude_transcript`，属真实缺陷）；状态只有文字。
- 协同会话：5 张卡片重复同一长 Scope、完整 Principal 与绝对路径。
- 契约：每条重复完整绝对路径；审计：结论只写"返修"，没有通过/拒绝徽标，基线串很长。
- 摘要：四张大卡片，390px 下占满一屏。
- 390px：任务队列是 900px 宽的表格在 316px 容器内横向滚动；整页 4257px。无页面级横向溢出、无页面错误。

## 试点范围（建议契约 `dashboard-ux-v1`）

1. **全宽布局**：去掉 1480px 上限（保留 16～24px 边距）。≥1600px 时"任务队列（主列）+ 右侧栏（协同会话、契约、审计）"两栏；1024～1599px 单列但区块内多列；<780px 维持单列。
2. **任务队列信息密度**：按 `queuedAt` 倒序；新增"开始时间 / 耗时"列；工作项与 Turn 截短显示（前 8 位，`title` 给全量）；替代关系改为短标记"替代上一次"（`title` 给被替代 ID）；请求与实际模型一致时合并为一格（如 `gpt-6-luna · medium ✓`），不一致或未确认时分开并标明；状态徽标（配文字，未知/离线不得用成功色）；`runtimeModelLabel` 同时接受 `codex_turn_context` 与 `claude_transcript`。
3. **协同会话精简**：区块标题旁显示一次共同 Scope；卡片只留"在线/阻塞、线程短 ID、工作树末两级目录、待审批"；完整信息用原生 `<details>` 展开。
4. **契约与审计**：契约显示文件名 + 修订号 + 兼容性；审计显示结论徽标（通过/拒绝/异常）、周期、契约修订，基线串截短并 `title` 全量。
5. **摘要指标条**：四项压缩为一行（窄屏两行），"调用观察"显示已用/上限。
6. **390px**：任务队列改为卡片列表（每张：角色、工作项短名、状态徽标、模型、开始/耗时），不再横向滚动整表；会话卡默认折叠详情。

约束：遵守 `DESIGN.md`（只读、无写按钮、无外部资源与 localStorage、未知值明确标注、focus-visible、reduced-motion、表格可键盘聚焦）；不得用 `overflow:hidden` 隐藏溢出；zh-CN / Asia/Taipei（UTC+8）时间。

## 分工

- **backend**（`src/dashboard/contracts.ts`、`src/dashboard/projection.ts`、`tests/dashboard-model.test.ts`）：派发记录新增 `queuedAt`、`startedAt`、`completedAt`（ISO 字符串，来源 `scheduled_work.queued_at/started_at` 与 `messages.completed_at`）和 `durationMs`（`completedAt - startedAt`，经对账完成的为 `null`）；缺失为 `null`；`schemaVersion` 仍为 1。SQLite fixture 行为测试覆盖有值、缺值、对账完成。
- **frontend**（`web/dashboard.html|js|css`、`tests/dashboard.test.ts`）：其余全部。把格式化与分组逻辑写成导出纯函数并直接测试，不用源码正则；字段缺失时降级为"未知"。

## 执行要点

1. 用户在真实终端执行 `sh .state/dashboard-ux-20261009/human-init.sh`（daemon 启动前必须完成）。
2. lead 在本仓库建 lead Task（CLI Task：`session_context` → `task_create` → 主机证据 → `task_start`）。
3. `nohup sh .state/dashboard-ux-20261009/worker-hold.sh > .state/dashboard-ux-20261009/worker-hold.log 2>&1 &`，生成清单写入 `workerTasks` 与 `externalTaskObservation`，跑 `worker-preflight`。
4. 起草契约 `docs/superpowers/contracts/dashboard-ux-v1.md`，向用户申请 `realExecution`（建议：frontend/backend `gpt-6-sol` medium，audit/advisor `claude-sonnet-5-5` high；`maxCalls` 6（2 派发 + 2 返修 + 2 审计）、`maxConcurrent` 2、`maxTurnMs` 3600000、advisor 1 次、有效期 6 小时），批准后写入并启动 daemon（`start-daemon.sh`），初始化 4 个角色，发布契约，派发。
5. worker 验证命令：`npm run typecheck`、`node --import tsx --test tests/<文件>`；lead 在沙箱外复跑 `npm test` 和 `npm run build`，导出 diff 作为审计基线后派 audit。
6. 审计通过后 lead 在 worker 分支提交、合并到 `feat/multi-agent-runtime`，用 Edge CDP 9223（`scripts/start-edge.py`，9222 被日常 Edge 占用）+ `ux-baseline/shot.mjs` 在 1920/1440/390 截图对比，确认无溢出、无页面错误，再提交 `pending_acceptance`。
7. 每 20 分钟续租（`renew-workers.sh` + lead Task checkpoint）；daemon 重启后重新初始化角色。
