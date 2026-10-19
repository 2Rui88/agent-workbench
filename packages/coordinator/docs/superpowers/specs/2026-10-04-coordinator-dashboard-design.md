# 协同进度 Dashboard

## 已确认目标

当前 Codex 会话为外部主会话，前端、后端、测试审计为三个执行者。Dashboard 统一查看项目实施状态，并作为真实协同流程的 E2E 场景。最终验收只能由用户完成。

## 链路与边界

CLI Task 的任务、实际 worktree 和有效租约 → 主会话受控派发 → Coordinator SQLite 队列、契约与回执 → 只读 HTTP 投影 → 浏览器页面 → Edge CDP 断言。

PowerContext 使用独立项目 Scope `scp_2759kw81x6233xpacens49sfrc`。主会话为 `codex-macmini`，执行者分别为 `coordinator-frontend`、`coordinator-backend`、`coordinator-audit`。执行者没有其他 Scope 权限。当前服务的绑定解析要求 `server.observe`；仅主会话解析真实 host binding，执行者独立验证身份、Scope 和动作。不要给执行者服务器级权限。

当前主会话的完整对话不自动镜像到协调进程。外部主会话显式登记身份和心跳，协调器不启动第二个主模型、不自动生成主会话 turn。外部主会话过期后停止新增执行。

真实执行先采用前后端 `gpt-6-luna / medium`、审计 `gpt-6.1-sol / high`。初始受控策略最多 8 次调用、最多 2 个执行者并行，授权到期与任务租约过期立即停止新增调用。策略是本次工程上限，并非用户提供的账单额度。升级或重试需要可核验的失败证据；未知调用结果禁止重放。实际模型、token、费用没有协议证据时显示未知。

CLI Task 主租约仍由当前会话持有。协调器不得冒充该 session 写 checkpoint 或 submit。若允许显式委托只读任务门禁，必须限定任务 ID、repository、worktree、session、有效期并实时核验；主会话负责所有任务状态写入。

## 页面与接口

使用现有 Node/TypeScript、SQLite、原生 HTML/CSS/JS，不引入 UI 框架或额外浏览器。

- `GET /health`：HTTP 观察进程健康。
- `GET /api/snapshot`：带 schemaVersion、capturedAt、source 的脱敏观测快照；数据库不可用返回 503。
- `GET /`、固定静态资源：Dashboard 页面。
- 仅 loopback，校验 Host/Origin，禁止 CORS、任意文件读取、写接口和凭据下发。
- 角色状态、请求模型/effort、turn/thread、队列、契约与审计、阻塞、调用上限和证据分别展示。
- 分页或有界列表必须报告总数和截断状态；禁止将截断列表呈现为全部。
- 轮询失败保留最后成功快照，显式显示过期和重试；空数据、加载、错误和未知值均有明确文案。

## 浏览器验证

先核验 PowerContext、CLI Task、Dashboard HTTP 健康，再核验实际 Edge CDP 协议与身份。共享一个 Edge，独占浏览器租约，自有隔离 context/page；不 launch、不下载 Chromium、不操作用户页面、不终止 Edge。

验证真实数据库变化 → HTTP 快照 → 页面更新，以及离线、空队列、长文本、窄屏、键盘和审计返修链路。Mock、协议接入、真实模型回执和业务 E2E 分层报告。

## 交付边界

保留现有未提交实现和 .DS_Store，不自动提交或推送，不修改关联仓库业务源码。仅当前项目实现与已授权的 PowerContext 项目接入配置。最终提交 `pending_acceptance`。
