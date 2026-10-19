# v0.2 多项目管理版本规划

日期：2026-08-18　状态：待确认（3 项设计决策）

## 现状与差距

数据层已就绪：`projects` ↔ `repositories`（project_id 外键）↔ `tasks`（经
repository 归属项目）；`repo:register` 已支持 `--project-id/--project-name`。
差距全在体验层：

- 看板只有扁平的仓库切换器，无项目维度
- API 无项目级查询（/api/repositories 是平铺清单）
- 看板默认进入逻辑只认"第一个仓库"

## 目标

- 多项目并存，每项目多仓库；看板按 项目 → 仓库 两级导航
- 提供"项目总览"：单项目内跨仓库聚合视图
- CLI/MCP 完全不变（会话仍绑定单仓库；跨项目天然无冲突，冲突策略本就按仓隔离）
- LAN 只读镜像自动获得同等能力

## 待确认的设计决策

1. **导航形态**：A. 顶栏两级下拉（项目 + 仓库，仓库含"全部"= 总览）——
   保持现有单页简洁；B. 左侧项目/仓库树——信息密度高但引入新布局。推荐 A。
2. **项目总览形态**：聚合四列（该项目全部任务按现有列规则混排，卡片带仓库
   徽标）——复用现有 view-model；备选：仓库×状态计数矩阵 + 点入下钻。推荐聚合四列。
3. **URL 结构**：`?project=<id>&repo=<id|all>` 双参数持久化（可收藏/分享）。
   推荐直接采用。

## API 变更

- `GET /api/projects` → `[{project_id, name, repositories:[{repository_id,label,...}]}]`
  （一次请求拿全导航数据，替代现有平铺 /api/repositories，保留旧端点兼容）
- `GET /api/tasks` 增加可选 `project_id` 过滤（与 repository_id 互斥使用）
- LAN 只读镜像同步以上两个查询；`/api/mode` 不变
- MCP 不动：session_context 绑定仓库、task_list 按仓库——Agent 视角无需项目概念

## 存储层变更（无迁移）

- `ProgressStore.listProjects(): ProjectWithRepositories[]`（join 查询）
- `listTasks` 过滤器扩展 `projectId`（SQL join repositories）

## 前端变更

- 头部：项目 Select + 仓库 Select（"全部仓库"= 项目总览）
- 卡片增加 仓库徽标（总览模式下区分任务归属）
- view-model 列/排序逻辑零改动；新增项目分组工具函数（含单测）
- 只读徽标、SSE 状态条、背景图等全部沿用

## 任务拆分（每步含测试与冒烟同步）

1. **后端**：listProjects + tasks 项目过滤 + API/LAN 端点 + 单元/集成测试
2. **前端**：两级切换器 + URL 双参数 + 总览聚合 + 仓库徽标 + view-model 单测
3. **验证**：seed 多项目场景（2 项目 3+ 仓库）、冒烟增加项目切换断言、
   双端口实测、文档更新（operations + integration）

## 不做（本期）

- 跨项目冲突检测（不同仓库天然隔离，无意义）
- 项目级权限/RBAC（单用户场景）
- 项目归档、删除、统计报表
- 任务跨项目移动

规模估计：3 个任务，约半天；沿用"实现+独立审查"节奏。
