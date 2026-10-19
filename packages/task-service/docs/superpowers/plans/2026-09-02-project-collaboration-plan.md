# 项目协作者只读可见与下游验证实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有项目 creator 归属基础上，增加项目分享/成员关系，使成员可查看项目全部任务但只能操作自己的任务，并保留跨 owner 下游依赖验证例外。

**Architecture:** 以 `projects.created_by` 表示创建人，以新增 `project_members` 和一次性 `project_shares` 表示协作授权。新增核心 `ProjectAccessService` 统一判断项目查看、创建人管理和任务 owner 操作权限；Board 与 MCP 只传递服务端认证 owner，TaskService 继续负责任务状态机和下游 validation 状态机。

**Tech Stack:** TypeScript、Node.js `node:sqlite`、Express、MCP Streamable HTTP、React/TSX、Vitest、Vite。

**Spec:** `docs/superpowers/specs/2026-09-02-project-collaboration-design.md`

## Global Constraints

- 分享凭证只保存 token 哈希，不把项目名或明文 token 当作授权凭证。
- 当前 owner 由 Board session 或绑定 MCP session 提供；不得信任请求体或查询参数伪造 owner。
- 成员可读取项目内所有任务，但普通任务写操作始终要求 `task.owner === authenticated owner`。
- 跨 owner 只允许既有下游 dependency validation contract 流程，不允许借此修改上游任务。
- 历史 `created_by IS NULL` 项目不自动推断创建人、不自动公开、不自动生成成员。
- 沿用已有 `review` 数据目录和服务实例；不创建替代仓库、空数据库或新的测试库。
- 不自动 commit、push、merge 或删除用户数据；每个实现环节先写失败测试再改最小代码。

---

### Task 1: 持久化项目成员与分享凭证

**Files:**
- Modify: `src/storage/migrations.ts`
- Modify: `src/storage/sqlite-progress-store.ts`
- Modify: `src/storage/progress-store.ts`
- Test: `tests/unit/storage/migrations.test.ts`
- Create: `tests/unit/storage/project-collaboration.test.ts`

**Interfaces:**
- Produces `ProjectMemberRecord`、`ProjectShareRecord` 类型，以及 `ProgressStore`/`ProgressTransaction` 的成员和分享凭证读写方法。
- Produces migration v11 `add_project_collaboration`，让现有 v10 数据库幂等升级。

- [ ] **Step 1: 写失败迁移与存储测试**

测试覆盖：v10 数据库升级后存在 `project_members`、`project_shares` 及 active-owner 索引；成员可插入、查询、撤销；分享 token hash 唯一，消费后不能再次消费；过期或撤销 token 不能消费；同一项目/owner 的 active 成员不会重复插入。

- [ ] **Step 2: 运行失败测试**

Run: `npm test -- --run tests/unit/storage/migrations.test.ts tests/unit/storage/project-collaboration.test.ts`

Expected: FAIL，缺少 v11 表或 `ProgressStore` 方法。

- [ ] **Step 3: 增加数据模型和 SQLite v11 migration**

在 `progress-store.ts` 增加：

```ts
export interface ProjectMemberRecord {
  project_id: string;
  owner: string;
  role: "member";
  granted_by: string;
  created_at: string;
  revoked_at: string | null;
}

export interface ProjectShareRecord {
  share_id: string;
  project_id: string;
  token_hash: string;
  created_by: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
  created_at: string;
}
```

`project_members` 使用 `(project_id, owner)` 主键；`role` 限制为 `member`；`project_shares.token_hash` 唯一；外键删除项目时级联；为 `owner WHERE revoked_at IS NULL` 建索引。v11 migration 先用 `PRAGMA table_info`/`sqlite_master` 判断对象，再创建缺失对象，保证重复打开不产生错误。

- [ ] **Step 4: 实现事务方法和 token 状态转换**

实现 `getProjectMember(projectId, owner)`、`listProjectMembers(projectId, includeRevoked?)`、`upsertProjectMember(record)`、`revokeProjectMember(projectId, owner, revokedAt)`、`createProjectShare(record)`、`getProjectShareByTokenHash(tokenHash)`、`consumeProjectShare(shareId, tokenHash, consumedAt)`、`revokeProjectShare(shareId, projectId, revokedAt)`。消费 SQL 必须带 `consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`，并检查 affected rows 为 1。

- [ ] **Step 5: 运行 storage 测试并记录结果**

Run: `npm test -- --run tests/unit/storage/migrations.test.ts tests/unit/storage/project-collaboration.test.ts`

Expected: PASS；再运行 `npm run typecheck`，确认现有 fake store 只需实现新增接口的最小兼容方法。

---

### Task 2: 统一项目访问策略并接入任务服务

**Files:**
- Create: `src/core/project-access-service.ts`
- Modify: `src/core/task-service.ts`
- Modify: `src/core/task-service.ts` 的 `TaskServiceDeps` 与构造函数
- Test: `tests/unit/core/project-access-service.test.ts`
- Test: `tests/unit/core/task-service.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ProgressStore`/`ProgressTransaction` 成员和分享方法。
- Produces:
  - `ProjectAccessService.isProjectViewer(projectId: string, owner: string): boolean`
  - `ProjectAccessService.assertProjectViewer(projectId: string, owner: string): void`
  - `ProjectAccessService.assertProjectCreator(projectId: string, owner: string): void`
  - `ProjectAccessService.createShare(projectId: string, owner: string): ProjectShare`
  - `ProjectAccessService.acceptShare(token: string, owner: string): ProjectMemberRecord`
  - `ProjectAccessService.assertTaskMutation(taskId: string, owner: string): void`

- [ ] **Step 1: 写失败权限单元测试**

覆盖创建人、active member、revoked member、未授权 owner、历史 null creator；验证 `TASK_OWNER_MISMATCH` 与项目权限错误；验证分享 token 生成只返回明文一次、接受后成为成员、重复接受失败；验证下游 validation 的 owner 规则不被普通任务权限替代。

- [ ] **Step 2: 运行失败测试**

Run: `npm test -- --run tests/unit/core/project-access-service.test.ts tests/unit/core/task-service.test.ts`

Expected: FAIL，服务和错误码尚不存在。

- [ ] **Step 3: 实现 ProjectAccessService**

使用 `randomBytes` 生成 token、SHA-256 保存 `token_hash`；默认分享有效期由构造参数 `shareTtlMs` 注入，生产默认 24 小时；接受时以当前认证 owner 写入/恢复成员关系。创建人判断只依赖 `projects.created_by`，不把项目名当 key。

- [ ] **Step 4: 接入 TaskService 的项目/任务边界**

为 `TaskServiceDeps` 增加 `projectAccess`，在 `createTask`/`adoptTask` 解析 repository 对应项目后调用 viewer 校验；任务 owner 已确定后，在普通生命周期入口统一调用 `assertTaskMutation`。dependency validation 的 request/receive/checkpoint/complete 继续使用下游 owner 校验，并在读取上游时只返回只读数据。

- [ ] **Step 5: 运行 core 测试**

Run: `npm test -- --run tests/unit/core/project-access-service.test.ts tests/unit/core/task-service.test.ts`

Expected: PASS；Run `npm run typecheck`，确认所有 `TaskService` fixture 注入同一个 in-memory access service。

---

### Task 3: Board 项目分享、加入及项目范围读取

**Files:**
- Modify: `src/server/board-routes.ts`
- Modify: `src/server/main.ts`
- Modify: `src/web/api-client.ts`
- Test: `tests/integration/server/board-api.test.ts`
- Test: `tests/integration/server/security.test.ts`

**Interfaces:**
- Consumes: `ProjectAccessService` and TaskService checks from Task 2.
- Produces Board endpoints:
  - `POST /api/projects/:projectId/shares` → `{ share_id, token, expires_at }`
  - `DELETE /api/projects/:projectId/shares/:shareId` → `{ revoked: true }`
  - `POST /api/project-invitations/:token/accept` → `{ project_id, owner, joined: true }`
  - `GET /api/projects/:projectId/members` → active members, creator metadata, no token hash
  - `DELETE /api/projects/:projectId/members/:owner` → `{ revoked: true }`
  - `GET /api/tasks?repository_id=...&scope=project` → project-member readable all-owner tasks

- [ ] **Step 1: 写 Board 失败测试**

用 `fixture.pairClient` 建立 creator/member 两个 Board session，覆盖创建分享、加入、个人项目列表出现、成员读取两个 owner 任务、成员修改他人任务返回 `403`/`PROJECT_ACCESS_REQUIRED` 或 `TASK_OWNER_MISMATCH`、撤销后读取返回项目权限错误、未授权 owner 不能用 name/id 访问。验证 token 不出现在后续列表和错误 evidence。

- [ ] **Step 2: 运行失败测试**

Run: `npm test -- --run tests/integration/server/board-api.test.ts tests/integration/server/security.test.ts`

Expected: FAIL，路由与 project-scoped task filter 未实现。

- [ ] **Step 3: 注入 ProjectAccessService 并实现路由**

`createHttpApp` 构造同一 access service；所有写路由从 `boardPrincipal(response).owner` 读取 owner。分享/撤销/成员管理通过现有 `replay` 幂等包装；项目和任务读取先做成员校验，再返回所有 owner 任务；普通写路由保留 `assertOwnerMatches`，不因 creator 身份放宽。

- [ ] **Step 4: 扩展项目/任务读取类型和实时事件**

`ProjectSummary` 增加成员状态/creator 字段；成员变更、分享接受、撤销和 project-scoped task read 不发布敏感 token，项目目录变更发布 `overview.changed`/目录刷新事件。未授权响应使用稳定错误码，不泄露项目存在性（必要时统一返回 `PROJECT_ACCESS_REQUIRED`）。

- [ ] **Step 5: 运行 Board 集成测试**

Run: `npm test -- --run tests/integration/server/board-api.test.ts tests/integration/server/security.test.ts`（需要允许本机回环监听）。

Expected: PASS。

---

### Task 4: MCP 成员加入与 agent 只读任务流

**Files:**
- Modify: `src/mcp/register-tools.ts`
- Modify: `src/mcp/http-transport.ts`（仅在需要传递 access service 时）
- Modify: `src/core/repository-bootstrap-service.ts`（仅在共享项目 bootstrap 校验需要时）
- Test: `tests/integration/mcp/mcp-tools.test.ts`
- Test: `tests/integration/mcp/mcp-transport.test.ts`

**Interfaces:**
- Produces MCP tools:
  - `project_share_create { session_id, operation_id, project_id }`
  - `project_share_revoke { session_id, operation_id, project_id, share_id }`
  - `project_join { session_id, operation_id, token }`
  - `project_members { session_id, project_id }`
  - `task_list` optional `project_id`/`scope: "owner" | "project"`，project scope 要求成员

- [ ] **Step 1: 写 MCP 失败测试**

验证绑定 session owner 可以生成/接受分享；member agent 的 `task_list(scope=project)` 返回项目内所有 owner 任务；member agent 对他人任务的 `task_start`/`task_checkpoint`/`task_submit` 被拒绝；自己的任务仍可正常流程；dependency validation 工具只对下游 owner 放行；未绑定或 revoked session 不能绕过项目权限。

- [ ] **Step 2: 运行失败测试**

Run: `npm test -- --run tests/integration/mcp/mcp-tools.test.ts tests/integration/mcp/mcp-transport.test.ts`

Expected: FAIL，工具目录和 project scope 尚不存在。

- [ ] **Step 3: 注册 MCP 工具并绑定认证 owner**

工具从 bound transport 解析 session，再由 `ProjectAccessService` 校验；`project_join` 的 owner 取 session owner，拒绝请求参数中的不同 owner；返回只包含项目/member/过期时间，不返回 token hash。

- [ ] **Step 4: 接入 task_list 和普通任务写入口**

默认保持现有 owner-scoped 行为；只有显式 `scope="project"` 且成员有效时查询全部任务。所有任务 mutation 继续要求任务 owner 等于 session owner；validation 工具复用现有下游验证状态机。

- [ ] **Step 5: 运行 MCP 集成测试**

Run: `npm test -- --run tests/integration/mcp/mcp-tools.test.ts tests/integration/mcp/mcp-transport.test.ts`（需要允许本机回环监听）。

Expected: PASS。

---

### Task 5: Board 前端协作者入口与只读任务状态

**Files:**
- Modify: `src/web/api-client.ts`
- Modify: `src/web/task-board.tsx`
- Modify: `src/web/project-dashboard.tsx`
- Modify: `src/web/task-drawer.tsx`
- Modify: `src/web/styles.css`
- Test: `tests/unit/web/api-client.test.ts`
- Test: `tests/unit/web/project-dashboard.test.tsx`
- Create: `tests/unit/web/task-board.test.tsx`

**Interfaces:**
- Consumes Board endpoints from Task 3 and existing SSE `overview.changed`/task events.
- Produces share modal/copy action for creator, join-by-token action for invitee, active member list, read-only task cards, and explicit downstream-validation action state.

- [ ] **Step 1: 写前端失败测试**

覆盖：创建人看到分享入口，成员看不到成员管理入口；项目任务卡显示其他 owner 但没有可操作按钮；自己的任务保留操作按钮；项目 creator badge、任务 executor badge、只读提示和验证入口文案不混淆；分享/加入/撤销成功后目录和项目成员列表通过 SSE 或显式刷新更新。

- [ ] **Step 2: 运行失败测试**

Run: `npm test -- --run tests/unit/web/api-client.test.ts tests/unit/web/project-dashboard.test.tsx tests/unit/web/task-board.test.tsx`

Expected: FAIL，类型/API 函数/只读视图尚不存在。

- [ ] **Step 3: 增加 API client 和状态模型**

为 share、join、members、project-scope tasks 增加带 `credentials: "same-origin"` 的 client 方法；错误保留服务端 code/message，UI 不展示 token hash 或内部 evidence。

- [ ] **Step 4: 实现项目协作者 UI**

在项目卡中增加“分享项目/成员”入口；成员任务在 drawer 和卡片上显示“只读：其他 owner 任务”，禁用普通 mutation；如果存在自己作为 downstream owner 的 validation request，只展示 validation 操作。

- [ ] **Step 5: 运行前端单元测试和 build**

Run: `npm test -- --run tests/unit/web/api-client.test.ts tests/unit/web/project-dashboard.test.tsx tests/unit/web/task-board.test.tsx && npm run build:web`

Expected: PASS，Vite 生产构建完成。

---

### Task 6: 端到端验证与同一 review 服务迁移

**Files:**
- Modify: `tests/e2e/board-smoke.py`（追加共享项目场景，保持现有场景）
- Modify: `docs/operations/local-service.md`（仅在现有运行手册需要记录 v11/重启步骤时）

**Interfaces:**
- Consumes all previous tasks and existing Edge CDP board session.
- Produces evidence that the same review SQLite database upgrades to v11, share/join works, read-only and validation boundaries hold, and realtime project directory refreshes.

- [ ] **Step 1: 运行完整静态和自动化检查**

Run: `npm run check`（允许回环监听）。

Expected: typecheck、全部 Vitest、server build、web build 均通过。

- [ ] **Step 2: 重启同一 review 服务**

确认 `TASK_MCP_DATA_DIR=/private/tmp/cli-session-task-mcp-e2e.review.5KcYXR` 与监听 `127.0.0.1:47321`，安全停止旧 watch 子进程后用 `npm run dev:server` 重启；查询 `PRAGMA user_version`、v11 表和现有项目数据，禁止新建 DB/仓库。

- [ ] **Step 3: 用 Edge 完成真实分享验证**

在现有 Board session 下为已有 `created_by=jande` 测试项目生成分享码；使用第二个已认证 owner 接受；核对个人项目目录、全部任务只读展示、自己的任务可操作、他人普通操作被拒绝、下游 validation 可执行。撤销成员后确认立即失去访问。

- [ ] **Step 4: 验证实时刷新**

保持 Board 页面打开，通过另一已认证会话加入/撤销成员或创建项目任务，等待 SSE `overview.changed`/task event，确认项目目录和任务列表自动更新，不依赖定时轮询或手工刷新。

- [ ] **Step 5: 更新 MCP checkpoint 并提交待验收**

记录迁移、API/MCP、前端、Edge 和 review DB 证据；使用 `task_submit` 将任务置为 `pending_acceptance`，不由 Agent 标记 `done`。不执行 commit/push，除非用户另行授权。
