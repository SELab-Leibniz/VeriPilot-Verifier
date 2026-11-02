# MatrixAssistant / OpenClaw 纠偏与 Stop 审查

所有 RC agent 的单次模型输出默认上限为 `32768`（32K）。在项目 `.runtime-corrector/config.yaml` 中配置 `maxOutputTokens` 可统一调整；评审还支持 `reviewers.defaults.maxOutputTokens` 与 `reviewers.<role>.maxOutputTokens`，角色配置优先。覆盖停止分类、Stop 单项/分组/文件质量/实现审查、基线刷新及其他评审，也覆盖受监督执行的私有 worker；格式修复与续问继续应用配置。详见 [Agent 单次输出上限](configuration.md#agent-单次输出上限)。

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

`effort` 支持 `off`、`low`、`medium`、`high`、`xhigh`、`max`，默认 `low`。需要请求关闭思考模式时设置 `effort: "off"`；RC 将它原样传给宿主，审查、工具与证据校验继续执行。本机目标 OpenClaw 的 DeepSeek V4 原生兼容路径会显式发送 `thinking.type: "disabled"`；自定义代理及其他模型的实际行为取决于对应适配，详见 [Reviewer 思考强度](configuration.md#reviewer-思考强度)。

实际开始一次业务纠偏才同时扣会话和流程各一次；审阅 Agent、单项保存、通知和排队不扣。任务、GT、配置、模式或需求周期变化都不恢复会话已用次数。已有会话没有可信的逐次启动历史时明确等待迁移核对，不能默认为新会话。

旧 `maxCorrectionsPerEpoch` 只在配置入口映射到 `maxCorrectionsPerFlow`，旧 `waitTimeoutMs` 只映射到本次 `assessmentTimeoutMs`，两者均带弃用提示。新旧同义字段同时出现时报错。移除旧“需求变化清零”和“整条纠偏链共享审查时限”语义。总时限小于默认三分钟预留的测试配置，必须同时显式缩短 `feedbackReserveMs`。

`assessment` 等本次审查结算和有效反馈交付，然后解除 RC 等待；流程最多实际纠偏一次。

`until_pass` 使用[运行结束后的多 Session 调度](until-pass-dispatch.md)：每轮先正常展示最终回复并结束，RC 通过宿主 `agent.wait` 确认终态，再独立判断并执行 Stop 审查。有有效反馈且额度允许时另起纠偏运行；纠偏运行同样先结束，再审查。没有有效反馈或无需审查时执行等待中的用户任务，否则保持空闲。异常或额度耗尽保留真实未通过／未验证状态，不能冒充 PASS。

until_pass 不使用原轮 `revise`，也不让后续聊天请求跨轮等待。`finalizeReviewWaitMs` 的原轮机会窗口仅适用于 assessment。审查、准入和修复使用各自有限窗口；新的 Stop 有新的审查窗口。已实际执行的最后一次 MA 修复仍作有时限的只读复验，不再获得修复额度。

审查与纠偏期间，公开 `reply_dispatch` 接管后续输入，持久化到对应 Session 并立即返回收件说明。普通旁路输入由 `before_agent_run` 暂缓，不能挤占纠偏任务。待办不写入当前需求，宿主原始记录不改写。启动结果未知时不重投，保留待办并核对实际运行；无法确认终态时不启动下一项。关闭浏览器不影响后台，Gateway 重启后先核对在途运行，再恢复调度。

浏览器访问当前 Gateway 的 `/plugins/runtime-corrector/`，使用宿主认证。一个页面管理多个会话，支持会话搜索、状态筛选和分页；选中后显示纠偏概览、当前基线正文、M01–M16 指标及可折叠的响应时间线。响应记录可按反馈正文、轮次、文件、skill、指标全文搜索，按类型、时间和需关注状态筛选，过滤后分页；可复制单条记录链接。历史缺少轮次或回执时显示未知，旧基线或已变化证据下的 PASS 不计作当前通过。后续待办仍可编辑、删除，多个待办按顺序保留，删除待办不停止审查。页面选择与 MA 当前窗口独立，会话列表与标题显示 Session 与项目，避免切错会话。修改与删除校验待办版本，旧页面不能覆盖新内容。插件 config 的 `stopReviewConcurrency` 设置跨 Session 的审查并发上限，默认 3（1–32）；等待并发资源计入审查时限，某个会话不会阻塞其他空闲会话的业务执行。方案、证据语义与复现实验见 [RC 控制台优化](rc-console-plan.md)。

新控制页的原生浏览器认证客户端目前验证于 MA 内置 OpenClaw `2026.7.1-2`。其他版本没有已验证接口时返回不可用，不猜测客户端结构；既有项目与审阅适配的支持范围保持独立。

日常回归使用状态机、持久化恢复、乱序事件、认证、待办编辑竞态和无模型宿主契约测试。控制页另用真实浏览器验证切换会话、草稿保存、过期修改拒绝和响应式布局。完整真实模型及 Electron 桌面长实验仍需单独验收，不能用这些自动化结果替代。

MatrixAssistant 适配通过公开 `before_prompt_build` 和 `before_agent_run` 核对当前反馈与启动准入，通过可信 `model.call.started` 的实际时间计账，使用带确切 `runId` 的 `chat.abort` 停止所属失效续作。原生 user-role 消息只携带反馈引用，正文在接入时重新筛选；插件只在自己的可信转录投影标记内部消息，不改原转录或宿主 UI 标签。宿主执行、模型、工具和审批仍由宿主负责。

宿主缺少已验证的启动门、可信观察或确切运行取消能力时，明确返回 `HOST_START_PROTOCOL_UNSUPPORTED`：保留确认偏差，结束等待，不自动续作，不把 API 成功当实际开始。OpenClaw 2026.10.3 的项目/审阅适配不等于已经验收了这份新的业务启动协议。关闭诊断事件的宿主不能启用依赖可信模型开始观察的自动续作。

MatrixAssistant 内置的 OpenClaw 2026.7.1-2 使用公开 harness 取消接口。调用前按已核验版本只读核对会话索引和运行索引必须指向同一个 RC 创建的活动句柄；身份核对与取消之间不异步让出。旧运行已被用户新运行替换时，不取消新运行。不申请网关管理员权限，也不调用仅限官方插件的通用网关取消接口。

检查器故障不会自动变成业务缺陷，本轮失败组不重派。取消、关闭、项目失效和总截止都有围栏；未知在途请求保留预留待核对，不自动重发。旧 Stop 的有效保存作为历史保留，不能以“放行”替代整体验收通过。


## Review 超时配置

宿主业务执行与 RC 语义评审使用独立时限。在宿主的 RC 插件配置中设置 `businessRunTimeoutMs: 0`，可关闭实际开始后的自动业务修复截止；准入等待、语义审查、用户取消及作用域失效检查继续生效。省略该字段时保持原有修复窗口行为。宿主自身的任务超时还须单独关闭，不能只改项目 YAML：已核验的 OpenClaw 2026.7.1-2 接受 `chat.send.timeoutMs: 0` 作为原生无任务截止模式。该宿主在内部使用平台最大安全定时器值作为无截止哨兵，不应把较短评测窗口再套在外层。

例如项目的 `reviewers.defaults.timeoutMs`、`limits.semanticReviewTimeoutMs` 与 `stopCorrection.assessmentTimeoutMs` 可继续设为 `1800000`（30 分钟），与宿主业务自然完成相互独立。Stop 的总窗口仍包含基线准备、审查与反馈预留；自动修复结束后的新 Stop 获得自己的审查窗口。

所有语义评审和角色 reviewer 默认 20 分钟，最大 24 小时（1000～86400000 毫秒）。在项目 `.runtime-corrector/config.yaml` 中设置：

```yaml
limits:
  semanticReviewTimeoutMs: 1800000 # 语义评审 30 分钟
reviewers:
  defaults:
    timeoutMs: 1200000 # 所有角色默认 20 分钟
  stopReviewer:
    timeoutMs: 5400000 # 终审角色 90 分钟
```

优先级：角色配置 > reviewers.defaults > limits.semanticReviewTimeoutMs > 20 分钟。未配置基线专用预算时，基线抽取和裁决同样遵守配置。格式修复与续问共用同一个角色截止时间；总评审窗口、宿主取消及较短的 Hook 预算仍然生效。普通 `hookTimeoutMs` 默认 20 分钟、最大 60 分钟；它与单个 reviewer 及多阶段总预算分别配置。

大型基线可在插件 `config.baselineLimits` 中单独配置 `timeoutMs`、`maxSteps`、`maxRepairs`、`maxAuditCalls`、`maxExternalRepairs`。例如设置 `timeoutMs: 86400000`、`maxSteps: 2000`，并把三项修复/审查额度设为 `2000`；它覆盖基线角色的普通时限和共享步数，修复与独立审查不重置预算。相应把 `hookTimeoutMs` 设为 `86460000`，Stop 的 `assessmentTimeoutMs` 至少留出完整基线窗口及返回时间；宿主任务和模型网络时限也需足够大。显式设置的更短 `reviewerTimeoutMs`、父级截止和取消继续有效。普通角色默认不变，组件流程见 [Stop 基线任务](stop-baseline-task.md)。

`onboarding-extractor`、`onboarding-adjudicator`、`skill-reviewer`、`artifact-reviewer` 和 `implementation-reviewer` 同样不设 RC 累计字节硬中止条件，上下文窗口与压缩由宿主管理。材料扫描、内联预览、单包披露、输出捕获和原文证据边界继续保留；这些限制分别约束材料准备、传输或证据完整性，不等于按会话累计字节中止审阅。

上述五个角色保留 RC 会话专用工具，并继承所选宿主 Agent 允许的读取、检索等工具；编辑、写入、补丁、命令/进程及代码执行工具禁止使用。RC 在每次私有调用的配置副本追加 deny 并在调用前拦截，宿主原有 profile、全局/模型/Agent 工具策略、显式 deny 及审批规则继续生效。私有会话关闭会将工具包装为执行入口的 Code Mode，直接使用剩余工具；宿主上下文管理和压缩配置保持不变。私有 `rc_progress` 只在所属评审会话有对象时注册。初次调用、格式修复和续问沿用相同策略。基线及停止分类 Agent 同样禁止编辑、写入和执行工具；基线候选保存、审查进度与结构化结果提交等专用工具保留，程序保存自身状态不属于业务文件写入。旧版通用语义审查保留原有只读工具范围。

原生 Hook 等待 reviewer 时，RC 每 30 秒发送标记为 `runtime-corrector.review` 的工具进度 `update`。MA 1.10.1 的桌面主进程会过滤自定义 Agent 流，旧版 `runtime-corrector.progress` 无法刷新空闲检查；新版本经宿主 `session.tool` 和 MA 现有聊天事件入口更新进度。只发送 `update/end`，不发送模型工具调用 `start` 或结果 `result`，不覆盖业务工具错误摘要；阶段提示也不再写入助手正文。定时器不冒充诊断模型进展，不延长原预算；取消、父运行结束及截止时间均停止周期上报。

Stop 等待使用同一通道，只刷新实际受阻的当前请求；已结束主运行的后台审查及尚无 runId 的排队请求不发送保活。兼容验证读取安装包内真实主进程过滤/转发函数和前端计时/工具分支，未知版本或入口变化直接报错。此项已验证 MA `1.10.1` + OpenClaw `2026.7.1-2` 的函数契约，仍不等于完整 Electron 桌面进程的真实长时验收。

## 安装前提

OpenClaw 产物的运行环境要求与安装后的配置方式如下。

### 在 Session 中初始化宿主设置

插件已加载后，由管理员在聊天框发送：

```text
/rc-setup
```

命令启用 RC 及 `allowConversationAccess`、`allowPromptInjection` 两个 Hook 权限；缺少 `reviewerModel` 时读取 OpenClaw 全局默认模型（兼容字符串、`primary` 和已配置的模型别名），缺少 `hookTimeoutMs` 时设置为 `3600000`。已有明确的 RC 模型、超时及其他参数保留。主 Agent 优先选择 `agents.list` 中第一个默认 Agent，否则第一个 Agent；没有列表时使用宿主隐式 `main`。只给该 Agent 追加业务工具 `runtime_corrector`，保留其工具范围和 deny；全局工具配置、其他 Agent 和私有评审工具授权不变。已有非空插件白名单会补入 RC，空或缺省白名单仍保持不限制插件的语义。

命令不接受路径或模型参数，使用宿主 `runtime.config.mutateConfigFile` 的新鲜源配置和 `afterWrite: auto` 写入；宿主负责配置校验、并发保护、备份和重载。重复执行且配置无变化时不再写入。若宿主没有此接口，命令报错，不另行猜测配置文件路径或绕过宿主写文件。

此命令不创建项目配置、不修改项目或 Session 开关，也不登记 `plugins.load.paths`。当前 MA 内置 OpenClaw 默认 `hybrid` 模式会热加载这些变更；正在执行的审查不保证中途切换参数。`gateway.reload.mode: off` 需要手动重启，`restart` 模式由宿主自动请求重启。命令按实际策略提示，不把“已保存”当作“热加载完成”。可信聊天渠道的 owner 或具有 `operator.admin` 的已认证用户才可执行；私有 RC Reviewer/Worker 不可调用。

### 运行环境

项目内默认配置使用 `/rc-project init` 创建，随后可用 `/rc-project on` 和 `/rc-session on` 开启。`/rc-session-default on|off|status` 只控制首次登记会话的默认值。初始化和开关都作用于当前 Session 的真实项目，不修改宿主配置或重启宿主；详见[项目与 Session 开关](session-control.md#在-session-中初始化和开关)。

OpenClaw 产物声明的 Node 范围为 `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`，并须同时满足所安装宿主的更严格要求。产物仅使用 Node.js 内置模块，不包含旧 Stop 复制/分组工作者、TypeBox 或旧依赖锁文件，安装无需 npm 或网络，也不读取或修改宿主及其他项目的 TypeBox。原生 Stop 只接受共享工作区协议；历史分类、分组和复制审查仅用于仓库内显式开发对照，不能通过产品配置启用。

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

### 长任务 Stop 预算

时间、审查轮次、每次修复轮次以及修复次数分别配置。以下配置最多等待 24 小时，每次终审和每次宿主业务修复各最多 2000 个模型响应步骤，最多自动续修 3 次：

```yaml
stopCorrection:
  enabled: true
  waitMode: until_pass
  assessmentTimeoutMs: 86400000
  feedbackReserveMs: 30000
  maxReviewSteps: 2000
  maxRepairSteps: 2000
  maxCorrectionsPerSession: 3
  maxCorrectionsPerFlow: 3
reviewers:
  defaults:
    timeoutMs: 86370000
```

审查步骤通过项目配置传给原生 Stop worker；业务修复步骤按可信模型启动事件计数，同一事件不会重复计数。超出每次修复步骤预算时只终止插件拥有的该次修复，不得中止其他用户回合。原有时间和取消保护继续生效，较短的显式父级预算仍会约束运行。宿主任务、Hook、无进展保护和会话锁也须允许 24 小时；benchmark 入口会统一这些设置。
