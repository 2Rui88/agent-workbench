# Coordinator Dashboard Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for coordinator bootstrap; use the user-authorized frontend/backend/audit workflow roles for the real execution trial. Do not create redundant implementer/reviewer sessions per small edit.

**Goal:** 以当前会话统筹真实执行，并通过只读 Dashboard 与 Edge E2E 验证协同进度。

**Architecture:** 复用持久队列与观察投影，增加外部主会话、显式真实调用门禁和本地 HTTP 观察面。任务状态写入保留在当前主会话；浏览器只接管已有 Edge。

**Tech Stack:** Node >=24, TypeScript, SQLite, node:http, vanilla web UI, Playwright Core CDP.

**Spec:** `docs/superpowers/specs/2026-10-04-coordinator-dashboard-design.md`

## Global Constraints

- 不自动提交或推送；最终人工验收。
- 前后端 gpt-6-luna / medium，审计 gpt-6.1-sol / high；首轮最大8次调用、并行2，未知调用结果冻结。
- 不给执行者服务器权限；不得冒用主会话 CLI Task transport。
- 无浏览器 launch、下载、用户页面操作或 Edge shutdown。

## Review Focus

1. 主会话心跳或任务委托过期后，新增执行必须停。
2. 未知模型/token 与离线状态必须真实展示。
3. HTTP 不得暴露 capability、原始消息正文、审批参数或 credential。
4. Host/Origin 绕过及静态路径穿越必须拒绝。
5. 截断列表、长文本及刷新失败不能伪装成完整/实时状态。

### Task 1: PowerContext 接入与 bootstrap

**Files:** `src/integrations/powercontext.ts`, `scripts/project-preflight.ts`, `scripts/daemon.ts`, `tests/project-enrollment.test.ts`.

**Interfaces:** `PowerContextProjectClient(request, bindingResolver?)`；role request 核验身份和项目动作，主身份 resolver 只读取绑定。

- [x] 定向创建 Scope、3 个私有凭据与项目 grants；原 launchd 入口重启并预检。
- [x] 验证四角色及九条跨 Scope 读取拒绝。
- [x] 写测试证明 resolver 与 role request 分离、错误绑定仍拒绝；先失败后修复。
- [x] 实现适配，运行 `npx tsx --test tests/project-enrollment.test.ts`：2/2；真实 `project-preflight` 四角色通过，整套105/105、typecheck/build通过。

### Task 2: 外部主会话与真实调用控制

**Files:** `src/engine.ts`, `src/runtime-config.ts`, `src/integrations/cli-task.ts`, `src/budget.ts`, `scripts/daemon.ts`, corresponding tests.

**Interfaces:** 显式 external lead registration/heartbeat；真实执行策略含授权引用、有效期、模型 allowlist、8 次调用与并行2；Task readonly delegation 限定具体绑定且禁止写。

- [ ] 先写过期主心跳、无授权、错模型、超并发、错 Task session/路径、委托写拒绝测试并确认失败。
- [ ] 实现控制，保留 Mock 默认行为与现有恢复冻结。
- [ ] 验证 `npm run typecheck` 与 focused tests。

### Task 3: Dashboard backend 与 frontend

**Files:** `src/dashboard/contracts.ts`, `projection.ts`, `http-server.ts`, `scripts/dashboard.ts`, `web/dashboard.html`, `dashboard.css`, `dashboard.js`, `tests/dashboard.test.ts`, `DESIGN.md`.

**Interfaces:** 先固定 `DashboardSnapshot` 类型，backend/frontend 仅分别写自己的文件；GET `/api/snapshot`，固定资源，无写接口。

- [ ] 定义 schemaVersion/capturedAt/source 及有界投影契约。
- [ ] backend 测试 SQLite→脱敏 snapshot、503、Host/Origin、路径穿越，随后实现。
- [ ] frontend 实现四角色、队列/契约/审计、阻塞、证据；轮询失败保留快照；中文、键盘、窄屏。
- [ ] 通过受控真实模型 dispatch 执行上述两个独立工作包；收集真实业务回执与调用证据。

### Task 4: 审计、Edge E2E 与验收门控

**Files:** `scripts/dashboard-e2e.ts`, `tests/dashboard-e2e.test.ts`, `docs/verification.md`.

- [ ] 较强审计模型审查准确性、权限、调用控制及 HTTP 边界，记录验证/返修契约。
- [ ] 服务与 Edge 双预检；真实数据库→HTTP→UI，刷新失败、空队列、窄屏、键盘；只清理自有资源。
- [ ] `npm run typecheck`, `npm run build`, `npm test` 与 premium 静态审查；区分真实模型和 Mock 证据。
- [ ] 主会话 checkpoint，并仅提交 pending_acceptance。

Execution authorization: user repeatedly approved continuing the Dashboard implementation, real-model development and project-specific PowerContext provisioning. The plan concretizes that approved scope; no additional permission is inferred for shared/global changes.
