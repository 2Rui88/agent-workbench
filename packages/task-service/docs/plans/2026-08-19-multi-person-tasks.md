# 多人协同任务管理规划

分支：`feat/multi-person-tasks`　日期：2026-08-19

## 场景

本地开发团队多人各自使用 Agent CLI（Codex / Claude Code）开发，每人有独立的
任务集，Agent 和 Session 完全不交叉。平台作为**只读进度看板**供团队查看
每个人的任务状态，不做权限管控（互信团队）。

```
┌─────────────────────────────────────────────────────┐
│                    项目仪表盘                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ 张三      │  │ 李四      │  │ 王五      │          │
│  │ 3 仓库    │  │ 1 仓库    │  │ 2 仓库    │          │
│  │ 12 任务   │  │ 5 任务    │  │ 8 任务    │          │
│  └──────────┘  └──────────┘  └──────────┘          │
└─────────────────────────────────────────────────────┘
         ↓ 点击某人
┌─────────────────────────────────────────────────────┐
│  张三的任务看板（仅显示张三的任务）                      │
│  待执行  │  进行中  │  待处理  │  已结束              │
│  ...     │  ...     │  ...     │  ...               │
└─────────────────────────────────────────────────────┘
```

## 设计原则

1. **无认证**：本地互信团队，不需要登录/密码/Token
2. **标签而非外键**：person 是任务上的一个标签字段，不是独立实体表
3. **Agent 自主声明**：Agent 在 `session_context` 或 `task_create` 时声明
   所属人，平台不做强校验（互信）
4. **看板按人筛选**：`GET /api/tasks?person=xxx` 过滤，前端按人分组

## 数据模型变更

### Migration v5：tasks 表加 `owner` 列

```sql
ALTER TABLE tasks ADD COLUMN owner TEXT;
CREATE INDEX tasks_owner_idx ON tasks(owner);
```

- `owner` 可空（兼容现有无主任务）
- 值为人员标识字符串（如 `zhangsan`、`lisi`），由 Agent 声明
- 不建 persons 表——用标签而非实体，保持简单

## API 变更

### `session_context` 增加可选 `owner` 参数

Agent 连接时声明所属人，后续该 session 创建的任务自动继承 owner：

```json
{ "workspace_path": "...", "repository_id": "...", "worktree_path": "...", "owner": "zhangsan" }
```

### `task_create` / `task_adopt` 增加可选 `owner` 字段

```json
{ ..., "owner": "zhangsan" }
```

未指定时继承 session 的 owner；session 也未指定则为空（无主任务，
看板默认显示在"未分配"分组）。

### `GET /api/tasks` 增加 `owner` 过滤

```
GET /api/tasks?repository_id=lkf-frontend&owner=zhangsan
GET /api/tasks?owner=zhangsan          （跨仓查某人的所有任务）
```

### `GET /api/projects` 响应增加 owner 维度统计

```json
{
  "projects": [
    {
      "project_id": "lkf",
      "repositories": [...],
      "owners": [
        { "owner": "zhangsan", "task_count": 8 },
        { "owner": "lisi", "task_count": 5 },
        { "owner": null, "task_count": 2 }
      ]
    }
  ]
}
```

### 新增 `GET /api/people`

```
GET /api/people → { "people": [{ "owner": "zhangsan", "task_count": 12, "repositories": ["lkf-frontend", "lkf-backend"] }] }
```

## MCP 工具变更

| 工具 | 变更 |
|---|---|
| `session_context` | 输入增可选 `owner` 字段，存入 session |
| `task_create` | 输入增可选 `owner`，默认继承 session owner |
| `task_adopt` | 同上 |
| `task_list` | 输入增可选 `owner` 过滤 |
| `task_get` | 返回增 `owner` 字段 |
| 其余工具 | 不变（owner 创建后不可改，避免管理成本） |

## 前端变更

### 项目仪表盘增加人员卡片

在现有项目卡下方增加人员维度：

```
┌─ LKF ─────────────────────────┐
│ [backend]  [docs]  [frontend] │
│ ── 人员 ──                     │
│ 张三  12 任务                  │
│ 李四   5 任务                  │
│ 未分配  2 任务                 │
└───────────────────────────────┘
```

### 看板增加人员切换

在仓库切换器旁增加人员筛选（下拉或 chip），选择某人后看板只显示该人的任务。
URL 参数 `?owner=zhangsan` 持久化。

### 任务卡片显示 owner 标签

卡片上增加小的 owner 徽标（如人名首字），未分配则不显示。

## 依赖提醒（站内通知）

上游任务完成/取消时，向依赖它的下游任务 owner 推送站内通知。

### 触发点

| 事件 | 通知内容 |
|---|---|
| 上游任务 `humanAccept` → done | "张三的『SQLite 迁移』已完成，你的『前端接入』可以开始" |
| 上游任务 `humanCancel` → cancelled | "张三的『SQLite 迁移』已取消，请检查你的依赖" |

### 数据模型

```sql
CREATE TABLE notifications (
  notification_id TEXT PRIMARY KEY,
  owner TEXT,              -- 谁应该看到（下游任务的 owner）
  task_id TEXT NOT NULL,   -- 下游任务
  upstream_task_id TEXT,   -- 上游任务
  upstream_title TEXT NOT NULL,
  upstream_status TEXT NOT NULL, -- done / cancelled
  read_at TEXT,            -- null = 未读
  created_at TEXT NOT NULL
);
```

### API

- `GET /api/notifications?owner=xxx` → 未读 + 已读列表（最近 50 条）
- `POST /api/notifications/:id/read` → 标记已读
- SSE 事件 `notification.new` → 实时推送到看板

### 前端

- 头部增加通知铃铛 + 未读计数徽标
- 点开下拉面板显示通知列表（上游任务名 + 状态 + 时间）
- 点击"标记已读"或"查看任务"跳转到对应任务详情
- 通知按 owner 筛选（当前看板筛选的 owner）

### 生成时机

在 `humanAccept` / `humanCancel` 的事务内：
1. 查 `task_dependencies` 找到所有依赖此任务的下流任务
2. 为每个下流任务的 owner 生成通知记录
3. 通过 SSE Hub 广播 `notification.new` 事件

## 不做的

- ❌ 认证 / 权限 / RBAC（互信团队）
- ❌ persons 实体表（用标签）
- ❌ 任务转移（owner 创建后不可改）
- ❌ 跨人依赖管理（依赖按任务，不按人）
- ❌ 通知 / 提醒
- ❌ 人员工作量统计 / 燃尽图

## 任务拆分

### Task 1：后端 — 数据模型 + API + 通知
- Migration v5（tasks.owner 列 + notifications 表）
- `session_context` 存储 owner
- `task_create` / `task_adopt` 继承 owner
- `GET /api/tasks` owner 过滤
- `GET /api/people` 端点
- `GET /api/projects` owner 统计
- `humanAccept` / `humanCancel` 事务内生成依赖通知
- `GET /api/notifications` + `POST .../read` + SSE `notification.new`
- LAN 镜像同步
- 测试全覆盖

### Task 2：前端 — 仪表盘人员卡片 + 看板筛选 + 通知
- 仪表盘项目卡内增加人员统计
- 看板增加 owner 筛选（URL `?owner=`）
- 任务卡片 owner 徽标
- 通知铃铛 + 未读计数 + 下拉面板
- 深浅色适配

### Task 3：MCP 工具 + 文档
- 6 个 MCP 工具的 schema/handler 更新
- `docs/integration/codex.md` / `claude-code.md` 增加 owner 说明
- 端到端冒烟验证

## 验收标准（含通知）

1. 两个 Agent 分别声明不同 owner，各自创建任务，看板按人筛选正确
2. 未声明 owner 的任务出现在"未分配"分组
3. 项目仪表盘正确统计各人任务数
4. 现有无主任务完全兼容（不破坏现有数据）
5. 上游任务验收后，下游 owner 的看板收到实时通知（铃铛 + 未读计数）
6. 全量测试通过，双端口（47321 + LAN）实测
