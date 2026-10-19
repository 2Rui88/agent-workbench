# Codex Session Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native execution, or superpowers:subagent-driven-development if the user selects delegation. Steps use checkbox syntax. No automatic commit or push.

**Goal:** 实现本机单用户、1 主 3 从的协同运行时，完成 P0 F01–F12；先以 Mock、真实协议握手及隔离夹具验证，真实模型 turn 与业务项目试运行独立门控。

**Architecture:** TypeScript 协调器独占 SQLite 状态与 Unix socket。App Server 驱动四个独立线程，每线程串行、角色之间并发；MCP、CLI 与只读观察端复用同一命令 schema。CLI Task 是业务任务和最终验收权威，PowerContext 只保存获准的项目交接。

**Tech Stack:** Node.js >=24、TypeScript、node:sqlite、MCP SDK、schema 校验、Node test runner；npm；Playwright Core attach 到已有 Edge。

**Spec:** ../specs/2026-10-03-session-coordinator-design.md
**Design source:** https://chatgpt.com/space/page_71306662013c8191800c939e42998ead
**Repository:** /Users/macmini/playground/codex-session-coordinator
**Execution:** 已确认当前会话 native 实现，模块接口集中审查。
**Current approval:** 用户已确认完整设计、项目路径、Mock/协议验证和当前会话逐模块实现。本任务已在 CLI Task 登记；产品代码须等待受控 lease。

## Global Constraints

- 单用户、本机、一个项目群组、lead/frontend/backend/audit 四角色；最多四个角色并发，一个目标 thread 同时最多一个 turn。
- 默认 execution=gpt-6-luna/high；analysis=gpt-6.1-sol/high；deep_analysis=gpt-6.1-sol/xhigh。启动时以 model/list 校验支持强度，不将目录存在描述为账号调用成功。
- lead/audit 默认 analysis，frontend/backend 默认 execution；每个新执行包显式 model/effort，升级后的下一任务恢复默认。不支持的组合拒绝，批准的 fallback 初始为空。
- 真实模型调用默认关闭；Mock 和真实统计分开标记。真实调用预算尚未授权，不自行代填金额或订阅额度。
- 不改已有 CLI Task、PowerContext、LKF 或其他业务仓库，不改全局配置、隐私权限、Edge 日常 Profile，不 push/merge/deploy。
- 实现开始前新建本地 Git 仓库，读取该仓库实际 Git user.name/user.email；注册自身 CLI Task 并完成 attach/conflicts/start。身份、服务或租约无效时停止业务代码写入。
- 所有业务执行包必须引用正确 repository/worktree/task 和新鲜权威门禁；Mock 场景使用隔离夹具，不能操作既有 review 数据库。
- 消息、turn 完成与业务验收分开。只有结构化业务回执完成请求；agent 只提交 pending_acceptance，不提供自动接受接口。
- Edge 已有受控入口在 ../.agent-browser-runtime；先确认健康后 attach。完整操作独占浏览器，清理自有资源，断开客户端后保留 Edge。
- Playwright 只使用 connectOverCDP；角色 sandbox 与允许写入根目录显式配置，audit 默认 read-only，禁止通过消息扩大权限。
- Skill 先保留在项目内作为候选；安装到全局或晋升稳定共享 Skill 另行确认。方案的 P1/P2 是后续扩展，不冒充第一版已实现。

## Review Focus

1. 投递后响应丢失、协调器退出或 Codex turn 未知：不得盲目再次启动；对账完成之前冻结相关请求。
2. stale generation、租约过期和 human takeover：旧角色不能完成回执、写契约或继续调度；已在执行的命令不能仅靠到期视为停止。
3. 同一 operation_id 不同 payload、权限跨组、路径穿越或 symlink 越界：拒绝变更，身份由服务认证确定。
4. 用量事件重复/乱序/缺失：防止重复计费统计；预算不足或来源未知时停止新增调用，Mock 不能污染真实用量。
5. CLI Task 部分成功、浏览器共享页或契约修订漂移：保持权威引用，冻结受影响链路，保留已发生的操作和旧验证证据。

## 文件与影响面

所有产品文件均在本项目内创建：

| 边界 | 文件 | 责任 |
| --- | --- | --- |
| 工程与配置 | package.json、tsconfig.json、.gitignore、AGENTS.md、config/example.json | 构建、开发命令、运行目录、授权模型与服务引用；无凭据 |
| 协议与权限 | src/protocol.ts、src/config.ts、src/auth.ts、src/errors.ts | 一套 schema 同时用于输入验证、CLI introspection 和 MCP；角色能力边界 |
| 持久化 | src/store.ts、src/migrations.ts、src/messages.ts | SQLite WAL、事务、版本、outbox、消息与租约 |
| 策略与调度 | src/model-policy.ts、src/scheduler.ts、src/recovery.ts、src/usage.ts | lead 策略、单线程 turn、并发预算、未知结果对账 |
| 执行器 | src/runtime/types.ts、src/runtime/app-server.ts、src/runtime/mock.ts、src/approvals.ts | NDJSON RPC、事件、thread/turn 恢复、人工审批 |
| 契约验证 | src/contracts.ts、src/validation.ts、src/preflight.ts | contract revision/digest、消费确认、测试与返修引用 |
| 外部权威 | src/integrations/cli-task.ts、src/integrations/powercontext.ts、src/git-context.ts | MCP 协议适配、实际 Git 身份与任务门禁；不复制权威状态 |
| 浏览器 | src/browser/queue.ts、src/browser/edge.ts、src/browser/runner.ts | 独占 lease、明确自有页面、受控工具进程、失效后对账 |
| 入口与观察 | src/server.ts、src/client.ts、src/cli.ts、src/mcp.ts、src/watch.ts、src/terminal.ts | Unix socket daemon、机器 JSON、角色 MCP、四窗观察与控制权 |
| 角色与候选 Skill | roles/lead.md、roles/frontend.md、roles/backend.md、roles/audit.md、skills/session-coordination/SKILL.md | 执行包和反馈规范；候选流程不安装全局 |
| 验证 | tests/*.test.ts、tests/fixtures/*、scripts/protocol-preflight.mjs | 隔离 DB/目录、Mock Server、协议验证和完整闭环 |

共享系统影响：只新增本项目自身的 CLI Task 登记；运行时与现有 MCP 服务建立独立会话。PowerContext 必须显式项目 Scope，未配置时不写入。现有浏览器工具目录复用为受控入口，不迁移或修改它。Herdr/Kitty 只新增本项目观察 pane，不向既有 agent 发送按键或提示。

## Task 1: 工程、协议与确定性权限

**Files:** 工程配置、src/protocol.ts、src/config.ts、src/auth.ts、src/errors.ts、tests/protocol.test.ts。
**Interfaces:** RoleId=lead|frontend|backend|audit；Actor 包含 groupId/roleId/bindingGeneration，来自 capability 身份；CommandRegistry 提供 schema、validate、dryRun、execute。

- [ ] 注册本项目任务，确认 Git owner、影响范围与有效租约；安装最少依赖，锁定版本。
- [ ] 写失败测试：rejectForgedSender、rejectCrossGroup、rejectSymlinkEscape、rejectUnsupportedEffort、dryRunDoesNotWrite。
- [ ] 运行定向测试确认红灯；再实现统一 schema、输入尺寸上限、路径 canonicalization 与角色权限。
- [ ] CLI stdout JSON envelope，stderr 人类诊断；稳定错误 code、retryable 与 nextAction；schema/help 可发现，敏感值不回显。
- [ ] 验证配置和 dry-run 测试通过，checkpoint；保持未提交。

## Task 2: 群组、队列、租约与幂等

**Files:** src/store.ts、src/migrations.ts、src/messages.ts、tests/messages.test.ts。
**Interfaces:** Store.transaction(fn)；send(actor,input)、claim(actor,input)、complete(actor,input)；所有变更绑定 operationId、expectedVersion、generation。

- [ ] 写失败测试：sameOperationReturnsSameReceipt、changedPayloadRejected、twoClaimantsOnlyOneWins、staleGenerationRejected、expiredClaimCannotComplete、restartPreservesQueue。
- [ ] 建表 groups/roles/runtime_bindings/messages/delivery_attempts/processing_leases/dispatch_runs/event_log/usage_snapshots，以及契约、验证、浏览器请求与外部操作记录。
- [ ] 事务领取、版本 CAS、有效时间检查；同逻辑请求返回原状态。投递 attempts 和业务 completed 分离，completed 需要非空结果与证据。
- [ ] 按 priority、createdAt、公平顺序出队；超时保留并标明原因，不丢请求、不直接推导 task done。
- [ ] 测试两连接竞争与进程重启恢复，checkpoint。

## Task 3: App Server、Mock、审批与用量

**Files:** src/runtime/*、src/approvals.ts、src/usage.ts、tests/runtime.test.ts、tests/usage.test.ts。
**Interfaces:** Runtime.initialize/listModels/startThread/resumeThread/readThread/startTurn/interruptTurn；RuntimeEvent 带 threadId/turnId/source。
**Turn input:** startTurn({threadId,input,model,effort,cwd}) 必须显式 model/effort。

- [ ] 写失败测试：rpcOutOfOrder、disconnectRejectsPending、serverRequestWaitsForHuman、eventDoesNotCompleteMessage、mockDoesNotCallProvider、duplicateUsageNotCountedTwice。
- [ ] 实现 stdio NDJSON 请求响应关联、背压、超时、受控进程关闭和结构化事件；不继承人类管理 token 到子进程。
- [ ] 人工审批原始请求进入 waiting_human；只允许独立 human capability 回复。角色 MCP/消息不能替用户批准。
- [ ] model/list 校验组合，记录请求配置和已收到的执行器回执；实际重路由事件单独投影，未收到不编造实际型号。
- [ ] 使用量记录来源，处理 cumulative 快照的重复与乱序；缺失或未知保持待对账。
- [ ] Mock 与本机真实 initialize/model/list 测试通过；不发真实 turn，checkpoint。

## Task 4: lead 调配、调度、恢复与接管

**Files:** src/model-policy.ts、src/scheduler.ts、src/recovery.ts、tests/scheduler.test.ts、tests/recovery.test.ts。
**Interfaces:** workDispatch(actor,ExecutionPackage)；tick(groupId)；reconcile(runId)；takeover/release(humanActor,roleId)。
**ExecutionPackage:** goal/taskRef/repository/worktree/allowedPaths/baseline/contractRef/acceptanceCriteria/verificationCommands/dependencies/model/effort/exitConditions。

- [ ] 写失败测试：oneTurnPerRole、fourRolesCanRun、busyRoleQueues、leadOfflineBlocksNewDispatch、escalationRestoresDefault、overBudgetRetainsPending。
- [ ] lead 根据明确度、影响范围、风险和失败证据决定档位；执行器只验证/应用，连续两次实现失败产生重新评估请求，不自行无限升级。
- [ ] 投递前事务记录 outbox/attempt 和调用预留；已发但响应未知标 needs_reconciliation，不能自动重新发。
- [ ] 写失败测试：restartDuringStartTurnDoesNotReplay、turnCompleteWithoutReceiptStaysClaimed、expiredRunRequiresReconciliation、humanTakeoverStopsNewTurns。
- [ ] 恢复核对 thread/turn/基线与 CLI Task 权威门禁。pause 停新派发；interrupt 需明确请求且不回滚外部副作用。
- [ ] 当前 Mock 全链路证明预算与恢复默认；真实模型开关保持关闭，checkpoint。

## Task 5: 契约、CLI Task、验证返修和正式交接适配

**Files:** src/contracts.ts、src/validation.ts、src/preflight.ts、src/integrations/*、src/git-context.ts、tests/integrations.test.ts、tests/contracts.test.ts。
**Interfaces:** TaskAuthority.checkGate(binding,taskRef)、checkpoint、submit；Contract.publish(lead,...)/ack(consumer,...)；Validation.create/record；Handoff.publish(scopeRef,revision)。

- [ ] 写失败测试：noTaskLeaseNoDispatch、wrongGitOwnerRejected、operationUnknownReconcilesBeforeRetry、agentCannotAccept、contractMismatchBlocksOnlyAffected。
- [ ] 当前 MCP tool schema 适配，不凭旧记录假设接口。业务门禁绑定实际 worktree、task version、lease 和冲突证据；只缓存引用与同步证据。
- [ ] 验证通过/行为失败/环境 error 分离；旧周期不可改，新基线返修形成新周期并复用 CLI Task 依赖协议。
- [ ] 后端变更后的真实业务验证要求原项目重启与健康证明；单元夹具不启动或改变共享服务。
- [ ] PowerContext adapter 要求显式项目 Scope/Principal 和精确 revision；部分成功对账，不写 Default/Likofu；未获准时仅 Mock。
- [ ] 模拟一次审计 rejected、实现返修、指定新基线 passed，业务任务只到 pending_acceptance，checkpoint。

## Task 6: 共享 Edge 请求与独占执行

**Files:** src/browser/*、tests/browser-queue.test.ts、tests/browser-edge.test.ts。
**Interfaces:** browserRequest(actor,input)、browserClaim(actor,...)/heartbeat/release/reconcile；受控 runner 只接受授权入口与参数。
**Lease:** group/role/generation/source/operation/resourceRefs/expiry；整段流独占，并行请求持久排队。

- [ ] 写失败测试：twoRolesShareOneBrowserLock、expiryDoesNotCancelInflight、staleBrowserLeaseCannotRelease、healthFailurePreventsRun、cleanupPreservesUserPages。
- [ ] 复用已准备的 Edge CDP、BH、PW 受控入口，健康检查服务与浏览器，禁止 launch 与浏览器下载。
- [ ] 路径和执行参数允许列表，先登记自有页；不允许 pages()[0]、共享 context 清理或 Browser.close。
- [ ] 过期后先核对在途进程与自有资源；确认停止/清理后才让下一请求领取。
- [ ] 以隔离测试页面串行运行两个角色请求，证明只有一个 Edge、清理后 Edge 保留；记录基础接入而非业务 E2E，checkpoint。

## Task 7: daemon、CLI、MCP、四窗观察及候选流程

**Files:** src/server.ts、src/client.ts、src/cli.ts、src/mcp.ts、src/watch.ts、src/terminal.ts、roles/*、skills/session-coordination/SKILL.md、tests/api.test.ts。
**Interfaces:** schema(command)、request(command,input,actor)、events(afterSequence)、watch(roleId)。
**Operations:** group_create/get/pause/resume、role_bind、work_dispatch、message_send/claim/complete、model_escalation_request、contract_publish/ack、validation_request/result、browser_*、control_takeover/release。

- [ ] 写失败测试：roleTokenCannotAdminister、eventReplayAfterRestart、malformedMcpInputRejected、stdoutIsJson、humanModeCannotBeSelectedByAgentArgument。
- [ ] Unix socket 与状态目录限制本机 owner 访问；actor 从受控 capability 得到，generation 换绑后旧 token 失效。
- [ ] CLI 与 MCP 共用 schema，不依赖 README 才能发现命令；dry-run 只给计划，不写 DB/消息/线程。
- [ ] 四个只读 pane 显示请求配置、执行回执、thread/turn、队列、阻塞与证据；Herdr/Kitty entrypoint 只启动 watch，不额外启动写工作区的 Codex 会话。
- [ ] 人工接管先停新 turn 并展示在途情况；释放控制需重新对账；人工批准只能经原审批桥，不自动按键。
- [ ] 候选 Skill 提供恢复、派发、回执、升级与门禁流程；原生 queue/TUI 附着 capability 检查后仍默认 disabled，未经实测不标为可靠投递，checkpoint。

## Task 8: 完整 Mock 场景、审计与交付

**Files:** tests/scenario.test.ts、tests/fixtures/*、scripts/protocol-preflight.mjs、docs/verification.md。
**Interfaces:** 隔离 scenario 覆盖 F01–F12，通过真实 CLI/MCP/daemon 入口而非仅内部函数。

- [ ] 写完整用例：契约 v1 → 前后端并行 → 直接 assistance → audit rejected → lead 升级 → backend 修复 → 契约/基线更新 → audit passed → pending_acceptance。
- [ ] 在 busy、服务重启、相同请求重复、预算限额、人类接管、浏览器排队条件下验证证据；失效 generation 和未知结果不得再次执行。
- [ ] 运行 npm test、npm run typecheck、npm run build；对照 F01–F12 自查实际实现，不把 P1/P2 feature flag 当成完成。
- [ ] 本机真实协议握手与浏览器基础验证通过；真实模型、首个业务项目、PowerContext 正式写入、真实用户审批分别列为未执行门禁。
- [ ] 审查未提交差异、权限与敏感日志；提交自身 CLI Task 至 pending_acceptance。默认不 commit/push，不代替用户最终接受。
- [ ] 交付启动/停止/观察/恢复命令、可复现证据和限制；用户确认后再开启受预算约束的真实模型试运行。

## 验证与开放顺序

先全 Mock → 真实 App Server 非推理协议与 Edge 隔离页 → 用户批准真实模型预算 → 单项目四角色真实 turn → 用户批准选定业务仓库/测试数据 → 真实功能闭环。代码实现可以先完成，真实调用及业务验收门禁不能由 Mock 替代。

## 实施前确认

本计划承接已批准设计，覆盖首版全部 P0；跨机器和非 Codex 执行器按设计留接口，不在首版开启。
用户已确认计划与当前会话 native 执行。实现仍遵循 CLI Task 的本地 host evidence 和 lease 门禁；不伪造 Git/工作树证据。
