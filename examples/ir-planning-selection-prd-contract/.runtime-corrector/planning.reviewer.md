# Planning Stage Agent 纠偏标准

你正在审阅刚生成或刚修改的 Planning bundle。每次都必须同时读取上游 `ir.md` 与 `PilotPlan.md`、`relations.json`、`granularity-choice.json`；不能只看触发 Hook 的单个文件。

## 可执行契约来源

1. 写 JSON 前先读取 `schemas/relations.schema.json` 和 `schemas/granularity-choice.schema.json`；它们是字段名、必填项、枚举和嵌套结构的权威来源。
2. 跨文件和图关系规则以 `planning.rules.yaml` 为准。不要读取 Runtime Corrector 的 JavaScript 实现来猜测格式或规则。
3. 如果 schema 与审阅文字矛盾，停止编造并报告具体冲突；用户可以直接修改项目内 schema 或 reviewer，下一次检查立即生效。

## 事实与边界

1. 当前用户请求与通过 IR criteria 的 `ir.md` 是需求事实来源；Planning 只能分解、分组和表达这些需求。
2. 不得把登录、同步、提醒、完成态、编辑、搜索、标签、云服务、额外设备形态或指定技术 API 擅自纳入本期交付。
3. 为形成最小可用闭环而引入的列表呈现、空输入处理、持久化等内容，必须明确标成必要推断、建议项或待确认项；不得伪装成用户原话。未被采纳的建议不能进入里程碑验收范围。
4. Planning 描述可实现、可评审的交付分组，不写代码步骤、类名、文件布局或详细技术设计。

## PilotPlan.md

1. `Granularity` 必须声明 `Recommended`、`Selected`、`Milestone count`、`Confirmation` 和有事实依据的 `Reason`。
2. 粒度只允许 `coarse|normal|fine`；确认只允许 `pending|human|auto`。`auto` 必须选择保守且可解释的推荐粒度，`human` 必须有真实用户确认，不能编造确认来源。
3. 每个 `## M<n>` 必须有非空标题、`Contains SR`、用户可见 `Goal`、可执行 `Review focus`、`Risks`（没有则明确 `none`）。
4. 每个 SR 恰好属于一个里程碑。里程碑是业务可评审增量，不是实现步骤；声明数量必须与实际章节数一致。

## relations.json

1. `schema_version` 必须是 `planning.relations.v1`；`nodes` 和 `edges` 必须是合法 JSON 数组，ID 唯一且引用闭合。
2. SR 节点使用 `SR-<n>`/`type: sr`，里程碑节点使用 `M<n>`/`type: milestone`，标题必须能对应 Planning 中的业务内容。
3. `contains` 只能是 `milestone -> sr`，且必须与 PilotPlan 的 `Contains SR` 完全一致。
4. `requires` 只能表达真实硬依赖，方向是“当前 SR -> 它依赖的 SR”；不得用它表达偏好顺序、共享组件或测试顺序，不得自依赖或形成环。

## granularity-choice.json

1. `schema_version` 必须是 `planning.granularity_choice.v1`；`mode`、`selected`、`recommended`、`milestone_count`、`groups`、`source`、`reason` 必须完整且可解释。
2. `selected`、`recommended`、里程碑数量和每组 SR 必须与 PilotPlan 完全一致；每组 milestone 必须与 relations 的 contains 边一致。
3. `mode: auto` 应使用 `source: auto_selected_recommended`；`mode: user` 只能记录真实用户选择。不要把模型自己的决定冒充用户确认。
4. 如果存在 `planning_hash`、`sr_hash`、`pilot_plan_hash`、`relations_hash`，必须来自权威确定性生成器并与当前文件相符；不得编造、复制过期值或用占位值冒充。无法权威计算时，报告限制并省略可选哈希，不要伪造。

## 纠偏完成条件

- 三个 Planning 文件结构合法、互相一致，并忠实覆盖 IR 中的本期功能。
- 对每个问题引用具体文件字段或文本证据，并直接修正实际 Planning 产物；不要修改已经通过的 IR 来迁就错误 Planning。
- 修正必须尽量小，保留稳定的 SR/Milestone ID；修正任一文件后同步检查另外两个。
- 若确定性诊断仍为 `failed`，继续修正并重新触发检查；通过后再做一次本标准的语义复核。
