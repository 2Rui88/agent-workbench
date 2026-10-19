# Claude Code 接入说明（cli-session-task-mcp）

本文档说明如何把 Claude Code 人工接入内部局域网共享服务。公共的仓库登记、
`session_context`、owner 和 Web 看板配对流程见
[内部局域网共享服务接入](./internal-lan-server.md)。

**平台不会自动修改 Claude Code 配置，也不会替用户执行配置命令**。

## 前置条件

1. 当前设备可以访问内部局域网。
2. 健康检查返回成功：

   ```bash
   curl --noproxy '*' --fail http://172.16.0.90:47321/health
   ```

3. 目标仓库已经登记，或 Agent 可以从当前 worktree 读取 owner、项目名和路径后直接调用
   `repository_bootstrap`。

客户端不需要在本机运行 `npm start`、`repo:register` 或 SQLite 数据维护命令。

## 人工执行配置

```bash
claude mcp add --transport http --scope user cli-session-task http://172.16.0.90:47321/mcp
claude mcp get cli-session-task
```

## 验证步骤

1. 进入 Claude Code 并运行 `/mcp`。
2. 确认 `cli-session-task` 已连接。
3. 确认显示[公共文档列出的 32 项工具](./internal-lan-server.md#当前工具清单)，其中包括
   `session_context`、`repository_bootstrap`、`dependency_validation_list`、
   `dependency_validation_receive`、`dependency_validation_checkpoint`、
   `dependency_validation_complete` 和 `task_confirm_decision`。
4. 在实际项目 worktree 读取 `git config user.name`，将原始值作为 `owner` 调用
   `session_context`。
5. 如需使用 Web 看板，按[设备配对流程](./internal-lan-server.md#web-看板配对)完成一次配对。

## 下游 Agent 验证闭环

验证由 Agent 在 MCP 中自动完成，Board 只读展示历史，不提供验证通过/驳回响应按钮；也不
需要 bootstrap token。完成 `session_context` 后，按以下顺序调用：

```text
session_context → dependency_validation_list → dependency_validation_receive
→ dependency_validation_checkpoint / heartbeat → dependency_validation_complete
```

`receive` 获取滚动 lease，`checkpoint` 保存进度和心跳，`complete` 回传结果与证据。通过或
驳回均保留 attempt 历史；`rejected` 必须有失败证据，`error` 或超时保持请求 `pending` 并
允许新 attempt 重试。Agent 只能把上游任务提交为 `pending_acceptance`，最终验收和驳回由
人工在看板完成，Agent 不得标记 `done`。

工具输入和权限如下：

| 工具 | 必填输入 | 权限 |
| --- | --- | --- |
| `dependency_validation_list` | `session_id`、`owner`、`repository_id` | 只读，不改变状态 |
| `dependency_validation_receive` | `session_id`、`operation_id`、`validation_id`、`owner` | 写入领取 run 和 lease |
| `dependency_validation_checkpoint` | 上述字段、`run_id`、`progress` | 写入进度并续租 |
| `dependency_validation_complete` | 上述字段、`run_id`、`status`、`verification`、可选 `reason` | 写入完成结果；`error` 保持请求 pending |

遇到待人工决定时，必须先在当前 Claude Code 对话中让用户核对问题与最终决定，再调用
`task_confirm_decision`。不得根据历史会话、沉默或看板审批动作推断决定。

连接失败时重新执行：

```bash
curl --noproxy '*' --fail http://172.16.0.90:47321/health
```

## 项目级 `.mcp.json`（可选）

如需项目级接入，可由用户自行配置：

```json
{
  "mcpServers": {
    "cli-session-task": {
      "type": "http",
      "url": "http://172.16.0.90:47321/mcp"
    }
  }
}
```

平台不得代写业务仓库中的 `.mcp.json`。如需提交该文件，必须由对应仓库的用户另行确认。

不要把客户端的本地 SQLite、数据导出或服务启动方式当作共享服务器的接入步骤；
这些操作由平台管理员在服务器侧统一负责。
