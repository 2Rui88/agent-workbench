# 跨任务依赖与 ctx 协议

`ctx` 是跨任务、跨仓库的上下文追踪记录，不持有任务 lease，也不替代业务任务。它保存上下游任务与仓库、依赖策略、边 generation、验证 cycle 和有序事件，供任务恢复、验证和人工验收追溯。

依赖边保留历史。删除或重建边会生成新的 `generation` 和 `ctx_id`，旧 ctx 标记为 `superseded`，旧 validation 不得被新边复用。取消任务只关闭当前 ctx 的同步状态并发布事件，不级联取消另一侧任务。

策略转换规则：

| 策略 | 执行推进 | 验证请求 | 上游人工验收 |
| --- | --- | --- | --- |
| `informational` | 不阻塞 | 可记录，不要求通过 | 不阻塞 |
| `validation_gate` | 不阻塞 | 要求同步验证 | 不阻塞 |
| `acceptance_gate` | 不阻塞 | 要求通过 | 阻塞直到通过 |
| `hard_block` | 只在显式硬阻塞检查点阻塞 | 要求通过 | 阻塞直到通过 |

每个 ctx 事件使用递增 `sequence`。消费方按 `(ctx_id, sequence)` 去重，丢弃旧序号；重复请求通过 operation idempotency 处理。事件至少包含上下游 task/repository、generation、cycle 和时间戳。

任务状态与依赖同步状态分离：任务可以在上游未验证、被取消或等待人工验收时继续独立运行；只有对应策略的验收门禁影响上游 `accept`。`resume` 由人工决定，落到 `paused`，再由拥有任务 lease 的 Agent 调用 `task_start` 重新接管。
