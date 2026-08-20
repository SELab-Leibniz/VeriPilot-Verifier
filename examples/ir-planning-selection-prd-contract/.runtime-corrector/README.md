# IR → Planning → Selection → PRD Contract 示例规则

这个目录是四阶段示例的纠偏控制面。它只属于 example，插件不会把这些业务 Stage
作为默认行为，也不会在隐藏位置替项目决定规则。

## 三层控制

1. `config.yaml` 的 `enabledStages`：阶段总开关。
2. artifact 的 `rules.enabled`：确定性硬规则开关；`rules.file` 指向规则文件。
3. artifact 或 Workflow 边的 `review.enabled`：语义审查开关；`criteria` 指向可选的项目标准。

一次纠偏固定经过：

```text
Agent 写入命中文件
  -> 执行 rules.enabled: true 的硬规则
  -> 有 review.enabled: true 时创建一次性隔离语义审阅
  -> 合并诊断并校验候选 Diff
  -> 主 Agent 决定是否最小修正
  -> 再次检查并记录结果
```

插件只诊断和提供审阅上下文，不会自动修改目标产物，也不会自动应用 Patch。

`config.yaml` 会先通过插件自带的 JSON Schema 做结构校验，再与其他配置来源一样只经过
一次策略编译。运行层不包含具体 stage 分支；新增 stage 时编辑本目录的 YAML、Reviewer
和 JSON Schema 即可，不需要读取或修改插件 JavaScript。若要从零开始配置另一个项目，
请优先运行 `/runtime-corrector:init` 生成通用模板。

## 控制 Diff

`config.yaml` 的输出配置默认是：

```yaml
output:
  persist: true
  mode: centralized
  directory: .runtime-correction
```

任一 artifact 或 bundle 成员命中 PostToolUse hook 后，插件先执行已启用硬规则；节点或任一直接入边的 `review.enabled: true` 时，才从当前 session 创建一次性隔离 fork。两类 review 全部关闭时不创建 fork。最新结果位于 `.runtime-correction/latest/<stage>/<artifact-key>/`，不可变历史位于 `.runtime-correction/runs/<stage>/<artifact-key>/<run-id>/`。

启用语义审阅时，主 Claude Code 会话必须可恢复；不要用 `--no-session-persistence` 启动
主会话。该参数只用于插件创建并在完成后释放的一次性 reviewer 子会话。

本示例的多文件审阅将 `limits.semanticReviewTimeoutMs` 设置为 `1200000`（20 分钟）。
Runtime Corrector 自己的 PostToolUse Hook 外层上限为 1260 秒；其他 Hook 的超时不受影响。

## 开关阶段

在 Claude Code 对话窗中，先用以下入口查看帮助或控制阶段：

```text
/runtime-corrector:help
/runtime-corrector:stages
/runtime-corrector:spec selection
/runtime-corrector:stages planning off
```

也可以直接说“只开启 Selection 和 PRD Contract 纠偏”或“关闭 Planning，其他阶段不动”。自然语言和命令都使用同一个 `enabledStages` 控制面，不会删除规则文件。

```powershell
runtime-corrector stages
runtime-corrector stage planning off
runtime-corrector stage planning on
```

也可以直接编辑：

```yaml
enabledStages:
  - selection
  - prd-contract
```

未列出的 stage 不会匹配或检查文件；规则文件仍保留，重新开启即可恢复。

## 修改硬规则

整个节点的硬规则在 `config.yaml` 中控制：

```yaml
rules:
  enabled: false
  file: selection.rules.yaml
```

编辑对应的 `*.rules.yaml`。规则内部设置 `enabled: false` 可以只关闭一条规则：

```yaml
rules:
  - id: EXAMPLE-RULE
    type: require-text
    values:
      - 必须出现的内容
    severity: error
    enabled: false
```

保存后，下一次命中文件写入立即使用新规则。

## 修改 Agent 审阅标准

节点语义审查在 `config.yaml` 中控制：

```yaml
review:
  enabled: true
  criteria: selection.reviewer.md
```

直接编辑对应的 `*.reviewer.md`，使用团队能读懂的自然语言描述：

- 需要同时读取哪些上游文件；
- 什么属于范围扩张；
- 哪些事实必须引用证据；
- 什么条件才算纠偏完成。

关闭语义审查请设置 `review.enabled: false`。criteria 文件为空会明确报错，不再被解释为开关；省略 `criteria` 表示只执行内置基线。

## 查看实际执行内容

```powershell
runtime-corrector explain selection
runtime-corrector spec selection
runtime-corrector check kit-map.md
```

`explain` 快速展示当前实际命中的来源；`spec` 展开全局精确格式、当前 rules、全部 schema 和 reviewer；`check` 返回具体规则 ID、文件位置、证据、确定性 Patch 数量和建议。手动 `check` 不创建隔离 session，非空 reviewer 会以 `agentReview: requested` 返回；包含已完成语义审阅的结果来自 `Write` / `Edit` 后的 PostToolUse 自动检查。重复失败时先读 `spec`，无需阅读插件测试或源码。
