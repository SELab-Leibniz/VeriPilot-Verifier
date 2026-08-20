# Runtime Corrector 文档

第一次使用只需阅读根目录 [README](../README.md)。需要理解或定制插件时，再按问题进入对应文档。

## 文档导航

| 我想了解 | 文档 |
|---|---|
| 如何启用任务 Ground Truth、Skill 执行看护、M01–M15 与有限 Stop 纠偏 | [Runtime Corrector v2 设计与配置](runtime-corrector-v2-design.md) |
| 从客户视角理解价值、信任边界、50 个关键问题、互动纠偏闭环与代码证据 | [Runtime Corrector 客户理解指南](customer-guide/runtime-corrector.html)（可直接双击打开） |
| 一次写入如何变成诊断，Agent 如何收到反馈 | [完整运作机理](how-it-works.md) |
| 如何开关阶段、修改匹配路径、规则、Reviewer、Schema 和输出持久化 | [配置与规则参考](configuration.md) |
| Claude 命令、Skill、隔离语义审阅、CLI、Hook JSON、自定义 Matcher/Collector | [外部接口参考](interfaces.md) |
| 从加载插件到使用四阶段 example、纠偏和定制规则 | [完整使用教程](tutorial.md) |
| 直接复制 IR → Planning → Selection → PRD Contract 配置与 prompt | [四阶段示例](../examples/ir-planning-selection-prd-contract/README.md) |
| 从零配置需求分析到 DT 设计的六阶段 DAG、硬规则、Review 标准，并用模板路径执行 Claude 穿刺 | [六阶段 Workflow 新手教程](six-stage-workflow-from-zero.md) |
| 在同一项目保留多个 change，并按 `changeName` 隔离上下游文档 | [多 change 实例关联示例](../examples/change-delivery-workflow/README.md) |
| 把 HarmonyOS Workflow 当作 Prompt Contract，并用命名 Ground Truth 和 checkpoint 看护 TodoList 文档 | [TodoList Prompt Contract 示例](../examples/harmonyos-todolist-prompt-contract/README.md) |
| 不调用 Planning/IR，由 Agent 将六阶段投影为四件套，再运行 PRD 与 Build QA auto | [受控交付 Workflow 教程](guarded-delivery-workflow-from-zero.md) |
| 如何创建、注册、启用自定义 Stage，并对 design.md 或 Markdown + JSON Bundle 做纠偏 | [交互式自定义 Stage 教程](../tutorial.html) |

## 推荐阅读顺序

1. 建立整体认识：[Runtime Corrector 客户理解指南](customer-guide/runtime-corrector.html)
2. 初次接入：[完整使用教程](tutorial.md)
3. 四阶段交付示例：[IR → Planning → Selection → PRD Contract](../examples/ir-planning-selection-prd-contract/README.md)
4. 六阶段文档 Workflow：[六阶段 Workflow 新手教程](six-stage-workflow-from-zero.md)
5. 并行 change：[实例关联示例](../examples/change-delivery-workflow/README.md)
6. Prompt Contract：[HarmonyOS TodoList 示例](../examples/harmonyos-todolist-prompt-contract/README.md)
7. 六阶段到完整交付：[受控交付 Workflow 教程](guarded-delivery-workflow-from-zero.md)
8. 自定义 Stage：[交互式 design.md 与 Markdown + JSON 教程](../tutorial.html)
9. 团队定制：[配置与规则参考](configuration.md)
10. 编排器或工具集成：[外部接口参考](interfaces.md)
11. 审计与排障：[完整运作机理](how-it-works.md)

## 最小心智模型

```text
阶段开关 config.yaml
        ↓
确定性检查 *.rules.yaml
        ↓
语义审阅 *.reviewer.md
        ↓
主 Agent 决定最小修正
```

项目内策略文件和 CLI 输出是客户可见的权威来源。普通使用和规则定制不需要阅读插件 JavaScript 源码。
