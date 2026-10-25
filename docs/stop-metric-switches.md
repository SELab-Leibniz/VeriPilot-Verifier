# Stop 指标审查开关

在项目的 `.runtime-corrector/config.yaml` 中，通过 `stopCorrection.metrics` 分别配置 M01–M16。每项使用布尔值 `true` / `false`；省略的项继承插件默认值，不会解释成“全部开启”。

默认开启：M08 Skill 步骤遵循度、M09 开发规范遵循度、M12 需求执行率、M13 验收闭环率、M15 关键旅程通过率、M16 生产实现覆盖率。

默认关闭：M01、M02、M03、M04、M05、M06、M07、M10、M11、M14。

例如只覆盖两项，其余保持默认：

```yaml
version: 2
artifacts: []
dynamicGroundTruth:
  enabled: true
stopCorrection:
  enabled: true
  metrics:
    M11: true
    M16: false
```

完整默认配置见 [config.yaml](../examples/stop-metric-switches/.runtime-corrector/config.yaml)。v2 自动引导配置也会列出所有 16 项及其默认值。无效编号、拼写错误、字符串 `"false"` 等非布尔值会在加载配置时被拒绝。

## 开关如何生效

任务首次进入纠偏链路时，程序冻结完整审查策略，保存到 `task.stop.reviewPolicy`。Stop 生成分母时先完成原有义务归属，再移除关闭指标的审查对象。关闭一项不会把它自动改派给其它指标，也不会删除冻结需求；同一个需求仍可能由其它已开启指标按各自职责检查。

开关共同控制普通 Stop、实现审查、过程检查、候选交付物收集及最终报告。M09 关闭时也不运行其 Kit 集成检查；没有开启的实现审查职责时，不做源码清单、构建/设备探测或实现 reviewer 调用。只开启 M16 时仍能从普通 Stop 获取源码证明，不依赖 M09 或 M12 被开启。

开启指标不会新增交付义务。没有对应的冻结对象时，仍按原适用性规则报告不可计算或不适用，不会为得到分数而要求创建额外文档或 Skill。

关闭指标的结论，以及只归属关闭视图的额外 finding，不会重新触发阻断。未知或其它未分配的开启指标仍接受原有身份与证据校验。关闭项在报告中显示 `DISABLED`，分母为 0、值为 `null`，不计分、不消耗纠偏机会，不冒充 PASS。

策略及开关进入分母摘要，沿用缓存和过程重试的版本校验。任务中修改配置不会改变当前任务已冻结的开关，也不会借此消除已经发现的偏差；程序记录 `STOP_REVIEW_POLICY_CHANGE_DEFERRED`，新任务采用新设置。基线更新导致的新纠偏 epoch 保留当前任务策略。

## 文件质量与其它流程

Stop 原有的额外文件内容质量审查没有 M 编号，单独由 `stopCorrection.fileQualityReviewEnabled` 控制，默认 `false`。开启后，它根据当前交付物及原始需求独立检查文件质量；不自动开启任何 M 指标，也不把文件 PASS 当成指标覆盖。仅开文件质量时仍会执行这一职责。

当 16 个指标及文件质量均关闭时，Stop 不启动基线刷新、分类、指标 reviewer、实现 reviewer 或构建/设备核验，直接记录 `ALL_STOP_REVIEWS_DISABLED` 并解除等待。本次验证状态为 `DISABLED`，不生成通过结论；也不会启动自动业务纠偏。

`stopCorrection.enabled` 继续是终止门的总开关。上述指标开关只管理 Stop 及其调用的审查职责，不会启用已关闭的文档纠偏或 Skill watcher，也不会关闭正在独立运行的 Skill 看护流程。已有活动 Skill watcher 仍按自身总开关工作。

## 代码链路

- `config/stop-defaults.json` 与 `metric-policy.mjs`：默认值、局部覆盖及关闭结论的范围过滤。
- 配置 Schema、`config.mjs`、`runtime-plan.mjs`、`derive.mjs`：校验、编译、配置合并和初始化模板。
- `metrics.mjs`：分母、策略摘要、关闭项与计分。
- `orchestrator.mjs`、`review-collector.mjs`：任务策略冻结、全关短路、按开启项分派、质量职责与旧式输出处理。
- `impl-review.mjs`、`artifact-candidates.mjs`、过程检查与重试：沿用所选分母，不额外恢复关闭职责。
- `task-store.mjs`、OpenClaw 等待与报告：跨 epoch 保留策略，关闭审查时正常结束且不显示为验收通过。
