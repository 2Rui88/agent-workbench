# CLI Session Task MCP MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在个人本机交付一个由 Codex、Claude Code 和兼容 MCP Client 共用的任务进度管控服务，以 SQLite 为真相源，通过 Streamable HTTP MCP 与最小 Web 看板管理任务、Checkpoint、租约、存量接管和人工验收。

**Architecture:** 单个 Node.js 进程同时提供 `/mcp`、`/api`、`/events`、`/board` 和 `/health`。领域状态机与冲突规则位于 `core`，SQLite 与只读 Git 探针通过接口接入，MCP 和 Web API 只调用应用服务；React 看板只负责人工流程，不复制业务规则。

**Tech Stack:** Node.js 26.5.0、npm 11.17.0、TypeScript 7.0.2、`node:sqlite`（SQLite 3.53.3）、`@modelcontextprotocol/sdk` 1.30.0、Express 5.2.1、Zod 4.4.3、React 19.2.8、Vite 8.2.1、Vitest 4.1.10、Supertest 7.2.2、browser-harness + Microsoft Edge。

## Global Constraints

- 使用 2 空格缩进；TypeScript 开启 `strict`，函数使用 `camelCase`，文件使用 `kebab-case`。
- 服务默认仅绑定 `127.0.0.1:47321`；SQLite 默认位于 `~/Library/Application Support/cli-session-task-mcp/task-progress.sqlite`。
- 平台不读取完整对话、不保存文件正文或完整 diff、不执行任意 Shell、不修改 LKF 业务仓库。
- Repo Probe 只能通过 `execFile` 执行固定参数的只读 Git 命令，禁止 `shell: true`。
- 一个 Session 只能持有一个活动任务；一个任务只能有一个可写主 Session；Agent 不能完成、取消或强制接管任务。
- 所有写入使用事务、`operation_id` 幂等键和 `expected_version` 乐观锁；`task_create`、`task_adopt` 使用 `expected_version: 0`。
- 浏览器自动化只使用 browser-harness 接管 Microsoft Edge；不得安装或使用 Playwright、Selenium 或额外浏览器运行时。
- 不引入 Redis、MinIO、消息队列或 PostgreSQL；首期不提供远程访问、账号、RBAC、通知和第三方集成。
- 不自动修改 Codex、Claude Code 或其他 Agent CLI 的配置；真实客户端配置必须获得用户单独授权。
- 当前目录不是 Git 仓库。不得执行 `git init`、`git add`、`git commit` 或 `git push`，除非用户在实施阶段另行授权；各任务末尾的提交命令只在授权后执行。
- 保留目标目录现有 `.DS_Store`，不得清理用户文件。

## File and Responsibility Map

| 区域 | 文件 | 单一职责 |
|---|---|---|
| 工程 | `package.json`、`tsconfig.json`、`tsconfig.server.json`、`vite.config.ts`、`vitest.config.ts` | 构建、开发和测试入口 |
| 共享契约 | `src/shared/task-contracts.ts` | Task、Session、Checkpoint、错误和 API/MCP Schema |
| 配置 | `src/config/runtime-config.ts` | 主机、端口、数据目录、超时和白名单配置 |
| 领域 | `src/core/task-state.ts` | 状态迁移、租约状态和 actor 权限 |
| 领域 | `src/core/conflict-policy.ts` | worktree、文件、模块和依赖冲突分级 |
| 应用 | `src/core/session-service.ts` | Session 注册、重连、活动时间和 stale 判断 |
| 应用 | `src/core/task-service.ts` | 十一个 MCP 工具与人工决定/验收操作共用的事务用例 |
| 存储 | `src/storage/database.ts`、`src/storage/migrations.ts` | SQLite 生命周期、迁移、事务和备份 |
| 存储 | `src/storage/progress-store.ts`、`src/storage/sqlite-progress-store.ts` | 可替换的持久化接口与 SQLite 实现 |
| 仓库 | `src/repo/repo-probe.ts` | 白名单路径校验和只读 Git 快照 |
| MCP | `src/mcp/client-metadata.ts` | MCP `clientInfo` 与能力归一化 |
| MCP | `src/mcp/tool-schemas.ts`、`src/mcp/register-tools.ts` | 十一个工具 Schema、注解和 handler 绑定 |
| MCP | `src/mcp/http-transport.ts` | Streamable HTTP Session 生命周期 |
| HTTP | `src/server/http-app.ts`、`src/server/security.ts` | 同源 API、Host/Origin 防护、静态资源 |
| HTTP | `src/server/board-routes.ts`、`src/server/sse-hub.ts` | 人工操作 API 与事件推送 |
| 运行 | `src/server/main.ts` | 组装依赖、启动、关闭和后台 stale 扫描 |
| CLI | `src/cli/register-repository.ts`、`src/cli/export-data.ts` | LKF 白名单初始化和 JSON 导出 |
| Web | `src/web/index.html`、`src/web/main.tsx`、`src/web/styles.css` | SPA 入口和全局样式 |
| Web | `src/web/api-client.ts`、`src/web/task-board.tsx`、`src/web/task-drawer.tsx` | API/SSE、四列看板和唯一详情/新建抽屉 |
| 测试 | `tests/unit/`、`tests/integration/` | 领域、存储、MCP、API 和竞态测试 |
| 验收 | `tests/e2e/board-smoke.py` | browser-harness + Edge 端到端冒烟流程 |
| 验收 | `tests/e2e/seed-e2e.ts` | 为隔离数据库创建待验收任务和 stale Session 测试夹具 |
| 接入 | `docs/integration/codex.md`、`docs/integration/claude-code.md` | 两类客户端的人工配置与验证说明 |

---

### Task 1: 工程骨架与共享契约

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.server.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/shared/task-contracts.ts`
- Create: `src/web/index.html`
- Create: `src/web/main.tsx`
- Test: `tests/unit/shared/task-contracts.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `TaskStatus`、`TaskPriority`、`TaskRecord`、`SessionRecord`、`CheckpointPayload`、`RepoSnapshot`、`PlatformError` 和对应 Zod Schema。

- [ ] **Step 1: 创建固定版本的 npm 工程配置**

`package.json` 使用以下依赖边界和脚本；不得加入 Playwright：

```json
{
  "name": "cli-session-task-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=26.5.0" },
  "scripts": {
    "dev:server": "tsx watch src/server/main.ts",
    "dev:web": "vite",
    "build:server": "tsc -p tsconfig.server.json",
    "build:web": "vite build",
    "build": "npm run build:server && npm run build:web",
    "start": "node dist/server/main.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "check": "npm run typecheck && npm test && npm run build",
    "repo:register": "tsx src/cli/register-repository.ts",
    "data:export": "tsx src/cli/export-data.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.30.0",
    "express": "5.2.1",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@types/express": "5.0.6",
    "@types/node": "26.2.0",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.4",
    "@types/supertest": "7.2.1",
    "@vitejs/plugin-react": "6.0.5",
    "supertest": "7.2.2",
    "tsx": "4.23.12",
    "typescript": "7.0.2",
    "vite": "8.2.1",
    "vitest": "4.1.10"
  }
}
```

Run: `npm install`

Expected: 生成 `package-lock.json`，`npm ls --depth=0` 无 missing/invalid。

`tsconfig.json` 必须开启 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`，并使用 `module: "ESNext"`、`moduleResolution: "Bundler"`、`jsx: "react-jsx"`。`tsconfig.server.json` 使用 `module/moduleResolution: "NodeNext"`、`rootDir: "src"`、`outDir: "dist"` 并排除 `src/web`。`vite.config.ts` 使用 React plugin，root 为 `src/web`、base 为 `/board/`、build outDir 为 `../../dist/web`，开发代理将 `/api`、`/events`、`/health` 指向 `http://127.0.0.1:47321`。`vitest.config.ts` 只匹配 `tests/unit/**/*.test.ts` 和 `tests/integration/**/*.test.ts`，不执行 `tests/e2e`。`.gitignore` 固定包含 `node_modules/`、`dist/`、`coverage/`、`.env`、`*.sqlite*` 和 `.DS_Store`。

- [ ] **Step 2: 写共享 Schema 的失败测试**

```ts
import { describe, expect, it } from "vitest";
import { checkpointPayloadSchema, taskStatusSchema } from "../../../src/shared/task-contracts.js";

describe("task contracts", () => {
  it("accepts every designed task status", () => {
    expect(taskStatusSchema.parse("pending_acceptance")).toBe("pending_acceptance");
    expect(taskStatusSchema.parse("cancelled")).toBe("cancelled");
  });

  it("rejects a checkpoint without next_action", () => {
    const result = checkpointPayloadSchema.safeParse({
      completed_items: [],
      current_state: "working",
      confirmed_decisions: [],
      pending_decisions: [],
      blockers: [],
      verification: []
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 3: 运行测试并确认先失败**

Run: `npm test -- tests/unit/shared/task-contracts.test.ts`

Expected: FAIL，原因是 `src/shared/task-contracts.ts` 尚不存在。

- [ ] **Step 4: 实现共享契约**

至少定义以下精确状态和 Checkpoint 字段：

```ts
export const taskStatusSchema = z.enum([
  "backlog",
  "in_progress",
  "waiting_human",
  "blocked",
  "paused",
  "verifying",
  "pending_acceptance",
  "done",
  "cancelled"
]);

export const taskPrioritySchema = z.enum(["P0", "P1", "P2", "P3"]);

export const checkpointPayloadSchema = z.object({
  completed_items: z.array(z.string()),
  current_state: z.string().min(1),
  human_context: z.array(z.string()).default([]),
  confirmed_decisions: z.array(z.string()),
  pending_decisions: z.array(z.string()),
  blockers: z.array(z.string()),
  verification: z.array(z.object({
    command: z.string().min(1),
    outcome: z.enum(["passed", "failed", "not_run"]),
    summary: z.string().min(1)
  })),
  next_action: z.string().min(1),
  source: z.object({
    source_type: z.enum(["native", "legacy_adoption"]),
    source_session_label: z.string().min(1),
    adoption_method: z.enum(["mcp", "web"]),
    adopted_at: z.iso.datetime()
  }).optional()
});
```

`PlatformError` 必须包含 `code`、`message`、`retryable`、`evidence`、`recovery_actions` 和可选 `current_version`。

- [ ] **Step 5: 完成类型、测试和构建基线**

Run: `npm run typecheck`

Expected: PASS。

Run: `npm test -- tests/unit/shared/task-contracts.test.ts`

Expected: 2 tests PASS。

在构建前创建最小 Web 入口：`src/web/index.html` 包含 `<main id="root"></main><script type="module" src="/main.tsx"></script>`；`src/web/main.tsx` 仅执行 `document.querySelector("#root")!.textContent = "CLI Session Task MCP"`。

Run: `npm run build`

Expected: TypeScript 共享契约与最小 Web 入口均构建成功，产物至少包含 `dist/shared/task-contracts.js` 和 `dist/web/index.html`；Task 10 创建运行入口后才要求出现 `dist/server/main.js`。

- [ ] **Step 6: 条件提交**

仅在用户已授权 Git 后执行：

```bash
git add package.json package-lock.json tsconfig.json tsconfig.server.json vite.config.ts vitest.config.ts .gitignore src/shared tests/unit/shared src/web/index.html src/web/main.tsx
git commit -m "chore: initialize task mcp project contracts"
```

---

### Task 2: SQLite Schema、事务与迁移安全

**Files:**
- Create: `src/config/runtime-config.ts`
- Create: `src/storage/database.ts`
- Create: `src/storage/migrations.ts`
- Create: `src/storage/progress-store.ts`
- Create: `src/storage/sqlite-progress-store.ts`
- Test: `tests/unit/storage/migrations.test.ts`
- Test: `tests/integration/storage/sqlite-progress-store.test.ts`

**Interfaces:**
- Consumes: `TaskRecord`、`SessionRecord`、`CheckpointPayload`、`RepoSnapshot`。
- Produces: `SqliteDatabase.open(config)`、`ProgressStore.transaction(work)`、`ProgressTransaction` 和只读查询方法。

- [ ] **Step 1: 写迁移失败测试**

测试必须使用 `mkdtemp(join(tmpdir(), "cli-session-task-mcp-"))`，禁止写入真实应用数据目录：

```ts
it("creates every required table with foreign keys and WAL", () => {
  const database = openTestDatabase();
  expect(database.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
  expect(listTables(database)).toEqual(expect.arrayContaining([
    "projects", "repositories", "tasks", "task_scopes", "sessions",
    "task_session_links", "active_task_leases", "checkpoints",
    "repo_snapshots", "task_events", "human_decisions",
    "task_dependencies", "operation_results", "legacy_task_imports"
  ]));
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm test -- tests/unit/storage/migrations.test.ts`

Expected: FAIL，原因是 `openTestDatabase` 或迁移尚不存在。

- [ ] **Step 3: 实现运行配置与数据库打开流程**

`RuntimeConfig` 使用以下确定值：

```ts
export interface RuntimeConfig {
  host: "127.0.0.1";
  port: number;
  dataDir: string;
  databasePath: string;
  staleAfterMs: 1_800_000;
  sqliteBusyTimeoutMs: 5_000;
}
```

数据库打开顺序必须是：创建数据目录、打开 `DatabaseSync`、设置 `foreign_keys=ON`、`journal_mode=WAL`、`busy_timeout=5000`、在已有数据库迁移前备份、执行按版本编号的迁移、执行 `PRAGMA integrity_check`。

- [ ] **Step 4: 建立完整首版 Schema**

约束必须落在数据库和应用层两处：

- `tasks.version INTEGER NOT NULL DEFAULT 0`。
- `active_task_leases.task_id` 和 `session_id` 分别唯一。
- `operation_results` 使用 `UNIQUE(session_id, operation_id)`。
- `legacy_task_imports.legacy_import_key` 唯一，并保存 `source_session_label`、`project_id`、`repository_id`、`worktree_path`、`normalized_title`、`task_id`。
- `task_events` 只有 INSERT 路径，不提供 update/delete repository 方法。
- JSON 使用 TEXT 保存，读写时通过 Zod 校验。

- [ ] **Step 5: 定义可替换存储接口**

```ts
export interface ProgressStore {
  transaction<T>(work: (tx: ProgressTransaction) => T): T;
  listTasks(filter: TaskListFilter): TaskSummary[];
  getTaskDetail(taskId: string): TaskDetail | undefined;
}

export interface ProgressTransaction {
  getTask(taskId: string): TaskRecord | undefined;
  insertTask(task: TaskRecord): void;
  updateTask(task: TaskRecord, expectedVersion: number): void;
  getLeaseByTask(taskId: string): ActiveTaskLease | undefined;
  getLeaseBySession(sessionId: string): ActiveTaskLease | undefined;
  putLease(lease: ActiveTaskLease): void;
  deleteLeaseByTask(taskId: string): void;
  insertCheckpoint(checkpoint: CheckpointRecord): void;
  insertRepoSnapshot(snapshot: RepoSnapshotRecord): void;
  appendTaskEvent(event: TaskEventRecord): void;
  getOperationResult(sessionId: string, operationId: string): OperationResult | undefined;
  putOperationResult(result: OperationResult): void;
  findLegacyImport(legacyImportKey: string): LegacyTaskImport | undefined;
  insertLegacyImport(record: LegacyTaskImport): void;
}
```

- [ ] **Step 6: 验证事务、唯一约束和重启读取**

Run: `npm test -- tests/unit/storage/migrations.test.ts tests/integration/storage/sqlite-progress-store.test.ts`

Expected: PASS，并覆盖事务回滚、重复租约失败、重复幂等键读取原结果、关闭重开后数据仍存在、第二连接持有 `BEGIN IMMEDIATE` 时按有限退避返回 `STORAGE_BUSY`、故意失败的迁移保留原数据库并拒绝启动、未知更高 schema version 返回不兼容错误。

- [ ] **Step 7: 条件提交**

```bash
git add src/config src/storage tests/unit/storage tests/integration/storage
git commit -m "feat: add sqlite storage and migrations"
```

---

### Task 3: 任务状态机与权限边界

**Files:**
- Create: `src/core/task-state.ts`
- Test: `tests/unit/core/task-state.test.ts`

**Interfaces:**
- Consumes: `TaskStatus`、`PlatformError`。
- Produces: `assertTransition(actor, from, to)`、`statusHoldsLease(status)`、`assertHumanOnlyAction(action, actor)`。

- [ ] **Step 1: 写完整迁移矩阵失败测试**

测试至少覆盖：

```ts
expect(() => assertTransition(agent, "in_progress", "paused")).not.toThrow();
expect(() => assertTransition(agent, "pending_acceptance", "done")).toThrowError("HUMAN_CONFIRMATION_REQUIRED");
expect(() => assertTransition(human, "pending_acceptance", "done")).not.toThrow();
expect(statusHoldsLease("in_progress")).toBe(true);
expect(statusHoldsLease("verifying")).toBe(true);
expect(statusHoldsLease("waiting_human")).toBe(false);
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm test -- tests/unit/core/task-state.test.ts`

Expected: FAIL，原因是状态机函数尚不存在。

- [ ] **Step 3: 实现精确迁移规则**

Agent 允许的主要迁移为：

```ts
const agentTransitions = new Set([
  "backlog->in_progress",
  "in_progress->waiting_human",
  "waiting_human->in_progress",
  "in_progress->blocked",
  "blocked->in_progress",
  "in_progress->paused",
  "paused->in_progress",
  "in_progress->verifying",
  "verifying->in_progress",
  "verifying->pending_acceptance"
]);
```

人工额外允许 `pending_acceptance->done`、`pending_acceptance->in_progress`，以及任意非终态到 `cancelled`。`done`、`cancelled` 不允许再次迁移。

- [ ] **Step 4: 验证全部矩阵**

Run: `npm test -- tests/unit/core/task-state.test.ts`

Expected: PASS；测试逐一覆盖 9×9 状态组合，不只抽样。

- [ ] **Step 5: 条件提交**

```bash
git add src/core/task-state.ts tests/unit/core/task-state.test.ts
git commit -m "feat: enforce task state transitions"
```

---

### Task 4: 多客户端 Session 注册与失联恢复

**Files:**
- Create: `src/mcp/client-metadata.ts`
- Create: `src/core/session-service.ts`
- Modify: `src/storage/progress-store.ts`
- Modify: `src/storage/sqlite-progress-store.ts`
- Test: `tests/unit/mcp/client-metadata.test.ts`
- Test: `tests/integration/core/session-service.test.ts`

**Interfaces:**
- Consumes: MCP `clientInfo`、Client Capabilities、Transport Session ID、白名单仓库上下文。
- Produces: `normalizeClientMetadata(input)`、`SessionService.sessionContext(input)`、`SessionService.markStale(now)`。

- [ ] **Step 1: 写客户端归一化失败测试**

```ts
expect(normalizeClientMetadata({ name: "codex-cli", version: "0.147.0" }).client_family).toBe("codex");
expect(normalizeClientMetadata({ name: "claude-code", version: "2.1.215" }).client_family).toBe("claude_code");
expect(normalizeClientMetadata({ name: "unknown-agent", version: "1.0.0" }).client_family).toBe("generic_mcp");
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm test -- tests/unit/mcp/client-metadata.test.ts tests/integration/core/session-service.test.ts`

Expected: FAIL，原因是归一化和 Session Service 尚不存在。

- [ ] **Step 3: 实现 Session 身份规则**

`sessionContext` 输入必须包含：

```ts
export interface SessionContextInput {
  transport_session_id: string;
  client_name: string;
  client_version: string;
  protocol_version: string;
  capabilities: Record<string, unknown>;
  workspace_path: string;
  repository_id: string;
  worktree_path: string;
}
```

本任务向 `ProgressTransaction` 增加以下精确方法：

```ts
getSessionByTransportId(transportSessionId: string): SessionRecord | undefined;
getSession(sessionId: string): SessionRecord | undefined;
insertSession(session: SessionRecord): void;
updateSessionActivity(sessionId: string, lastActivityAt: string): void;
listSessionsInactiveBefore(cutoff: string): SessionRecord[];
setSessionStaleAt(sessionId: string, staleAt: string): void;
```

同一 `transport_session_id` 复用平台 Session；新 Transport Session 创建新 `session_id`。不得按客户端类型、workspace、worktree 或厂商会话 ID自动继承租约。

- [ ] **Step 4: 实现 stale 标记**

30 分钟无 MCP 状态事件只设置 `stale_at` 供 Web 显示警告，不改变任务状态、不删除租约。人工释放操作由 Task 8 的 Web API 调用。

- [ ] **Step 5: 验证重连和未知客户端降级**

Run: `npm test -- tests/unit/mcp/client-metadata.test.ts tests/integration/core/session-service.test.ts`

Expected: PASS，覆盖同 Transport 重连、新进程新 Session、缺失可选 capabilities、30 分钟边界和 29 分 59 秒不 stale。

- [ ] **Step 6: 条件提交**

```bash
git add src/mcp/client-metadata.ts src/core/session-service.ts src/storage tests/unit/mcp tests/integration/core/session-service.test.ts
git commit -m "feat: register multi-client sessions"
```

---

### Task 5: 白名单 Repo Probe 与冲突策略

**Files:**
- Create: `src/repo/repo-probe.ts`
- Create: `src/core/conflict-policy.ts`
- Create: `src/cli/register-repository.ts`
- Modify: `src/storage/progress-store.ts`
- Modify: `src/storage/sqlite-progress-store.ts`
- Test: `tests/unit/core/conflict-policy.test.ts`
- Test: `tests/integration/repo/repo-probe.test.ts`

**Interfaces:**
- Consumes: 已登记 `repositories.root_path`、任务 scope 和变更文件路径。
- Produces: `RepoProbe.inspect(input): Promise<RepoSnapshotDraft>`、`evaluateConflicts(input): ConflictReport`。

- [ ] **Step 1: 写只读探针与冲突失败测试**

测试在临时 Git 仓库建立 staged、unstaged、untracked 三类文件，并断言：

```ts
expect(snapshot.changed_files).toEqual(expect.arrayContaining([
  "staged.txt", "unstaged.txt", "untracked.txt"
]));
expect(evaluateConflicts({ left, right: sameWorktree }).level).toBe("hard");
expect(evaluateConflicts({ left, right: overlappingFiles }).code).toBe("FILE_CONFLICT");
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm test -- tests/unit/core/conflict-policy.test.ts tests/integration/repo/repo-probe.test.ts`

Expected: FAIL，原因是 Repo Probe 和冲突策略尚不存在。

- [ ] **Step 3: 实现安全路径校验和固定 Git 命令**

只允许以下 `execFile("git", args)` 调用：

```ts
["-C", rootPath, "rev-parse", "--show-toplevel"]
["-C", rootPath, "worktree", "list", "--porcelain", "-z"]
["-C", worktreePath, "rev-parse", "HEAD"]
["-C", worktreePath, "branch", "--show-current"]
["-C", worktreePath, "status", "--porcelain=v2", "-z"]
```

必须用 `realpath` 规范化路径，并以 `git -C rootPath worktree list --porcelain -z` 的结果验证 worktree 属于已登记仓库；不得假定 linked worktree 位于仓库根路径之下。拒绝符号链接逃逸和未登记路径，返回 `REPOSITORY_NOT_ALLOWED`。

本任务向存储接口增加：

```ts
getRepository(repositoryId: string): RepositoryRecord | undefined;
upsertProject(project: ProjectRecord): void;
upsertRepository(repository: RepositoryRecord): void;
listActiveTaskScopes(repositoryId: string): ActiveTaskScope[];
```

- [ ] **Step 4: 实现冲突分级**

- 同一可写 worktree：`hard/WORKTREE_CONFLICT`。
- 变更文件集合交集非空：`hard/FILE_CONFLICT`。
- 同仓不同 worktree 且模块路径重叠：`warning/MODULE_OVERLAP`。
- 未完成软依赖：`warning/SOFT_DEPENDENCY`。
- 探针失败：`hard/REPO_PROBE_FAILED`，禁止开始或切换。

- [ ] **Step 5: 实现仓库注册 CLI**

CLI 只写平台 SQLite；先校验目录存在且为 Git 仓库，再 upsert project/repository。首期实际命令为：

```bash
npm run repo:register -- --project-id lkf --project-name LKF --repository-id lkf-frontend --repository-name frontend --path /Users/macmini/playground/lkf/lkf-frontend
npm run repo:register -- --project-id lkf --project-name LKF --repository-id lkf-backend --repository-name backend --path /Users/macmini/playground/lkf/lkf-backend
npm run repo:register -- --project-id lkf --project-name LKF --repository-id lkf-docs --repository-name docs --path /Users/macmini/playground/lkf/lkf-docs
```

- [ ] **Step 6: 验证探针无业务仓写入**

Run: `npm test -- tests/unit/core/conflict-policy.test.ts tests/integration/repo/repo-probe.test.ts`

Expected: PASS；测试对探针前后 `git status --porcelain=v2` 原始输出做相等断言。

- [ ] **Step 7: 条件提交**

```bash
git add src/repo src/core/conflict-policy.ts src/cli/register-repository.ts src/storage tests/unit/core/conflict-policy.test.ts tests/integration/repo
git commit -m "feat: add read-only repository conflict probe"
```

---

### Task 6: Task Service、Checkpoint、切换与存量接管

**Files:**
- Create: `src/core/task-service.ts`
- Modify: `src/storage/progress-store.ts`
- Modify: `src/storage/sqlite-progress-store.ts`
- Test: `tests/unit/core/task-service.test.ts`
- Test: `tests/integration/core/task-races.test.ts`
- Test: `tests/integration/core/legacy-adoption.test.ts`

**Interfaces:**
- Consumes: `ProgressStore`、`RepoProbe`、`evaluateConflicts`、`assertTransition`、`SessionService`。
- Produces: `TaskService` 的 `createTask`、`listTasks`、`getTask`、`checkTaskConflicts`、`attachTask`、`startTask`、`checkpointTask`、`switchTask`、`submitTask`、`adoptTask`、`humanUpdateTask`、`humanRecordDecision`、`humanAccept`、`humanReject`、`humanCancel`、`humanReleaseSession`。

- [ ] **Step 1: 写生命周期和权限失败测试**

至少包含：

```ts
await expect(service.startTask(startInput)).resolves.toMatchObject({ status: "in_progress", version: 1 });
await expect(service.switchTask({ ...switchInput, checkpoint: undefined })).rejects.toMatchObject({ code: "CHECKPOINT_REQUIRED" });
await expect(service.humanAccept(taskId, agentActor)).rejects.toMatchObject({ code: "HUMAN_CONFIRMATION_REQUIRED" });
await expect(service.submitTask(submitInput)).resolves.toMatchObject({ status: "pending_acceptance" });
await expect(service.startTask({ ...warningInput, acknowledged_warning_codes: [] })).rejects.toMatchObject({ code: "HUMAN_CONFIRMATION_REQUIRED" });
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm test -- tests/unit/core/task-service.test.ts`

Expected: FAIL，原因是 `TaskService` 尚不存在。

- [ ] **Step 3: 实现统一写入包装器**

所有 Agent 写操作必须经过以下顺序：

```ts
return store.transaction((tx) => {
  const previous = tx.getOperationResult(sessionId, operationId);
  if (previous) return previous.response;
  const response = performVersionedMutation(tx, input);
  tx.putOperationResult({ session_id: sessionId, operation_id: operationId, response });
  return response;
});
```

版本不符返回 `TASK_VERSION_CONFLICT` 并携带 `current_version`；事务失败不得留下 checkpoint、event 或 lease 的部分写入。

本任务向 `ProgressTransaction` 补充以下领域写入方法，方法名不得在后续适配层改写：

```ts
insertTaskScope(scope: TaskScopeRecord): void;
upsertTaskSessionLink(link: TaskSessionLinkRecord): void;
insertHumanDecision(decision: HumanDecisionRecord): void;
insertTaskDependency(dependency: TaskDependencyRecord): void;
listTaskDependencies(taskId: string): TaskDependencyRecord[];
listActiveScopesByWorktree(worktreePath: string): ActiveTaskScope[];
```

- [ ] **Step 4: 实现正常生命周期**

- `createTask` 创建 `backlog/version=0` 与 `task_created` 事件。
- `listTasks`、`getTask`、`checkTaskConflicts` 不产生写入；`attachTask` 只写 `task_session_links`，不创建 lease、不改变任务状态。
- `startTask` 先 Repo Probe 和冲突检查；hard conflict 直接拒绝，warning code 必须全部出现在 `acknowledged_warning_codes` 后才可继续；随后变为 `in_progress`、版本加一、创建唯一 lease。
- `checkpointTask` 写 checkpoint 与 snapshot；目标为 `waiting_human`、`blocked`、`paused` 时释放 lease。
- `submitTask` 要求验证证据非空且全部 `passed`，进入 `pending_acceptance` 并释放 lease。
- `humanRecordDecision` 写入结论、决定人和时间；只有相关待决定事项已有结论，`waiting_human` 才能恢复为 `in_progress`。
- 人工 accept/reject/cancel 通过同一状态机并写 `human_decisions`，同时追加 actor=`human` 的事件。

- [ ] **Step 5: 实现原子 `task_switch`**

先在事务外采集当前与目标 Repo Snapshot，再在单一数据库事务内校验版本、写当前 checkpoint/snapshot、暂停当前任务、释放当前 lease、开始目标任务、创建目标 lease。任何步骤失败时当前任务和租约保持原样。

- [ ] **Step 6: 写存量接管失败测试**

```ts
await expect(service.adoptTask(activeLegacyInput)).resolves.toMatchObject({ status: "in_progress" });
await expect(service.adoptTask({ ...activeLegacyInput, operation_id: "retry" })).resolves.toMatchObject({ task_id: firstTaskId });
await expect(service.adoptTask(agentPendingAcceptanceInput)).rejects.toMatchObject({ code: "HUMAN_CONFIRMATION_REQUIRED" });
expect(await listLeasesForSharedWorktree()).toHaveLength(0);
expect((await listTasksForSharedWorktree()).every((task) => task.status === "paused")).toBe(true);
```

- [ ] **Step 7: 实现 `task_adopt`**

单事务创建 task、初始 checkpoint、Repo Snapshot、`legacy_task_adopted` 事件和 `legacy_task_imports` 记录。相同 `legacy_import_key` 且身份字段一致时返回既有任务；身份字段不一致时返回 `TASK_ALREADY_ADOPTED`。第二个存量任务命中同 worktree 时，将两个存量导入任务均置为 `paused`、释放相关 lease、追加冲突事件。

- [ ] **Step 8: 验证竞态**

Run: `npm test -- tests/unit/core/task-service.test.ts tests/integration/core/task-races.test.ts tests/integration/core/legacy-adoption.test.ts`

Expected: PASS，覆盖两个 Session 抢同任务、一个 Session 抢两个任务、`task_adopt` 与 `task_start` 并发、重复 operation 和重复 legacy key。

- [ ] **Step 9: 条件提交**

```bash
git add src/core/task-service.ts src/storage tests/unit/core/task-service.test.ts tests/integration/core
git commit -m "feat: implement task lifecycle and legacy adoption"
```

---

### Task 7: Streamable HTTP MCP 与十一个工具

**Files:**
- Create: `src/mcp/tool-schemas.ts`
- Create: `src/mcp/register-tools.ts`
- Create: `src/mcp/http-transport.ts`
- Test: `tests/integration/mcp/mcp-tools.test.ts`
- Test: `tests/integration/mcp/mcp-transport.test.ts`

**Interfaces:**
- Consumes: `TaskService`、`SessionService`、MCP Client Metadata。
- Produces: `createMcpServer(deps)`、`mountMcpTransport(app, deps)` 和 `/mcp`。

- [ ] **Step 1: 写工具清单和 Instructions 失败测试**

```ts
expect((await listToolNames(client)).sort()).toEqual([
  "session_context", "task_list", "task_get", "task_conflicts", "task_attach",
  "task_create", "task_adopt", "task_start", "task_checkpoint", "task_switch", "task_submit"
].sort());
expect(serverInstructions.slice(0, 512)).toContain("切换或停止前必须 checkpoint");
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm test -- tests/integration/mcp/mcp-tools.test.ts`

Expected: FAIL，原因是 MCP Server 尚不存在。

- [ ] **Step 3: 注册十一项工具及注解**

读工具标记 `readOnlyHint: true`；写工具标记 `readOnlyHint: false`、`destructiveHint: false`。每个 handler 只做 Zod 解析、调用 service、把 `PlatformError` 转为稳定结构，不直接访问 SQLite。

`session_context` 必须合并 transport 捕获的 `clientInfo`、协议版本、capabilities；Agent 不能覆盖这些字段。

工具输入边界固定如下：

| 工具 | 必填输入 | 主要输出 |
|---|---|---|
| `session_context` | `workspace_path`、`repository_id`、`worktree_path` | `session_id`、客户端元数据、当前 lease、stale 状态 |
| `task_list` | 可选 `status[]`、`repository_id`、`priority[]` | `TaskSummary[]` |
| `task_get` | `task_id` | `TaskDetail` |
| `task_conflicts` | `task_id` 或完整 proposed scope | `ConflictReport` |
| `task_attach` | `session_id`、`operation_id`、`expected_version`、`task_id`、`role` | 更新后的参与关系与 task version |
| `task_create` | `session_id`、`operation_id`、`expected_version: 0`、标题、目标、优先级、验收标准、scopes、依赖、`next_action` | 新任务 |
| `task_adopt` | create 字段、`legacy_import_key`、来源 Session 标签、目标状态、初始 checkpoint、Repo Snapshot | 接管任务、lease 或冲突回退 |
| `task_start` | `session_id`、`operation_id`、`expected_version`、`task_id`、`acknowledged_warning_codes[]` | `in_progress` 任务与 lease |
| `task_checkpoint` | `session_id`、`operation_id`、`expected_version`、`task_id`、checkpoint、目标非终态 | checkpoint、snapshot、任务状态 |
| `task_switch` | 当前/目标 task ID 与 version、当前 checkpoint、`acknowledged_warning_codes[]` | 两个任务的新版本与目标 lease |
| `task_submit` | `session_id`、`operation_id`、`expected_version`、`task_id`、验证证据 | `pending_acceptance` 任务 |

所有工具统一返回 `{ ok, data, meta: { request_id, schema_version, task_version }, next }`；错误返回 `PlatformError` 字段且仍保留稳定错误码。

- [ ] **Step 4: 实现 Streamable HTTP Session 管理**

使用 MCP SDK `StreamableHTTPServerTransport`，以 SDK 生成的 Transport Session ID 为 key 保存活动 transport。仅接受 `POST /mcp`、`GET /mcp` 和 `DELETE /mcp`；关闭 transport 时释放连接对象，但不自动释放任务 lease。

- [ ] **Step 5: 写协议级集成测试**

使用 SDK `Client` + `StreamableHTTPClientTransport` 连接临时端口，验证 initialize、tools/list、`session_context`、`task_create`、重复 operation、稳定错误码和 transport delete 后重连行为。

- [ ] **Step 6: 运行 MCP 测试**

Run: `npm test -- tests/integration/mcp/mcp-tools.test.ts tests/integration/mcp/mcp-transport.test.ts`

Expected: PASS；工具数严格为 11，未知客户端归类 `generic_mcp`，新 Transport Session 不继承旧 lease。

- [ ] **Step 7: 条件提交**

```bash
git add src/mcp tests/integration/mcp
git commit -m "feat: expose task workflow over streamable http mcp"
```

---

### Task 8: Web API、SSE 与本地安全边界

**Files:**
- Create: `src/server/security.ts`
- Create: `src/server/sse-hub.ts`
- Create: `src/server/board-routes.ts`
- Create: `src/server/http-app.ts`
- Test: `tests/integration/server/board-api.test.ts`
- Test: `tests/integration/server/security.test.ts`

**Interfaces:**
- Consumes: `TaskService`、`SessionService`、`SseHub`。
- Produces: `createHttpApp(deps)`、REST 路由、`GET /events` 和 `GET /health`。

- [ ] **Step 1: 写 API 与安全失败测试**

```ts
await request(app).get("/health").expect(200, { ok: true });
await request(app).post("/api/tasks").set("Origin", "https://evil.example").send(validTask).expect(403);
await request(app).get("/api/tasks").set("Host", "evil.example").expect(403);
await request(app).post(`/api/tasks/${taskId}/accept`).send({ expected_version: 2 }).expect(200);
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm test -- tests/integration/server/board-api.test.ts tests/integration/server/security.test.ts`

Expected: FAIL，原因是 HTTP App 尚不存在。

- [ ] **Step 3: 实现唯一人工 API**

提供以下路由：

```text
GET    /health
GET    /api/tasks
GET    /api/tasks/:taskId
POST   /api/tasks                  mode=create|legacy_import
PATCH  /api/tasks/:taskId
POST   /api/tasks/:taskId/accept
POST   /api/tasks/:taskId/reject
POST   /api/tasks/:taskId/cancel
POST   /api/tasks/:taskId/decisions
POST   /api/sessions/:sessionId/release
GET    /events
GET    /board
```

人工 legacy import 允许 `pending_acceptance`，仍禁止直接导入 `done`、`cancelled`。所有 mutation 要求 `operation_id` 和 `expected_version`；Web 通过 `crypto.randomUUID()` 为每次人工操作生成 operation ID，重试复用原值。人工 actor 由本地 Web route 固定注入，不能由请求 body 冒充。

- [ ] **Step 4: 实现 Host、Origin 与 SSE**

只接受 `Host` 为 `127.0.0.1:47321` 或 `localhost:47321`；测试临时端口通过显式 `allowedHosts` 注入。Web mutation 的 `Origin` 只能是同源；MCP 请求单独走 `/mcp` 的本地 Host 校验。SSE 事件固定为：

```text
event: task.changed
data: {"task_id":"task_0001","version":3}

```

- [ ] **Step 5: 验证 API 与事件**

Run: `npm test -- tests/integration/server/board-api.test.ts tests/integration/server/security.test.ts`

Expected: PASS，覆盖 create/import 共用入口、accept/reject/cancel、release stale Session、异常 Host/Origin 和 SSE 广播。

- [ ] **Step 6: 条件提交**

```bash
git add src/server tests/integration/server
git commit -m "feat: add secure board api and sse"
```

---

### Task 9: 最小四列 Web 看板

**Files:**
- Modify: `src/web/index.html`
- Modify: `src/web/main.tsx`
- Create: `src/web/styles.css`
- Create: `src/web/api-client.ts`
- Create: `src/web/task-board.tsx`
- Create: `src/web/task-drawer.tsx`
- Create: `src/web/board-view-model.ts`
- Test: `tests/unit/web/board-view-model.test.ts`

**Interfaces:**
- Consumes: `/api/tasks`、`/api/tasks/:id`、人工 mutation API、`/events`。
- Produces: 四列看板、任务卡、唯一抽屉和 SSE 自动刷新。

- [ ] **Step 1: 写分列和排序失败测试**

```ts
expect(columnForStatus("paused")).toBe("backlog");
expect(columnForStatus("verifying")).toBe("active");
expect(columnForStatus("pending_acceptance")).toBe("attention");
expect(columnForStatus("done")).toBe("closed");
expect(sortTasks([p2Recent, p0Old])[0].priority).toBe("P0");
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm test -- tests/unit/web/board-view-model.test.ts`

Expected: FAIL，原因是 view model 尚不存在。

- [ ] **Step 3: 实现纯 View Model**

四列固定为：待执行、进行中、待处理、已结束。排序键依次为优先级、是否等待人工、最后更新时间；已结束默认折叠。

- [ ] **Step 4: 实现语义化任务卡和唯一入口**

- 页面顶部只有一个“新建任务”按钮。
- 文档标题固定为“任务进度看板”，页面主标题固定为“任务进度”。
- 同一抽屉内用 radio 选择“新建”或“导入存量”。
- 任务卡使用 `<button>` 并带标题、稳定 ID、仓库/模块、客户端类型、`next_action` 和 stale 警告。
- 抽屉使用 `role="dialog"`、`aria-modal="true"`，集中展示 checkpoint、Session、Repo Snapshot、依赖、决定、验证证据和事件。
- 不实现拖拽、独立列表页、独立 Session 页、统计图或重复快捷按钮。

- [ ] **Step 5: 实现人工操作和 SSE 刷新**

记录人工决定、accept、reject、cancel、priority edit、release stale Session 都只出现在详情抽屉。收到 `task.changed` 后按 `task_id` 重新获取详情并刷新列，不做乐观伪造状态。

- [ ] **Step 6: 验证单元测试与生产构建**

Run: `npm test -- tests/unit/web/board-view-model.test.ts`

Expected: PASS。

Run: `npm run build:web`

Expected: PASS，产物位于 `dist/web`。

- [ ] **Step 7: 条件提交**

```bash
git add src/web tests/unit/web
git commit -m "feat: add minimal task progress board"
```

---

### Task 10: 运行入口、备份导出与客户端接入说明

**Files:**
- Create: `src/server/main.ts`
- Create: `src/cli/export-data.ts`
- Create: `docs/integration/codex.md`
- Create: `docs/integration/claude-code.md`
- Test: `tests/integration/server/restart-recovery.test.ts`
- Test: `tests/integration/cli/export-data.test.ts`

**Interfaces:**
- Consumes: 所有已实现服务和 RuntimeConfig。
- Produces: 可启动进程、优雅关闭、JSON 导出、Codex/Claude Code 人工配置说明。

- [ ] **Step 1: 写重启恢复和导出失败测试**

创建任务、lease、checkpoint 和 event，关闭数据库后用同一路径重开；断言任务和审计存在，原 lease 标记为待恢复而不是自动转移。导出 JSON 必须包含 schema version、projects、repositories、tasks、checkpoints、snapshots、events、decisions、dependencies，不包含 operation response 中的敏感 header。

- [ ] **Step 2: 运行并确认失败**

Run: `npm test -- tests/integration/server/restart-recovery.test.ts tests/integration/cli/export-data.test.ts`

Expected: FAIL，原因是运行入口和导出尚不存在。

- [ ] **Step 3: 实现进程生命周期**

启动顺序：读取配置、打开/迁移数据库、构造 store/probe/services、构造 Express、挂载 `/mcp` 和 Web、监听 `127.0.0.1:47321`、每 60 秒扫描 stale Session。监听遇到 `EADDRINUSE` 时输出明确端口冲突并非零退出，不尝试结束已有进程。`SIGINT`/`SIGTERM` 顺序关闭 HTTP、MCP transports、timer、SQLite；不得自动更改任务状态。

- [ ] **Step 4: 实现备份和导出**

迁移前备份命名为 `backups/task-progress-YYYYMMDD-HHmmss.sqlite`。`npm run data:export -- --output /private/tmp/cli-session-task-mcp-export.json` 使用临时文件写完后原子 rename；目标已存在时拒绝覆盖并返回非零退出码。

- [ ] **Step 5: 编写 Codex 接入说明**

文档包含人工加入的配置片段和检查命令：

```toml
[mcp_servers.cli_session_task]
url = "http://127.0.0.1:47321/mcp"
required = true
default_tools_approval_mode = "writes"
```

验证：重启 Codex CLI/IDE，运行 `/mcp`，确认服务器已连接且工具数为 11。文档明确禁止平台自动编辑 `~/.codex/config.toml`。

- [ ] **Step 6: 编写 Claude Code 接入说明**

文档给出以下人工命令，但实施时必须先获用户授权：

```bash
claude mcp add --transport http --scope user cli-session-task http://127.0.0.1:47321/mcp
claude mcp get cli-session-task
```

验证：进入 Claude Code 后运行 `/mcp`，确认连接和 11 项工具。文档注明项目级 `.mcp.json` 可用 `{"mcpServers":{"cli-session-task":{"type":"http","url":"http://127.0.0.1:47321/mcp"}}}`，但平台不得写入 LKF 业务仓。

- [ ] **Step 7: 验证恢复、导出和构建**

Run: `npm test -- tests/integration/server/restart-recovery.test.ts tests/integration/cli/export-data.test.ts`

Expected: PASS。

Run: `npm run build`

Expected: PASS，并生成 `dist/server/main.js` 与 `dist/web/index.html`。

Terminal A：

```bash
task_smoke_dir=$(mktemp -d /private/tmp/cli-session-task-mcp-smoke.XXXXXX)
TASK_MCP_DATA_DIR="$task_smoke_dir" node dist/server/main.js
```

Expected: 输出监听地址；另一个终端执行 `curl --fail http://127.0.0.1:47321/health` 返回 `{"ok":true}`。验证后向服务发送 `SIGINT`，确认端口不再监听。

- [ ] **Step 8: 条件提交**

```bash
git add src/server/main.ts src/cli/export-data.ts docs/integration tests/integration/server/restart-recovery.test.ts tests/integration/cli
git commit -m "feat: add runtime recovery and client onboarding"
```

---

### Task 11: browser-harness + Edge 端到端验收

**Files:**
- Create: `tests/e2e/board-smoke.py`
- Create: `tests/e2e/seed-e2e.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: 运行中的 `http://127.0.0.1:47321/board` 和已登记的 LKF repositories。
- Produces: 可重复执行的 Edge UI 冒烟流程；不产生 Playwright 依赖。

- [ ] **Step 1: 编写 browser-harness 冒烟脚本**

脚本必须使用已有标签页复用和 Accessibility Tree：

```py
open_or_switch_tab("http://127.0.0.1:47321/board")
wait_for_load()

def find_ax(role, name):
    nodes = cdp("Accessibility.getFullAXTree")["nodes"]
    for node in nodes:
        role_value = node.get("role", {}).get("value")
        name_value = node.get("name", {}).get("value")
        if role_value == role and name_value == name:
            return node
    raise AssertionError(f"AX node not found: {role} {name}")

def click_ax(role, name):
    node = find_ax(role, name)
    box = cdp("DOM.getBoxModel", backendNodeId=node["backendDOMNodeId"])["model"]["content"]
    click_at_xy(sum(box[0::2]) / 4, sum(box[1::2]) / 4)

assert "任务" in js("document.title")
click_ax("button", "新建任务")
assert find_ax("dialog", "任务详情")
```

继续通过可访问名称填写标题、目标、优先级、仓库和 `next_action`，提交后断言任务卡出现在“待执行”；打开同一抽屉切换“导入存量”，分别导入 `paused` 和 `pending_acceptance` 任务；从抽屉验收后者并断言进入默认折叠的“已结束”。

`seed-e2e.ts` 在隔离数据库中创建一个 31 分钟未活动的 `in_progress` Session/任务/lease，以及一个供 SSE 验证的 backlog 任务。它只能接受经 `realpath` 规范化后以 `/private/tmp/cli-session-task-mcp-e2e.` 开头的 `TASK_MCP_DATA_DIR`，否则立即退出并拒绝写入。

- [ ] **Step 2: 增加非 npm 浏览器命令**

`package.json` 只增加：

```json
"seed:e2e": "tsx tests/e2e/seed-e2e.ts",
"test:e2e:edge": "browser-harness < tests/e2e/board-smoke.py"
```

不得添加 `@playwright/test`、`playwright`、`selenium-webdriver` 或 Chromium 下载脚本。

- [ ] **Step 3: 启动隔离数据服务**

Terminal A：

```bash
task_e2e_dir=$(mktemp -d /private/tmp/cli-session-task-mcp-e2e.XXXXXX)
TASK_MCP_DATA_DIR="$task_e2e_dir" npm run seed:e2e
TASK_MCP_DATA_DIR="$task_e2e_dir" npm start
```

Expected: `127.0.0.1:47321` 监听且 `/health` 为 200。

- [ ] **Step 4: 使用 browser-harness 接管 Microsoft Edge**

Run: `npm run test:e2e:edge`

Expected: PASS，覆盖新建、详情、优先级、存量导入、人工验收、释放 seed 创建的 stale Session。脚本通过页面内同源 `fetch` 创建一个任务并只依赖 EventSource 等待任务卡出现，以单独验证 SSE 刷新。若 Edge 尚未允许远程调试，只运行一次 `browser-harness --doctor`，由用户在 `edge://inspect/#remote-debugging` 手工允许后重试；不得探测或启动 Chrome。

- [ ] **Step 5: 条件提交**

```bash
git add tests/e2e/board-smoke.py tests/e2e/seed-e2e.ts package.json package-lock.json
git commit -m "test: verify board flows with browser harness"
```

---

### Task 12: 全链路验收与多客户端实机验证

**Files:**
- Modify only if verification exposes a defect: the owning source/test file from Tasks 1-11.
- Do not create additional reports or README files.

**Interfaces:**
- Consumes: 完整 MVP。
- Produces: 设计文档第 15 节全部验收证据。

- [ ] **Step 1: 运行静态、单元、集成和构建验证**

Run: `npm run check`

Expected: typecheck PASS、全部 Vitest PASS、server 和 Web build PASS。

- [ ] **Step 2: 运行数据库和业务仓安全核对**

Run: `npm ls --depth=0`

Expected: 无 missing/invalid，输出中不存在 Playwright/Selenium。

在三个 LKF 仓库分别记录验证前后的 `git status --porcelain=v2 --branch`，运行 Repo Probe 和所有测试后逐字比较；Expected: 平台没有造成任何新增业务仓变更。

- [ ] **Step 3: 验证 Codex 实机接入**

在用户已人工配置并重启后运行 `codex mcp list`，在 Codex 中运行 `/mcp`，调用 `session_context`、`task_create`、`task_checkpoint`。Expected: 客户端归类 `codex`，工具数 11，Checkpoint 出现在 Web 看板。

- [ ] **Step 4: 验证 Claude Code 实机接入**

在用户已授权并配置后运行 `claude mcp get cli-session-task`，在 Claude Code 中运行 `/mcp`，调用 `session_context` 并读取 Codex 创建的任务。Expected: 客户端归类 `claude_code`，看到同一任务台账。

- [ ] **Step 5: 验证跨客户端唯一租约**

让 Codex 对测试任务执行 `task_start`，随后让 Claude Code 对同一任务执行 `task_start`。Expected: Claude Code 收到 `TASK_LEASE_CONFLICT`，包含现有 Session、worktree 证据和恢复动作；数据库中只有一条活动 lease。

- [ ] **Step 6: 验证存量任务接管**

分别覆盖：活动任务获得 lease、挂起任务无 lease、重复 `legacy_import_key` 返回原任务、同 worktree 两个存量任务均 paused、Agent 导入 `pending_acceptance` 被拒绝、Web 人工导入 `pending_acceptance` 成功。

- [ ] **Step 7: 运行 browser-harness 最终验收**

Run: `npm run test:e2e:edge`

Expected: PASS；只复用 `http://127.0.0.1:47321/board` 标签页，不打开重复页面，不启动 Chrome，不录制视频。

- [ ] **Step 8: 条件最终提交**

仅在用户已授权 Git 且前述验证全部通过后执行：

```bash
git status --short
git add package.json package-lock.json tsconfig.json tsconfig.server.json vite.config.ts vitest.config.ts .gitignore src tests docs/integration
git commit -m "feat: deliver local multi-agent task progress mcp"
```

不得推送远程；最终报告必须列出测试总数、Codex/Claude Code 实机版本、Edge/browser-harness 结果、SQLite 路径、监听地址和任何未通过项。
