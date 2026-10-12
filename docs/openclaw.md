# OpenClaw 原生输出隔离候选

分支 `codex/openclaw-native-transparency` 从 `f19f2fc` 创建，目标仍为 OpenClaw `2026.7.1-2`。本版只用于隔离实验，未替换原分支或用户安装。过程输出与纠偏已验证，但仪表盘未显示最终 RC 摘要，当前不建议直接替换原安装。

保留当前 RC 需求账本、来源校验、程序引文、逐项进度/部分反馈、输出字段容错及默认三次格式修复。提取 `codex/reviewer-information-map` 的原生执行边界，不整体移植其观察器、并发调度、评审缓存或其他评审流程。

业务使用宿主原生 `openclaw` 运行时。RC 不注册业务 harness、私有工作会话、控制服务、状态页或业务发送/继续/停止入口。原文本、工具结果、媒体、问题和审批保持宿主流程。过程纠偏仍通过原工具结果交给宿主判断。

固定宿主发现 `before_agent_finalize` Hook 时会暂存原生 assistant 文本。V2 实验确认移除私有 harness 只能恢复工具事件，文本仍到终审后发出。V3 不注册这一终止门；完整 Stop 核心评审转至文本最终回复的 `reply_payload_sending` 阶段，保留原回复，尝试追加状态与偏离依据，不取消发送、不强制结束、不另建业务修正运行。

过程反馈可影响当前工具循环，终审反馈供用户和宿主后续判断。本版不保留旧私有控制器在终审之后自动串行修正的能力。“正常回复已交付”不能解释成 RC 验收通过。普通无业务操作的问答、纯媒体与审批不触发完整终审。

完整 App 补跑已保存终审 PASS，但仪表盘先显示原生 final，并不会自动显示后续 Hook 追加的普通文字。当前聊天摘要交付未通过，其他渠道未实测；不能凭正常业务交付文字推断 RC 验收状态。

## 部署配置

仅在确认隔离结果后安装，不自动修改当前宿主。

```sh
npm run build:plugin
openclaw plugins install --force /absolute/path/dist/runtime-corrector-openclaw
```

候选版本 `1.9.1-openclaw.10-native-transparency.1`。仅迁移原先绑定 `runtime-corrector-supervised` 的 provider/model，移除旧绑定或设为原生 `openclaw`，保留其他运行时、模型、凭据和审批设置。移除插件配置 `supervisedExecution`。已有 `plugins.allow` 时确保包含 `runtime-corrector`。

```json
{
  "models": { "providers": { "your-provider": { "agentRuntime": { "id": "openclaw" } } } },
  "plugins": { "entries": { "runtime-corrector": {
    "enabled": true,
    "hooks": { "allowConversationAccess": true, "allowPromptInjection": true },
    "config": { "reviewerModel": "registered-provider/model", "hookTimeoutMs": 600000 }
  } } }
}
```

项目角色设置仍在 `.runtime-corrector/config.yaml`，不配置 CLI `reviewerRuntime`。

```yaml
reviewers:
  defaults:
    model: registered-provider/model
    effort: low
    timeoutMs: 1200000
    formatRepairAttempts: 3
```

修复次数默认从 RC `config/reviewer-defaults.json` 读取，项目/角色可覆盖。同一角色及修复共享原截止时间。原生同步 Hook 仍受宿主 Hook 时限限制；配置 20 分钟并不表示每个原生 Hook 都能等待 20 分钟。本实验 Hook 上限仍为 10 分钟。旧 `stopCorrection.assessmentTimeoutMs` 用于旧控制器拥有的评估窗口，当前原生回复路径不使用它，不作为新版有效配置示例。

完整重启后核对实际插件和模型运行时；不通过更新全局超时、关闭检查或开启 shadowMode 冒充兼容。实验与具体未验证项见 [App 对比记录](experiments/rc-native-transparency-live-test.md)。
