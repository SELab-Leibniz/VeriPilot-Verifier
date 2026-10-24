# OpenClaw 原生纠偏与独立 Stop 终审

当前候选包 `1.9.1-openclaw.11-session-projects.11` 支持 Session 项目解析、显式启用与状态隔离，兼容 `2026.7.1-2` 和 `2026.10.3`。7.1（包括 MA）存在持久化 `spawnedCwd` 时自动跟随宿主项目，缺失时才使用 `/rc-project bind /绝对项目目录`；新版使用宿主 New Session 项目选择。自动模式禁用 RC 手动绑定。没有有效项目配置时不运行零配置纠偏。详见 [Session 项目说明](session-projects.md)。下文旧版真实 Stop 闭环属于历史验证，不替代新版候选的验收。

原生执行、Stop 续作和独立终审预算已通过提交 `f76e7b5` 合入 `codex/openclaw-2026.7.1-2`，固定宿主 OpenClaw `2026.7.1-2`。合并代码不自动替换已安装插件或宿主配置。独立预算 Todo 对照和一次真实 Stop 重修闭环详见 [预算实测](experiments/rc-native-stop-budget-live-test.md)、[迷你重修实测](experiments/rc-native-stop-mini-live-test.md)。[合并后记账 App 实测](experiments/rc-postmerge-ledger-live-test.md)跑通两次 Stop、一次宿主重修、最终 19/19 独立 CLI 检查；首次终审超过 10 分钟并完成。RC PASS 不等同于全部业务需求均已通过独立检查。

业务运行、输出、模型选择、工具和审批由宿主负责。RC 不注册业务 harness、不关闭流式文字、不应用补丁、不注册 `before_agent_finalize`。过程意见通过原工具结果交给宿主；Stop 发现有依据的业务偏离时，最多提供配置数量的原生续作机会，宿主自行判断动作。

```yaml
stopCorrection:
  enabled: true
  maxCorrectionsPerEpoch: 3
  assessmentTimeoutMs: 3600000 # 可选：一套 RC 终审的总窗口
  waitMode: until_pass # 默认：等待宿主修正并复验到 PASS；assessment 只等本轮评审与反馈准入
  waitTimeoutMs: 3600000 # 可选：整条修正与复验链的总等待上限
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

角色时间仍在自己的 YAML。原生回复/结束 Hook 只登记 RC 终审回执，业务回复立即返回；评审使用 RC 自己的工作准入与截止时间，不借用宿主业务运行或 Hook 的剩余时间。`stopCorrection.assessmentTimeoutMs` 现在也用于原生 RC 终审总窗口；不配置时沿用既有各角色预算与设备检查预算之和。每个角色仍受自己的 `reviewers.<role>.timeoutMs` 和 RC 总窗口约束，不是每个阶段无限续期。

检查器故障按原核心基础设施预算重新评审，复评使用不同评审身份，但同一 RC 总截止时间；不增加业务 k、不重新冻结用户需求、不让宿主为检查器故障修改业务。重置、项目切换、会话结束和 Gateway 关闭会取消旧评审；来源/证据失效仍不派发。每个原生业务 run 的回执保存于 `.runtime-correction/openclaw/native-stop-reviews/`，状态为 PENDING/RUNNING/SETTLED，最终 reviewStatus 保存 PASS/DEVIATION/UNVERIFIED/CANCELLED。重启不会偷偷重放旧评审或业务反馈。

### Stop 等待门（本分支）

原生 Stop 登记终审后，回复会提示 RC 正在验收。同会话的下一条普通任务在公开的 `reply_dispatch` 等待，该入口提供当前请求的 runId 和取消信号；直接原生 Agent 入口由 `before_model_resolve` 补充保护，RC 更新当前 runId 之前也会检查。其他会话独立运行，可信回执标识的 RC 续作可直接进入，避免等待自己的派发完成。

`stopCorrection.waitMode` 默认是 `until_pass`：初审发现偏差后，继续等待宿主实际修正及后续 Stop 复验，只有纠偏链当前运行的有效 PASS 才正常放行下一任务。等待门覆盖“反馈已派发、宿主正在修正、尚未开始下一次评审”的间隔，跨原生 runId 沿用同一条链；旧轮次结论不能代替新一轮复验。`maxCorrectionsPerEpoch` 仍限制纠偏次数，最后一次允许的修正仍有完整复验机会。

需要原行为时，在项目 `.runtime-corrector/config.yaml` 中设置 `stopCorrection.waitMode: assessment`：只等待本轮评审及纠偏反馈的宿主准入回执。发现偏差时先记录评审，再完成一次有界派发；最终记录中的 `followupStatus` 区分宿主接受、拒绝与未确认。此模式不要求后续修正到 PASS；新任务仍遵守宿主自己的排队策略。

`until_pass` 的总等待上限由可选 `stopCorrection.waitTimeoutMs` 指定，包含宿主修正及多轮复验；省略时继承一套终审的预算。整条链沿用首次登记的模式和总截止时间，不在每次续跑时重新计时；单次评审仍受 `assessmentTimeoutMs` 和各角色预算约束。`assessment` 沿用本轮评审剩余窗口。实际入口等待还取当前 Hook 可用窗口的较短值；Hook 窗口沿用插件 `hookTimeoutMs` 和宿主对应 Hook 策略，并保留一秒返回余量。

两种模式都在次数耗尽仍未通过、反馈被拒或未确认、评审故障、总超时或用户取消时明确提示后放行；次数耗尽保留 DEVIATION，故障/超时保留 UNVERIFIED，取消保留 CANCELLED 或已提交的原评审结论，不将异常当成 PASS。超时取消 RC 自己的检查，不中止宿主业务执行。即使后端或清理回调不响应，等待门也能释放，迟到结果不能改写等待终态或重新打开原链。后续来源或文件发生变化时，原有证据校验仍阻止过期反馈；重启不会重放旧链。无需修改宿主。

实际等待期间每 30 秒通过公开 Agent 工具进度事件发送状态；验收完成、反馈拒绝或超时发送结束进度。回复尾部的验收提示只作用于发送载荷，状态事件不追加主会话模型消息，也不替换原回复正文。后台评审不对已结束的业务 run 发送保活。没有可用展示通道时尽力提示，通知失败不影响放行。

可用 `node scripts/diagnostics/stop-wait-gate-contract.mjs <hostRoot> <全新输出目录> [空闲Gateway端口]` 做隔离验证：脚本使用本地确定性模型服务，验证默认通过、跨修正与复验等待、显式 assessment 模式、次数耗尽及超时放行，检查真实宿主事件及下一轮模型输入。测试副本通过公开 Hook 观察等待门后的准入，避免把宿主自身排队误当作 RC 等待；无外部模型调用，不改已安装宿主或业务会话。

## Review 超时配置

所有语义评审和角色 reviewer 默认 20 分钟，最大 60 分钟（1000～3600000 毫秒）。在项目 `.runtime-corrector/config.yaml` 中设置：

```yaml
limits:
  semanticReviewTimeoutMs: 1800000 # 语义评审 30 分钟
reviewers:
  defaults:
    timeoutMs: 1200000 # 所有角色默认 20 分钟
  stopReviewer:
    timeoutMs: 3600000 # 终审角色 60 分钟
```

优先级：角色配置 > reviewers.defaults > limits.semanticReviewTimeoutMs > 20 分钟。基线抽取和裁决同样遵守配置。格式修复与续问共用同一个角色截止时间；总评审窗口、宿主取消及较短的 Hook 预算仍然生效。`hookTimeoutMs` 自身也是默认 20 分钟、最大 60 分钟；它与单个 reviewer 及多阶段总预算分别配置。

原生 Hook 等待 reviewer 时，RC 每 30 秒发送标记为 `runtime-corrector.review` 的工具进度 `update`。MA 1.10.1 的桌面主进程会过滤自定义 Agent 流，旧版 `runtime-corrector.progress` 无法刷新空闲检查；新版本经宿主 `session.tool` 和 MA 现有聊天事件入口更新进度。只发送 `update/end`，不发送模型工具调用 `start` 或结果 `result`，不覆盖业务工具错误摘要；阶段提示也不再写入助手正文。定时器不冒充诊断模型进展，不延长原预算；取消、父运行结束及截止时间均停止周期上报。

Stop 等待使用同一通道，只刷新实际受阻的当前请求；已结束主运行的后台审查及尚无 runId 的排队请求不发送保活。兼容验证读取安装包内真实主进程过滤/转发函数和前端计时/工具分支，未知版本或入口变化直接报错。此项已验证 MA `1.10.1` + OpenClaw `2026.7.1-2` 的函数契约，仍不等于完整 Electron 桌面进程的真实长时验收。详见 [MA 传输修复与验证边界](experiments/ma-progress-transport-20261022.md)。

## 安装前提

### MA 启动后插件配置消失

MA `1.8.160` 的 `cleanupStalePluginConfigs` 不扫描标准的 `~/.openclaw/extensions`，扫描 `plugins.load.paths` 时只检查 manifest 的 `main`（缺省为 `dist/index.js`），不读取 `package.json` 的 `openclaw.extensions`。因此仅执行 OpenClaw 的 install/enable 后，合法插件仍可能被误判为 stale，并从 `plugins.allow` 和 `plugins.entries` 删除；插件文件仍在。

新版产物已在 manifest 中补齐原生入口 `main`。关闭 MA 后，从本仓库构建、使用宿主内置 CLI 重新安装，再运行一次配置命令：

```powershell
npm run build:plugin
node "<MA安装目录>/resources/openclaw/openclaw.mjs" plugins install --force ./dist/runtime-corrector-openclaw
node ./scripts/configure-ma-host.mjs
```

配置命令验证已安装入口，将该插件的绝对目录追加到 `plugins.load.paths`，启用 RC 及所需 Hook 权限，保留其他配置，并在写入前备份原文件。重复执行不增加重复路径或重复备份。自定义配置位置可传 `--config <openclaw.json>` 和 `--plugin-root <已安装插件目录>`；如此前清理已删除 RC 模型设置，可显式传 `--reviewer-model <provider/model>` 恢复。命令不会自动读取旧备份或恢复其中的其他设置。重新打开 MA 后生效。

MA 同时会将顶层 `tools.alsoAllow` 精确同步为内置模板，手工添加的 `runtime_corrector` 会在启动时被移除。若需在主助手使用此工具，运行 `node ./scripts/configure-ma-host.mjs --tool-agent main`，把授权保存到现有 `agents.list` 中 `id: "main"` 的 `tools.alsoAllow`，这个位置由 MA 保留。首次创建该 Agent 的列表时继承当前全局额外工具；已有独立列表则保留其范围，只追加 `runtime_corrector`。全局工具设置、其他 Agent 及所有 deny 规则保持不变；不会给业务助手开放评审员专用的 `rc_progress`。其他助手须使用其实际 Agent ID 显式配置。

合并不自动安装。当前候选包版本 `1.9.1-openclaw.11-session-projects.11`。从旧受控执行版本迁移时，业务需使用原生 `openclaw`；只移除 RC 自己此前添加的 `runtime-corrector-supervised` 绑定与 `supervisedExecution`，保留其他模型、运行时、凭据、工具、审批及时间设置。新版宿主的 Node 要求以其安装包为准：`2026.10.3` 使用 Node `>=24.16.0 <25` 或 `>=26.1.0`。

```json
{"plugins":{"entries":{"runtime-corrector":{
  "enabled":true,
  "hooks":{"allowConversationAccess":true,"allowPromptInjection":true},
  "config":{"reviewerModel":"registered-provider/model","hookTimeoutMs":1200000}
}}}}
```

保留原 RC 需求账本、来源验证、程序引文、逐项进度/有效部分反馈与可配置三次格式修复。没有引入新总结 LLM、业务执行器或通用调度框架。
