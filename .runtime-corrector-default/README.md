# Runtime Corrector 项目规则

这个目录由 OpenClaw / MatrixAssistant 的 `/rc-project init` 从插件默认模板复制到 Session 实际绑定的项目中。默认 `config.yaml` 来自用户提供的 `SEWeekly/鸿蒙kit开发的长程任务/202611/default_rc_config/config.yaml`，随插件打包，初始化时不依赖该来源路径。模板关闭 OpenSpec 阶段审阅、产物原始需求纠偏、动态需求基线、实现纠偏和 Skill 看护，开启 Stop 原始需求审查与需求框架检查；M08、M12 关闭，其余 M 指标开启。规则与评审标准均可按项目修改。

初始化保留模型以外的模板配置：项目总开关 `enabled: true`，首次登记会话的默认开关 `sessionDefaults.enabled: false`；默认评审与 Stop Reviewer 各自超时为两小时。Stop 审查窗口两小时，反馈预留五分钟，会话与流程各最多纠偏三次。模板中的回归检查命令保留，但 `regressionCheck.enabled: false`，不会执行。已有 `.runtime-corrector` 不覆盖。

在当前会话执行 `/rc-session on`，即可允许该会话使用已配置的纠偏功能；项目已手动关闭时先执行 `/rc-project on`。初始化时，`reviewers.defaults.model` 及模板内各角色的显式 `model`（包括 `stopReviewer.model`）均改为当前 OpenClaw RC 的 `reviewerModel`，避免沿用模板来源环境中的模型；缺少宿主 RC 模型时先执行 `/rc-setup`。这使用宿主当前配置，不进行逐个模型的联网可用性探测。初始化后可按项目修改模型，重复初始化不会覆盖已有配置。修改 `sessionDefaults.enabled` 不会改变已登记会话的选择；各会话独立设置保存在 `sessions.local.yaml`，应加入项目的 Git 忽略规则。

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

## 常用命令

```text
/rc-project on|off|status
/rc-session on|off|status
/rc-session-default on|off|status
```

项目关闭会暂停项目内所有会话的 RC，并保留其任务和额度；会话默认开关只决定后续首次登记时的初始值。开关命令不修改具体纠偏功能的实现或参数。
