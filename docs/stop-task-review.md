# Stop 审查、预算与状态

生产 Stop 由 `orchestrator.mjs` 进入 `production-stop.mjs` 与 `assessStopCorrection()`，再通过 `stop-review-round.mjs`、`stop-task-group.mjs` 完成共享核心审查。没有静默回退旧 Stop 核心。显式只读验证复用审查机制，不领取业务续作准入，也不终止已有自动流程。

## 配置

```yaml
version: 2
artifacts: []
dynamicGroundTruth:
  enabled: true
stopCorrection:
  enabled: true
  waitMode: until_pass
  maxCorrectionsPerSession: 3
  maxCorrectionsPerFlow: 3
  assessmentTimeoutMs: 1200000
  feedbackReserveMs: 180000
  reviewGroupSize: 3
  fileQualityReviewEnabled: false
```

指标默认值与全关行为见 [指标开关](stop-metric-switches.md)。两层次数可以为零；分组大小和时间为正整数，预留必须小于总时限。默认 20 分钟包含 3 分钟结算/交付预留；缩短总窗口时需要显式缩短预留。

旧 `maxCorrectionsPerEpoch` 只映射为 `maxCorrectionsPerFlow`；旧 `waitTimeoutMs` 只映射为本次 `assessmentTimeoutMs`，均产生弃用提示。新旧同义字段同时出现时报错。需求变化不清零会话额度，业务修复不占已经结束的审查窗口。

## 范围与分组

先核对额度再准备 GT、分类、收集源码及启动 reviewer。全关、零额度或历史迁移无法核对时不启动这些模型工作。审查冻结原要求、条件、例外、公共约束和证据版本；中间输出、等待用户、外部阻塞、阶段完成和任务完成分别确定适用范围。

同一优先级、同一指标的至多 K 项由一个 Agent 顺序提交。组合任务书只复用公共材料，不改变条目身份或指标分母。调度按 P0/P1/P2 和指标游标持久化，派发时推进；本轮失败组不重新派发。单项提交经完整证明校验并持久化后返回回执，不能用组 PASS 替代成员判断。部分保存后崩溃或截止，已保存项继续参与收尾，未完成项明确保留。

原文工具、字节分页、累计读取预算、程序引文和 M16 生产链证明见 [读取边界](stop-review-bounds.md) 与 [M16](m16-production-implementation-coverage.md)。必要依据未变的单项 PASS 可保守复用；过程/执行结果必须符合当前历史。配置、模型、指令、绑定或证据变化不能复用失效判断。额外文件质量审查由独立开关控制。

## 额度、启动与等待

会话额度跨任务、需求修订和项目作用域累计；流程额度只限制本条纠偏链。只有宿主可信地确认实际开始一次业务修复才同时扣一次，两者不因审阅或通知次数增加。未知在途请求保留预留待核对，不自动重发，也不直接当成未开始。

`assessment` 等审查结算和有效反馈交付，然后解除等待；流程最多实际纠偏一次。`until_pass` 在有当前有效偏差且额度允许时继续等待已实际开始的修复及后续 Stop。未开始的排队请求最多等到当前总截止；及时开始的修复不受旧审查计时限制，后续 Stop 有新窗口。

入口额度耗尽会跳过自动审查并明确放行，不额外赠送最后一次自动复验，也不冒充 PASS。没有可信逐次启动历史的旧会话进入迁移核对，不能默认累计次数为零。

## 取消、依据与恢复

取消、关闭、项目切换、总截止和反馈发布均有身份与当前性围栏。有效偏差子集可以重新筛选，不能生成新条目或悄悄修改旧条目。检查器失败属于基础设施状态，不能伪造成业务违规；同一轮不会因此反复重派。

结束流程释放同一流程内旧 Stop 的等待，保留原评估事实。恢复必须确认原拥有进程已退出，保留逐项回执并关闭旧审查轮；缺少拥有者时沿用原绝对截止。迟到事件只影响所属 Stop，不能取消后来的独立等待链。

宿主必须提供经过验证的启动门、真实开始观察和精确运行取消能力；否则返回 `HOST_START_PROTOCOL_UNSUPPORTED`，保存偏差、解除等待且不自动续作。MatrixAssistant 和不同 OpenClaw 版本的具体边界见 [宿主指南](openclaw.md)。离线回归覆盖机制，真实模型准确性、桌面长时流程、重启恢复及 K 分组性能尚未完成整体验收。
