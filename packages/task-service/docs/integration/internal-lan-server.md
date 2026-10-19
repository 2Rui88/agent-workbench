# 内部局域网共享服务接入

本文档是团队接入 `cli-session-task-mcp` 的公共说明。当前实例只在内部局域网提供服务，
不对公网开放，也不要求客户端在本机启动服务或维护 SQLite。

## 服务地址

| 用途 | 地址 |
| --- | --- |
| MCP | `http://172.16.0.90:47321/mcp` |
| Web 看板 | `http://172.16.0.90:47321/board` |
| 健康检查 | `http://172.16.0.90:47321/health` |

接入前先确认设备已连接内部局域网：

```bash
curl --noproxy '*' --fail http://172.16.0.90:47321/health
```

预期返回 `{"ok":true}`。当前使用内网 HTTP，不部署证书；禁止把该服务直接暴露到公网。

## Agent 初始化

每个新的 MCP transport 或 Agent 会话都要在实际项目 worktree 中调用一次
`session_context`。先读取当前 worktree 的 Git 身份：

```bash
git config user.name
git config user.email
git rev-parse --show-toplevel
```

将 `git config user.name` 的原始值作为 `owner` 传给 `session_context`，不得使用对话昵称、
历史会话身份或服务器默认值代替。示例：

```json
{
  "workspace_path": "/absolute/path/to/repo",
  "repository_id": "my-repo",
  "worktree_path": "/absolute/path/to/repo",
  "owner": "git config user.name 的原始值"
}
```

同一 MCP transport 内只需绑定一次；新建或重连为新的 Agent 会话后需要重新绑定。
后续 `task_create`、`task_adopt` 会继承该 owner。

## 同一会话切换 worktree

同一个 MCP transport 进入同一仓库的另一个 worktree 时，不要再次用 `session_context`
覆盖绑定。先在目标 worktree 读取 Git 身份和路径：

```bash
git config user.name
git rev-parse --show-toplevel
```

- 当前会话没有任务租约：调用 `session_rebind`，传入当前 `session_id`、新的
  `operation_id`、当前绑定的 `expected_worktree_path`、目标 `workspace_path` 和
  `worktree_path`。
- 当前会话正在执行任务：使用 `task_switch`。跨 worktree 切换时应始终传入
  `target_worktree_path` 显式指定目标路径并纠正可能过期的 scope。服务会在同一事务中
  checkpoint 当前任务、
  替换目标任务的 worktree scope、移动租约并更新 session 的 worktree 身份，失败时整体回滚。
- `owner` 必须与首次绑定时完全一致；`session_rebind` 只允许在同一已登记仓库内切换。
- 切换到其他仓库或其他 owner 时必须新建 MCP transport，并重新执行 `session_context`。

`session_rebind` 会拒绝活跃租约、过期的 `expected_worktree_path` 和已经被其他任务占用的
目标 worktree；重复提交相同 `operation_id` 只会返回第一次结果。

## 仓库登记

- 已登记仓库：直接调用 `session_context`。
- 未登记仓库：Agent 从当前项目目录读取准确的 Git owner、`repository_id`、项目名和路径，
  直接调用 `repository_bootstrap`；服务端会在同一事务中创建/匹配项目、登记仓库并绑定
  当前 transport 的 Session，不再要求预先存在 Session，也不需要浏览器 token。
- Agent 初始化、任务执行和下游验证均可自动完成；只有任务进入 `pending_acceptance` 后才
  需要人工验收。
- 已存在 Session 的场景继续使用 `repository_register` 登记其他仓库；仓库移动后使用
  `repository_rebind` 更新路径。客户端不要运行本机 `repo:register` 代替远程登记，因为
  局域网服务器无法直接访问客户端的本地路径或数据库。

路径是客户端 worktree 的声明式路径。服务端不应尝试把它解释为服务器本地路径。

## 下游 Agent 验证闭环

初始化和验证均由 Agent 自动完成，不需要 bootstrap token；Board 对验证请求、运行状态和
证据只读展示，不提供人工验证响应按钮。Agent 完成 `session_context` 后，在下游仓库按顺序
调用：

```text
session_context → dependency_validation_list → dependency_validation_receive
→ dependency_validation_checkpoint / heartbeat → dependency_validation_complete
```

每个请求只能有一个 active run。run 状态包括 `queued`、`claimed`、`running`、`passed`、
`rejected`、`error` 和 `cancelled`。`receive` 取得滚动 lease，`checkpoint` 保存进度与心跳，
`complete` 回传验证结果与证据；`rejected` 必须有失败证据，`error` 或超时保持请求
`pending` 供下一 attempt 重试，旧 attempt 不删除。Agent 通过后上游仍需进入
`pending_acceptance`，最终验收或驳回只能由人工在看板执行，Agent 不得直接标记 `done`。

## Web 看板配对

1. 在浏览器打开 `http://172.16.0.90:47321/board`。
2. 未配对设备只显示安装与初始化引导，不会展示项目、任务或验收操作。
3. 点击“生成一次性配对码”，再点击“复制 Agent 指令”。
4. 把完整指令交给已经完成 `session_context` 的同一个 Agent。
5. Agent 按指令调用 `board_pair`；浏览器会自动进入当前 owner 的看板。

配对属于浏览器设备会话，不属于每个 Agent 会话。一个浏览器设备配对成功后，不需要让
每个 Agent 会话重复配对；主动退出、会话失效或换浏览器后需要重新配对。每个新的 Agent
会话仍须独立执行一次 `session_context`。

一次性配对码不得写入仓库、任务 checkpoint、日志或聊天之外的长期存储。

## 看板视角与权限

- 个人仪表盘默认显示当前配对 owner 的项目、仓库和任务；已绑定 Session 的零任务项目也会显示。
- 全局总览向已配对用户展示所有 owner；点击人员标签或使用 `?owner=<查看对象>` 可进入其只读视角。
- URL 中的 owner 仅改变读取目标，不改变浏览器配对身份。其他 owner 的任务和明细可查看，
  但修改、验收、驳回、取消和会话释放仍由服务端限定为任务真实 owner。
- 依赖通知只对当前配对 owner 可见和操作，不随 URL owner 切换。
- 匿名或未配对设备只能看到安装和配对引导，不能读取个人或全局数据。

## 远端 worktree 主机取证

服务端无法直接探测开发机上的 worktree（`REMOTE_WORKTREE_EVIDENCE_REQUIRED`）时，
需要用主机签名证据补齐 checkpoint / submit 门禁。一次性引导（每台开发机）：

```bash
# 在开发机上的任意 cli-session-task-mcp 检出中执行
npm run host-key -- generate
npm run host-key -- register --server http://172.16.0.90:47321 \
  --owner "$(git config user.name)" --label "$(hostname)"
```

之后在远端 worktree 中的工作节拍（在 `task_start` / `task_checkpoint` / `task_submit`
之前、证据窗口内执行）：

```bash
npm run evidence -- collect --server http://172.16.0.90:47321 \
  --session <session_id> --operation checkpoint   # start/checkpoint 用
npm run evidence -- collect --server http://172.16.0.90:47321 \
  --session <session_id> --operation submit --task <task_id>  # submit 用
```

`evidence collect` 在本地完成指纹（HEAD + tracked diff + untracked 摘要）、签名与服务端
验证，证据默认 15 分钟内可被 checkpoint/submit 消费（`TASK_MCP_HOST_EVIDENCE_WINDOW_MS`
可调）。主机密钥撤销（最小实现）：

```sql
UPDATE host_keys SET status = 'revoked', revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE host_key_id = '<id>';
```

轮换：把旧私钥移为 `~/.cli-session-task/host-key.previous.pem` 后重新
`generate` + `register`，会自动附带轮换签名。

## Session 假死与恢复（resume）

MCP transport 会话是服务进程内存态：服务重启后全部失效，客户端若继续携带旧
`mcp-session-id` 头调用，会持续收到 404 `SESSION_NOT_FOUND`，工具侧重试无效。平台会话、
任务租约与 checkpoint 历史**不受重启影响**，处于"假死"——记录都在，只是没有 transport
能触达。

每次 `session_context` 绑定都会返回一次性 `resume_token`（服务端仅存哈希；每次绑定或
resume 都会轮换）。恢复优先级：

1. **resume（推荐）**：客户端重连（新会话/新 initialize）后，用**原绑定时的仓库、
   workspace、worktree、owner** 调用 `session_context(resume_session_id=<原会话>,
   resume_token=<签发令牌>)`。校验通过后会话以**同一 session_id** 挂到新 transport：
   租约不动、checkpoint 连续、`stale_at` 清除，并记录 `session_rebound`（via
   `session_resume`）事件。旧 transport 仍存活、令牌不匹配、successor 已设或上下文
   不一致时 fail-closed 拒绝。
2. **显式 successor**：原会话已不可恢复但需要交接时，新会话
   `session_context(successor_session_id=<原会话>)`，租约按既有语义转移到新会话并
   bump generation。
3. **租约到期后重新认领**：没有 token 且无法显式 successor 时，等待租约到期（默认
   30 分钟）。新 transport 用实际仓库、owner 和原 worktree 绑定会话，读取最新任务版本，
   检查冲突后调用 `task_start`；服务端在同一事务中回收过期租约、接管仍为
   `in_progress` 的任务并记录 `task_lease_recovered`，随后可以 checkpoint。租约行已被
   惰性清除但任务仍为 `in_progress` 时同样适用。远端 worktree 仍须先提交新鲜的主机
   签名证据。有效租约、不同 owner 或 worktree、版本冲突均不能自动接管；确需提前
   接管或切换 worktree 时由任务 owner 在 Board 释放 Session。

Agent 侧约定：收到 `SESSION_NOT_FOUND` 应视为"transport 已死"信号——先重连，再按上述
优先级恢复，最后 checkpoint 补录。令牌请与会话 id 一起在本地保存；它不会出现在任何
日志或错误回显中，丢失后只能走 2/3。

## 当前工具清单

连接成功后应看到 32 项工具：

- `session_context`
- `session_rebind`
- `board_pair`
- `repository_bootstrap`
- `repository_register`
- `repository_rebind`
- `project_share_create`
- `project_share_accept`
- `project_members_list`
- `project_member_remove`
- `project_share_revoke`
- `task_list`
- `dependency_context_get`
- `dependency_validation_list`
- `dependency_validation_receive`
- `dependency_validation_checkpoint`
- `dependency_validation_complete`
- `operation_result_get`
- `task_get`
- `task_recovery_get`
- `dependency_repair_list`
- `dependency_repair_receive`
- `task_conflicts`
- `task_attach`
- `task_create`
- `task_adopt`
- `task_confirm_decision`
- `task_start`
- `task_checkpoint`
- `task_switch`
- `task_dependencies_update`
- `task_submit`

远端 worktree 场景另有 3 项主机取证工具（`host_key_register`、
`worktree_evidence_challenge`、`worktree_evidence_commit`），通常由
`npm run evidence -- collect` 代为调用，无需手动分步。

`task_confirm_decision` 只能记录用户在当前 Agent 对话中明确确认的问题和最终决定；不得
推断同意、复用旧对话或从看板动作代填。Agent 只能把已验证任务提交为
`pending_acceptance`，最终接受或驳回由人工在看板完成。

## 客户端专属配置

- [Codex 接入说明](./codex.md)
- [Claude Code 接入说明](./claude-code.md)

服务端部署、备份和回滚由平台管理员负责，参见 [Linux 部署指南](../../deploy/README.md)。
