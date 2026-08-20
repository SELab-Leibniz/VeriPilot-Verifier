# Runtime Corrector 项目规则

这个目录是当前项目的纠偏控制面。插件不内置业务 Stage，也不会在隐藏位置替项目决定产物结构。

`/runtime-corrector:init` 生成的模板默认关闭全部 Stage。启用前按顺序完成：

1. 在 `config.yaml` 中把 `example-document` 改成项目真实的 artifact 与 Stage。
2. 用 `patterns` 或 `pathTemplates` 指定真实输出路径，两者只能保留一个。
3. 按需编辑 `example.rules.yaml` 和 `example.reviewer.md`。
4. 把确认后的 Stage id 加入 `enabledStages`。
5. 使用 `/runtime-corrector:explain <stage>` 检查实际生效内容。

## 三层控制

1. `enabledStages`：Stage 总开关。
2. `artifacts[].rules.enabled`：确定性硬规则开关。
3. `artifacts[].review.enabled` 与 `workflow.edges[].review.enabled`：节点和边的语义审阅开关。

一次自动纠偏固定经过：

```text
Agent 写入命中文件
  -> 执行已启用硬规则
  -> 按需创建一次性隔离 reviewer
  -> 合并诊断并校验候选 Diff
  -> 主 Agent 决定是否最小修正
  -> 再次检查并记录结果
```

插件只诊断和提供审阅上下文，不自动修改目标产物，也不自动应用 Patch。

## 常用入口

```text
/runtime-corrector:stages
/runtime-corrector:explain <stage>
/runtime-corrector:spec <stage>
/runtime-corrector:check <artifact>
```

需要完整的四阶段示例时，查看插件目录中的
`examples/ir-planning-selection-prd-contract/`，不要把示例业务规则当作插件默认行为。
