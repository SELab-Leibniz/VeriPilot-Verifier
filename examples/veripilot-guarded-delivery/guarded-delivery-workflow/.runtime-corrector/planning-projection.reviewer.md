# 受控 Planning 四件套审阅标准

语义证据范围必须严格限定为：

- 六阶段来源：`requirement-analysis.md`、`requirement-breakdown.md`、
  `code-understanding.md`、`solution-design.md`、`manual-test-cases.md`、`dt-design.md`；
- Planning 输出：`SR.md`、`PilotPlan.md`、`relations.json`、
  `granularity-choice.json`。

不要读取或引用 IR、planning-source、traceability、manifest、handoff 或其他
文件来证明业务语义。此 node 由外层 Agent 编写，并非 Planning 插件产物；Finding
和候选 Diff 只能指向当前四件套，禁止调用 Planning 插件或修改六阶段来源。

## 六阶段到 SR 的一致性

1. 每个需求、拆分项、验收点、约束、非目标和开放问题都有明确 SR 去向。
2. 每个 SR 有稳定 `SR-N`，并包含 Description、Acceptance、Dependencies、
   Priority 和 External conditions。
3. 不存在无六阶段来源的新 SR；代码候选或测试手段不能被提升为新产品功能。
4. 人工用例与 DT 场景保留为验收证据，且每个验收点至少映射一个 SR。

## 四件套内部一致性

1. 每个 SR 恰好被一个 `M<N>` 包含；PilotPlan、relations 和 granularity 表达
   完全相同的分组。
2. PilotPlan 使用稳定的 `## M<N>: 标题` 和
   `- Contains SR: SR-N, ...`。
3. `requires` 只表示真实执行硬依赖，方向正确、无自环、无环且不过度排序。
4. `relations.json` 是 SR 关系机器权威；PilotPlan 只做人类可读投影。
5. 推荐粒度形成独立可验证增量，不为平均大小而改变功能边界。

Finding 必须明确指出“六阶段来源路径 -> Planning 文件路径”、缺失/冲突的稳定
ID，并只建议修正当前 Agent 所有的四件套；不得建议调用 Planning 插件或修改
publication manifest/hash。
