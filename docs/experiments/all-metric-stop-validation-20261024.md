# 全指标 Review 与完整 Stop 验证

分支：`codex/all-metric-review-validation`。本轮按“隔离提示选择 → 生产工厂/收集器 → 完整 Stop → 空代码厨房开发”的顺序验证。阶段1检查点为 `c509619`；开始点为 `c64969a`。

## 隔离实验1：提示与角色

43个冻结案例覆盖本轮新增的12个指标。M01/M05/M12沿用上轮提示；其余指标有明确职责，复用同一只读执行器。开发集及留出集暴露的错误和第二版闭合提示的选择过程见 [实验说明](../../experiments/review-metrics-20261024/README.md) 与 [机器汇总](../../experiments/review-metrics-20261024/phase1-summary.json)。

固定输入汇总中，baseline为36/43，selected为43/43。共执行87个worker任务，另有8个同输入、同提示结果复用；任务数不是HTTP请求数。这是定向合成案例的结果，不能估计生产准确率。用于修正第二版提示的旧留出失败例已经成为开发回归。

## 隔离实验2：当前生产路径

支持单个CURRENT_TASK对象的TASK_COMPLETE评审。M01–M15按对象职责分流；M09/M12实现审查保留源码范围。STAGE_COMPLETE、分类、未知适用性及findings-only仍使用原生路径。没有宣称所有阶段都替换为新执行器。

M08保留原Skill及正式Skill Ground Truth绑定；过程/闭合角色读取所属原始事件，源码角色不接收整个过程。单项结果立即保存，失败不覆盖已完成结果。整体文件质量另由原生评审执行一次，不追加一个读取全部单项结果的总评Agent。文件质量补充仍不是逐文件隔离，且没有PASS缓存。

真实生产工厂与collector的新增13例全部完成，标签、诊断、职责及引用通过独立审计：12个新增指标及M09的第二角色，7 PASS、6 DEVIATION，最大反馈1442字节。没有在这13例中生产采样UNVERIFIED；过程记录是合成材料，不能当真实业务执行。轨迹位于 `experiments/review-metrics-20261024/integration-plan/live-01/`；独立审计位于 `.runtime-correction/all-metrics-lab-20261024/phase2-semantic-audit.json`。

旧7例回归全部完成收集，6例符合基准；F08把永久emoji误作所需图片加载占位而给PASS。该项已读全必读材料，源码引用有效，实际使用正确提示；这是模型语义漏检，不是输入丢失或overflow。K09缺少业务执行证据，由程序直接保留UNVERIFIED；因此该轮为6个模型worker任务加1个程序结算，不能写成7个模型任务。失败原样保留在 `.runtime-correction/stop-integration-allmetrics-regression-01/`，独立审计为 `.runtime-correction/all-metrics-lab-20261024/legacy-regression-semantic-audit.json`。

全仓回归：1248项，1239通过、9跳过、0失败，242.2秒。日志为 `.runtime-correction/all-metrics-lab-20261024/full-regression-01.log`。完整回归证明机制兼容，不消除上述真实模型漏检。

## 完整 Stop 与空代码开发

尚待执行。入口与输入保护见 [隔离宿主计划](../../experiments/review-metrics-20261024/e2e-plan/plan.md)。实际测试将使用新端口、独立state/home和原生worktree；原业务项目、原session及18789宿主保持只读。原厨房合同、Skill和21场景verifier保持原字节，不扩大产品预算。

完整Stop以实际非空population、正式终态、原生续作receipt及独立业务验收判定。启用配置不等于角色已触发，空指标分母不计通过。厨房从空代码开发阶段由真实业务模型写实现，观察器不复制或修补业务代码。

## 交付边界

插件版本为 `1.9.1-openclaw.11-session-projects.12`。整个顶层experiments目录不进入安装包，避免夹带实验宿主认证状态、原始会话及外置oracle。原始模型轨迹保留在忽略目录，冻结输入与精简审计单独保留。

本文件在后续阶段完成后更新真实结果。当前不是“全流程已通过”的报告。
