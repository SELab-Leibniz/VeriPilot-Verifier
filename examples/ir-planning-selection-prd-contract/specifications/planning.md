# Planning Stage 全局规范

本规范描述 Planning bundle 的完整作者地图。项目内两个 JSON Schema、`planning.rules.yaml` 和 `planning.reviewer.md` 是当前项目的可编辑执行来源，`spec` 接口会把它们全部展开。

## Bundle

默认必须同时存在：

- `ir.md`
- `PilotPlan.md`
- `relations.json`
- `granularity-choice.json`

缺文件时状态为 `pending`，不是最终失败。只修改 Planning 三件套；IR 是只读事实源。

## `PilotPlan.md`

顶层元数据必须能识别：

- `Recommended`: `coarse`、`normal` 或 `fine`
- `Selected`: `coarse`、`normal` 或 `fine`
- `Milestone count`: 正整数
- `Confirmation`: `pending`、`human` 或 `auto`
- `Reason`: 非空理由

至少一个 H2 里程碑，标题形如 `## M1`。每个里程碑必须声明：

- `Goal`
- `Review focus`
- `Risks`，无风险时明确 `none`
- `Contains SR`，至少一个 `SR-n`

里程碑 ID 不得重复；一个 SR 不得同时属于多个里程碑；声明数量必须等于实际 H2 里程碑数。

## `relations.json`

精确字段结构以当前 `schemas/relations.schema.json` 为准。当前内置关系校验还要求：

- `schema_version` 为 `planning.relations.v1`；
- `nodes` 与 `edges` 为数组；
- node ID 只能是 `M<n>` 或 `SR-<n>`，标题非空且类型对应 `milestone`/`sr`；
- node 和 edge 不重复，edge 两端必须引用现有 node；
- `contains` 是 `milestone -> sr`；
- `requires` 是不同的 `sr -> sr`；
- edge 类型只能来自当前规则的 `allowedEdgeTypes`；
- `requires` 默认不得成环；
- `contains` 分组与 PilotPlan 完全一致。

## `granularity-choice.json`

精确字段结构以当前 `schemas/granularity-choice.schema.json` 为准。当前内置一致性校验还要求：

- `schema_version` 为 `planning.granularity_choice.v1`；
- `mode` 为 `user` 或 `auto`；
- `selected`、`recommended` 为 `coarse`、`normal` 或 `fine`；
- `milestone_count` 为正整数；
- `source` 和 `reason` 非空；
- selected/recommended 与 PilotPlan 一致；
- milestone_count 与实际里程碑数一致；
- groups 与 PilotPlan 的里程碑/SR 分组一致；
- 出现 hash 字段时必须是 64 位十六进制 SHA-256。

## 通过条件

- 两个 JSON 都通过当前项目 Schema。
- PilotPlan、relations、granularity choice 对同一 SR 集合和分组给出同一答案。
- `requires` 只表达真实硬依赖，不把排序偏好写成依赖。
- Planning 忠实于 IR，没有新增用户角色、功能或平台能力。
