# Codex 接入说明（cli-session-task-mcp）

本文档说明如何把 Codex CLI/IDE 人工接入内部局域网共享服务。公共的仓库登记、
`session_context`、owner 和 Web 看板配对流程见
[内部局域网共享服务接入](./internal-lan-server.md)。

**平台不会自动修改 `~/.codex/config.toml`**；以下配置需要用户手动加入并确认。

## 前置条件

1. 当前设备可以访问内部局域网。
2. 健康检查返回成功：

   ```bash
   curl --noproxy '*' --fail http://172.16.0.90:47321/health
   ```

3. 目标仓库已经登记，或 Agent 可以从当前 worktree 读取 owner、项目名和路径后直接调用
   `repository_bootstrap`。

客户端不需要在本机运行 `npm start`、`repo:register` 或 SQLite 数据维护命令。

## 人工加入配置

在 `~/.codex/config.toml` 中加入：

```toml
[mcp_servers.cli_session_task]
url = "http://172.16.0.90:47321/mcp"
required = true
default_tools_approval_mode = "writes"
```

保存后重启 Codex CLI/IDE，使配置生效。

## 从仓库主目录切换 worktree

Codex 可以先从仓库主目录（例如 `backend`）启动，再由 Agent 创建或选择同一仓库的
linked worktree。Shell 的 `workdir` 和 MCP Session 的 `worktree_path` 是两套独立状态；
只执行 `cd` 或给命令传入新的 `workdir`，不会自动改变 MCP 身份。

Agent 在目标 worktree 写入代码前，应先确认该路径属于当前已登记仓库，并读取目标路径的
Git 身份：

```bash
git -C /absolute/path/to/target-worktree config user.name
git -C /absolute/path/to/target-worktree rev-parse --show-toplevel
git -C /absolute/path/to/backend worktree list --porcelain
```

随后按任务状态选择切换方式：

- 会话没有活动任务租约：调用 `session_rebind`，把当前绑定路径作为
  `expected_worktree_path`，并把目标路径作为新的 `workspace_path` 和
  `worktree_path`。
- 当前任务需要暂停并切到目标 worktree 的另一个任务：调用 `task_switch`。跨 worktree
  切换时应始终传入 `target_worktree_path`，由 Agent 显式指定并修正目标任务的 worktree
  scope；省略时为兼容旧客户端，继续使用目标任务已有 scope，缺失则留在当前 Session
  worktree。服务会在一个事务中 checkpoint 当前任务、暂停并释放当前租约、更新目标 scope、
  启动目标任务，同时把 Session 的 worktree 身份切到目标路径。任何一步失败时整体回滚。
- 同一个任务需要迁移到另一个 worktree：先 checkpoint 并暂停该任务，释放租约，再调用
  `session_rebind`，执行 `task_conflicts` 后重新 `task_start` 同一任务。

MCP 切换成功后，Shell 命令才应使用目标 worktree 作为 `workdir`。不要再次调用
`session_context` 覆盖旧绑定；它会返回 `SESSION_CONTEXT_CONFLICT`。切换到其他仓库或
其他 Git owner 时必须建立新的 MCP transport。

如果目标 linked worktree 位于 Codex 初始可写目录之外，应在启动时通过 `--add-dir` 授权，
或退出后使用 `codex resume -C /absolute/path/to/target-worktree <SESSION_ID>` 从目标路径
恢复会话。MCP 切换不会扩大 Codex 的文件系统权限。

## 验证步骤

1. 在 Codex 中运行 `/mcp`。
2. 确认 `cli_session_task` 已连接。
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

遇到待人工决定时，必须先在当前 Codex 对话中让用户核对问题与最终决定，再调用
`task_confirm_decision`。不得根据历史会话、沉默或看板审批动作推断决定。

连接失败时重新执行：

```bash
curl --noproxy '*' --fail http://172.16.0.90:47321/health
```

不要把客户端的本地 SQLite、数据导出或服务启动方式当作共享服务器的接入步骤；
这些操作由平台管理员在服务器侧统一负责。

三工具的职责、SessionStart Hook、依赖返修和人工验收门禁见
[Codex 三工具开发流水线](./codex-development-pipeline.md)。
