# MatrixAssistant / OpenClaw 纠偏与 Stop 审查

当前生产 Stop 使用共享评估核心和单 Agent 分组逐项提交，主要适配 MatrixAssistant 内置 OpenClaw `2026.7.1-2`。支持的另一版本为 `2026.10.3`，其项目与审阅适配不代表新的自动续作协议已整体验收。完整真实模型、桌面长时边界、进程重启/GT 缓存恢复与 K 分组性能仍待单独验收。构建不会自动安装到现有宿主。

Session 项目解析、显式启用和作用域隔离继续遵循 [Session 项目说明](session-projects.md)。7.1（包括 MA）优先跟随宿主持久化的 `spawnedCwd`，缺失时才使用 `/rc-project bind /绝对项目目录`；自动模式不接受手动绑定。没有有效项目配置时不启动自动审查。

```yaml
stopCorrection:
  enabled: true
  waitMode: until_pass
  maxCorrectionsPerSession: 3
  maxCorrectionsPerFlow: 3
  assessmentTimeoutMs: 1200000 # 每次 Stop 总审查与交付窗口，20 分钟
  feedbackReserveMs: 180000 # 包含在总窗口内，默认第 17 分钟停止审查
  reviewGroupSize: 3 # 同一个 M、同一优先级的最多 K 项，一个 Agent 顺序提交
  fileQualityReviewEnabled: false
reviewers:
  defaults:
    model: registered-provider/model
    effort: low
    timeoutMs: 1200000 # 单角色上限仍受本次 Stop 的共享截止限制
```

实际开始一次业务纠偏才同时扣会话和流程各一次；审阅 Agent、单项保存、通知和排队不扣。任务、GT、配置、模式或需求周期变化都不恢复会话已用次数。已有会话没有可信的逐次启动历史时明确等待迁移核对，不能默认为新会话。

旧 `maxCorrectionsPerEpoch` 只在配置入口映射到 `maxCorrectionsPerFlow`，旧 `waitTimeoutMs` 只映射到本次 `assessmentTimeoutMs`，两者均带弃用提示。新旧同义字段同时出现时报错。移除旧“需求变化清零”和“整条纠偏链共享审查时限”语义。总时限小于默认三分钟预留的测试配置，必须同时显式缩短 `feedbackReserveMs`。

`assessment` 等本次审查结算和有效反馈交付，然后解除 RC 等待；流程最多实际纠偏一次。`until_pass` 在有有效偏差且额度允许时，继续等待已实际开始的宿主修复和后续 Stop。排队请求未开始时最多等到本次总截止；及时确认开始的修复不再受旧审查计时影响。后续 Stop 有新窗口，入口额度耗尽时跳过审查并明确放行，不为最后一次修复额外赠送自动复验，也不冒充 PASS。

MatrixAssistant 适配通过公开 `before_prompt_build` 和 `before_agent_run` 核对当前反馈与启动准入，通过可信 `model.call.started` 的实际时间计账，使用带确切 `runId` 的 `chat.abort` 停止所属失效续作。原生 user-role 消息只携带反馈引用，正文在接入时重新筛选；插件只在自己的可信转录投影标记内部消息，不改原转录或宿主 UI 标签。宿主执行、模型、工具和审批仍由宿主负责。

宿主缺少已验证的启动门、可信观察或确切运行取消能力时，明确返回 `HOST_START_PROTOCOL_UNSUPPORTED`：保留确认偏差，结束等待，不自动续作，不把 API 成功当实际开始。OpenClaw 2026.10.3 的项目/审阅适配不等于已经验收了这份新的业务启动协议。关闭诊断事件的宿主不能启用依赖可信模型开始观察的自动续作。

检查器故障不会自动变成业务缺陷，本轮失败组不重派。取消、关闭、项目失效和总截止都有围栏；未知在途请求保留预留待核对，不自动重发。旧 Stop 的有效保存作为历史保留，不能以“放行”替代整体验收通过。


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

Stop 等待使用同一通道，只刷新实际受阻的当前请求；已结束主运行的后台审查及尚无 runId 的排队请求不发送保活。兼容验证读取安装包内真实主进程过滤/转发函数和前端计时/工具分支，未知版本或入口变化直接报错。此项已验证 MA `1.10.1` + OpenClaw `2026.7.1-2` 的函数契约，仍不等于完整 Electron 桌面进程的真实长时验收。

## 安装前提

OpenClaw 产物声明的 Node 范围为 `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`，并须同时满足所安装宿主的更严格要求。原生审阅任务固定依赖 `typebox 1.3.27`；构建产物包含 npm v3 锁文件，可在产物目录执行 `npm ci --ignore-scripts` 预装。

### MA 启动后插件配置消失

MA `1.8.160` 的 `cleanupStalePluginConfigs` 不扫描标准的 `~/.openclaw/extensions`，扫描 `plugins.load.paths` 时只检查 manifest 的 `main`（缺省为 `dist/index.js`），不读取 `package.json` 的 `openclaw.extensions`。因此仅执行 OpenClaw 的 install/enable 后，合法插件仍可能被误判为 stale，并从 `plugins.allow` 和 `plugins.entries` 删除；插件文件仍在。

新版产物已在 manifest 中补齐原生入口 `main`。关闭 MA 后，从本仓库构建、使用宿主内置 CLI 重新安装，再运行一次配置命令：

```powershell
npm run build:plugin
node "<MA安装目录>/resources/openclaw/openclaw.mjs" plugins install --force ./dist/runtime-corrector-openclaw
node ./dist/runtime-corrector-openclaw/scripts/configure-ma-host.mjs
```

配置命令验证已安装入口，将该插件的绝对目录追加到 `plugins.load.paths`，启用 RC 及所需 Hook 权限，保留其他配置，并在写入前备份原文件。重复执行不增加重复路径或重复备份。自定义配置位置可传 `--config <openclaw.json>` 和 `--plugin-root <已安装插件目录>`；如此前清理已删除 RC 模型设置，可显式传 `--reviewer-model <provider/model>` 恢复。命令不会自动读取旧备份或恢复其中的其他设置。重新打开 MA 后生效。

MA 同时会将顶层 `tools.alsoAllow` 精确同步为内置模板，手工添加的 `runtime_corrector` 会在启动时被移除。若需在主助手使用此工具，运行 `node ./dist/runtime-corrector-openclaw/scripts/configure-ma-host.mjs --tool-agent main`，把授权保存到现有 `agents.list` 中 `id: "main"` 的 `tools.alsoAllow`，这个位置由 MA 保留。首次创建该 Agent 的列表时继承当前全局额外工具；已有独立列表则保留其范围，只追加 `runtime_corrector`。全局工具设置、其他 Agent 及所有 deny 规则保持不变；不会给业务助手开放评审员专用的 `rc_progress`。其他助手须使用其实际 Agent ID 显式配置。

合并不自动安装。当前包版本 `1.9.1-openclaw.11-session-projects.12`。从旧受控执行版本迁移时，业务需使用原生 `openclaw`；只移除 RC 自己此前添加的 `runtime-corrector-supervised` 绑定与 `supervisedExecution`，保留其他模型、运行时、凭据、工具、审批及时间设置。新版宿主的 Node 要求以其安装包为准：`2026.10.3` 使用 Node `>=24.16.0 <25` 或 `>=26.1.0`。

```json
{"plugins":{"entries":{"runtime-corrector":{
  "enabled":true,
  "hooks":{"allowConversationAccess":true,"allowPromptInjection":true},
  "config":{"reviewerModel":"registered-provider/model","hookTimeoutMs":1200000}
}}}}
```

保留原 RC 需求账本、来源验证、程序引文、逐项进度/有效部分反馈与可配置三次格式修复。没有引入新总结 LLM、业务执行器或通用调度框架。
