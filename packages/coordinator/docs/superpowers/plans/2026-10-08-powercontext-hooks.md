# PowerContext hooks 核心协议与宿主适配实施计划（计划 C）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把官方 PowerContext 插件 0.2.0 的 hooks 改造成"核心协议 + Codex/Claude 适配层"，在自维护仓库中构建两个自包含插件，Codex 和 Claude 同时切换；补齐 `claude-macmini` 身份，撤销 `coordinator-lead`，并调整 coordinator 的 lead 启动器。

**Architecture:** 核心包 `powercontext_hooks` 保留官方 hook 逻辑，所有宿主差异集中在 `HostProfile`；hook 进程由统一入口按 `--host` 选择配置。构建脚本把核心包复制进两个插件外壳，两种本地 marketplace 清单放在同一目录。

**Tech Stack:** Python 3.12、pydantic-settings（沿用官方 `uv.lock`）、unittest、uv；Codex 本地 marketplace；Claude Code plugin marketplace。

**Spec:** `docs/superpowers/specs/2026-10-08-multi-agent-runtime-design.md` 第 11 节

## Global Constraints

- 代码仓库：`~/playground/powercontext`，目录 `integration/`（核心与测试）和 `plugins/`（构建产物与 marketplace 清单）。保留 Apache-2.0 版权头和 LICENSE 说明。
- Codex 适配层的外部行为必须与官方 0.2.0 一致：环境变量前缀 `POWERCONTEXT_CODEX_`、凭据 `~/.codex/powercontext/credentials.json`（受 `CODEX_HOME` 影响）、绑定键 integration `codex`、origin `codex`、source id 前缀 `codex-user-prompt:`、user-agent 与诊断文件名不变。
- Claude 适配层：前缀 `POWERCONTEXT_CLAUDE_`、凭据 `~/.claude/powercontext/credentials.json`（受 `CLAUDE_CONFIG_DIR` 影响）、integration 与 origin `claude`、source id 前缀 `claude-user-prompt:`、MCP 配置格式 `{"mcpServers":{"powercontext":{"type":"http","url":…,"headers":{"Authorization":"${POWERCONTEXT_CLAUDE_AUTHORIZATION}"}}}}`。
- hooks 必须 fail open：任何异常都不能阻断宿主会话（PreToolUse 无法解析 Scope 时按官方行为 deny 该工具调用）。
- 不在输出、日志或提交中出现 token；读取凭据文件只取字段名或经脚本写入。
- 对外部状态的修改（服务重启、bootstrap、撤销授权、shell 配置、插件安装、`config.toml`）已获用户批准，执行前先备份。

## Review Focus

- Claude 的 hook 输入里可能没有 Codex 才有的字段（`conversation_id`、`thread_id`）；核心按官方逻辑优先取 `session_id`，测试覆盖只有 `session_id` 的输入。
- 插件被宿主复制到缓存目录后，核心包必须仍能导入；构建测试检查插件目录自包含（不引用仓库路径）。
- `${POWERCONTEXT_CLAUDE_AUTHORIZATION}` 未设置时，Claude 的 MCP 和 hooks 都必须安静失败，不能把 `${...}` 原样当成 token 发送。
- Codex 切换后 hooks 需要重新信任；切换前记录旧的 `hooks.state` 键，确认插件名和市场名不变。
- 撤销 `coordinator-lead` 后，`principals.json`、Access 授权、Runbook、coordinator 配置示例中都不能再引用它。

---

### Task C1: 导入官方 0.2.0 作为基线

- [ ] 复制 `~/.codex/plugins/cache/powercontext/powercontext/0.2.0` 中的 `hooks/`、`scripts/`、`settings.py`、`powercontext_client_config.py`、`pyproject.toml`、`uv.lock`、`skills/`、`README.md` 到 `integration/baseline-0.2.0/`（排除 `.venv`、`__pycache__`），记录来源路径与 sha256 清单到 `integration/baseline-0.2.0/SOURCE.md`。
- [ ] 提交：`chore: import official PowerContext plugin 0.2.0 baseline`。

### Task C2: HostProfile 与通用 settings

**Files:** `integration/powercontext_hooks/{__init__,host,settings,powercontext_client_config}.py`，`integration/tests/test_host_settings.py`

**Interfaces:**
- `HostProfile`（frozen dataclass）：`name`、`env_prefix`、`home_env`、`home_default`、`integration`、`origin`、`source_prefix`、`user_agent_recall`、`user_agent_token_savings`、`component_prefix`、`diagnostics_file`、`mcp_format`（`'codex'|'claude'`）、`authorization_env`。
- `CODEX`、`CLAUDE`、`profile_for(name) -> HostProfile`、`active_profile() -> HostProfile`、`activate(profile)`。
- `settings_class(profile) -> type[PluginSettings]`；`load_settings(profile, plugin_root: Path) -> PluginSettings`。

- [ ] 写失败测试：两个 profile 的常量；Claude 从 `POWERCONTEXT_CLAUDE_AUTHORIZATION` 读授权、从 Claude 格式 `.mcp.json` 读 URL；Codex 格式 `.mcp.json` 被 Claude profile 拒绝，反之亦然；Claude `headers` 中的值必须是 `${POWERCONTEXT_CLAUDE_AUTHORIZATION}`；凭据文件路径随 `CLAUDE_CONFIG_DIR`/`CODEX_HOME` 变化。
- [ ] 实现：settings 逻辑从基线复制，把 `_AUTHORIZATION_ENVIRONMENT`、`env_prefix`、`host`、凭据目录、错误文案中的宿主名改为取自 profile；MCP 配置解析按 `mcp_format` 分支。
- [ ] 测试通过后提交。

### Task C3: 核心 hook 模块参数化

**Files:** `integration/powercontext_hooks/{scope_binding,prepared_context,diagnostics,session_binding,bind_tools,recall,token_savings}.py`，`integration/tests/test_host_constants.py`

- [ ] 写失败测试：`session_binding_key`/`binding_keys` 的 integration 随 profile；recall 构造的 source 载荷 `origin` 与 id 前缀随 profile；请求头 user-agent 随 profile；诊断文件名随 profile；Codex profile 下全部等于基线值。
- [ ] 实现：从基线复制模块，改为包内相对导入，替换写死的 `codex` 常量为 `active_profile()` 字段；`CodexPluginSettings` 改为 `load_settings(active_profile(), PLUGIN_ROOT)`。
- [ ] 测试通过后提交。

### Task C4: 统一入口

**Files:** `integration/powercontext_hooks/__main__.py`，`integration/tests/test_entry.py`

- [ ] 写失败测试（子进程，配合 `http.server` 打桩的 PowerContext）：`--host claude session-start` 只带 `session_id`/`cwd` 时调用 `PUT /v1/scope-bindings` 绑定 `claude` 键；`--host claude bind-tools` 对 `mcp__powercontext__search_memory` 输出 allow 并补上 `scope_id`；服务不可达时 `recall` 不输出且退出码 0；未设置授权时不发送请求；未知 host 或事件退出码非 0 且不读 stdin 之外的内容。
- [ ] 实现：解析 `--host` 与事件名，`activate(profile_for(host))`，分发到对应模块 `main()`。
- [ ] 测试通过后提交。

### Task C5: 插件外壳、构建与 marketplace

**Files:** `integration/build_plugins.py`，`plugins/.agents/plugins/marketplace.json`，`plugins/.claude-plugin/marketplace.json`，`plugins/{codex,claude}/powercontext/…`，`integration/tests/test_build.py`

- [ ] 写失败测试：构建后两个插件目录都包含核心包副本（与源码逐文件相同）、`pyproject.toml`、`uv.lock`、`skills/`；Codex 外壳 `.codex-plugin/plugin.json` 与基线字段一致，`hooks/hooks.json` 四个事件命令为 `uv run --frozen --quiet --project "${PLUGIN_ROOT}" python -m powercontext_hooks --host codex <event>`；Claude 外壳 `.claude-plugin/plugin.json`、`hooks/hooks.json` 使用 `${CLAUDE_PLUGIN_ROOT}` 与 `--host claude`，`.mcp.json` 为 Claude 格式；两个 marketplace 清单名都为 `powercontext`；插件目录中不出现仓库绝对路径。
- [ ] 实现构建脚本（幂等，先清空再生成），运行并提交生成物。

### Task C6: 身份与环境（外部状态）

- [ ] 备份；`principals.json` 新增 `claude-macmini`（service、`collaborative_writer: true`、四个 `bootstrap_roles`、`bootstrap_admin: true`）；删除 `coordinator-lead-v1` 凭据；`.env` 增加 `POWERCONTEXT_CLAUDE_AUTHORIZATION='Bearer <claude-macmini token>'`（脚本写入）；`--check`。
- [ ] 用 dashboard-admin 通过 Access API 撤销 `coordinator-lead` 在 scp_2759 上的 3 条授权（先 `bindings/list` 取 `binding_id` 与 `version`）。
- [ ] 重启服务，运行 `--bootstrap-access`，`verify_access.py` 全部 ok；核对 `claude-macmini` 在 4 个 Scope 上有四个角色，`coordinator-*` 授权不变。
- [ ] 新增 `~/.config/powercontext/claude-env.zsh`、`claude-env.fish`（与 codex 版同构，读取 `POWERCONTEXT_CLAUDE_AUTHORIZATION`），在 `.zshrc`、fish 配置中 source；干净环境实测可读到。
- [ ] Runbook 增加 `claude-macmini`，删除 `coordinator-lead` 相关描述。

### Task C7: 安装与切换

- [ ] Claude：`claude plugin marketplace add ~/playground/powercontext/plugins`，`claude plugin install powercontext@powercontext`；`claude plugin list` 与 `claude mcp get powercontext` 核对。
- [ ] Codex：备份 `config.toml`；`[marketplaces.powercontext]` 改为 `source_type = "local"`、`source = "~/playground/powercontext/plugins"`（以实际要求的绝对路径为准）；记录旧 `hooks.state` 键；提示用户在新 Codex 会话中重新信任 hooks。
- [ ] 零模型验证：用两个 host 的入口，在本仓库目录下以真实服务运行 `session-start`、`bind-tools`、`recall`，核对 Access 审计中的 `principal_id` 分别为 `claude-macmini`、`codex-macmini`；本仓库 Claude workspace 键绑定到 scp_2759。
- [ ] 请用户各开一个新会话（Claude、Codex）确认召回与绑定生效。

### Task C8: coordinator 侧调整（本仓库）

**Files:** `src/lead-launch.ts`、`tests/lead-launch.test.ts`、`skills/codex-session-coordinator/*`、`README.md`、`config/app-server.example.json`

- [ ] 改测试：Claude lead 不再生成 powercontext MCP 配置，仍生成 Handoff deny 设置；Codex lead 不再注入 `powercontext_lead`。
- [ ] 实现并提交；配置示例中 lead 的 principal 改为宿主身份（`claude-macmini`，授权变量 `POWERCONTEXT_CLAUDE_AUTHORIZATION`）。
- [ ] 继续计划 B 的 Task 19（Skill/README），并把本计划的结论写入。
