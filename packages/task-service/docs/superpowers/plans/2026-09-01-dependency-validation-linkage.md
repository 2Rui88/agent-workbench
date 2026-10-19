# 下游 Agent 依赖验证联动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让上游提交后的依赖验证由下游 Agent/服务自动领取、执行、滚动续租并回传结果，同时保留人工最终验收。

**Architecture:** 保留现有 `dependency_validations` 作为上下游请求和验收门禁记录，新增 `dependency_validation_runs` 作为每次执行/重试记录。Agent 通过 MCP 的 list/receive/checkpoint/complete 操作驱动 run；验证结果由服务事务性写回请求并发出上下游事件，不允许下游直接改上游任务。

**Tech Stack:** TypeScript 7、Node.js 26、SQLite (`node:sqlite`)、Zod、MCP SDK、Express、Vitest、React/Vite。

**Spec:** `docs/superpowers/specs/2026-09-01-dependency-validation-linkage-design.md`

## Global Constraints

- `dependency_validations.status` 继续使用 `pending | passed | rejected | superseded`；执行层另用 `queued | claimed | running | passed | rejected | error | cancelled`。
- `rejected` 表示业务验证不满足并必须带失败证据；`error`/超时表示执行异常，request 保持 `pending` 并可重试。
- 每个 request 同时只能有一个活跃 run；receive、checkpoint、complete 都必须以 `(session_id, operation_id)` 幂等。
- 下游写入必须校验绑定 transport session、Git owner、downstream task、repository 和当前 cycle；不能直接修改 upstream task。
- 租约沿用现有滚动续期机制；checkpoint/heartbeat 刷新 `heartbeat_at` 和 `expires_at`，不设置固定总时长。
- 所有下游验证通过后，上游只能进入 `pending_acceptance`，Agent 不得自行标记 `done`；Board 只读展示验证历史。
- 跨仓库只通过现有 task dependency 和 validation id 关联，不以 repository id 单独授权。
- 本计划中的 commit 步骤仅在用户明确授权提交后执行；本会话默认不自动 commit/push。

## 文件结构与职责

- `src/storage/progress-store.ts`：验证执行记录、状态和事务接口。
- `src/storage/migrations.ts`、`src/storage/sqlite-progress-store.ts`：v9 runs 表、请求契约字段、查询/更新/滚动续租实现。
- `src/core/task-service.ts`：权限校验、状态机、幂等包装、结果回传和 gate 更新。
- `src/mcp/tool-schemas.ts`、`src/mcp/register-tools.ts`：Agent 可调用的 list/receive/checkpoint/complete MCP 工具。
- `src/server/board-routes.ts`、`src/web/api-client.ts`、`src/web/dependency-notifications.tsx`、`src/web/task-drawer.tsx`、`src/web/styles.css`：Board 只读验证状态和证据展示，移除人工响应入口。
- `tests/unit/storage/migrations.test.ts`：v9 migration 和 schema 约束。
- `tests/unit/core/task-service.test.ts`：状态机、owner、幂等、租约和 cycle 单元测试。
- `tests/integration/mcp/mcp-tools.test.ts`：MCP schema 与 Agent workflow。
- `tests/integration/server/board-api.test.ts`、`tests/unit/web/dependency-notifications.test.tsx`、`tests/unit/web/task-drawer.test.tsx`：Board 只读 API/UI 回归。

### Task 1: 扩展存储契约并加入验证执行 migration

**Files:**
- Modify: `src/storage/progress-store.ts:234-379`
- Modify: `src/storage/migrations.ts:5-40`
- Modify: `src/storage/sqlite-progress-store.ts:321-349,633-730,1480-1610,1870-2065`
- Test: `tests/unit/storage/migrations.test.ts`

**Interfaces:**
- Produces `DependencyValidationRunStatus`, `DependencyValidationRunRecord`, `DependencyValidationRunView`。
- Produces transaction methods `getDependencyValidationRun`, `getActiveDependencyValidationRun`, `listDependencyValidationRuns`, `insertDependencyValidationRun`, `updateDependencyValidationRun`, `renewDependencyValidationRunLease`。
- `DependencyValidationRecord` 增加不可变 `validation_spec: JsonValue`；view 暴露 `latest_run`。

- [ ] **Step 1: Write the failing migration/schema test**

在 `tests/unit/storage/migrations.test.ts` 的 migration assertions 中增加 v9 期望：

```ts
expect(tableNames).toContain("dependency_validation_runs");
expect(columnNames("dependency_validation_runs")).toEqual(
  expect.arrayContaining([
    "run_id", "validation_id", "attempt", "status", "owner", "session_id",
    "heartbeat_at", "expires_at", "verification_json", "operation_id"
  ])
);
expect(migrationModule.migrationMetadata.at(-1)).toEqual({
  version: 9,
  name: "add_dependency_validation_runs"
});
```

Run: `npm test -- tests/unit/storage/migrations.test.ts`

Expected: FAIL because migration metadata and runs table do not exist.

- [ ] **Step 2: Add storage types and transaction signatures**

在 `progress-store.ts` 定义：

```ts
export type DependencyValidationRunStatus =
  | "queued" | "claimed" | "running" | "passed" | "rejected" | "error" | "cancelled";

export interface DependencyValidationRunRecord {
  run_id: string;
  validation_id: string;
  attempt: number;
  status: DependencyValidationRunStatus;
  owner: string;
  session_id: string;
  worktree_path: string;
  heartbeat_at: string;
  expires_at: string;
  started_at: string | null;
  completed_at: string | null;
  verification: JsonValue[];
  failure_reason: string | null;
  error_reason: string | null;
  operation_id: string;
  created_at: string;
  updated_at: string;
}
```

把 validation spec、latest run 和上述方法加入 `ProgressTransaction`/store view，并更新内存测试 store 的类型占位实现，确保 TypeScript 能表达完整状态机。

- [ ] **Step 3: Implement migration v9 and SQLite persistence**

在 `migrations.ts` 追加 `add_dependency_validation_runs`，在 SQLite migration 列表追加 runs 表和索引：

```sql
CREATE TABLE dependency_validation_runs (
  run_id TEXT PRIMARY KEY,
  validation_id TEXT NOT NULL REFERENCES dependency_validations(validation_id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  status TEXT NOT NULL CHECK (status IN ('queued','claimed','running','passed','rejected','error','cancelled')),
  owner TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  worktree_path TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  verification_json TEXT NOT NULL CHECK (json_valid(verification_json)),
  failure_reason TEXT,
  error_reason TEXT,
  operation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(validation_id, attempt)
);
CREATE UNIQUE INDEX dependency_validation_runs_active_idx
  ON dependency_validation_runs(validation_id)
  WHERE status IN ('queued','claimed','running');
```

同时为 `dependency_validations` 增加 `validation_spec_json`（默认 `{}`，保证旧 seed 可迁移），实现 row parser、insert/list/update、active run 查询和滚动 lease 更新；`renewDependencyValidationRunLease` 必须以 `run_id + owner + session_id + expires_at > now` 为更新条件。

- [ ] **Step 4: Run migration tests and inspect schema**

Run: `npm test -- tests/unit/storage/migrations.test.ts`

Expected: PASS；另外确认旧 v8 数据库升级到 user_version 9，重复打开不会重复创建 runs 表。

- [ ] **Step 5: Commit after authorization**

```bash
git add src/storage/progress-store.ts src/storage/migrations.ts src/storage/sqlite-progress-store.ts tests/unit/storage/migrations.test.ts
git commit -m "feat: persist dependency validation runs"
```

### Task 2: 在 TaskService 实现 Agent 验证状态机和滚动租约

**Files:**
- Modify: `src/core/task-service.ts:43-108,220-245,1350-1480,1590-1710,1780-1860`
- Test: `tests/unit/core/task-service.test.ts`

**Interfaces:**
- Produces `listDependencyValidationRequests(input)`、`receiveDependencyValidation(input)`、`checkpointDependencyValidation(input)`、`completeDependencyValidation(input)`。
- Receive input：`{ session_id, operation_id, validation_id, owner }`。
- Checkpoint input：`{ session_id, operation_id, validation_id, run_id, owner, progress: JsonValue }`。
- Complete input：`{ session_id, operation_id, validation_id, run_id, owner, status: "passed" | "rejected" | "error", verification, reason? }`。
- Receive result 返回 `{ validation_id, run_id, attempt, status: "claimed", validation_spec }`；complete result 返回 request、run 和 gate 的最新状态。

- [ ] **Step 1: Add failing unit tests for receive and ownership**

在依赖验证测试附近新增 `seedPendingValidation()` 测试 helper：调用现有 `createFixture()`、`startedTask()`、`createTask()`，通过 `store.insertTaskDependency()` 建立 upstream/downstream 关系，再用现有 `checkpointTask()` 和 `submitTask()` 把 upstream 推到 `pending_acceptance`，返回 `{ fixture, validation }`。随后增加：

```ts
it("lets only the downstream owner receive a pending validation once", async () => {
  const { fixture, validation } = await seedPendingValidation();
  const { service, store } = fixture;

  await expect(service.receiveDependencyValidation({
    session_id: "session-wrong-owner",
    operation_id: "op-receive-wrong",
    validation_id: validation.validation_id,
    owner: "owner-other"
  })).rejects.toMatchObject({ code: "OWNER_MISMATCH" });

  const first = await service.receiveDependencyValidation({
    session_id: "session-downstream",
    operation_id: "op-receive-1",
    validation_id: validation.validation_id,
    owner: "owner-downstream"
  });
  const retry = await service.receiveDependencyValidation({
    session_id: "session-downstream",
    operation_id: "op-receive-2",
    validation_id: validation.validation_id,
    owner: "owner-downstream"
  });
  expect(retry.run_id).toBe(first.run_id);
  expect(store.validationRuns).toHaveLength(1);
});
```

Run: `npm test -- tests/unit/core/task-service.test.ts -t "receive"`

Expected: FAIL because the service methods and run store are not implemented.

- [ ] **Step 2: Implement request listing, receive and immutable validation contract**

在 `#requestDependencyValidations` 创建 request 时，从 upstream checkpoint/snapshot 生成不含 secret 的 `validation_spec`。新增 service 方法校验 session owner/repository/downstream task 和最新 cycle；在同一事务中复用 active run 或插入 attempt 1 的 `claimed` run，标记 request read，并发出 `dependency_validation_received`。

通过现有 `#withOperation(session_id, operation_id, ...)` 保证丢失响应后的重试返回原结果；不要调用 `task_create`，避免验证 run 重新触发依赖验证。

- [ ] **Step 3: Add failing tests for rolling checkpoint and terminal results**

覆盖以下断言：

```ts
it("rolls the validation lease on checkpoint", async () => {
  const { fixture, validation } = await seedPendingValidation();
  const { service, store } = fixture;
  const received = await service.receiveDependencyValidation({
    session_id: "session-b",
    operation_id: "op-receive-heartbeat",
    validation_id: validation.validation_id,
    owner: "jande"
  });
  const before = store.validationRuns.find((run) => run.run_id === received.run_id)!;
  await service.checkpointDependencyValidation({
    session_id: "session-b",
    operation_id: "op-validation-heartbeat",
    validation_id: validation.validation_id,
    run_id: received.run_id,
    owner: "jande",
    progress: { phase: "running", completed_checks: ["npm test"] }
  });
  const after = store.validationRuns.find((run) => run.run_id === received.run_id)!;
  expect(after.heartbeat_at).not.toBe(before.heartbeat_at);
  expect(Date.parse(after.expires_at)).toBeGreaterThan(Date.parse(before.expires_at));
});

it("maps passed/rejected to the request and keeps error pending", async () => {
  const passedCase = await seedPendingValidation();
  const passedRun = await passedCase.fixture.service.receiveDependencyValidation({
    session_id: "session-b", operation_id: "op-receive-pass",
    validation_id: passedCase.validation.validation_id, owner: "jande"
  });
  const passed = await passedCase.fixture.service.completeDependencyValidation({
    session_id: "session-b", operation_id: "op-complete-pass",
    validation_id: passedCase.validation.validation_id, run_id: passedRun.run_id,
    owner: "jande", status: "passed",
    verification: [{ command: "npm test", outcome: "passed", summary: "green" }]
  });
  expect(passed.validation.status).toBe("passed");

  const rejectedCase = await seedPendingValidation();
  const rejectedRun = await rejectedCase.fixture.service.receiveDependencyValidation({
    session_id: "session-b", operation_id: "op-receive-reject",
    validation_id: rejectedCase.validation.validation_id, owner: "jande"
  });
  const rejected = await rejectedCase.fixture.service.completeDependencyValidation({
    session_id: "session-b", operation_id: "op-complete-reject",
    validation_id: rejectedCase.validation.validation_id, run_id: rejectedRun.run_id,
    owner: "jande", status: "rejected", reason: "契约不匹配",
    verification: [{ command: "npm test", outcome: "failed", summary: "contract mismatch" }]
  });
  expect(rejected.validation.status).toBe("rejected");

  const errorCase = await seedPendingValidation();
  const errorRun = await errorCase.fixture.service.receiveDependencyValidation({
    session_id: "session-b", operation_id: "op-receive-error",
    validation_id: errorCase.validation.validation_id, owner: "jande"
  });
  const errored = await errorCase.fixture.service.completeDependencyValidation({
    session_id: "session-b", operation_id: "op-complete-error",
    validation_id: errorCase.validation.validation_id, run_id: errorRun.run_id,
    owner: "jande", status: "error", reason: "runner timeout", verification: []
  });
  expect(errored.validation.status).toBe("pending");
});
```

Run: `npm test -- tests/unit/core/task-service.test.ts -t "lease|passed|rejected|error"`

Expected: FAIL until checkpoint/complete state transitions exist.

- [ ] **Step 4: Implement checkpoint, complete, retry and stale-cycle guards**

`checkpointDependencyValidation` 以 run owner/session 和未过期租约为条件更新 progress、`heartbeat_at`、`expires_at`；`completeDependencyValidation` 只接受 `claimed/running`，passed 要求所有 verification outcome 为 passed，rejected 要求非空 reason，error 只终止当前 attempt 并保持 request pending。新 cycle supersede 旧 request 后，旧 run complete 必须返回版本冲突且不能更新 gate。

完成业务结果时发出 upstream/downstream `dependency_validation_responded` 事件，并复用现有 `getDependencyValidationGate` 逻辑，不直接更新 upstream task status。

- [ ] **Step 5: Run core tests and commit after authorization**

Run: `npm test -- tests/unit/core/task-service.test.ts`

Expected: PASS，包含既有人工验收门禁测试。

```bash
git add src/core/task-service.ts tests/unit/core/task-service.test.ts
git commit -m "feat: automate dependency validation execution"
```

### Task 3: 暴露 Agent MCP 工具

**Files:**
- Modify: `src/mcp/tool-schemas.ts:1-340`
- Modify: `src/mcp/register-tools.ts:1-40,900-1020`
- Test: `tests/integration/mcp/mcp-tools.test.ts`

**Interfaces:**
- `dependency_validation_list`：read-only，返回当前绑定 owner/repository 的 pending request 和 latest run。
- `dependency_validation_receive`：write，输入 `session_id/operation_id/validation_id/owner`。
- `dependency_validation_checkpoint`：write，输入 `session_id/operation_id/validation_id/run_id/owner/progress`。
- `dependency_validation_complete`：write，输入 `session_id/operation_id/validation_id/run_id/owner/status/verification/reason?`。

- [ ] **Step 1: Write failing MCP tool registration tests**

在 `tests/integration/mcp/mcp-tools.test.ts` 增加完整调用链：

```ts
const listed = await callTool(client, "dependency_validation_list", {
  session_id: downstreamSession,
  owner: "owner-downstream",
  repository_id: "repo-downstream"
});
expect(listed.data.validations).toHaveLength(1);

const received = await callTool(client, "dependency_validation_receive", {
  session_id: downstreamSession,
  operation_id: "mcp-receive-1",
  validation_id: listed.data.validations[0].validation_id,
  owner: "owner-downstream"
});
expect(received.data.status).toBe("claimed");
```

Run: `npm test -- tests/integration/mcp/mcp-tools.test.ts -t "dependency_validation"`

Expected: FAIL because schemas/tools are not registered.

- [ ] **Step 2: Add Zod schemas and register handlers**

所有 write handler 必须先 `requireBoundSessionId`，再调用 TaskService；owner 只作为显式身份声明并由 service 与绑定 session 比对。工具说明必须强调：receive 是领取，不是通过；complete 的 error 不会解除上游 gate；人工只负责最终验收。

- [ ] **Step 3: Add MCP idempotency and error tests**

验证 wrong owner、wrong session、重复 receive、重复 complete、缺少 rejected reason、过期 lease 和旧 cycle 均返回结构化错误，并确保 `operation_id` 重试返回同一 JSON 结果。

- [ ] **Step 4: Run MCP tests and commit after authorization**

Run: `npm test -- tests/integration/mcp/mcp-tools.test.ts`

Expected: PASS，既有 session/task/bootstrap 工具测试不受影响。

```bash
git add src/mcp/tool-schemas.ts src/mcp/register-tools.ts tests/integration/mcp/mcp-tools.test.ts
git commit -m "feat: expose agent dependency validation tools"
```

### Task 4: 将 Board 和 HTTP API 改为只读验证视图

**Files:**
- Modify: `src/server/board-routes.ts:266-370`
- Modify: `src/web/api-client.ts:230-350`
- Modify: `src/web/dependency-notifications.tsx:40-330`
- Modify: `src/web/task-drawer.tsx:600-650`
- Modify: `src/web/styles.css:1470-1560`
- Test: `tests/integration/server/board-api.test.ts`, `tests/unit/web/dependency-notifications.test.tsx`, `tests/unit/web/task-drawer.test.tsx`

**Interfaces:**
- GET `/api/dependency-validation-activities` 保留，并返回 latest run 状态、attempt、lease/证据摘要。
- 删除或迁移期禁用 Board 的 `POST /dependency-validations/:id/respond` 和 `POST /tasks/:id/request-dependency-validation` 写入口；Board 不再调用 `humanRespondDependencyValidation`。
- API client 删除 `respondDependencyValidation`/`requestDependencyValidation`，新增验证 run 视图类型。

- [ ] **Step 1: Write failing API/UI tests for read-only behavior**

在 server 测试中断言旧响应入口不再改变 request：

```ts
await beta.client
  .post(`/api/dependency-validations/${validationId}/respond`)
  .send({ operation_id: "board-write", status: "passed" })
  .expect(404);

const history = await beta.client
  .get("/api/dependency-validation-activities?repository_id=repo-2")
  .expect(200);
expect(history.body.activities[0].status).toBe("pending");
```

UI 测试应断言 pending 验证只显示状态、领取提示和证据入口，不渲染“验证通过/驳回”按钮。

- [ ] **Step 2: Implement read-only API and view model**

移除 mutation route/client callback，扩展 activity mapping 以展示 run status、attempt、last error 和 verification summary；保留 request/response read marker。不要改变现有 task acceptance gate API。

- [ ] **Step 3: Implement read-only notification and drawer rendering**

删除输入框、`onRespondValidation` 和 response buttons；pending 显示“等待下游 Agent 验证”，running 显示 attempt/最近 heartbeat，rejected/error 显示原因和恢复信息，passed 显示证据摘要。

- [ ] **Step 4: Run API/UI tests and commit after authorization**

Run: `npm test -- tests/integration/server/board-api.test.ts tests/unit/web/dependency-notifications.test.tsx tests/unit/web/task-drawer.test.tsx`

Expected: PASS；Board 只读回归通过。

```bash
git add src/server/board-routes.ts src/web/api-client.ts src/web/dependency-notifications.tsx src/web/task-drawer.tsx src/web/styles.css tests/integration/server/board-api.test.ts tests/unit/web/dependency-notifications.test.tsx tests/unit/web/task-drawer.test.tsx
git commit -m "refactor: make dependency validation board read-only"
```

### Task 5: 更新文档、种子数据和端到端验证

**Files:**
- Modify: `README.md`, `docs/integration/claude-code.md`, `docs/integration/codex.md`, `docs/integration/internal-lan-server.md`
- Modify: `tests/e2e/seed-e2e.ts`, `tests/e2e/board-smoke.py`
- Test: `tests/integration/server/restart-recovery.test.ts`

**Interfaces:**
- 文档给出 Agent downstream workflow：`session_context → dependency_validation_list → receive → checkpoint/heartbeat → complete`。
- 文档明确无 bootstrap token、无人工验证响应，人工仅在 `pending_acceptance` 验收。

- [ ] **Step 1: Update integration docs and seed data**

把旧的 Board respond 示例替换为 MCP 调用示例，种子数据增加一个 `pending` request、一个 `running` run、一个 `passed` run 和一组 error/retry 历史，不写入 token/session secret。

- [ ] **Step 2: Add restart and end-to-end assertions**

重启测试确认 runs、lease、attempt 和 request status 可恢复；Edge smoke 测试确认验证历史可读、pending/running/rejected/passed 标签正确，且不存在人工响应按钮。

- [ ] **Step 3: Run focused and full verification**

Run:

```bash
npm run typecheck
npm test
npm run build
```

若本机 Edge/服务环境可用，再运行：

```bash
npm run test:e2e:edge
```

Expected: typecheck、unit/integration tests、server/web build 全部通过；E2E 环境失败需单独记录，不得冒充功能失败。

- [ ] **Step 4: Final checkpoint and pending acceptance**

记录完成项、验证命令及结果、未解决的环境问题和下一步；只将任务提交为 `pending_acceptance`，不得由 Agent 标记 `done`。

## Plan Self-Review

- Spec coverage：请求层/执行层、receive/complete/checkpoint、滚动续租、error 与 rejected 区分、旧 cycle、权限、事件、Board 只读、测试和人工验收均有对应任务。
- Placeholder scan：计划没有未决占位内容；所有任务给出了具体文件、接口、测试命令和预期结果。
- Type consistency：Task 1 产出的 run 类型和 transaction 方法被 Task 2 使用；Task 2 的四个 service 方法被 Task 3 的 MCP handler 使用；Task 4 只消费 Task 1/2 的 view，不修改 gate 语义。
- Lease consistency：计划明确沿用滚动续期，并将当前 checkpoint 路径未刷新 `heartbeat_at`/`expires_at` 的风险作为 Task 2 的实现检查项。
