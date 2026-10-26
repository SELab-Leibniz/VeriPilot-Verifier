# MatrixAssistant / OpenClaw 纠偏与 Stop 审查

Stop 前置基线刷新已接入专用抽取 task，支持候选批次、结构化 compact 恢复和事务应用回执，见 [基线 task 协议与验证边界](stop-baseline-task.md)。其他提取入口及审阅角色保留各自协议。构建不会安装到现有 MA。

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

`assessment` 等本次审查结算和有效反馈交付，然后解除 RC 等待；流程最多实际纠偏一次。`until_pass` 在有有效偏差且额度允许时，继续等待修复和复验。审查/准入与业务修复使用不同的有限窗口：实际启动后不再受旧审查截止影响，但修复仍有 `hookTimeoutMs`（最大一小时）的兜底等待，后续 Stop 有新审查窗口。普通请求的外层等待独立遵守 `reply_dispatch` 的一小时上限（宿主策略可进一步缩短），不复用某一个阶段的 `hookTimeoutMs`；异常、漏终态、额度耗尽或超时都明确结束为未通过/未验证并放行。已实际执行的最后一次 MA 修复仍作有时限的只读复验，不再获得新的修复额度；其他入口在额度耗尽时跳过自动审查。

MA 的 `before_agent_finalize` 已接入，但默认 `finalizeReviewWaitMs: 0`：登记后台审查后立即返回，让原任务先结束。MA 不向该钩子提供剩余运行时间，UI 心跳也不会延长宿主硬超时，因此不默认在此等待慢审查。若明确接受这段开销，可在插件 config 中将 `finalizeReviewWaitMs` 设为 `1..2000`，为已完成且仍有效的审查或足够快的审查提供原轮续修机会；同一运行最多请求一次原轮续修，避免撞上宿主三次上限。原轮后续可信模型调用才计为开始，工具往返不会重复计费。

原轮未继续时，后台审查与终态通知共用一次交接：同一会话、同一预算预留、一个幂等请求。只等待宿主接收请求，不在结束钩子中等待新运行实际开始；执行顺序由宿主原生会话队列保证。接收结果不明确时不自动再投第二份。普通聊天只在队列外的早期 `reply_dispatch` 等待；已经进入模型选择钩子的旁路请求会结束旧 RC 等待并继续，不能占着执行位置等待排在后面的修复。RC 账本读取故障不能拒绝普通任务，失效准入只拒绝 RC 自己创建的续修。

等待中的后续用户输入只在 RC 的当前任务投影中暂缓生效，不改写宿主记录。这包括追加的“修改上一任务要求”消息：它在获准进入后才重新核验，不会即时使当前反馈失效。改写当前用户输入前缀、Ground Truth 或相关文件证据仍使旧反馈失效；不能用改写旧记录的测试推断追加消息会即时生效。保活发送 UI 进度事件，并通过宿主公开的 `markDiagnosticSessionProgress` 通知当前有限等待仍活跃，避免内部卡死恢复误取消排队请求；接口缺失、加载超时或通知失败时，以 `UNVERIFIED` 结束当前流程并放行，不能继续长等。不伪造模型调用或工具执行，不延长已结束的后台运行，不在原任务最终回复中拼接“正在验收”。

日常回归默认使用快速自动化：模拟乱序终态、保活缺失/抛错/挂起、宿主回执与可信启动事件；长等待用虚拟时钟推进五分钟以上。宿主对接可用不调用模型的轻量契约测试。真实模型及完整 OpenClaw 长实验按需单独安排，不作为每次回归的必跑项；`RC_LONG_WAIT_TEST=1` 的真实时间等待用例保持可选。

MatrixAssistant 适配通过公开 `before_prompt_build` 和 `before_agent_run` 核对当前反馈与启动准入，通过可信 `model.call.started` 的实际时间计账，使用带确切 `runId` 的 `chat.abort` 停止所属失效续作。原生 user-role 消息只携带反馈引用，正文在接入时重新筛选；插件只在自己的可信转录投影标记内部消息，不改原转录或宿主 UI 标签。宿主执行、模型、工具和审批仍由宿主负责。

宿主缺少已验证的启动门、可信观察或确切运行取消能力时，明确返回 `HOST_START_PROTOCOL_UNSUPPORTED`：保留确认偏差，结束等待，不自动续作，不把 API 成功当实际开始。OpenClaw 2026.10.3 的项目/审阅适配不等于已经验收了这份新的业务启动协议。关闭诊断事件的宿主不能启用依赖可信模型开始观察的自动续作。

MatrixAssistant 内置的 OpenClaw 2026.7.1-2 使用公开 harness 取消接口。调用前按已核验版本只读核对会话索引和运行索引必须指向同一个 RC 创建的活动句柄；身份核对与取消之间不异步让出。旧运行已被用户新运行替换时，不取消新运行。不申请网关管理员权限，也不调用仅限官方插件的通用网关取消接口。

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

`onboarding-extractor`、`onboarding-adjudicator`、`skill-reviewer`、`artifact-reviewer` 和 `implementation-reviewer` 同样不设 RC 累计字节硬中止条件，上下文窗口与压缩由宿主管理。材料扫描、内联预览、单包披露、输出捕获和原文证据边界继续保留；这些限制分别约束材料准备、传输或证据完整性，不等于按会话累计字节中止审阅。

上述五个角色保留 RC 会话专用工具，并继承所选宿主 Agent 允许的读取、检索等工具；编辑、写入、补丁、命令/进程及代码执行工具禁止使用。RC 在每次私有调用的配置副本追加 deny 并在调用前拦截，宿主原有 profile、全局/模型/Agent 工具策略、显式 deny 及审批规则继续生效。私有会话关闭会将工具包装为执行入口的 Code Mode，直接使用剩余工具；宿主上下文管理和压缩配置保持不变。私有 `rc_progress` 只在所属评审会话有对象时注册。初次调用、格式修复和续问沿用相同策略。基线及停止分类 Agent 同样禁止编辑、写入和执行工具；基线候选保存、审查进度与结构化结果提交等专用工具保留，程序保存自身状态不属于业务文件写入。旧版通用语义审查保留原有只读工具范围。

原生 Hook 等待 reviewer 时，RC 每 30 秒发送标记为 `runtime-corrector.review` 的工具进度 `update`。MA 1.10.1 的桌面主进程会过滤自定义 Agent 流，旧版 `runtime-corrector.progress` 无法刷新空闲检查；新版本经宿主 `session.tool` 和 MA 现有聊天事件入口更新进度。只发送 `update/end`，不发送模型工具调用 `start` 或结果 `result`，不覆盖业务工具错误摘要；阶段提示也不再写入助手正文。定时器不冒充诊断模型进展，不延长原预算；取消、父运行结束及截止时间均停止周期上报。

Stop 等待使用同一通道，只刷新实际受阻的当前请求；已结束主运行的后台审查及尚无 runId 的排队请求不发送保活。兼容验证读取安装包内真实主进程过滤/转发函数和前端计时/工具分支，未知版本或入口变化直接报错。此项已验证 MA `1.10.1` + OpenClaw `2026.7.1-2` 的函数契约，仍不等于完整 Electron 桌面进程的真实长时验收。

## 安装前提

OpenClaw 产物声明的 Node 范围为 `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`，并须同时满足所安装宿主的更严格要求。产物将 `typebox 1.3.27` 的私有副本及 MIT 许可证放入 `vendor/typebox/`，审阅模块通过相对路径直接加载，随插件一同复制安装，无需 npm 或网络。它不依赖全局、宿主或其他项目的 TypeBox，也不写入这些位置。构建仅使用仓库内压缩包，先按审阅任务锁文件校验 SHA-512；归档缺失或不匹配时构建失败。原始 npm v3 锁文件保留在 `lib/review-task/`，插件根包不再声明需要另行下载的 TypeBox 依赖。

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

RC 必需工具统一列在 `config/openclaw-tool-contracts.json`。构建自动生成安装包的 `contracts.tools`，运行时注册和私有会话授权使用同一份清单，安装后不需要手填内部工具名。逐项审查与基线刷新使用各自的工具组；RC 在每次私有审查的配置副本中自动追加所需授权，再用 `tools.allow` 与运行参数 `toolsAllow` 限定最终范围。用户显式 deny 保留；授权不保存到全局配置，也不把私有工具开放给业务会话。

产物审查的完整协议由程序直接放入私有调用，模型无需到业务工作区外读取插件的 `SKILL.md`；工作区读取限制不因此放宽。编辑后的产物审查不是完成声明：尚未到期的测试复跑、后续产物与最终回复按待完成处理，不能要求每份短计划重述全任务。历史快照仍保持不可变，最终执行证据由后续检查或 Stop 评估。

Stop 检查器失败必须保留真实失败原因及 `UNVERIFIED`，并提供可显示的未验收通知；不能用 `NO_CURRENT_DEVIATION` 掩盖尚未核验，也不会把检查器故障交给业务 Agent 作为修复指令。

MA 的终态通知使用宿主公开的按会话身份追加助手消息接口：校验 `sessionId/sessionKey/agentId`，由宿主管理写锁、幂等和 `session.message` 广播。不读取网关令牌、不申请管理员权限，也不使用仅限官方插件的内部网关接口。MA 1.10.1 会在业务最终消息后的五秒内去重快照；独立审查通知避开该窗口，并在发送前再次核对会话仍有效。追加被拒绝、能力不可用和应答不明都不能记为已送达；应答不明时核对唯一标记，不盲目重发。

冻结的执行记录使用 `execution/` 和 `execution-index.json` 作为审查包内部路径，避免 MA 将旧的 `process/`、`process-index.json` 按 `/proc` 敏感路径误判。这些文件仍受原有快照范围、哈希、读取凭据和宿主审核约束。

合并不自动安装。当前包版本 `1.9.1-openclaw.11-session-projects.15`。从旧受控执行版本迁移时，业务需使用原生 `openclaw`；只移除 RC 自己此前添加的 `runtime-corrector-supervised` 绑定与 `supervisedExecution`，保留其他模型、运行时、凭据、工具、审批及时间设置。新版宿主的 Node 要求以其安装包为准：`2026.10.3` 使用 Node `>=24.16.0 <25` 或 `>=26.1.0`。

```json
{"plugins":{"entries":{"runtime-corrector":{
  "enabled":true,
  "hooks":{"allowConversationAccess":true,"allowPromptInjection":true},
  "config":{"reviewerModel":"registered-provider/model","hookTimeoutMs":1200000}
}}}}
```

保留原 RC 需求账本、来源验证、程序引文、逐项进度/有效部分反馈与可配置三次格式修复。没有引入新总结 LLM、业务执行器或通用调度框架。
