# 本地 Mock／协议阶段验收

项目：`/Users/macmini/playground/codex-session-coordinator`。本阶段实现独立的 workflow runtime：SQLite 状态、Unix socket daemon、角色 MCP、CLI 和候选 Skill。Skill 保留在项目内，未安装到全局。

## 验证证据

2026-10-04 本地执行：

| 命令或证据 | 结果 | 能证明的范围 |
| --- | --- | --- |
| `npm run typecheck` | 通过 | TypeScript 类型检查 |
| `npm run build` | 通过 | 生成可执行 CLI/MCP/daemon |
| `npm test` | 103/103，通过 | 隔离 Mock、真实本地进程、MCP stdio、Unix IPC 和恢复协议 |
| `npm run protocol-preflight` | initialize/model/list 成功，8 个模型 | 当前本机 Codex App Server 协议及模型目录；没有 startThread/startTurn |
| 候选 Skill quick_validate.py | 通过 | 静态格式，不是模型压力测试 |
| 独立整分支审查及并发复现 | 已修复审查发现；无剩余 Mock 阶段阻塞 | 本地源码与隔离行为，未证明真实业务效果 |

完整四角色 MCP 场景覆盖：契约 v1、前后端并行、相互协助、浏览器排队、审计 rejected、模型升级、修复、契约／基线 v2、audit passed、幂等提交 pending_acceptance。此场景由确定性测试脚本驱动 lead 决策；另有自动 lead 唤醒测试证明入口和显式 model/effort，未把 Mock 描述为真实模型自主决策。

## 关键边界

- CLI Task 的权威对象是实际 repository + 独立 worktree。分别建立 transport，用工作树原始 Git 身份绑定；同一 repository 的不同 worktree 不复用同一个 transport。恢复不会抢占其他 session 的有效租约。
- PowerContext 使用项目 Scope，四角色分别使用 service Principal、凭据环境引用和真实 role-session host binding。预检拒绝单 Principal 模式、错误身份、Default Scope 和权限不匹配。没有开通实际 Scope／Principal 或写入正式交接；正式交接适配属于 F14/P1。
- lead、frontend、backend、audit 可显式启动 turn；角色内串行，角色间并发。lead 的 `automation_lead_configure` 保存唤醒模板，worker 消息每条只形成一个持久唤醒请求。
- 默认执行为 gpt-6-luna/high，lead／audit 分析为 gpt-6.1-sol/high；复杂度和失败证据达到阈值使用 gpt-6.1-sol/xhigh，下一任务重新选择默认。组合必须由 model/list 支持；这里记录的是请求型号和思考强度。
- 完成回执持久且支持相同内容重试。收到业务回执后仍等待对应 turn completed，才释放执行槽。超时、启动响应丢失、租约失效和进程崩溃进入 needs_reconciliation，不自动重放。
- 调用预算当前为明确标记的 Mock 次数／并发预算；用量累计快照有独立去重测试。真实推理开关始终关闭，未把 Mock 次数换算成真实 token 或金额，也未验证真实用量事件的生产闭环。
- `allowedPaths` 会 canonicalize 并拒绝越出绑定 worktree。细分目录／文件边界是协作约束；不宣称 App Server 对每个文件实施内核级白名单。audit 的运行时 sandbox 为 read-only。
- Task 的未知操作保留冻结记录。先使用 `automation_task_operation_result` 查询权威结果，再审查原操作和任务状态；该查询不会自动清除本地未知记录或再次执行写入。
- 验收命令只可提交 `pending_acceptance`。没有自动接受／done 工具；最终验收由用户完成。

## 启动与观察

以下命令是操作者入口，本次没有替用户启动常驻服务或配置全局 Skill：

```sh
cd /Users/macmini/playground/codex-session-coordinator
npm run build
COORDINATOR_ROLE=lead npm run group-init -- config/example.json
npm run human-control -- config/example.json init
npm run daemon -- config/example.json
```

human credential 的创建和控制决定要求用户自己的交互 TTY，与角色 capability 分离。若已有凭据，复用原文件；不覆盖已有组。

另一个终端查看命令 schema、执行 dry-run 或打开四个只读 pane：

```sh
node dist/scripts/client.js config/example.json lead schema
node dist/scripts/client.js config/example.json backend automation_message_claim '{}' --dry-run
COORDINATOR_DB_PATH="$PWD/.state/state.sqlite" scripts/open-kitty-panes.sh local-development
```

CLI 使用受控角色环境 capability 时，不读取包含其他角色的组凭据文件。实际角色 App Server 只启用自身 coordinator_role 和 powercontext_role MCP，停用继承的插件、apps 和其他 MCP 身份。观察端只读，未对现有 Kitty／Herdr 会话发送按键。

守护进程用自身终端 Ctrl-C 正常停止；只关闭自己的运行时连接和 socket。意外退出后用同一配置重启：核对记录的死进程和 socket inode/dev 后接管，将在途任务冻结；先初始化原角色线程，再用 `automation_reconcile` 核对运行时和业务证据。已确认或新增的 turn 不能凭“未开始”声明重新入队。

## 仓库任务接入

App Server 模板是 `config/app-server.example.json`，其中 Scope 是占位引用。先由操作者准备 Scope、独立 Principal、授权环境变量以及实际仓库注册，再执行 `npm run project-preflight -- /path/to/runtime.json`。

lead 统一使用：

- `automation_task_recover`：绑定原始 Git owner、实际 repo/worktree、当前任务版本，执行冲突检查和恢复。
- `automation_task_checkpoint`：新鲜版本、稳定 operationId、具体 checkpoint。
- `automation_task_operation_result`：只读查询未知操作权威回执。
- `automation_submit_for_acceptance`：当前契约／基线、最新 passed audit 和已完成 dispatch，最终仅 pending_acceptance。

远端 Task 无法读取本机 worktree 时，可配置 `taskHostEvidence.cliRepositoryPath/serverUrl`。协调器用已安装 CLI Task collector 和已登记 host key 收集签名证据；调用失败即关闭门禁，不伪造 fingerprint。源码中接线经过隔离测试，本次没有接管其他业务仓库。

## 浏览器按需接入

运行配置可选加入以下段；具体 URL 必须改为获准项目的真实服务端点：

```json
{
  "browser": {
    "cdpEndpoint": "http://127.0.0.1:9222",
    "allowedOrigins": ["http://127.0.0.1:3000"],
    "healthUrls": ["http://127.0.0.1:3000/health"],
    "harness": {
      "entrypointPath": "/Users/macmini/playground/.agent-browser-runtime/browser-harness-edge.mjs",
      "homePath": "/Users/macmini/playground/.agent-browser-runtime/.browser-harness"
    }
  }
}
```

浏览器没有配置时不连接或启动浏览器。配置后仍先检查 Task、服务健康、Edge 身份和 CDP。`automation_browser_request` 选择 playwright 或 browser_harness；PW 支持 visible/hidden/text selector 断言，BH 入口只运行固定的 task-owned target 检查，要求既有受控 daemon，不接收任意 Python。完整交互调试仍需受控 BH 工具流程。

整段流程包含自有页面创建、导航、断言／检查、资源清理和客户端断开，均持有同一浏览器租约。保存 target/context 引用；真实 Edge 对账会检查记录的 target 是否仍存在。在途 execute 即使到期也不得通过重试或 lead 声明释放。只清理自有页面和隔离 context；不关闭 Edge、用户 context 或前台页。

本次浏览器测试使用隔离 Mock driver 和受控 Harness 子进程 stub；没有启动 Edge、接管登录状态或执行业务 E2E。

## 后续真实阶段

本地源代码保持未提交、未推送。开放真实模型前需要明确批准记录和预算执行门禁；当前源码不提供可绕过批准的配置开关。随后依次验证实际四角色 Principal／Scope、真实用户审批、受预算控制的模型 turn、选定业务仓库与测试数据，以及共享 Edge 的业务链路。上述真实阶段不能由本地 Mock 验收替代。
# 2026-10-04 Herdr 动态接入

本轮最终检查：`npm test` 124/124；`npm run typecheck`、`npm run build`、`sh -n scripts/herdr-resume.sh` 均通过。隔离测试实例已停止，用户默认 Herdr 0.9.1 服务仍运行。没有提交或推送。

用户已授权接入。入口 `npm run herdr:resume -- <runtime.json> <session UUID>` 必须在实际 Herdr 主窗格执行，读取 Herdr 注入的 socket/workspace/tab/pane。缺失上下文、外来窗格、映射不一致、未知命令结果或观察进程变化立即停止，保留主会话与用户进程。

隔离 named session `coordinator-herdr-probe-20261004` 已真实验证 SQLite 调度状态 → Socket 分屏 → observer 输出：设计 1 窗格，前后端 dispatch 后 3 窗格，audit dispatch 后 4 窗格。布局几何最终 2×2；主 pane `w3:p1` 的 shell PID 不变，焦点仍为主 pane。证据在忽略目录 `.state/herdr-probe/e2e-evidence.json`。不调用真实 Provider。

恢复入口在实际 Herdr pane 用假的 `codex` 可执行文件验证，只验证 UUID/cwd 参数和监督，不冒充真实 Codex resume 成功。控制器因外来窗格停止后，主终端显示故障，假的主进程正常继续结束；没有自动重试模型。

在 Kitty shell 先运行 `herdr --session codex-coordinator`，然后在其空白主窗格内：

```sh
cd /Users/macmini/playground/codex-session-coordinator
npm run herdr:resume -- .state/dashboard-e2e-20261004/runtime.json 01a100c4-7563-7b81-b9b2-d9b371e6c37b
```

先退出旧的交互入口，避免同时恢复同一个 Codex thread。该入口恢复指定会话，不创建重复 lead、不自动续真实模型授权，也不自行更新 Task 租约。新主会话继续实现前须按 task-recovery 恢复原 Task 和 PowerContext 项目 Scope。原真实 App Server audit 尚在启动前 reconciliation 阻塞；Herdr 接入通过不代表此问题或 Dashboard 业务 E2E 已完成。

完成结果默认保留；主会话退出、控制器停止后可在同一 Herdr 主窗格运行 `npm run herdr:follow -- <runtime.json> --compact`，仅关闭已完成且仍由本项目 observer 占用的窗格。unknown、人工请求或活跃 dispatch 不收起。

## Herdr 主会话恢复与 Dashboard 页面验证（2026-10-04）

实际 `codex-coordinator` Herdr 会话中，主窗格 `w1:p1` 恢复原 Codex UUID；控制器和审计 observer `w1:p2` 保留，焦点保持主窗格。目前只有一个审计派发，因此显示两个窗格。此前隔离 Mock 验证的 1→3→4 不代表本次真实前后端已派发。

当前 Codex 协议的 `thread/read(includeTurns=true)` 不可用。运行时改为 metadata read 加 `thread/turns/list` 完整分页；仅本客户端新建、未发起任何 turn 的 idle thread 可把明确的未 materialize 错误视为无历史。未知结果、恢复线程读取失败、重复 cursor 均继续关闭执行门禁。真实 fresh 与既有 audit thread 的只读协议验证成功，没有发起 Provider turn。

验证结果：`npm test` 127/127；`npm run typecheck`、`npm run build` 通过。Premium strict 静态审计零 findings。恢复 Dashboard 后，经独占 BrowserQueue 租约，Playwright Core 连接已有 Edge CDP，在任务自有隔离 context 验证真实 HTTP 快照、四角色与原排队任务、自动刷新、注入 503 后保留旧快照和重试恢复、键盘 skip link、390px 窄屏与 reduced motion。截图发现窄屏列挤压，已增加表格最小宽度，并重新验证；表格局部横向滚动，文档无横向溢出。清理自有资源后 Edge CDP 仍可用，页面无 JS error。

证据：`.state/herdr/dashboard-e2e-evidence.json`、`dashboard-desktop.png`、`dashboard-narrow.png`、`full-tests.log`、`ui-audit.json`。页面地址：`http://127.0.0.1:63718/`。

剩余：真实执行 grant 与旧外部 Task 观察绑定均已到期；原审计 package 的 Task version 也已过时，需要保留原记录并通过受控恢复流程处理。真实模型审计、业务返修链路以及独立 worker 写入任务/worktree 尚未证明，项目未提交最终验收。

## 单次真实审计与审批适配修复（2026-10-04）

用户确认撤销影响清单后，新增主会话专属 `automation_cancel_queued`。调度记录和消息在同一 SQLite transaction 撤销，保留原 payload/hash，记录证据；非 queued、已有 turn/start、处理租约或非 cancelled 预算预留均拒绝。已撤销派发不作为完成依赖或可提交验收的 dispatch。原 audit-v1 已安全撤销；v2 使用 Task version 10 和契约 v2 基线，主会话受控引导完成契约 ack（不声称是模型自主 ack）。

用户授权的唯一真实审计已发起：请求 `gpt-6.1-sol/high`，dispatch `b70ec33d-9875-49da-80f1-ac59ad46d90a`，turn `01a10658-79ef-76e0-beec-5bb1c88eacb6`。预算记 1 次调用；工具审批中断了执行，未产生 validation 或业务 receipt。Herdr `w1:p2` 显示对应真实 AppServer lifecycle；主窗格焦点保持。跨客户端 thread history 的 interrupted 不能单独判定实时等待状态；本次在 5 分钟 watchdog 发出中断后，再读取持久 turn 为 interrupted，调度保留 needs_reconciliation，预算保留 unknown，禁止重试。

现场发现审批适配器仅支持 command/file，未支持 `mcpServer/elicitation/request`。已按当前 Codex 本地生成 JSON Schema 补齐：空 MCP tool approval form 的 accept -> `{action:'accept',content:{}}`，decline/cancel -> action；有字段表单和 URL accept 要求 native input。响应前和发出响应时再次核验当前活跃派发/turn，旧实例、超时或终止的请求拒绝。人工凭据、交互审批以及最终验收继续由用户持有。

最终本地验证：132/132 tests、typecheck/build 通过。受控协调器已重启加载修复，realTurnsEnabled=false，audit thread 无 turn 启动地恢复；Edge 与 Dashboard 健康。真实调用未得到最终审计结论，项目仍未最终验收。下一次调用需新的额度授权及对旧中断派发的失败状态恢复；当前不自动重跑。证据 `.state/herdr/audit-terminal-history.json`、`real-audit-observation.json`、`live-audit-pane.json`。

## 2026-10-04 Failure recovery and scoped worker tools

User confirmed the impact plan and main-session inline implementation. This phase used no new Provider turns, delegated reviewers, commits, pushes or global configuration changes.

- `npm test`: **141/141 passed**; `npm run typecheck` and `npm run build` passed. Coverage includes atomic SQLite rollback, immutable originals, spent quota, unavailable/mismatched/live/successful runtime fences, lead/current Task binding checks, unique replacement lineage, lost dispatch response/outbox recovery, rejected audit and bounded explicit repair, current passed audit and `pending_acceptance` only.
- Worker launch restricts coordinator and project PowerContext read tools; server default remains `prompt`, allowlisted tools use explicit `approve`. Plugins/apps and inherited servers remain disabled; user approval and sandbox policy remain. Worker catalog fixture confirms control tools are absent. Audit result recording is correctly non-idempotent. Scope administration and `resolve_scope_binding` are excluded; no Principal grants were expanded.
- `npm run protocol-preflight`: Codex AppServer accepted the selected effective config fields with **modelTurns=0/configWrites=0**. Disabled probe config and MCP catalog checks do not establish actual model auto-approval or successful audit execution.
- Original real dispatch `b70ec33d-9875-49da-80f1-ac59ad46d90a` was archived **failed / interrupted** only after current Task gate and original runtime thread/turn history verification. Legacy thread provenance came from its unique runtime-origin approval reference; new executions persist their original thread ID. Original package/hash/turn remain unchanged. Budget is **callsUsed=1/inFlight=0/unknown=0**; one obsolete approval is **stale**, not waiting for acceptance. No business/audit receipt exists. Group remains paused and the consumed model grant remains expired.
- Project-owned daemon, Dashboard and Herdr observers were refreshed. Main Codex PID **16435**, lead pane **w1:p1**, focus, two-pane layout and existing pane sizes remain. Failed result and stale approval metadata are visible. Herdr uses a supported `idle` state-label key with an explicit failed title/token; no layout replacement or pane removal.
- Existing Edge CDP identity and three service health endpoints passed. An owned isolated Playwright context under the exclusive BrowserQueue lease confirmed failed/cancelled records, stale approval count, actual HTTP polling, injected 503 snapshot retention/retry, keyboard skip link, reduced motion and 390px overflow checks. No page errors; owned resources cleaned and Edge remained alive. Initial test-only selector error was corrected before the passing rerun.
- Premium static UI audit: **0 violations/warnings**. Screenshots and evidence are under ignored `.state/herdr/`; implementation ledger and test outputs are under ignored `.superpowers/sdd/2026-10-04-failure-recovery-tool-authorization/`.

Remaining validation: real scoped tool invocation/auto-approval, successful real audit/repair, and independently bound worker write Tasks/worktrees. Final project acceptance remains human-only. A new real execution requires a new explicit bounded grant; failure archival does not extend or refund quota.

## 2026-10-04 Runtime model evidence and independent worker preparation

The lead implemented per-turn model verification from the original Codex rollout. Thread defaults and requested choices are not used as actual model evidence. The reader checks original session and turn identity, root containment, file ownership, bounded file metadata, malformed records and conflicting contexts. Immutable whitelisted model/effort/source metadata is persisted in SQLite and projected to Dashboard and Herdr. This confirms Codex runtime turn configuration, not an independently observed upstream physical model version.

The existing failed real audit is now runtime-confirmed `gpt-6.1-sol/high`; its failure, consumed call and stale approval remain unchanged. A no-turn dispatch displays `未执行`; an executed turn without model evidence displays `未确认`.

Verification: root **147/147** tests, typecheck and build passed. Two independently staged worker snapshots each passed **145/145** tests. Actual Edge owned-context E2E verified the model label, no-turn label, retained 503 snapshot/recovery, keyboard skip link, reduced motion and 390px document overflow boundary; no page errors, Edge still alive. Actual Herdr audit-pane read confirmed the runtime model while retaining main PID16435, focus and existing two-pane geometry. Static UI audit reported zero violations/warnings.

Frontend Task `d97179e6-0226-4b01-b650-e87cc43e38a9` and backend Task `f5f0692e-5351-455d-95b7-fec4df33b298` own independent Git worktrees. Snapshot writes occurred after own Task conflict and lease checks, then both Tasks were paused. Worker write gates recheck actual Git owner/worktree, current Task version/lease/conflicts and explicit project Scope/role Principal. All four live role identities and project Scope were verified without Provider turns or permission expansion.

User explicitly authorized **five additional** calls: frontend/backend `gpt-6-luna/medium`, audit `gpt-6.1-sol/high`, at most two concurrent, package input at most12000 characters and five-minute execution deadline; repair counts within five, no automatic upgrade. The previous spent single call is separate history. No additional turn has started at this checkpoint.

Live startup currently stops on `FILE_CONFLICT`: untracked project source copied into both worker worktrees overlaps the lead's active source snapshot. No conflict gate was bypassed. A local source baseline commit (excluding runtime, credentials, DS_Store and unrelated documents) requires explicit user permission under the global Git rule; alternatively execution must remain serial. Final real audit/repair, independent worker business writes and overall human acceptance remain pending.

## 2026-10-04 Authorized local baseline and genuine independent worker turns

User explicitly allowed one local source baseline and synchronization to both worker branches. Commit `a3489bc6f2070b2c8786b0dc0ff525a22dbef651` contains the approved116 source/config/test files; runtime, credentials, DS_Store and other documentation were excluded. Both worker branches fast-forwarded to it; their previous staged snapshots were moved into ignored local backups. No push. Generated dependency symlinks are locally excluded from Git status, without excluding business source.

Actual independent Task/lease/Scope/Principal preflight passed. Two genuine concurrent `gpt-6-luna/medium` turns completed with business receipts and persisted runtime model proof: frontend dispatch `1bd26898-cdc0-4ff2-8e19-46c0c3800063`, backend dispatch `1f2a91ad-3dc1-4beb-8cbc-97bdabfda38d`. Frontend152 tests and backend149 tests/typecheck passed independently. Only the five allowed files were integrated; integrated154 tests/typecheck/build passed. Child Tasks were explicitly succeeded to host finalization sessions, checkpointed and pausedv5; neither accepted nor committed.

Herdr actual mapping now has mainw1:p1 plus auditw1:p2, frontendw1:p4 and backendw1:p5. The main Codex PID16435 and external thread remain. The same Dashboard URL63718 observes the new group `dashboard-real-workers-20261004`; old failed history remains in its original DB/group.

Strong audit dispatch `ac443fa4-ee9c-41f1-be34-ef2f931d4a8c` uses `gpt-6.1-sol/high`, contract `a3c05e18-8c44-4e6e-8797-9e26dbbf4962`, exact five-file integrated digest `a1d2fa4feef20f82eb8e...`. At this checkpoint it is awaiting native one-time approval for focused tests creating their own temporary fixtures; the read-only sandbox returned EPERM. Independent human control remains required. Additional grant3/5 used, with no automatic retry or upgrade.

Current Edge preflight failed: PID83978 occupies9222 but /json/version returns HTTP404 and no CDP JSON. Current browser rerun stopped before creating pages or contexts; the earlier passed Edge UI evidence must not be represented as proof of the newly integrated UI. User exit is requested before reusing the controlled dedicated Profile entrypoint; no Edge process was terminated.

Code graph reindex and representative symbol search succeeded after baseline commit. Central graph metadata points to this worktree, but stored per-file hashes are empty and no repository artifact was emitted, so full commit linkage verification is not claimed. Integrated business changes remain uncommitted for review; final acceptance remains user-only.

## 2026-10-04 Final repaired baseline and human acceptance handoff

This section supersedes the pending validation and Edge-blocked state in the earlier checkpoint sections. The existing development Profile `~/.edge-codex` (created October3) was reused after the user exited Edge; it was not recreated. Playwright connected through CDP and created one task-owned isolated context, so its temporary window carried no persisted login state. Actual integrated Dashboard E2E passed at 13:26 UTC: current HTTP/model receipts, polling, retained503/retry, keyboard access, reduced motion and390px overflow; no page errors. Owned resources were removed, Edge stayed alive at completion. No subsequent browser restart is needed for this handoff.

All five additional authorized model calls are consumed, with no in-flight or unknown quota. Frontend/backend genuine concurrent turns completed; the initial audit expired at native approval and was honestly archived, without replaying the expired approval. The replacement strong audit rejected two reproduced defects: canonical/symlink worker-path aliases and blocking FIFO evidence reads. Lead inline repair added pre-uniqueness canonicalization, fail-closed real runtime paths, regular-file precheck plus nonblocking open, descriptor identity checks and bounded chunk reads without whole-file line arrays. RED regressions then GREEN are retained. Root156 tests, typecheck/build passed.

Final strong audit `fac604db-7105-469a-942a-0eef0c348521` passed contract `3311f990-9819-441e-b733-8c386280b676`, exact seven-file SHA256 `2fcefdf5a4e79492f171ff517f6cc9f08079163278921bd9c9898b6c4b9e4c1d`. Original audit dispatch `09a1fdcc-ab47-43e3-a23b-14185e53f644` completed with business receipt. Audit independently checked source digest, readonly in-memory repair reproductions, typecheck/diff check, and host156-test proof; it did not independently rerun filesystem-writing fixtures or browser E2E. Backend-only final repair did not alter the previously browser-verified frontend.

Host finalized the independent child Tasks under their own valid leases: frontend152 tests and backend150 tests/typecheck/diff check passed; the exact reader repair was copied into the backend worktree while its lease was held. Both Tasks now `pending_acceptance` v9, never accepted by Agent. Coordinator automation is paused; Dashboard and four Herdr observer panes remain available, preserving the current main session. The final integration packet is `.state/dashboard-real-workers-20261004/acceptance-packet.json`; host submits the main Task to `pending_acceptance` after its fresh checkpoint.

Limitations: runtime model metadata proves per-turn Codex configuration, not physical upstream model routing. Central code graph indexing and symbol lookup succeeded but no commit-linked repository artifact exists, so complete graph commit linkage remains unverified. The authorized local baseline is committed; integrated source remains uncommitted, with no push. Final acceptance is exclusively human.


## 2026-10-04 v0.1 closeout

- Dashboard default, README and current owned runtime use port **25426**. `/health`, `/`, JS/CSS and `/api/snapshot` return 200; correct real group and five consumed calls persist. Started replacement before stopping only the checked old Dashboard PID; port4317 Python service preserved. No fresh browser E2E was claimed for this migration.
- Herdr audit title now uses newest non-cancelled dispatch while unresolved results still block. Two regression tests first reproduced historical failure pollution, then passed. Owned controller refreshed without changing four pane identities or focus; live title **audit · idle** confirmed.
- Updated Skill and its operations reference installed globally at `~/.codex/skills/codex-session-coordinator`; source/global file digests identical and validator passed. No global MCP or system configuration changed.
- Full suite **166 passed**, typecheck/build and diff check passed. Isolated compiled-entry Mock smoke evidence: `.state/cm-O0Ycvw/evidence.json`. First init, frontend/backend thread init, assistance claim/complete, pause, graceful stop/restart, identical persisted snapshot/thread, duplicate init refusal and credential preservation passed. A synthetic human-capability fixture was confined to this Mock group; this is not human-TTY approval verification. Zero additional Provider calls.
- Integrated modifications remain uncommitted; final human acceptance and separately authorized Git delivery remain.


## 2026-10-04 Codex authorization and dynamic Kitty closure

- Added only project `dashboard-admin` viewer/reviewer through official Access API, idempotency keys and host Codex identity. Both create responses 201. Dashboard GET target Scope 200; contribute/delegate remain denied. Four service Principals and exact role-session bindings verified live; frontend/backend read+contribute, audit read+review, lead all four scoped actions. No worker admin/delegate or write-tool expansion.
- Kitty 0.48.2 dynamic observer controller, dedicated per-process config/private socket and precise ownership checks implemented. Actual isolated Mock terminal proof **1→3→4**, unchanged lead focus, restart same pane IDs, compact back to lead only. Foreign topology/process regression checks pass. Full **168 tests**, typecheck/build/diff and shell syntax checks passed. Source/global Skill synchronized with backup and matching digests. No new Provider calls.
- Browser retry reused existing `.edge-codex/Default` (Profile/History/Cookies created October3); confirmed actual process argv and owned `edge://version` page. Explicit Default and no-first-run avoid startup onboarding, without deleting data. Initial Playwright default-context override failed (`Browser.setDownloadBehavior` context management unsupported); failure archived, no fallback/browser replacement. Connection with `noDefaults:true` succeeded and now is used by the project Edge adapter to preserve shared defaults.
- **25426 E2E passed**: actual independent frontend/backend and final audit receipts, per-turn model labels, polling timestamp, injected503 stale retention/retry, keyboard skip link, reduced-motion context, 390px no overflow, no page errors. Task-owned context cleaned; Edge CDP remains live. Evidence: `.state/dashboard-real-workers-20261004/dashboard-25426-evidence.json` and viewport PNGs.
- Full original output excluded by explicit user choice; summaries sufficient for this version. ZCode/Claude deferred. No Git commit/push; commit-linked graph verification awaits authorized Git delivery; final Task acceptance human only.

## 2026-10-05 final delivery closure

- User acceptance completed for the coordinator, authorization, dynamic Herdr/Kitty observation, independent Edge Profile coexistence and Dashboard 25426 verification.
- Final local commit: `62477120adb03b9cc90b99f340e1f2504113a580` (`feat: complete coordinator collaboration workflow`). No remote push.
- Temporary `.state` evidence, Mock groups, old probes, generated protocol dumps and test logs were removed. The active `dashboard-real-workers-20261004` runtime and `rw` socket directory were retained so the current Dashboard/daemon session was not interrupted. Untracked `.DS_Store` files remain outside the commit.
- README now contains guarded Agent bootstrap instructions for dependency installation, Skill discovery, validation, runtime initialization, human control, daemon startup and model authorization. Existing Skill directories are not overwritten.
- Codebase Memory was reindexed against `/Users/macmini/playground/codex-session-coordinator` after the commit. Representative `KittyController`, `connectExistingEdge`, `startDashboard` and `workerToolPolicy` symbols were found in the graph. The local `codebase-memory-mcp` 0.9.0 service emitted `.codebase-memory/graph.db.zst` and `artifact.json` for snapshot project `coordinator-snapshot-6247712`; `artifact.json.commit` matched the then-current HEAD. The artifact is ignored by Git and remains a local shareable snapshot.

## 2026-10-08 Claude SDK 预检（多 agent 运行时 Task 0）

环境：`@anthropic-ai/claude-agent-sdk@0.3.293`（scratchpad 安装，未入库），Claude Code 2.1.294，Codex CLI 0.161.0。一次真实调用：`claude-haiku-5-5`、`low`、回复 OK，费用约 0.0009 USD。

- `options.env`：SDK 源码为 `St = O ? {...O} : {...process.env}`，传入时整体替换，不与父进程合并；SDK 只追加 `CLAUDE_CODE_ENTRYPOINT`、`CLAUDE_AGENT_SDK_VERSION`。
- 登录态：只放行 `HOME/PATH/TMPDIR/LANG/LC_ALL` 时 `accountInfo()` 返回 `tokenSource: none`，调用报 "Not logged in"；补上 `USER`、`LOGNAME` 后返回订阅账号（Claude Pro）。白名单必须包含这两个变量。
- 模型目录：用不产出消息的 prompt 迭代器即可调用 `supportedModels()`（约 1.7 s，无模型调用）。条目为别名加 `resolvedModel`：`default/opus → claude-opus-5-5`、`sonnet → claude-sonnet-5-5`、`haiku → claude-haiku-5-5`、`claude-fable-5-1[1m] → claude-fable-5-1`；思考强度 `low/medium/high/xhigh/max`。
- init 消息：`apiKeySource` 在订阅登录下为 `none`，不能据此判断未登录；鉴权以 `accountInfo()` 为准。
- result 消息：`subtype: success`，有 `total_cost_usd` 与 `modelUsage`（`inputTokens`、`outputTokens`、`cacheReadInputTokens`、`cacheCreationInputTokens`、`costUSD` 等）；**没有** `user_message_uuid`。
- 会话记录：`~/.claude/projects/<slug>/<sessionId>.jsonl`，每行带 `sessionId`。prompt 行 `type: user`，内容为 `[{type:'text'}]` 数组；assistant 行带 `message.model`，并带 `effort`、`perTurnEffort`（本次为 `low`）。此外还有 `attachment`、`queue-operation`、`cost-state` 等非对话行。
- Codex 用量通知：`thread/tokenUsage/updated`，参数 `{threadId, turnId, tokenUsage: {last, total, modelContextWindow}}`，`last/total` 字段为 `inputTokens`、`cachedInputTokens`、`cacheWriteInputTokens`、`outputTokens`、`reasoningOutputTokens`、`totalTokens`。`last` 只是最后一次模型响应，按轮统计应取 `total` 在本轮内的增量。

## 2026-10-08～09 多 agent 运行时真实验证（Dashboard 执行方展示，Task 20）

配置：Claude lead（claude-opus-5-5）+ Codex frontend/backend（gpt-6-luna medium，后期 backend 改 gpt-6-sol medium）+ Claude audit/advisor（claude-sonnet-5-5 high）；组 `multi-agent-20261008`，契约 `dashboard-agent-view-v1` r1→r3。

**流程已真实跑通**
- advisor 咨询：第一次在 5 分钟上限内写回答超时被中断（已对账归档）；第二次约 30 秒完成，6 条建议中 lead 核对源码后部分采纳，形成契约 r2。
- 派发 → 回执 → 审计拒绝 → 契约修订 → 返修 → 复审：audit cycle 1（9060d8f9）拒绝，问题包括契约归属把审计派发算入、行为测试缺失；cycle 2（225bec65）确认 cycle 1 的核心缺陷已修，仍以测试断言偏弱、frontend 闭包逻辑未测、`.comparison-panel` 使用 `overflow:hidden` 为由拒绝。
- 实际模型证据：Codex 为 `codex_turn_context`，Claude 为 `claude_transcript`（advisor 第二次咨询经 `automation_model_refresh` 补核）；用量按 turn 结束后记录。
- 额度：授权按 `authorizationRef` 计数，先后用了 `user-approval-20261008-chat`、`user-approval-20261009-chat`（6→7）、`user-approval-20261009-chat-2`（3），均已用完。

**运行中发现并修复的缺陷（均先写复现测试）**：advisor 被 worker 登记门控拦截（f8be9cc）；Codex 未执行过的线程在 daemon 重启后无法恢复（f859fca）；Codex 用量在 turn 中途被记录后冲突（14b78e0）；Claude 用量缺失字段被当作 0（88757b1）；按授权计数、turn 上限 1 小时、worker 不提交（75931d6）；示例配置的 `receiptTimeoutMs` 压过授权上限（d2a182e）；观察窗状态、时区与 Claude 模型标签（6d7fc97）；无回执结束的 turn 及时转待对账（8e1c8b5）；中断标记被误计为 Claude 提问（225e49d）；固定观察窗布局（10aab43、e322cbb）。全量测试 248 项通过。

**环境结论**
- Codex worker 沙箱禁止 socket 监听：`npx tsx`、`npm test` 报 `listen EPERM`，应改用 `node --import tsx --test`（已记为 PowerContext 经验 `art_3c96a86c029c4fc5912c7361ea4fa4ad`）。
- 多次 "Selected model is at capacity"（`server_overloaded`）为 OpenAI 服务端算力不足，账号额度正常（pro，周用量 15%）。
- 出网：经 Clash Verge 全局脚本，Claude Code 与 Codex 的域名经桥接出口 149.52.57.145，bigmodel 直连，订阅刷新不影响。

**结果与未完成项**
- Dashboard 执行方展示未通过审计，**未合并**。worker 改动已由 lead 提交在 worker 分支：backend `feat/dashboard-agent-backend@00c4d3a`，frontend `feat/dashboard-agent-frontend@35d4c69`。
- 390px 页面测试未做。lead Task 未提交待验收；两个 worker Task 的租约已过期，保持 in_progress。
- 旧组 daemon 与租约守护进程已停止，观察窗已关闭。后续以试点组（`project:init` 新建）继续 Dashboard 易用性优化。

## 2026-10-09 Dashboard 易用性试点（第一次用 project:init 跑实际工作）

配置：组 `dashboard-ux-20261009`（`project:init` 生成）；Claude lead（claude-opus-5-5）+ Codex frontend/backend（gpt-6-sol medium）+ Claude audit（claude-sonnet-5-5 high），不用 advisor；契约 `dashboard-ux-v1` r1→r4；基线 `feat/multi-agent-runtime@455f0b0`。时间均为 Asia/Taipei（UTC+8）。

**流程**
- 14:28 lead Task `3c4e112c` 建立；`worker-hold` 建 worker Task（frontend `d9aa56b0`、backend `517f05f5`）；`worker-preflight`、`project-preflight` 通过（0 次模型调用）；授权 `user-approval-20261009-dashboard-ux`（6 次）。
- 14:35 派发 backend r1、frontend r1。backend 一次通过契约第 1 节；lead 合并两份 diff 截图复核发现前端把 ISO 时间当数字、工作项被截成 8 位等问题，契约升 r2 后派 frontend r2。
- frontend r2 派发被 CLI Task 门禁以 `FILE_CONFLICT` 拒绝：上一轮"执行方展示"的旧 worker Task `8ccf3a82`/`7c81c907` 仍为 in_progress，快照里改动了同一批 dashboard 文件。取消只能在看板操作，用户 15:40 取消后放行；冲突策略只排除 `done`/`cancelled`，`paused` 不够。
- 审计 cycle 1（`93104b2a`）拒绝前端 11 处缺陷 → 契约 r3 → frontend r3 → lead 复核仍有 3 处小缺陷，经用户同意由 lead 直接修改；用户要求显示时区统一 Asia/Taipei → 契约 r4 → 审计 cycle 2（`97f1cff3`）拒绝 1 处中等缺陷（≥1600 侧栏契约/审计并排）→ 6 次额度用完，用户追加 `user-approval-20261009-dashboard-ux-2`（1 次审计），lead 修复 → 审计 cycle 3（`b1722d84`）**通过**。

**执行方、实际模型与用量**（实际模型均来自运行时证据）

| 派发 | 执行方 / 实际模型 | 证据 | 耗时 | 输入 / 缓存 / 输出 token | 费用 |
| --- | --- | --- | --- | --- | --- |
| backend r1 | Codex gpt-6-sol medium | codex_turn_context | 6分58秒 | 858,166 / 758,400 / 5,150 | 无 |
| frontend r1 | Codex gpt-6-sol medium | codex_turn_context | 4分14秒 | 754,074 / 631,296 / 7,865 | 无 |
| frontend r2 | Codex gpt-6-sol medium | codex_turn_context | 5分19秒 | 1,041,932 / 999,680 / 8,783 | 无 |
| audit cycle 1 | Claude claude-sonnet-5-5 high | claude_transcript | 1分57秒 | 3,014 / 405,715 / 12,957 | $0.48（估算） |
| frontend r3 | Codex gpt-6-sol medium | codex_turn_context | 5分48秒 | 1,286,266 / 1,245,440 / 6,670 | 无 |
| audit cycle 2 | Claude claude-sonnet-5-5 high | claude_transcript | 1分46秒 | 3,030 / 1,240,220 / 25,366 | $1.24（估算） |
| audit cycle 3 | Claude claude-sonnet-5-5 high | claude_transcript | 1分05秒 | 3,042 / 2,071,089 / 33,052 | $1.58（估算） |

**结果**
- 审计通过后 lead 在 worker 分支提交（backend `bc9f749`、frontend `7cc1d91`，内容与审计补丁 sha256 一致），`--no-ff` 合并（`39395c5`、`2111893`）；观察窗格时区 `4641e82`、契约 `325af8b`。
- 合并后沙箱外：`npm run typecheck`、`npm run build` 通过，`npm test` 254/254（`TZ=America/New_York` 与 `TZ=Asia/Taipei` 各一次）。
- 页面（Edge CDP 9223，截图在 `docs/superpowers/pilots/2026-10-09-dashboard-ux/`，`before/` 与 `after/` 同源数据对比）：与改造前同源数据（组 `multi-agent-20261008`）1920 整页 2555→1880px、首屏可见任务队列与右侧栏；1440 1807px；390 4257→4069px，任务队列由 900px 宽表格横向滚动改为四行卡片。三个宽度无页面级横向溢出、无页面错误。试点组自身数据中 Claude 审计显示 `claude-sonnet-5-5 · high ✓`（原"未确认"缺陷已修）。

**偏差与待办**
- 390px 整页只降约 4%，未达到契约"明显低于改造前"的字面要求；审计接受为已记录偏差，建议后续改为"不高于改造前"或数值上限。剩余高度主要是会话卡（约 970px）。
- 摘要"调用观察"显示 `已用 / 上限` 时，已用是全组所有授权的累计，上限是当前授权（试点组显示 `7 / 1`），口径不一致，需改为按当前 `authorizationRef` 计数或同时标出累计。
- lead 直接修改了 frontend 的部分实现（3 处布局缺陷、耗时说明、时区），偏离"worker 实现、lead 协调"的分工，已在提交说明与审计包中注明。
- 简报与契约把 `tests/dashboard.test.ts` 与 `tests/dashboard-model.test.ts` 的分工写反，worker 按文字放置，未造成缺陷。
- 返修派发不能用 `replacesDispatchId`（只用于替代失败派发）；lead 主机证据约 15 分钟有效，过期后派发会被门禁拒绝，需先取证并 checkpoint。

## 2026-10-09 普通 claude 会话按意图接入（skill 驱动的 lead 接入，实机验收）

环境：Kitty 中的 Herdr；测试业务仓库 `~/playground/attach-demo`；mock 组 `attach-demo-20261009`（无真实执行授权，人工凭证由用户在真实终端 `human-control init` 生成）。分支 `feat/skill-driven-lead`，审查修复后重新构建 `dist`。时间均为 Asia/Taipei。

- 20:31 用户在 Herdr 新窗格进入测试仓库，直接运行 `claude`，说"开始协同：检查状态"。新会话加载 skill 后自行执行 `lead:attach`，回复已接入、观察窗格用 Herdr、有新工作时才打开。
- 协调器侧核对：`daemon.pid` 指向由 `start-daemon.sh` 拉起的 daemon；`lead-supervisor.pid` 记录 `{pid, sessionRef, claudePid}`，claudePid 的命令行为 `claude`；布局控制器是守护进程的子进程，从 `dist/scripts/herdr-follow.js` 运行并写出 `layout-ready.json`；`external_lead` 登记该会话，到期时间随心跳滚动。
- 20:33 以 lead 凭证初始化 backend、发布并确认测试契约后派发 mock 工作：右侧自动打开 `Coordinator backend` 窗格（`w7:p4`），其中进程直接为 `herdr-watch`（`exec` 取代 shell）。随后以 backend 身份提交回执使组空闲。
- 20:35:41 用户退出 `claude`：守护进程记录"Claude lead exited"，lead 在场登记被释放（`expires_at=0`）；控制器关闭 backend 窗格（映射 `panes` 为空）；`group-stop --if-idle` 停止 daemon；`daemon.pid`、`lead-supervisor.pid`、布局锁均已删除；无任何残留协调器进程。

结论：用户只需在 Herdr 中普通启动 `claude` 并表达意图，接入、按需开窗格、退出收尾全部自动完成。

## 2026-10-16 观察标签页与 PowerContext 退役

分支 `feat/herdr-observer-tab`。时间均为 Asia/Taipei。

**PowerContext 退役**
- 提交 `611c730`：runtime.json 不再接受 `powerContext` 段（加载报 `PowerContext is retired`），真实模式只需 `taskMcpUrl` 与 `repositories`；跨 agent 记忆改为 `projectMemory.path` 指向业务仓库内的记忆文档；`project-preflight` 改为核对 Task MCP、各 worktree 的 Git 身份与记忆文件可读，`worker-preflight` 只核对 CLI Task owner、租约与 worktree。
- `npm run typecheck`、`npm run build` 通过，`npm test` 266/266（布局修复之前）。

**观察标签页实机检查**（Herdr workspace `wE`，10:26–10:31，mock 组 `attach-demo-20261009`）
- `lead:attach` 返回 `ATTACHED`，未发出任何 Herdr 请求；主会话标签 `wE:t1` 仍只有一个窗格。
- `herdr:open` 新建标签 `wE:t2`「流水線協同 · attach-demo-20261009」：總覽 `wE:p2`、advisor `wE:p3`、frontend `wE:p4`、backend `wE:p5`、audit `wE:p6`；焦点留在 `wE:t1`。
- 窗格文本显示固定标题行与总览行，例如 `backend   执行完成 · codex · 未确认` / `最新：mock work done for pane verification`。
- 12 秒内各窗格滚动偏移保持不变（不滚动）。
- 发现两处缺陷，之后已修复：advisor 窗格横跨底部整行（拆分顺序问题）；早期帧在回滚区留下空行（改为全部拆分完成后再启动观察器，并只做一次初始清屏）。
- `herdr:close` 返回 `CLOSED`，只剩 `wE:t1`。

**最终复验**（布局修复后）
- `npm run typecheck`、`npm run build` 通过，`npm test` 266/266（0 skipped）。
- 实机复验（Herdr 工作区 `wE`，10:34–10:35）：`herdr:open` 建立标签 `wE:t3`「流水線協同 · attach-demo-20261009」。
- 面板几何（area 228×67）：

| 窗格 | ID | 尺寸 | 位置 |
| --- | --- | --- | --- |
| 總覽 | `wE:p7` | 68×34 | (0,0) |
| advisor | `wE:p9` | 68×33 | (0,34) |
| frontend | `wE:p8` | 160×22 | (68,0) |
| backend | `wE:pA` | 160×23 | (68,22) |
| audit | `wE:pB` | 160×22 | (68,45) |

- 五个窗格的 scrollback 偏移在 8 秒后仍全为 0。
- 总览首行 `總覽 · attach-demo-20261009 · 在线 0/4 · 待审批 0 · 派发 2`；frontend 窗格首行 `frontend · 暂无派发 · 代理未知 · 未确认`。
- 再次 `herdr:open` 返回 `ALREADY_OPEN`（observerTab `wE:t3`）。
- `herdr:close` 返回 `CLOSED`，之后仅剩主标签 `wE:t1`（1 个窗格）。
