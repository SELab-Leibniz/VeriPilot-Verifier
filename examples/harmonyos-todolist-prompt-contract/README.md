# HarmonyOS TodoList Prompt Contract 纠偏示例

这个示例把 `baseline_workflow.yaml` 当作交给开发 Agent 的 Prompt Contract，而不是由 Runtime Corrector 执行的流程定义。Agent 仍按自己的宿主流程生成文档和实现证据；Corrector 只在 Write/Edit 命中 Artifact 后检查当前节点、直接上游和声明的 Ground Truth。

## 示例需求

- 新增待办；
- 完成和取消完成；
- 终止并重新启动应用后仍保留待办及完成状态；
- 不做账号、云同步和真实后端。

## 节点映射

```text
requirements -> ux-design
requirements -> code-understanding -> solution-design
solution-design -> manual-test-cases -> dt-test-cases
solution-design + manual-test-cases + dt-test-cases -> implementation-checkpoint
```

`prompt/user-request.md` 与 `baseline_workflow.yaml` 是命名 Ground Truth。每个目标 Artifact 都显式引用它们；它们只读、不会成为候选 Patch 目标。

## 验证

```text
runtime-corrector validate --cwd <本示例目录>
runtime-corrector check spec/todolist/requirements.md --cwd <本示例目录> --format json
runtime-corrector check evidence/todolist/checkpoint.json --cwd <本示例目录> --format json
```

示例不要求 Corrector 推进 Stage，也不把 Corrector 的 `passed` 当成宿主工作流的 acceptance。
