# 受控交付 Gate 审阅标准

只编辑当前 Gate Markdown。六阶段来源、Planning/PRD deliverables、generated JSON、
manifest、handoff、Build QA evidence 和完成报告全部只读。

## 通用 Gate

1. `输入与哈希证据` 列出实际存在文件及当前 SHA-256，不接受占位符。
2. `Corrector 结果` 分开记录 deterministic status 和 `agentReview.status`；
   `requested` 不能写成 `completed`。
3. `门禁结论` 只能是 `passed`、`needs_human` 或 `blocked`。
4. 任一 error/warning finding、pending bundle、reviewer failure、过期 hash、
   非 verified 组件结果或缺失证据都不能写 `passed`。
5. `下一动作` 必须是 YAML 允许的下一 Stage 或组件唯一公开 recovery action。
6. `Bundle 边界声明` 记录 `max_related_files=120`、
   `collector_candidate_cap=480`、`expected_related_files`、
   `observed_related_files` 和 `collector_truncated=false`。无法证明未截断时阻断。
7. control receipt 只证明上一个 Gate 的状态；manifest/handoff 只证明协议结构与
   hash 传递。二者都不得作为新增、删减或改写业务意图的语义证据。

## planning-fidelity-gate

- 语义 evidence 恰好是六阶段 6 份来源与 Planning 四件套：
  `SR.md`、`PilotPlan.md`、`relations.json`、`granularity-choice.json`。
- 所有上游 ID 有 SR 去向，无新增能力、静默遗漏或改义。
- 四件套中的 SR、Milestone、contains/requires 和 granularity 分组一致。
- planning-source、manifest、handoff、traceability 和其他文件均不
  参与此语义判断。

## prd-deliverables-gate

- 语义 evidence 恰好是 Planning 四件套与 PRD 两件套：`PRD.md`、
  `acceptance-contract.json`。
- Stage 85 报告只是必须为 passed 的 control receipt，不参与语义推导。
- PRD 不得重切 SR/Milestone；acceptance refs 和可观察结果与 Planning SR 一致。
- 六阶段、planning-source、traceability、manifest、handoff 和其他 PRD 文件
  均不参与此边界的语义判断。

## build-qa-handoff-gate

- 输入恰好是 Stage 85/95 两份 control receipts、外层 Planning projection
  delivery manifest、PRD manifest 和 PRD handoff。
- 该 Gate 只确认两个语义 Gate 已通过，以及 Build QA 所需协议身份、版本、hash、
  source freshness 和文件引用有效；不再次读取 Planning/PRD deliverables 做语义审查。
- 只在精确测试版本下记录 `COMPAT-PRD-BUILD-RETRY-POLICY-001`。

## build-qa-post-audit

- 每个 milestone 只收集明确列名的 execution contract、milestone result、
  evidence chain、changed files、output manifest/handoff，以及 delivery manifest；
  禁止 `deliverables/*`、`reports/*.md`、`output/*.json` 目录泛扫。
- 检查 milestone 数量、依赖顺序、contract/result identity、changed-files 与 evidence
  hash 闭包。这里不重审产品语义，也不得倒称为实现前暂停了 Build QA 内部流程。

## delivery-summary

- delivery-summary 执行前的 17 个 Stage 都有 completion report；自身 report 在本
  Gate 通过后写入，不得提前伪造。
- 总结列出六阶段、Planning、PRD 和依赖顺序下的 Build QA manifest hashes。
- 只有全部必须 Stage `completed` 才能标 `verified`；否则标 `incomplete`。
- `human_approval_recorded` 默认 false，除非存在用户显式批准证据。
