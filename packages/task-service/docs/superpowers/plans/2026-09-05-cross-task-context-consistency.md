# Cross Task Context Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:**补全跨任务、跨仓依赖协议，引入只负责上下文一致性和追溯的 ctx 工单，并解除软依赖对任务执行的错误阻塞。

**Architecture:**业务任务继续独立持有状态和 lease；ctx 工单关联上下游任务、仓库、revision、cycle 与事件序号。依赖同步、验证门禁、人工验收分离，只有 hard_block 影响推进，软依赖最多影响最终验收。

**Tech Stack:** TypeScript, Zod, SQLite, Vitest, MCP, Board HTTP/SSE。

**Spec:**本计划依据本轮确认的跨任务/跨仓依赖协议要求。

## Global Constraints

- ctx 不持有任务 lease，不替代业务任务，不执行业务交互。
- 依赖边和验证历史不可删除；新 revision/cycle 不复用旧请求。
- 跨仓事件必须带 repository、task、revision、cycle、sequence，并支持幂等与乱序保护。
- 不自动级联取消下游任务。

### Task 1: 协议模型与状态矩阵

**Files:** `src/shared/task-contracts.ts`, `src/shared/dependency-validation-contracts.ts`, `src/core/task-state.ts`, `docs/superpowers/specs/ctx-dependency-protocol.md`

- [ ] 定义 `DependencyPolicy`、`ContextStatus`、`DependencySyncState`、`ctx_id` 和事件 envelope。
- [ ] 明确 informational/validation_gate/acceptance_gate/hard_block 的转换矩阵。
- [ ] 增加状态机测试：软依赖不阻塞执行，hard_block 才阻塞验收/提交。

### Task 2: SQLite ctx 工单与依赖策略迁移

**Files:** `src/storage/progress-store.ts`, `src/storage/sqlite-progress-store.ts`, `src/storage/migrations.ts`

- [ ] 增加 `dependency_contexts`、`dependency_context_events` 表及索引。
- [ ] 为 `task_dependencies` 增加策略、ctx_id、generation/version 字段，兼容旧数据默认 `acceptance_gate`。
- [ ] 保留历史边和 validation cycle；取消只关闭当前 cycle，不删除绑定。
- [ ] 增加迁移和完整性测试。

### Task 3: 核心同步与取消/恢复语义

**Files:** `src/core/task-service.ts`, `src/server/main.ts`

- [ ] task submit 创建/更新 ctx，并发布带上下游仓库与 revision 的事件。
- [ ] validation complete 只更新同步状态和 gate；不得把软依赖失败映射为 reject。
- [ ] 上游取消发布 ctx 事件，终止活动验证 run，保留下游依赖边，不级联取消。
- [ ] 上游恢复创建新 cycle；下游可继续工作并重新验证。
- [ ] 增加乱序、重复事件、取消恢复和跨仓 fixture 测试。

### Task 4: MCP、Board 与 Web 展示

**Files:** `src/mcp/tool-schemas.ts`, `src/mcp/register-tools.ts`, `src/server/board-routes.ts`, `src/web/task-board.tsx`, `src/web/task-drawer.tsx`, `src/web/dependency-notifications.tsx`

- [ ] 增加 ctx 查询、同步状态查询和 `task_resume` MCP 合约。
- [ ] Board 展示执行状态、依赖同步状态、验证状态、验收门禁四个独立字段。
- [ ] 取消/恢复/验证事件通过 SSE 传播，客户端按 sequence 去重并处理旧事件。
- [ ] 保持人工 accept、返工、resume 三种动作独立。

### Task 5: 端到端验收

**Files:** `tests/unit/core/task-state.test.ts`, `tests/unit/core/task-service.test.ts`, `tests/integration/mcp/mcp-tools.test.ts`, `tests/integration/server/board-api.test.ts`

- [ ] 覆盖同仓和跨仓依赖、软依赖继续推进、hard_block、取消、恢复、新 cycle、事件幂等。
- [ ] 运行 `npm run typecheck`、`npm test`、`npm run build`、`git diff --check`。
- [ ] 提交前确认任务状态为 `pending_acceptance`，由人工验收完成最终关闭。

### Task 6: Worktree/branch 切换后的任务自动接管

**Files:** `src/core/session-service.ts`, `src/core/task-service.ts`, `src/storage/progress-store.ts`, `src/mcp/register-tools.ts`, `tests/unit/core/task-service.test.ts`, `tests/integration/mcp/mcp-transport.test.ts`

- [ ] 定义 session succession 条件：同 owner、同 repository、同 ctx/task 关联，允许 worktree/branch 改变；client family 只作风险提示，不作为唯一接管条件。
- [ ] 在 session rebind/transport successor 建立时发现旧 session 的非终态任务，将 lease 原子迁移到新 session，更新 `task_session_links` 与 worktree scope。
- [ ] 若新 worktree 与其他活动任务冲突，拒绝自动接管并返回结构化 `WORKTREE_CONFLICT`，不得留下无主 lease。
- [ ] 对旧 session 标记 stale/ended，写入 `lease_succeeded` 和 `session_succeeded` 审计事件；保证重复接管幂等。
- [ ] 覆盖分支切换、worktree 切换、transport 轮换、旧 session 无 lease、新 session 已持有其他任务 lease、冲突回滚等测试。

### Task 7: 显式 successor 关联协议

**Files:** `src/shared/task-contracts.ts`, `src/core/session-service.ts`, `src/core/task-service.ts`, `src/mcp/tool-schemas.ts`, `src/mcp/register-tools.ts`, `src/storage/progress-store.ts`, `src/storage/sqlite-progress-store.ts`

- [ ] 为 `session_context` 增加可选 `successor_session_id`/`successor_ctx_id`，禁止仅凭 owner/repository/client family 自动接管。
- [ ] 校验旧 session 属于同 owner/repository、任务仍为非终态、ctx/task 关联一致，且目标 worktree 无冲突。
- [ ] 在单事务内迁移 lease、更新 task-session link、记录 predecessor/successor 审计事件。
- [ ] 新 session 已有其他 lease、旧 session 已结束、关联过期或 worktree 冲突时返回结构化错误且不改变任何状态。
- [ ] 增加 transport 轮换和跨 worktree/branch 接管测试，并保留陌生 session 不能接管的回归测试。
