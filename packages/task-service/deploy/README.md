# Linux 部署指南

## 前置条件

- Node.js >= 24.19.0
- npm 11.x
- systemd（Ubuntu/Debian/CentOS）
- 内网服务器

## 首次安装（独立主机）

```bash
git clone <repo> /opt/cli-session-task-mcp
cd /opt/cli-session-task-mcp
./deploy/setup.sh
```

`setup.sh` 只用于新独立主机的首次引导，不用于当前共享生产实例的日常发布。

## 日常生产发布（artifact）

当前 `172.16.0.90` 使用开发机构建、服务器收取产物的发布方式：

1. 在开发机对待发布提交执行 `npm ci`、`npm run check`，产出 `dist/`。
2. 推送 `main`，确认远端 ref 与本地提交一致。
3. 在服务器 `/opt/cli-session-task-mcp/releases/<时间戳>-<短提交>/dist` 新建 release，
   上传本机构建产物并校验关键文件哈希；生产机不得执行 `npm ci` 或 `npm run build`。
4. 确认服务器仓库干净后只做 `main` 快进，将新 release 同步到实际目录
   `/opt/cli-session-task-mcp/dist`，再重启 `cli-session-task-mcp`。
5. 验证 systemd、`/health`、`/board`、MCP 工具发现和 Host 门禁。失败时把上一版
   release 同步回实际 `dist` 并重启；不得用 `dist` 软链污染服务器 Git 工作区。

涉及 schema 升级时，应用会在迁移前写入 `data/backups/`。发布后必须确认备份新增、
数据库完整性和目标 schema 均正常。不要直接复制正在运行的 SQLite 主文件作为备份。

## 团队接入

当前内部共享实例：

- MCP：`http://172.16.0.90:47321/mcp`
- Web 看板：`http://172.16.0.90:47321/board`
- 健康检查：`http://172.16.0.90:47321/health`

完整的仓库登记、owner、`session_context` 和浏览器配对流程见
[内部局域网共享服务接入](../docs/integration/internal-lan-server.md)。

**Codex**（`~/.codex/config.toml`）：

```toml
[mcp_servers.cli_session_task]
url = "http://172.16.0.90:47321/mcp"
```

**Claude Code**：

```bash
claude mcp add --transport http --scope user cli-session-task http://172.16.0.90:47321/mcp
```

首次访问 Web 看板时，未配对设备只显示初始化引导。生成一次性配对码，并让已经完成
`session_context` 的同一个 Agent 调用 `board_pair`；成功后进入该 owner 的个人视角。
浏览器设备配对后不会由服务端自动失效；Edge 会把持久 Cookie 限制为最多 400 天，
服务会在每次认证成功时重新续满 400 天。清理该站点 Cookie、主动退出或显式撤销后
需要重新配对。每个新的 Agent 会话仍须单独执行一次 `session_context`。
同一 transport 进入同仓库的新 worktree 时使用 `session_rebind`；有活跃任务时使用
`task_switch` 原子更新任务租约和 session worktree 身份。

## 权限

- 未配对设备：只能看到安装和配对引导，不能读取项目或任务
- 已配对成员：可查看所有 owner 的项目、任务和明细；`?owner=<查看对象>` 只改变读取目标
- 验收/驳回/取消/释放：仅任务真实 owner；URL owner 不改变配对身份或写权限
- 依赖通知：仅当前配对 owner 可见和操作，不随查看对象切换
- MCP 写入：Agent 会话（自动继承 owner）
- 数据库：SQLite（服务进程独占，无外部访问）

## 运维

```bash
systemctl restart cli-session-task-mcp
journalctl -u cli-session-task-mcp -f
```

## 已知限制

### HTTP 环境下 Web Crypto API

内网 HTTP（非 HTTPS、非 localhost）下 `crypto.randomUUID()` 不可用。已内置降级方案，
复制 Agent 指令和所有 mutation 操作均有兼容处理。当前实例不对公网开放，继续使用
局域网 HTTP，不部署证书；如后续引入 `crypto.subtle` 等 API，必须先补充对应降级方案。
