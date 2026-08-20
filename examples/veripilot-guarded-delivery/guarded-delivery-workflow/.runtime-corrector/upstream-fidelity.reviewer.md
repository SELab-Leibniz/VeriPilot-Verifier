# 直接入边忠实性审阅标准

对当前目标的每条已启用直接入边分别审查，并在 Finding 中明确写出
`from -> to`。源文件只读；当前 node 可编辑时修正只能落在当前目标，
`editable: false` 时只报告 Finding 且候选 Diff 必须为空。

## 通用检查

1. 违背：目标是否和上游已确认意图、范围、约束、非目标、决策或事实冲突。
2. 遗漏：目标是否漏掉必须保留的需求、验收、标识、异常路径或开放问题。
3. 扩张：目标是否加入没有上游证据支持的新能力、新完成态或新假设。
4. 追溯：目标结论能否引用稳定需求 ID、拆分项、代码路径或测试 ID。
5. 权威：需求文件决定产品意图，代码理解决定仓库事实；派生方案不得反向改写。

## 精确边界

- 六阶段内部边：按需求覆盖、代码真实性、方案映射和测试覆盖核对。
- `* -> planning-source`：只检查索引、原文快照和 byte hash 的无损承载。
- 六阶段节点 `-> planning-projection`：目标只允许
  `SR.md`、`PilotPlan.md`、`relations.json`、`granularity-choice.json`；逐来源检查
  SR 追溯，不得引用 IR、manifest/handoff 或其他 Planning 文件补足语义。
- `planning-projection -> prd-deliverables`：源只允许 Planning 四件套，目标只允许
  `PRD.md` 与 `acceptance-contract.json`；不得引用 traceability、manifest/handoff
  或其他 PRD 文件补足语义。
- `* -> planning-fidelity-gate` 与 `* -> prd-deliverables-gate`：遵守各 Gate 的
  精确 semantic evidence 范围；前序 Gate 报告仅是 control receipt。
- `* -> build-qa-handoff-gate`：只校验 control receipts 和协议 transport。
- `* -> build-qa-post-audit`：只校验明确列名的执行/证据闭包，不重审产品语义。

源尚未生成时，该边保持 `pending`；不得用推测代替缺失输入。
