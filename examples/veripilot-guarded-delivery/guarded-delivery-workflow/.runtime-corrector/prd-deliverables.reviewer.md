# 受控 PRD 两件套审阅标准

语义证据范围必须严格限定为：

- Planning：`SR.md`、`PilotPlan.md`、`relations.json`、
  `granularity-choice.json`；
- PRD：`PRD.md`、`acceptance-contract.json`。

不要读取或引用六阶段原文、IR、planning-source、traceability、manifest、
handoff 或 PRD 目录中的其他文件来证明这一边界的业务一致性。六阶段意图已在
Planning 门禁中直接验证；本节点只验证 PRD 两件套没有偏离已通过的 Planning
四件套。此 node 为 `editable: false`，Reviewer 只报告 Finding；修正只能进入
PRD public feedback/作者流程。

1. PRD 中的 SR 集合、标题、语义和 Milestone 归属与 Planning 完全一致。
2. 不得重切、重复或漏掉 SR，不得加入没有 Planning 证据的新功能。
3. 每个 SR 的 target file 与约束不得改变 SR 意图；新增文件必须明确标记为
   “拟新增”，不能伪装成现有仓库事实。
4. 每个 SR 都有稳定 `*_OK` acceptance reference，动作、可观察结果和证据类型
   可执行。
5. `acceptance-contract.json` 的 SR、acceptance refs 和 PRD 当前内容一致，
   无空列表、孤立项或重复语义。
6. Auto approval、verified 和 human approval 必须分开陈述。

Finding 必须明确指出“Planning 文件路径 -> PRD 文件路径”、受影响的 SR/Milestone/
acceptance ID，并要求通过 PRD public feedback 生成新 revision；不得建议直接编辑
acceptance、manifest、handoff 或 hash。
