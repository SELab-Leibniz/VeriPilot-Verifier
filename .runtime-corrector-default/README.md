# Runtime Corrector 项目规则

这个目录由 OpenClaw / MatrixAssistant 的 `/rc-project init` 从插件默认模板复制到 Session 实际绑定的项目中。模板用需求原文审查 OpenSpec 的 proposal、差量规格、design、tasks 及配置的直接入边。差量规格按变更关联提案，任务清单审阅也会读取同一变更的差量规格。Stop 使用原文清单并报告有反证的偏差。模板关闭需求基线、文档阶段指标、实现纠偏、Skill 看护和压缩恢复。规则与评审标准均可按项目修改。

初始化后，项目总开关 `enabled` 和首次登记会话的默认开关 `sessionDefaults.enabled` 均为 `false`。`reviewers.defaults.model` 在创建时复制当前 OpenClaw RC 的 `reviewerModel`，随后可以按项目修改，不会持续覆盖。已有 `.runtime-corrector` 不覆盖。

在当前会话执行 `/rc-project on`，再执行 `/rc-session on`，即可允许该会话使用已配置的纠偏功能。修改 `sessionDefaults.enabled` 不会改变已登记会话的选择；各会话独立设置保存在 `sessions.local.yaml`，应加入项目的 Git 忽略规则。

## 三层控制

1. `enabledStages`：Stage 总开关。
2. `artifacts[].rules.enabled`：确定性硬规则开关。
3. `artifacts[].review.enabled` 与 `workflow.edges[].review.enabled`：节点和边的语义审阅开关。

默认模板用于 OpenSpec `spec-driven` 流程。`specs → tasks` 入边缺少差量规格时标记为待补齐。使用允许省略差量规格的自定义流程时，可将这条边的 `review.enabled` 设为 `false`。从 `enabledStages` 移除 `specs` 会关闭差量规格的写入触发；任务清单仍按已配置的入边读取来源。

## 可选：同一变更整包审阅

使用 proposal、design、tasks 和差量规格的项目，可选择插件安装目录下 `.runtime-corrector-default/openspec-full-plan.topology.yaml`。它按变更名收集完整方案，在 proposal、design、tasks 和至少一份差量规格齐备后启动语义审阅；草稿写入仍执行确定性检查，之后修改任一成员会重新审阅当前整包。独立启用的 Ground Truth 或运行时审查仍遵循原有设置，可能在草稿未齐时运行。

先备份项目配置，再将随附的 `openspec-plan.rules.yaml` 复制到项目 `.runtime-corrector/`；已有同名文件时先核对内容。将 overlay 的 `enabledStages`、`artifacts`、`workflow` 三个顶层值合入当前 `config.yaml`，审阅并替换原有拓扑；不要用 overlay 覆盖整个配置。保留模型、时限、项目与会话开关、原文覆盖和任务 READY 要求、Stop 及验证设置；已有自定义审阅标准也须核对。`/rc-project init` 不自动选择或复制这两个可选资源。

此选项只适用于上述文件结构。文件齐备只决定何时审阅，不证明所有能力规格、需求或实施任务完整；Apply 前仍须执行既有的 OpenSpec 校验、当前方案覆盖和任务就绪检查。它不会自动开启未配置的严格检查。

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

## 常用命令

```text
/rc-project on|off|status
/rc-session on|off|status
/rc-session-default on|off|status
```

项目关闭会暂停项目内所有会话的 RC，并保留其任务和额度；会话默认开关只决定后续首次登记时的初始值。开关命令不修改具体纠偏功能的实现或参数。
