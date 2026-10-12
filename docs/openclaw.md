# OpenClaw 原生 Stop 续作隔离候选

`codex/openclaw-native-stop-followup` 从原生输出候选 `522a6ea` 创建，固定宿主 OpenClaw `2026.7.1-2`。当前仅用于隔离验证，未替换原分支或当前安装。真实 App 对照 13/14 → 14/14，原生续作后完整验收 PASS，详见 [实测记录](experiments/rc-native-stop-followup-live-test.md)。

业务运行、输出、模型选择、工具和审批由宿主负责。RC 不注册业务 harness、不关闭流式文字、不应用补丁、不注册 `before_agent_finalize`。过程意见通过原工具结果交给宿主；Stop 发现有依据的业务偏离时，最多提供配置数量的原生续作机会，宿主自行判断动作。

```yaml
stopCorrection:
  enabled: true
  maxCorrectionsPerEpoch: 3
reviewers:
  defaults:
    model: registered-provider/model
    effort: low
    timeoutMs: 1200000
    formatRepairAttempts: 3
```

k 默认来自包内 `config/stop-defaults.json`，项目 `.runtime-corrector/config.yaml` 优先。沿用原纠偏 epoch：正式 HARD 需求更新可重新开预算，RC 自有反馈不计为新用户需求。Reviewer 超时、格式故障使用原独立故障预算，不当作业务已确认偏离。耗尽仍未通过时保留未通过，不能显示 PASS。PASS 可通过已有记录查询，无须在聊天强插摘要。

续作通过公开 `api.runtime.subagent.run` 在同一会话开启下一次原生运行，沿用宿主设置。派发回执区分准备、宿主接受、反馈观察、再次评审完成；不确定派发不重试，确认拒绝不算已读取。下一次自有运行从 `agent_end` 完整复验，最多 k 次。

该公开接口持久化的提示会在宿主聊天显示为一条额外 You 消息，正文标记 RC 意见/非新需求或授权。RC 只在自己的可信转录投影排除它，不写宿主原转录、不改 UI 标签。真实问题、媒体、错误、审批和正常取消保留宿主处理；实际审批 UI 尚未实测。

角色时间仍在自己的 YAML。每次原生业务运行遵循宿主超时；同步 Hook 仍受宿主 10 分钟上限约束，20 分钟角色配置不能突破此限制。旧 `stopCorrection.assessmentTimeoutMs` 属旧私有控制器窗口，不作为新路径有效时间示例。

## 安装前提

本实验不自动安装。候选包版本 `1.9.1-openclaw.10-native-stop-followup.1`。若以后由用户选择迁移，业务需使用原生 `openclaw`；只移除 RC 自己此前添加的 `runtime-corrector-supervised` 绑定与 `supervisedExecution`，保留其他模型、运行时、凭据、工具、审批及时间设置。

```json
{"plugins":{"entries":{"runtime-corrector":{
  "enabled":true,
  "hooks":{"allowConversationAccess":true,"allowPromptInjection":true},
  "config":{"reviewerModel":"registered-provider/model","hookTimeoutMs":600000}
}}}}
```

保留原 RC 需求账本、来源验证、程序引文、逐项进度/有效部分反馈与可配置三次格式修复。没有引入新总结 LLM、业务执行器或通用调度框架。
