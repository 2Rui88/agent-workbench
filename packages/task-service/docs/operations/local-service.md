# 本机开发与隔离运行（launchd）

本文档只适用于开发者在 macOS 上运行私有本机实例，不是团队成员的接入入口。
当前团队统一使用 `http://172.16.0.90:47321` 的内部局域网共享服务；接入步骤见
[内部局域网共享服务接入](../integration/internal-lan-server.md)。不要同时把同一个 Agent
连接到本机实例和共享实例，以免任务登记到不同的 SQLite 台账。

服务以用户级 LaunchAgent 常驻：开机自启、崩溃自动拉起、日常无需手动维护。

- 服务地址：`http://127.0.0.1:47321`（`/mcp`、`/board`、`/api`、`/events`、`/health`）
- 数据：`~/Library/Application Support/cli-session-task-mcp/task-progress.sqlite`（迁移前自动备份到同目录 `backups/`）
- 日志：`~/Library/Application Support/cli-session-task-mcp/service.log`
- Agent 定义：`~/Library/LaunchAgents/com.cli-session-task-mcp.plist`（入口 `scripts/run-service.sh`）

## 常用操作

```bash
# 状态
launchctl print gui/$(id -u)/com.cli-session-task-mcp | head
curl -s http://127.0.0.1:47321/health

# 重启（例如 npm run build 后让后端生效）
launchctl kickstart -k gui/$(id -u)/com.cli-session-task-mcp

# 停止并取消常驻
launchctl bootout gui/$(id -u)/com.cli-session-task-mcp

# 恢复常驻
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cli-session-task-mcp.plist

# 实时日志
tail -f ~/Library/Application\ Support/cli-session-task-mcp/service.log
```

## 注意

- `npm start` 手动启动会与常驻实例端口冲突（EADDRINUSE），日常请用上面的 kickstart 重启。
- 纯前端改动：`npm run build` 后浏览器刷新即可，无需重启服务；涉及后端（src/server、src/core、src/storage、src/mcp）改动：`npm run build` 后执行 kickstart。
- 升级 Node（homebrew 大版本变更）后如服务起不来，确认 `/opt/homebrew/bin/node` 仍存在（`scripts/run-service.sh` 依赖它）。

## 跑隔离 E2E 冒烟（不影响常驻服务）

测试实例使用独立端口（`TASK_MCP_PORT`）与独立数据目录，常驻的 47321 服务全程不动：

```bash
task_e2e_dir=$(mktemp -d /private/tmp/cli-session-task-mcp-e2e.XXXXXX)
TASK_MCP_DATA_DIR="$task_e2e_dir" npm run seed:e2e
TASK_MCP_DATA_DIR="$task_e2e_dir" TASK_MCP_PORT=47399 npm start &
BOARD_URL=http://127.0.0.1:47399 npm run test:e2e:edge
# 结束后：杀掉 47399 实例（按端口精确匹配，别 pkill 全部 node），清理目录
lsof -ti :47399 | xargs kill
rm -rf /private/tmp/cli-session-task-mcp-e2e.*
```

注意：不要用 `pkill -f "node dist/server/main.js"`——会把常驻实例一并杀掉（它 10 秒内自动复活并抢回 47321，期间测试会打到真实服务）。

## 多项目

- 看板右侧 ⇄「项目」按钮：弹出的菜单可切换项目（进入该项目第一个仓库）或打开**项目仪表盘**（项目卡片 + 各仓任务数，点仓库行跳回看板）。
- URL：`?repo=<仓库>`、`?view=dashboard|overview` 与 `?owner=<查看对象>` 持久化，可收藏。
- 注册新项目/仓库：`npm run repo:register -- --project-id X --project-name X --repository-id Y --repository-name Y --path /path/to/repo`。

## 局域网共享生产服务

当前生产拓扑是 `172.16.0.90:47321` 上的单一共享服务，同时提供 `/mcp`、`/board`、
`/api`、`/events` 和 `/health`，不再提供第二监听端口或只读兼容服务。Web 看板通过设备
配对固定操作身份；已配对成员可用 `owner` 参数只读查看其他成员的项目、任务和明细，
只有任务真实 owner 可以修改、验收或管理租约。依赖通知始终仅当前配对 owner 可见。
