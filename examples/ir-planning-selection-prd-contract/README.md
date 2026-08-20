# IR → Planning → Selection → PRD Contract

这是一个完整、可复制的四阶段 Runtime Corrector 示例，不是插件默认配置。

```text
IR → Planning → Selection → PRD Contract
```

- `workflow.yaml`：可直接作为 prompt 交给 Agent，描述 Stage 职责、上下游、输出路径和执行边界。
- `.runtime-corrector/config.yaml`：插件实际加载的项目策略。
- `.runtime-corrector/*.rules.yaml`：可确定判断的格式、字段和一致性规则。
- `.runtime-corrector/*.reviewer.md`：需要结合上下文判断的语义标准。
- `.runtime-corrector/schemas/`：Planning JSON 输出的结构契约。
- `single-stage-configs/`：只需要其中一个 Stage 时可参考的最小 YAML，以及旧 JSON IR
  集成的兼容示例；新项目优先使用 YAML。
- `specifications/`：四个 Stage 的作者规范和通过条件。

## 使用

把本目录中的 `.runtime-corrector/` 复制到待验证项目根目录，以 project scope 启用插件，
然后把 `workflow.yaml` 的完整内容作为 prompt 交给 Agent。

本示例使用固定文件名：

```text
ir.md
PilotPlan.md
relations.json
granularity-choice.json
kit-map.md
PRD.md
```

每次 Write/Edit 只纠偏本次触发文件。Planning、Selection 和 PRD Contract 会把已配置的
上游文件作为只读证据；复杂语义和上下游一致性由 reviewer 判断。

如果项目需要并行 change、日期化文件名或自定义 Stage，请从
`/runtime-corrector:init` 生成的通用注释模板开始，改用 `pathTemplates` 与
`workflow.correlation`。不要把这个示例的业务名称写入插件代码。
