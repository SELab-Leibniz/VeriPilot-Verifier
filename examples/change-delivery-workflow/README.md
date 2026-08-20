# Change Delivery Workflow 示例

这个目录既是可直接交给 Claude 的工作流 prompt，也是 Runtime Corrector 的项目级配置示例。复制整个目录到一个项目后，用 `workflow.yaml` 作为 prompt，即可让插件看护生成的六类文档。

## 目录

```text
workflow.yaml
src/cli.mjs
.runtime-corrector/
  config.yaml
  rules/                 # 可确定判断的格式与必填内容
  reviewers/nodes/       # 单文档语义和事实审查
  reviewers/edges/       # 前后文档一致性审查
```

`src/cli.mjs` 是最小验证素材，只用于让“代码理解”有真实源码可读，不属于插件实现。

## 工作流映射

`workflow.yaml` 描述的是创作过程，`.runtime-corrector/config.yaml` 看护的是创作结果：

```text
需求分析 ─┬─> UX设计稿（可选） ─┐
         └─> 需求拆分 ─────────┴─> 代码理解
代码理解 ─> 方案设计 ─> 人工测试用例 ─> DT测试用例
```

需求分析和需求拆分共同维护一份需求分析报告，因此配置中只有一个 `requirements-report` 产物节点。若为它们配置两个相同文件模式的节点，文件只会命中第一个节点，既增加歧义，也不能表达“丰富同一文档”。

UX 是真正的可选产物。配置保留 `requirements-report -> ux-design` 的一致性边，但不把 `ux-design -> code-understanding` 设为强制输入边，否则未生成 UX 时会产生错误的缺失上游提示。代码理解节点把 UX 文件列为相关文件，并要求 reviewer 在 UX 存在时检查一致性。

## Change 实例

六类产物使用 `pathTemplates`，并以 `changeName` 作为 correlation key。同一 change 可以在不同
日期生成后续文档；插件仍会把它们连接为同一实例。目录中同时存在其他 `changeName` 时，其他
实例不会进入本轮上游、相关 artifact 或 reviewer 请求，只有 `workflow.yaml` 和 `src/**/*`
等项目级证据继续共享。

`changeName` 由调用者在首次写入前决定。同一 change 的所有 stage 必须复用它；新 change 不
自动继承历史 change。若意图不明确，先使用 `runtime-corrector-workflow` Skill 选择继续已有
实例或创建新实例。

## 分工原则

- YAML 硬规则检查标题、检查项数量、`REQ-` 追溯标识和明显占位符。这些结果稳定、快速且容易定制。
- 节点 reviewer 检查单文档的事实、完整性和语义。
- 边 reviewer 检查相邻文档是否遗漏、冲突或扩大范围。
- 插件本身不包含任何“需求分析”“UX”或其他业务 stage 的专用代码；新增 stage 只需要增改项目配置。

## 使用

将目录内容复制到待验证项目，确保 Runtime Corrector 以项目 scope 启用，然后把完整的 `workflow.yaml` 内容作为 prompt 交给 Claude。
主 Claude Code 会话需要保持可恢复状态，不要使用 `--no-session-persistence`；节点和边的
reviewer 会从父 session 创建一次性只读 fork。手动 CLI `check` 只验证确定性规则并返回
待执行 reviewer，不会替代这条 PostToolUse 真实链路。

示例输入会生成：

```text
spec/2026-07-27-需求分析报告-dry-run.md
spec/2026-07-27-UX设计稿-dry-run.md
spec/2026-07-27-代码理解报告-dry-run.md
spec/2026-07-27-模块设计报告-dry-run.md
spec/2026-07-27-人工测试用例-dry-run.md
spec/2026-07-27-DT测试用例-dry-run.md
```

运行时结果保存在 `.runtime-correction/`。每个被匹配的文档应留下诊断、修补建议和 reviewer 结果；违反硬规则时，Claude 会收到可操作的纠偏提示。

若要定制新流程，优先修改：

1. `workflow.yaml` 中的 stage 和输出路径。
2. `config.yaml` 中的产物节点与必需依赖边。
3. `rules/` 中可机械判断的约束。
4. `reviewers/` 中必须结合上下文判断的语义标准。

不要为了某个新 stage 修改插件代码，除非出现无法用现有通用规则或 reviewer 表达的运行时能力缺口。
