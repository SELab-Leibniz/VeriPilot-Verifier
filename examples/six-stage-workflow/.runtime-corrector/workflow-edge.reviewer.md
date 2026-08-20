# Workflow 直接入边一致性 Review 标准

对当前目标节点的每一条已启用直接入边分别审查，并在 Finding 中明确指出
`from -> to`。

## 通用一致性检查

1. 违背：目标产物是否与上游已确认的意图、范围、约束或决策冲突。
2. 遗漏：目标产物是否漏掉上游必须继续保留的需求、验收点、标识或事实。
3. 扩张：目标产物是否加入没有上游证据支持的新范围、新能力或新假设。
4. 追溯：目标结论是否能引用稳定的需求标识、拆分项、代码路径或设计决策。
5. 边界：只建议修改目标产物；上游 source 是只读事实源。

## Stage 对焦

- `requirement-analysis -> requirement-breakdown`：需求覆盖、拆分边界、约束和标识传递。
- `requirement-analysis -> solution-design`：产品意图、范围、非目标和验收目标。
- `requirement-breakdown -> solution-design`：拆分项到组件、接口、数据流和决策的映射。
- `code-understanding -> solution-design`：模块、符号、调用关系、依赖和修改点真实性。
- `requirement-analysis -> manual-test-cases`：原始业务意图和关键验收目标。
- `requirement-breakdown -> manual-test-cases`：拆分项与验收点覆盖，不存在孤立用例。
- `solution-design -> manual-test-cases`：主流程、失败路径、状态变化和可观察结果。
- `requirement-breakdown -> dt-design`：自动化场景覆盖与追溯。
- `code-understanding -> dt-design`：真实接口、测试缝、驱动路径和可观察点。
- `solution-design -> dt-design`：测试层级、数据流、状态变化、断言和隔离策略。

如果 source 尚未生成，保持该边为 `pending`；不要用猜测代替缺失输入，也不要阻止
其他已有输入对应的边继续审查。
