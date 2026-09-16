# OpenClaw 验收、故障恢复与用户交互改进方案

日期：2026-09-16。目标宿主：OpenClaw `2026.7.1-2`。核对分支：`codex/openclaw-2026.7.1-2`，基线提交：`1bf0d84`。

修订：已纳入专业评审的四项 P1 建议及混合消息身份要求。保留查询不改变需求、两类预算分离、完成结论绑定成果快照的原则；补齐固定入口选型、核心 `verify_only`、提交事务校验及发送未确认窗口。以下设计已落实为 `.7` 的核心事务、控制接口、状态页和终端入口；执行证据见 [逐项验收记录](openclaw-acceptance-7.md)。

**状态：已实施；各入口的实测结果、未满足项与未验证项已单独记录。版本 `1.9.1-openclaw.7`，回退基线 `.6`。** 本文不改变宿主源码，不提供宿主补丁，不替换宿主模块；保留原核心的需求基线、规则与语义评审、严重性、归因、纠偏预算、停止条件及评审防递归机制。配置目录 `.runtime-corrector/` 保留不动，新增运行记录写入 `.runtime-correction/`。

核心原则：验收控制任务的完成声明；用户控制与状态说明始终有独立通路。未经验证不能宣称全部完成，有记录支持的解释不能被统一错误提示吞掉。

## 1. 当前问题、依据和验证边界

| 发现 | 源码或记录依据 | 能确认什么 |
| --- | --- | --- |
| 真实用户输入的身份已校验，但没有先区分查询与变更要求 | `lib/openclaw/supervised.mjs` 的 `queueMessage`，约 244–284 行：确认 recorder/provenance 后直接记录 `pendingRequirement`，转交工作会话并调用 `acceptRequirement` | 中途查询也可能进入补充要求流程、打断评审；不能据此断言每条查询一定增加需求版本，版本还由原核心决定 |
| 未验证状态替换候选回复 | 同文件约 385–387 行：只有 VERIFIED/CHAT 使用候选正文；其他分支使用固定提示及反馈，WAITING_FOR_USER 有例外 | 工作回复中的有效解释可能没有进入最终回复；不是所有解释都应原样放行 |
| 查询若沿用核心运行队列，会等待评审 | `lib/openclaw/runtime.mjs` 的 `withState`、`acceptRequirement`、`assessSupervised`；`controller-store.mjs` 持有整个控制器生命周期的互斥锁 | “加一个状态工具”不足以保证及时回答，需要独立读记录通路 |
| 已有原生进度转发，但语义阶段粗 | `supervised.mjs` 转发所属运行的真实诊断事件，阶段文字主要是执行、修正、验收；reviewer 回调主要提供 runId | 可以复用事件，尚不能声称每个文件的评审阶段都已精确显示 |
| 基础设施失败与纠偏次数已分开 | `lib/runtime-v2/orchestrator.mjs` 的 `stopInfrastructureFailure`、`MAX_STOP_INFRASTRUCTURE_RETRIES = 2` | 原规则为首次尝试加最多 2 次重试，连续第 3 次失败后停止自动验收。返回 allow 只表示退出阻塞，仍是 UNVERIFIED，绝不是 PASS |
| 仅在适配层禁止继续执行，仍会扣纠偏次数 | 同文件约 1126–1140、1291–1304 行：非完成分类有阻断问题及完成分类有阻断问题两条分支，都在返回适配层前递增 `correctionAttempts` | `verify_only` 必须由核心显式支持，两处分支都要覆盖，不能只改控制器循环 |
| 核心提交后才检查取消，无法撤销已经发生的状态变化 | `lib/openclaw/runtime.mjs` 的 `assessSupervised` 在 `await run(..., "Stop", ...)` 返回后检查 abort；核心此前已分步保存预算、问题和验证状态 | 取消、需求版本及控制器代次必须在核心提交的同一个短事务中校验；适配层事后丢弃返回值不够 |
| 固定版本的 reply_dispatch 没有用户 recorder | 本机 `dist/hook-types-DQ9eTy2x.d.ts` 的 `PluginHookReplyDispatchContext` 及 `dist/dispatch-DnzGTpPs.js` 的实际调用 | `replyOptions` 在别处拥有 recorder，不代表该 Hook 收到了它；不能按新版文档假设存在 |
| 证据有指纹检查，但记录仍需扩展 | `lib/openclaw/evidence.mjs`：观察读写路径、生成摘要并复查；持久化快照包含总摘要及文件列表 | 可复用已有保护；需要持久化逐文件指纹、明确必需文件/缺失文件及需求版本，完善交付竞争处理 |
| GLM 至少一条故障路径在模型/接口输出阶段 | `docs/openclaw-acceptance-6.md` 和对应合成证据：不依赖 OpenClaw 也出现输出额度耗尽、无最终正文 | `.6` 的独立三场景和隔离原生六次评审已有通过记录；不能等同于原会话或真实网页/终端完整闭环通过 |

原方案编制时运行 `openclaw-supervised`、`openclaw`、`openclaw-host-contract` 三组测试：**58 项通过，0 失败**。本次文档修订未重跑运行时测试；这个历史基线不是本方案新行为已通过的证明。

**未验证：** 当前安装的插件与正在运行的 Gateway 是否使用同一源码；用户原会话每一条消息的完整事件链；实际三份文档当前内容及逐项采纳情况；本方案网页与终端的中途交互效果。本文不据截图或旧测试替这些项目宣布通过。

## 2. 固定版本的入口能力与明确选型

**选型确定：独立控制主通路采用插件注册的认证 Gateway 方法；普通任务保留原生聊天及受控 harness；Steer 通过活动句柄处理真实需求变更；插件命令首期只做只读查询。`reply_dispatch` 仅用于能取得可靠关联信息的只读查询，不承担要求变更或可靠历史提交。**

以下能力依据本机 `2026.7.1-2` 类型及实际源码核对。表中“有接口”不是完整交互已通过；网页忙碌投递、终端显示及聊天历史回执仍须契约和界面测试。

| 入口 | 可信身份及会话来源 | 消息编号与去重 | 独立回复及确认能力 | 本方案用途与边界 |
| --- | --- | --- | --- | --- |
| 网页普通发送 | 认证后的 `chat.send` 生成 `ctx.SessionKey`、`GatewayClientScopes`、`InputProvenance`；SenderId 在操作界面可能缺失，不能把显示名当身份 | Gateway 将客户端 `idempotencyKey` 放入 `ctx.MessageSid`，`reply_dispatch` 的 event 带 ctx/runId；MessageSid 是入口关联号，不冒充 transcript 记录 ID | dispatcher 可提交该请求的回复；`queuedFinal/counts` 只是排队结果；Hook 没有用户 recorder 或可靠历史写入回执。网页忙碌时有 Queue | 普通任务继续原生流程；只读查询仅在消息已到达、权限/关联齐全时拦截。缺失信息则明确提示独立查询入口，不创建纠偏任务，不按文本猜编号；不能承诺 Queue 中的查询即时响应 |
| 网页 Steer | 宿主活动运行收到的 `options.userTurnTranscriptRecorder`，通过 `resolveMessage()` 校验真实用户来源及所属会话 | 使用 recorder 实际消息 ID/幂等关联；若无法建立稳定映射，拒绝有状态变更并说明原因 | 现有确认队列提供 `queued`、`deliveredAtMs`，recorder 可确认 transcript 持久化；这些是接收/工作会话投递确认，不是独立聊天回复确认 | 用于运行中真实需求变更；队列入口仍先区分查询。查询回复不挤入 worker，独立查看走控制主通路；不把“Steered”界面标记当模型已采纳 |
| 终端聊天 | `GatewayChatClient` 通过认证 Gateway 调用 `chat.send`；会话/权限检查同网页 | TUI 发送 runId 作为 `idempotencyKey`，服务端据此关联；终端同样不能把 runId 直接当 transcript ID | 初始响应是请求接收，最终回复通过宿主事件；到达插件时可使用相同只读处理，忙碌时独立回复及历史效果未验证 | 普通任务及宿主取消保持原入口；可靠即时查询/变更/仅复验由插件 CLI 客户端调用控制主通路，不宣称 CLI 调用等同于 TUI 聊天验收 |
| 插件聊天命令 | `PluginCommandContext` 提供 `isAuthorizedSender`、scopes 及可选 sessionKey/sessionId；缺少目标绑定时不猜任务 | 当前上下文没有稳定原消息 ID 或 recorder。内部查询编号只能标记本次报告，不能用来给变更请求做可靠去重 | handler 返回 ReplyPayload，宿主负责发送；没有该命令的可靠 transcript 提交/用户可见确认回调 | 首期只提供状态、反馈、帮助；不直接修改需求、不授权修正/重验。混合或有副作用请求转到控制主通路，不能仅凭同文本去重 |
| 插件 Gateway 接口 | `registerGatewayMethod` 的 handler 获得宿主 client、scopes、req、respond；校验身份及会话访问范围，不信任 params 中自称的 actor，变更请求拒绝无认证 client | req.id 只关联这次传输。插件客户端在发送前持久化 `commandId`；重连保留它。服务器按身份/任务/commandId/actionId 和负载摘要去重，同键异内容报冲突 | respond 可独立回复，不进入任务模型队列。插件先落盘自己的接收/结果回执，再响应；响应丢失后按 commandId 查询。该回执不是原生聊天历史或用户已看到的证明 | **可靠控制主通路**：读状态、读反馈、修改要求、停止、`verify_only`、授权修正。插件自有页面/CLI 调用同一服务，原生聊天历史镜像另行核验，不伪造宿主 recorder |

拟新增的方法契约为 `runtime-corrector.status`、`runtime-corrector.feedback`、`runtime-corrector.control`、`runtime-corrector.receipt`：读方法使用宿主读权限，控制方法使用写权限并验证任务范围。这里只确定待实现接口，当前尚不能直接执行。`control` 请求携带稳定 commandId、actionId、目标任务/会话、预期代次及操作负载；服务端回执区分 RECEIVED、BASELINE_COMMITTED、APPLIED_TO_WORKER 和具体操作结果。插件不会覆盖宿主的 `chat.send`。

固定版本的关键依据：`hook-types-DQ9eTy2x.d.ts` 约 585–625 行及 `dispatch-DnzGTpPs.js` 约 1779–1807 行确认 reply_dispatch 没有 `userTurnTranscriptRecorder`；`chat-pg-BxhF6.js` 约 3130–3158 行构造 MessageSid/权限上下文，约 3375 行只向后续 replyOptions 提供 recorder；`types-DaHgOqFX.d.ts` 的 PluginCommandContext 和 GatewayRequestHandlerOptions 定义各自可取得的字段；`gateway-chat-BW6uyvQL.js` 的 sendChat 定义 TUI 的 chat.send 关联。

兼容模块只能包装目标版本**实际存在、调用方实际传入**的能力。只读导入一个 recorder 工厂不能获得未传入的用户消息、原生 recorder 所有权或可靠回执；不得补造、注入、猴子补丁或用文本相似度推导这些能力。`before_dispatch` 在本版本也没有完整消息编号，不选作可靠变更入口。

第一阶段按上表验证身份、稳定关联、回执含义及忙碌时投递。独立 Gateway 通路是明确的实施选择；其成功仍不能替代网页普通发送、Steer 或 TUI 的完整验收。只读命令或 Hook 能回复，也不代表其历史需求隔离已经成立：若无法建立第 3.1 节所需的可信映射或证明宿主不会把命令回灌为需求，不启用该入口的任务内查询功能，明确指向独立控制入口。若原生聊天缺少即时投递或历史回执，明确列为不满足/未验证，不修改宿主、不静默降级。

## 3. 六类交互的处理规则

入口先检查真实用户身份、会话归属，再决定用途。新任务仍沿用原核心任务触发规则，不新增模型分类器。明确的按钮、命令和无歧义自然语言可直接分类；模糊或混合意图先返回现有状态，必要时请求用户明确变更内容，不能默默更新需求。

| 用户交互 | 进入的流程 | 对需求、预算及控制器的影响 |
| --- | --- | --- |
| 提交任务 | 原核心识别任务 → 创建/绑定唯一控制器 → 原生执行 → 原核心验收 → 必要修正及复验 | 按原核心建立任务与需求；仅实际偏差纠正按原规则计数 |
| 查询进度 | 独立读取持久化状态快照并立即回复，附记录时间 | 不调用 worker、reviewer、UserPromptSubmit 或需求提取；不创建控制器，不改变需求版本/epoch/预算 |
| 查询反馈及采纳 | 读取 finding、反馈回执、工具写入及复验记录，按文件聚合 | 不重新评审；没有相应记录的步骤显示“未验证/无记录” |
| 补充或修改要求 | 持久化真实变更指令及 pending revision → 确认已接收 → 冻结旧完成交付 → 原核心更新基线 → 转交工作会话并记录回执 | 仅有效需求变化由原核心推进版本/epoch；纯重复要求不能借机重置预算 |
| 要求停止 | 先持久化取消代次，再中止执行和全部内部评审，等待活动句柄确认结束 | 不删文件和历史，不新建控制器；先回“已接收停止”，确认句柄退出后再报“已停止” |
| 要求重新验收 | 读取当前文件及需求，调用核心 `verify_only`，创建新的评审尝试或复用同一在途尝试 | 保留 taskId、需求版本和纠偏 epoch；保存问题但不扣内容纠偏次数、不派发修改 |

“现在怎样，另外改成 SQLite”按 **原消息 ID + 子动作 ID** 拆分，例如 `M123/query-1` 与 `M123/requirement-1`；同一原消息的分解结果首次落盘后复用，重试不重新分配子动作 ID。Gateway 控制请求使用等价的 `commandId + actionId` 并保留 nativeMessageId 映射；没有原生消息时明确记录为 control 来源，不伪造 nativeMessageId。引用中的“停止”、代码块内的命令、工具输出或自动反馈不作为用户控制指令。无法无歧义判断的消息，不可以仅因包含“状态”一词就逃过正常任务流程。

### 3.1 查询与需求必须在历史回读时继续分离

控制查询可以出现在用户可见聊天历史，但在可信本地记录中对**子动作**标注 `purpose=control_query`、`requirementEligible=false`。混合消息仅排除查询片段，保留 `requirementEligible=true` 的变更子动作及原文位置/内容摘要作为需求来源；不能过滤整条原消息而丢掉真实要求。向原核心提供这个受信的用途投影，原生聊天仍保留原消息，不伪造新的用户消息。不能只跳过当次 Hook，否则下一轮读取完整历史时仍可能把查询重新解释成需求。

`transcript.mjs` 现有同文本匹配不得覆盖可信映射。匹配优先使用宿主 ID/幂等关联及已持久化的原消息—子动作映射；可信 ID 不同，即使文本完全一样也是不同消息。旧记录没有可靠关联时，同文本至多作为待核实线索，不能据此覆盖 ID、继承查询豁免、授予需求权威或合并预算来源；标记 IDENTITY_UNRESOLVED 并保留原记录。

自动纠偏保留 `internal_system` 来源、原任务及反馈引用；工作会话不能给自身输入授予用户权限。reviewer 身份继续由持久化运行记录判断，不把提示词前缀当作授权证明。

### 3.2 变更要求的确认分三步

- `RECEIVED`：指令已可靠落盘，旧结果从此不具备交付资格；立即回复收到的变更内容。
- `BASELINE_COMMITTED`：原核心已更新需求版本并保存新旧需求差异。如果需求提取失败，保留待处理状态，不谎称基线已更新。
- `APPLIED_TO_WORKER`：原生工作会话的确认投递接口返回真实回执。失败时显示未生效，不能把“已接收”写成“执行器已按新要求工作”。

原生会话忙碌时不绕过其工具和沙箱策略。已经开始的工具操作可能先结束，记录其真实结果；随后按新要求决定复用、补充修改或重新验收。没有可靠依赖映射时，整个当前完成验收作废；能证明未受影响的文件保留历史证据，但不能直接把旧版本全局 PASS 搬给新需求版本。

### 3.3 核心显式提供 verify_only 与新的有界验收窗口

新增受信内部参数 `assessmentMode: execute_and_correct | verify_only`，由控制服务传入核心，不能由模型正文自行设置。默认执行闭环保留原规则。核心两条阻断分支及关联状态提交都必须理解该模式；仅在适配层停止 worker 不够。

| 核心行为 | execute_and_correct | verify_only |
| --- | --- | --- |
| 保存有效评审、逐项问题和证据 | 是 | 是 |
| 更新当前验证状态 | 在事务校验通过后更新 | 同左；有偏差即 DEVIATION，无有效结论即 UNVERIFIED |
| 发现阻断问题 | 原授权及预算允许时，提交纠正决定和派发意图，扣一次 | 记录 `correctionRequired=true`、`AWAITING_CORRECTION_AUTHORIZATION`，**不扣次数、不重置 epoch、不派发工作运行** |
| 反馈送达及问题解决 | 依据真实回执和有效复验 | 同左；保存问题不等于反馈已送达，更不等于问题已解决 |
| 通过后宣布完成 | 仍受第 8 节约束 | 仍受同一约束，不能把旧执行运行的取消/超时记录改成成功 |

同一需求、文件快照和有效验收窗口已有在途尝试时，重复请求复用 attemptId。有效 verify_only 发现偏差后，用户明确授权继续修正，核心重新核对当前代次、需求、证据及剩余预算，在**提交该修正派发意图的短事务**中以 correctionId 扣一次。重复授权、回调及同一派发意图恢复不重复扣减；证据过期先重新判断，不能拿旧问题直接派发修改。没有用户授权的 verify_only 不自动切换模式。

**时间窗与原运行分离：** 原执行运行已超时后，新的真实用户重验指令建立 `assessmentWindowId`，保存 `requestedAt`、`startedAt`、`deadlineAt = startedAt + effectiveVerifyTimeoutMs`。该值从有效评审超时配置解析为有限正值并写入记录；沿用配置的时长，不沿用已经过期的时间戳。新窗口有自己的 AbortController 和当前 generation/cancelEpoch，关联原任务/原运行以供审计，不继承旧运行已经触发的超时 signal。新窗口开始及运行期间的取消、插件关闭、会话重置仍立即生效。

每个明确的手动重验指令只授权 **1 次核心验收尝试**，内部各角色最多一次格式修复，所有步骤共享这个新窗口。不会因为自动基础设施预算曾耗尽而静默清空计数，也不会因一次手动重验重新开放一组自动重试。重复同一指令复用窗口，不能延长 deadline；排队未开始时显示排队，真正开始时固定截止时间，此后不续期。

保留 taskId、当前 requirementVersion/digest、correctionEpoch、内容预算和基础设施历史。合法评审后按原规则重置“连续”基础设施失败数可以保留，但历史累计数不清零。新窗口结束后不启动旧工作运行；再次重验需要新的明确用户指令。

## 4. 建议状态流转与并发规则

不新增第二套纠偏决策引擎。原核心仍决定通过、纠正、等待和终止；适配层记录可见执行状态并组织交付。

```text
接收任务 → 执行 → 验收
                 ├─ 有效结论且有内容偏差 → 原预算允许 → 修正 → 再验收
                 ├─ 有效结论且满足完成条件 → 交付前核对 → 已验证交付
                 ├─ reviewer 故障 → 原独立额度内重试 → 用尽后暂停/未验证
                 └─ 等待用户或预算耗尽 → 保留记录并暂停

任何阶段 ── 查询状态/反馈 ──→ 读取快照、单独回复；任务状态不变
发送提交前 ── 修改要求 ──→ 待更新基线、旧证据失效、按新要求继续
发送已提交但未确认 ── 修改要求/停止 ──→ 阻止后续活动，保留在途/未知交付记录
任何活动阶段 ── 停止 ──→ 停止中 → 句柄确认退出 → 已停止
暂停/未验证/旧运行超时 ── 用户重新验收 ──→ 新有界窗口 → verify_only
verify_only 发现偏差 ──→ 保存问题、等待修正授权，不扣内容预算
明确授权继续修正 ──→ 核心核对并提交唯一修正派发意图 → 扣一次 → 修正
```

分别保存三种信息，避免把进程结束等同于任务完成：

- `executionState`：RUNNING、PAUSING、PAUSED、STOPPING、STOPPED、FINISHED。
- `phase`：具体的执行、文件评审、最终验收、纠正、需求更新、交付阶段。
- `verificationState`：NOT_RUN、RUNNING、PASS、DEVIATION、UNVERIFIED、STALE；等待用户另存 `pauseReason`。

查询读取原子快照，不持有整个任务的控制器锁，不进入等待 reviewer 的 Promise 队列。取消和需求变更通过短事务控制收件箱接收，但其权威 generation、需求 pending revision、cancelEpoch 必须与核心提交使用**同一任务短事务及版本记录**，不能在另一个文件中各自加锁后产生校验空隙。接收事务提交后才确认收到；停止不排在需求提取或模型请求后面。

保留跨进程唯一控制器；taskId 确定后补齐任务级绑定，不能仅靠父会话互斥。每次执行/验收先记录派发意图，再派发。对决策、预算扣减与交付使用不同但关联的幂等键。旧 generation、轮次或 cancelEpoch 的结果只能追加审计事件，不能覆盖当前状态。

### 4.1 核心提交事务是取消与版本校验的最后边界

核心新增统一提交入口，例如 `commitAssessmentDecision(expectedContext, candidate)`；名字是设计示意。适配层传入经运行记录验证的 expectedContext，核心从权威任务记录读取当前值，不能只相信内存中的 signal。OpenClaw 受控调用缺少提交上下文应明确失败，不能跳过校验；其他宿主由各自适配入口保持既有默认行为并做回归。

流程必须是：

1. **事务外**派发并等待模型、执行只读证据收集、校验 schema、计算报告与候选决定。必要时保存不可变候选记录，但标为 UNCOMMITTED，不修改当前任务、偏差关闭状态或预算。
2. 进入同一个短任务事务，核对 `generation`、requirementVersion/digest、correctionEpoch、pendingRequirementRevision、`cancelEpoch`、插件启用版本、当前验收窗口及 deadline；核对候选绑定的证据版本，并检查 attemptId/correctionId 是否已经提交。
3. 任一条件过期：只追加带原因的 `LATE_RESULT_IGNORED` 审计记录；不更新 task.status、verification、lastAssessmentId，不关闭偏差，不增加内容/基础设施计数，也不把候选发布为当前评审。
4. 条件有效：按 assessmentMode 决定是否允许修正派发及扣数，将评审引用、问题/关闭变化、验证状态、预算变化和业务事件一起提交。verify_only 的内容预算 delta 恒为 0；自动模式或明确授权修正时以 correctionId 去重。
5. 事务提交后再更新可重建的只读投影并执行已记录的派发/交付意图；模型调用与网络等待始终在短事务之外。

必须覆盖两条 Stop 阻断分支、PASS、等待用户、基础设施失败及其计数分支，并把 `markMetricPassesFixed`、`recordDeviationFindings` 等有状态操作纳入同一提交。不能先调用这些函数修改记录，再在适配层检查取消；重构为准备变更与提交变更两个阶段，避免嵌套获取同一锁。

跨多个记录文件使用可恢复提交记录/提交标记：候选评审可先写入，只有事务提交引用后才成为当前评审；预算、决定和业务事件只能作为同一提交发布。恢复只完成已提交事务的投影，不重新执行模型或重复扣数。过期候选只保留审计；审计序号可以前进，但业务状态及业务计数保持不变。

## 5. 有内容的失败回复与防递归交付

新增确定性报告生成器，从持久化记录生成可见回复。它不调用模型，不原样发布未经验证的候选完成回复，也不靠删除“完成”两个字过滤风险。

回复用途分为：`verified_result`、`failure_report`、`status_report`、`control_ack`。只有 `verified_result` 可包含本任务完成声明，必须携带通过交付检查的记录。后三类由受信代码依据记录生成，不能成为新的 Stop 评审输入或触发 UserPromptSubmit。

用途由插件内部消息记录及所属回执绑定，不从模型正文读取；工作模型不能写一个“status_report”标记取得豁免。引用文件中的“全部完成”只是被引用内容，不能提升为系统结论。报告只陈述有证据的事实，未知字段明确为未验证。

状态回复属于查询消息自己的回执和生命周期，不能复用活动任务最终回复的消息 ID，也不能关闭、覆盖或冲掉活动任务进度。父历史只写一次真实用户消息、一次对应回复；内部 reviewer 提示和自动纠偏指令不伪装为用户消息。

每份失败回复至少展示：

1. 已保留的文件、最后记录的版本/时间；没有重新核对磁盘时注明“按最近记录”。
2. 每个文件的具体问题及 findingId、对应需求来源和评审记录。
3. 反馈是否实际送达；已观察到哪些写入/编辑，关联修改前后指纹。
4. 哪些问题已通过后续有效复验，哪些仍有偏差或尚未复验。
5. 中断原因、失败类别、尝试次数、最后有效活动时间。
6. 未解决事项、实际内容纠偏预算，以及用户可选的下一步。

采纳状态分开记录：`DELIVERED`（已送达）、`CHANGE_OBSERVED`（观察到修改）、`RESOLVED_VERIFIED`（复验确认解决）。模型说“已采纳”不构成证据；有编辑记录也不代表语义问题已解决；缺少记录显示 UNKNOWN，不能武断标为拒绝采纳。

### 失败回复格式示例

以下编号、文件状态和次数为**假设示例，不是用户当前工作区的验收结果**。

> 已暂停：最终验收连续 3 次运行失败。本次不能宣布全部完成。
>
> 按最近保存记录，三个文件保留在 `openspec/changes/local-notes-check/`；记录时间为 14:08。
>
> - proposal.md：发现持久化与允许丢失矛盾（P-01）；反馈已送达；删除了“仅存内存、允许丢失”要求；复验 R-04 对该文件快照通过。
> - design.md：仍采用内存存储，违背 proposal（D-01）；反馈已送达；未找到后续修改记录，最近有效评审仍不通过。
> - tasks.md：发现遗漏编辑、删除、完成状态、持久化，以及登录/云同步越界（T-01 至 T-06）；记录了补写持久化的修改，但该次修改后的复验未得到有效结论，其余事项尚未证明已解决。
>
> 中断原因：最终 reviewer 超时；这表示本轮验收不可用，不表示新增了内容偏差。实际内容纠偏已用 1/3 次；这 3 次基础设施失败没有扣除内容纠偏次数。
>
> 可继续查询反馈；重新验收当前文件；在剩余预算内继续修正；修改要求；或保持停止。以上状态查询不会启动模型或新的验收。

若连文件、反馈或修改记录都不存在，应直接写“是否已创建/送达/采纳：未验证”，不可生成看似具体的补全信息。

## 6. 真实阶段、等待与界面一致性

| 界面文字 | 驱动事件与条件 |
| --- | --- |
| 准备写入 design.md | 工具前检查已收到 Write/Edit，但工具尚未获准或开始 |
| 正在写入 design.md | 所属 nativeRunId/toolCallId 的真实 `tool.execution.started`，参数含已解析目标路径 |
| design.md 已写入 | 工具成功结束，读取修改后内容并记录指纹；工具失败不能显示成功 |
| 正在评审 tasks.md | 文件评审请求已落盘并实际派发，记录 reviewRole、assessmentId、目标文件 |
| 正在等待 GLM 最终验收 | 原生评审已启动、尚无有效结果；区分排队等待、模型请求、格式校验 |
| 正在进行第 2 次修正 | 原核心第 2 个实际纠正决定已提交，对应工作运行已派发；不能用所有原生 run 数量代替纠偏次数 |
| 评审故障，第 1/2 次重试 | 已记录失败原因及重试决定，真实派发后显示重试中；等待期间显示下一次尝试时间 |
| 停止中 / 已停止 | 已接收取消 / 所有相关活动句柄确认结束，分别显示 |

为 reviewer 的启动、模型请求、格式修复、结束增加事件元数据。`model.call.started/ended`、`tool.execution.*` 及当前真实 `run.progress` 用于更新时间，不展示私有思考正文或凭据。

进度记录带 taskId、generation、operationId、eventSeq、phaseStartedAt、lastActivityAt、deadlineAt 和 attemptOrdinal。重连/刷新按持久化快照恢复；只有当前运行、更高序号事件可更新当前阶段。多个在途工具列出各自状态，不让迟到的上一个工具结束事件覆盖正在评审的阶段。

等待时展示“等待对象、开始时间、已等待时长、最后活动、是否重试”。有支持的界面可本地计时；原生聊天若只能显示文字，则在真实阶段事件与查询时返回准确时间，不能宣称已有实时计时组件。仅因时间流逝，不伪造后端心跳或刷新宿主活动时间来延长任务寿命。缺少后续事件时显示“最后已确认阶段；当前运行是否仍活跃未验证”，不编造百分比。

## 7. reviewer 故障与成果偏差分别处理

| 项目 | reviewer 基础设施故障 | 成果内容偏差 |
| --- | --- | --- |
| 判定依据 | 超时、中止、认证/接口错误、输出截断、没有最终正文、格式修复后仍无效，或无法覆盖要求的评审对象 | 有效评审结论，在当前需求和证据下指出具体偏差，由原核心判断严重性及纠正必要性 |
| 结果 | 当前验收 UNVERIFIED；保留以前有证据的问题记录 | 当前对象 DEVIATION，记录 finding、需求来源、严重性、归因和证据 |
| 计数 | 独立 infrastructureFailures；另保留累计历史、attemptId 和失败代码 | 原 `stopCorrection.maxCorrectionsPerEpoch`；默认 3，以项目配置为准 |
| 自动上限 | 最终验收保留原核心首次 + 最多 2 次重试；真实 JSON/schema 错误每次最多 1 次格式修复，共享原截止时间 | 原核心决定每次修正是否派发和扣减；不能因展示同一偏差重复扣减 |
| 暂停 | 达到上限、绝对截止时间、取消；明确配置/认证错误可提前暂停并说明所需修复 | 预算用尽、需要用户决策、原核心停止条件命中 |

格式修复是一次评审尝试的内部步骤，记录 parentAttemptId 和调用次数，不能再叠加一层无界重试。运行截断/超时不按格式错误补问。自动闭环的重试受该次父运行及评审的原绝对截止时间约束，不会每试一次重置整个超时。用户手动重验按第 3.3 节取得新的有限窗口；窗口内部不续期，也不因旧父运行已经超时而立即拒绝新授权。

这里的“最多 3 次”指原核心最终验收的失败回合，不等于所有模型调用加起来最多 3 次；一回合可能包含需求提取、最终 reviewer 及一次格式修复。文件语义评审与需求提取的单次调用也最多进行一次格式修复，不额外套入另一组 3 次自动调用循环；之后由原核心事件与截止条件决定。记录必须同时展示角色尝试数、格式修复数、最终验收回合数，避免把不同层级重复计算成纠偏次数。

提交评审结果前验证结构、完整对象集合、重复/未知对象、来源与证据绑定。不能把缺失项默认填 PASS。有效结论尚缺依据时记录“依据待补充/未验证”，不强造内容偏差。故障发生后，过去已确认的偏差不会被删除，但只能声称对其当时快照有效。

去重及有效性校验需落在第 4.1 节的核心事务，而不只是 UI 层或核心返回之后：相同 attemptId 回调重放复用旧决定；相同 correctionId 只扣一次。verify_only 即使得到有效阻断偏差，内容纠偏次数也不变；取消先提交后返回的 PASS、偏差或故障结果均不能改变任何业务计数。查询、重新连接、重复通知和进程重启均不能清零计数。

## 8. 完成交付不可绕过的条件

`verified_result` 必须同时满足以下条件，不采用“无错误返回”作为替代：

1. 原核心认定任务完成，完成评审 PASS，任务完成状态及 verification PASS 一致；shadow/关闭验收不能取得这个保证等级。
2. 当前任务必需的评审对象齐全，无缺失、无阻断偏差、无必需但未验证项。
3. 评审使用的 requirementVersion、Ground Truth digest、规则/指标对象集合摘要与当前一致，没有已接收但尚未提交的真实需求变更。
4. 必需成果清单及每个文件内容指纹与验收快照一致；应存在却缺失的文件和相关目录清单也纳入证据。
5. 当前 generation、执行轮次及 cancelEpoch 与决定一致；当前授权的执行/验收窗口未取消、未重置、未超时；没有尚未结束的相关写入或评审。旧父运行的历史超时仍保留，但不冒充新手动验收窗口的截止时间。
6. 发送提交前重新核对，通过下面的交付状态机记录唯一 outbox；宿主确认另行记录，不能把派发或排队当作确认。

证据指纹必须绑定实际交给评审的内容或受原权限约束的不可变副本，不能只在读取结束后重新读取磁盘算一个 hash。发现读取期间变化、必要内容被截断或覆盖不足时，本次完成验收标为未验证。这样才能避免“评审看到旧内容，记录却绑定了新文件”的错误通过。

保留原有“正常聊天无需任务验收”的原核心判断，但控制回复只能陈述记录，不能借 CHAT 分支交付活动任务的完成声明。

需求变化、关联文件修改、会话重置或取消使旧完成决定失去**新的发送提交资格**，已提交发送的消息另按下面的在途规则处理。旧评审保留为历史事实，标 STALE 或 LATE_RESULT_IGNORED，不删除审计链。取消已在核心事务中提交后返回的 reviewer，只能进入过期审计，不能先改状态再靠适配层撤销。

### 8.1 明确“已发送、未确认”的窗口

```text
READY ── 原子校验并记录发送提交 ──→ SEND_COMMITTED ── 有效宿主回执 ──→ ACKED
  │                                      └── 超时/断连/崩溃/无法确认 ──→ UNKNOWN
  └── 取消或证据过期 ──→ CANCELLED / STALE
UNKNOWN ── 核对到原有的有效宿主回执 ──→ ACKED（注明可能在取消后才确认）
```

- **READY**：内容、目标及证据已准备，但没有发送授权。取消先提交，禁止转入 SEND_COMMITTED；需求或文件版本变化同样阻止旧内容发送。
- **SEND_COMMITTED**：在与控制操作一致的短事务中，复查第 8 节条件并记录 outboxId、不可变 payload 摘要、目标会话、幂等键、证据快照及 `sendCommittedSeq`。该状态是发送的线性化点，不等于宿主已经接收，更不等于用户已看到。事务外最多发起一次对应发送尝试。
- **ACKED**：取得可与 outboxId/宿主消息/幂等键对应的有效回执。保存 receiptKind，区分历史落盘、宿主接收、渠道送达；`queuedFinal/counts` 不能自动升级成可靠历史或可见送达确认。
- **UNKNOWN**：发送提交后未取得有效回执，包括进程可能在提交后、真正调用发送前崩溃的情况。先查询已有宿主回执/历史和插件 outbox，不自动重发，不因找不到一次记录就断言消息没有到达。缺少可核对接口则保持未知。

**取消竞争规则：**

| 取消落盘时机 | 必须采取的动作与用户说明 |
| --- | --- |
| SEND_COMMITTED 之前 | 禁止发送，停止执行和评审；可明确说“该完成回复未提交发送” |
| SEND_COMMITTED 之后、ACKED 之前 | 停止后续执行/评审/新发送；可尽力中止在途传输，但保留在途或 UNKNOWN 状态。说明“取消已记录；先前回复发送在途/结果未知，仍可能到达”；活动句柄未退出时仍显示停止中，不能承诺绝不会送达 |
| UNKNOWN 期间 | 保持停止，仅核对已有回执；不重发。之后收到回执只更新交付审计，不把已取消任务改回成功或恢复预算/执行 |
| ACKED 之后 | 保留此前快照的历史交付，停止后续活动；不能承诺撤回已确认消息 |

取消的核心状态与交付状态是两个字段，可以同时为“任务已停止、先前发送 UNKNOWN”。核心评审提交成功也不等于发送已提交；必须分别记录两者的提交序号。新要求在 SEND_COMMITTED 后到达时，旧快照不再是当前要求的有效结论，标明过期；不宣称能收回在途文本。

受控工具写入与发送提交共用写入栅栏，网络发送和等待回执不占用任务短事务。状态查询/取消确认使用自己的请求和 outbox，不能复用原任务完成消息的回执；UNKNOWN 的原消息也不能被查询回复覆盖。

**文件系统边界：** 外部进程不受插件锁约束，不能承诺任意外部写入与网络发送绝对原子。完成证据绑定明确快照和时间；SEND_COMMITTED 前检测到变化则阻止提交，其后变化将快照标为过期并说明在途或历史消息的范围。要求更强保证需要不可变成果快照或宿主级文件隔离，不能声称纯插件已做到。

## 9. 持久化字段与目录

扩展现有 task state、journal、evaluations 和 OpenClaw controller 记录；新增状态投影和控制收件箱。历史记录缺少新字段时标为 UNKNOWN/未验证，不由旧 assistant 文本反推。

| 字段组 | 必需字段 |
| --- | --- |
| 关联和幂等 | schemaVersion、eventId、eventSeq、taskId、parentSessionId、parentRunId、nativeRunId、workerSessionId、generation、round、assessmentId、attemptId、correctionId、causationId、dedupeKey |
| 输入与权限 | nativeMessageId（可能缺失）、transportRequestId、commandId、actionId、原消息/子动作/历史记录 ID 的可信映射、片段位置/摘要、actor、provenance、intent、purpose、requirementEligible、receivedAt、接收/基线提交/工作会话回执 |
| 需求与控制 | requirementVersion、groundTruthDigest、sourceIds、correctionEpoch、pendingRequirementRevision、cancelEpoch、enabledStateRevision、controller owner、expectedContext、taskCommitSeq、assessmentCommitId、候选 UNCOMMITTED/已提交标记 |
| 进度与时间窗 | executionState、phase、operationId、toolCallId、filePath、reviewRole、phaseStartedAt、lastActivityAt、attemptOrdinal、retryReason、nextRetryAt；assessmentWindowId、originRunId、requestedAt、startedAt、effectiveVerifyTimeoutMs、deadlineAt、窗口自身取消绑定 |
| 成果与证据 | artifactManifest、逐文件 hash/存在状态、相关目录清单摘要、beforeHash、afterHash、observedAt、rulesDigest、metricPopulationDigest、evidenceSnapshotId、staleReason |
| 反馈与采纳 | findingId、requirementRef、严重性、归因、feedbackId、deliveryReceipt、editEventIds、recheckAssessmentId、adoptionState、未解决说明 |
| 评审与预算 | assessmentMode、correctionRequired、correctionAuthorizationCommandId/actionId、correctionDispatchIntentId、budgetDelta、transportOutcome、assessmentOutcome、failureCode、formatRepairCount、consecutiveInfrastructureFailures、historicalInfrastructureFailures、correctionsUsed/limit、原核心 decision 和 evaluationId |
| 交付与恢复 | replyPurpose、outboxId、completionDecisionId、deliveryState（READY/SEND_COMMITTED/ACKED/UNKNOWN 等）、sendCommittedSeq/At、payloadDigest、目标会话、hostIdempotencyKey、sendAttemptedAt（未知时为空）、hostMessageId、receiptKind、deliveryReceipt、ackAt、unknownReason、cancelledDuringSend、statusSnapshotSeq、asOf、pauseReason、lateResultIgnoredReason、recoveryState |
| 测试结论 | testScope、fixtureCaseId、expectedFinding、injectedSnapshotId、observedFindingId、feedbackReceipt、repair/recheck 引用、coverageVerdict、closureVerdict、perArtifactQuality |

状态投影放在现有任务目录下，例如 `tasks/<taskId>/status.json`；控制指令与事件保存在独立子目录，不使用整轮控制器锁，但权威版本更新必须进入第 4.1 节的同一任务短事务。沿用私有权限、原子替换和进程互斥。投影只发布已提交事件，不让查询看到半条结果；记录读取失败直接返回“记录不可用”，不能降级成模型编造。

## 10. 故障注入测试与文档质量分开出结论

首先把本次测试范围冻结到真实需求：检测覆盖测试，还是包括修正及复验的完整闭环。不能由执行模型在失败后自行缩小测试标准。

检测覆盖按每个注入项对照：实际 Write/Edit 写入的坏快照 → 规则/语义 finding → 反馈实际送达。需要验证修正的项目继续关联真实修改及有效复验。包含指定三个文件、唯一 changeName、Write/Edit 限制、没有应用实现、配置文件未变等约束；没有操作记录或前后指纹就不能宣布这些约束已满足。

Write/Edit 限制针对主工作会话创建和修改目标文档的工具；内部 reviewer 保持只读，插件自己的日志和控制记录仍通过受控原子写入保存，不把日志写入误算成应用实现。

文档质量则根据**当前需求和当前文件快照**分别判断 proposal、design、tasks。不能因“这是故意写错的”而把持久化冲突、功能遗漏、登录/云同步越界改标 PASS，也不能以只通过 proposal 代表另外两个文件。

下面均为展示示例，非本次实际工作区结论：

| 独立结论 | 示例 A：检测到了问题，成果仍有错 | 示例 B：完整纠偏闭环通过 |
| --- | --- | --- |
| 注入问题检测及反馈覆盖 | PASS：所有约定注入项均有坏快照、finding 和送达回执 | PASS：同左 |
| 修正及复验闭环 | 未完成：仍有问题未确认修好 | PASS：所需修改及后续复验有完整记录 |
| proposal | PASS，绑定当前快照 | PASS，绑定当前快照 |
| design | DEVIATION：持久化设计冲突仍存在 | PASS，绑定当前快照 |
| tasks | DEVIATION：仍遗漏任务/存在越界项；若修改后未复验则显示 UNVERIFIED | PASS，绑定当前快照 |
| 用户任务最终交付 | “检测覆盖成功；文档尚未全部合格，完整闭环未通过。” | 只有原核心完成及交付检查同时满足，才可宣布本次任务完成 |

如果用户明确只要求检测覆盖，且原核心依据这个既定任务范围确认完成，可以说“约定的检测覆盖测试完成”；仍必须独立注明文档质量不合格，不能泛化为“全部完成、三个文件均通过”。若没有完整覆盖记录，就连“看护机制测试通过”也必须标未验证。

## 11. 具体模块改动点

以下为建议改动，不代表已实现。

| 模块 | 改动 |
| --- | --- |
| `lib/openclaw/entry.mjs` | 按第 2 节注册认证 Gateway 控制主通路、只读插件命令、有限的 reply_dispatch 查询及取消/重置生命周期；保留原普通任务入口，不覆盖 chat.send |
| 新增 `lib/openclaw/interactions.mjs` | 共享分流、nativeMessageId/commandId + actionId 映射、混合输入片段投影、控制收件箱、独立接收回执、身份/任务范围校验和 mutation 幂等 |
| 新增 `lib/openclaw/status.mjs` | 只读状态投影、反馈采纳链聚合、等待时间计算、确定性报告；读取不进入任务队列 |
| 新增 `lib/openclaw/delivery-policy.mjs` | 回复用途绑定、完成检查、READY → SEND_COMMITTED → ACKED/UNKNOWN、发送取消竞争和回执核对；控制回复独立，不伪造确认或自动重发未知结果 |
| `lib/openclaw/supervised.mjs` | queueMessage 先分流；丰富失败回复；仅复验显式调用核心 verify_only；为用户重验创建新有限窗口；传递取消/版本守卫，消费核心已提交结果，不能把返回后 abort 检查当预算保护 |
| `lib/openclaw/runtime.mjs` | 查询绕开 withState/Stop；真实需求变更送 UserPromptSubmit；把 assessmentMode、windowId/deadline、generation/需求/cancelEpoch 上下文传入核心；保留前后 abort 快速检查，但以核心事务为准 |
| `lib/openclaw/transcript.mjs`、`lib/runtime-v2/ground-truth-provenance.mjs` | 原消息 + 子动作的可信用途投影在回读中保持；混合消息只排除查询片段；同文本匹配不得覆盖可信身份；内部反馈不获得用户权威 |
| `lib/openclaw/controller-store.mjs`、`lib/runtime-v2/task-store.mjs` | 权威控制版本与核心结果共用短事务；候选/提交分离；保存窗口及 outbox 状态、补齐任务唯一绑定；可恢复提交及原子只读投影，不重做不确定副作用 |
| `lib/openclaw/evidence.mjs` | 逐文件持久化指纹、必需/缺失对象、需求/规则绑定、修改后的失效及交付前复查 |
| `lib/openclaw/reviewer.mjs`、`reviewer-policy.mjs` | 保留 `.6` 故障分类；增加 role/文件/attempt 等进度元数据；关闭和迟到结果处理 |
| `lib/runtime-v2/orchestrator.mjs` | 两条 Stop 阻断分支显式支持 verify_only；准备/提交分离；PASS、偏差、故障、预算及偏差关闭统一进入带代次/需求/cancelEpoch 校验的事务；授权修正后以 correctionId 扣一次，不改原严重性/归因算法 |
| `lib/openclaw/compat-2026.7.1-2.mjs` | 仅包装确实存在且调用方已提供的排队/取消/历史能力；契约明确 reply_dispatch 无 recorder、命令无稳定消息 ID；缺失时返回能力不足，不能靠导入工厂补造 |
| 测试与诊断脚本 | 增加交互、报告、事件、预算及双结论断言；复用合成 GLM 脚本和三宿主构建流程 |

## 12. 可重复验收用例

测试保存输入、事件序列、需求/预算前后快照、原生运行计数、文件指纹、消息回执及最终界面证据。下面全是**待实施用例**；不能把现有 58 项基线测试的通过移用过来。

| 编号 | 场景 | 必须断言 |
| --- | --- | --- |
| A01 | reviewer 挂起时询问“到哪一步了” | 不等待 reviewer；返回真实最后阶段/时间；需求 digest/version、epoch、预算、controller generation 均不变；worker/reviewer 新调用数为 0 |
| A02 | 模型 provider 完全不可用时查状态 | 仍由记录正常回答；记录也不可用时明确说明，不调用其他模型补答 |
| A03 | 查询反馈及采纳 | 正确区分已送达、已改动、复验通过、未知；没有新验收；引用编号可追到事件 |
| A04 | 未验证结束后再次查询 | 获得具体解释，不再返回同一笼统失败；不创建控制器，不重新提取需求 |
| A05 | 查询写入历史后再正常执行/压缩/重启回读 | 查询及自动反馈不变成需求源；原消息 ID + actionId 映射不变；不同可信 ID 的同文本消息不合并；同文本匹配不得覆盖可信 ID 或继承查询豁免，旧记录身份未定时保留 UNKNOWN |
| A06 | 混合输入、引号/代码块、模糊指令 | 同一消息的 query-1/requirement-1 分别落盘；历史回读只排除查询片段，真实要求保留来源及片段；重复消息/重连不重建子动作 ID、不重复更新要求；引用不执行，模糊变更不猜测 |
| A07 | 执行中补充要求 | 接收先落盘、旧完成资格立即冻结；分别核对接收、基线提交、worker 送达三份回执；重复同一消息仅一次生效 |
| A08 | 评审中变更要求，同时旧 PASS/偏差/故障返回 | 在核心提交前暂停夹具，先提交新 requirementVersion/pending revision，再释放结果；旧结果只写审计，task/verification/lastAssessmentId、偏差关闭及两类预算不被它修改；不能只断言最终没发消息 |
| A09 | 网页停止/终端取消与核心结果、发送竞争 | 取消先于核心提交则 PASS/偏差/故障均仅审计；取消先于 SEND_COMMITTED 则零发送。发送先提交时按在途/未知说明，停止后续派发，不能保证原消息不到达；句柄未退时报停止中 |
| A10 | reviewer 或工具不配合取消 | 不宣称已完全停止；明确未确认的运行/副作用；迟到结果只审计，不能扣新预算或覆盖状态 |
| A11 | 核心 verify_only 得到阻断偏差、重复点击及随后授权修正 | 分别覆盖非完成分类和完成分类两条核心阻断分支：保存评审/问题，correctionAttempts 前后严格相等、零 worker 修改、无 epoch 重置；随后明确授权且核对有效，提交一个 correctionId 只扣一次；重复授权不再扣数 |
| A12 | 原运行已超时/基础设施额度耗尽后手动重验 | 取得新 windowId 和未来的有限 deadline，不复用旧已过期时间或 abort signal；每个明确新指令最多一次核心验收，无新自动重试批次；taskId、GT、epoch 及预算历史保留；重复指令复用窗口且不续期，新取消仍有效 |
| A13 | timeout、空正文、截断、401、无效 schema | 全部与 DEVIATION 分开；真实格式错误最多一次修复；运行失败不格式补问；内容纠偏次数不变 |
| A14 | reviewer 连续失败 | 原自动上限为最多 3 次评审尝试，且受绝对截止时间限制；停止后仍能查询；显示实际调用/重试/格式修复次数 |
| A15 | 持续内容偏差，项目预算设为 2 | 原核心最多派发 2 次纠正；第三个需要纠正的决定进入预算耗尽，不再写入；不能误报成功 |
| A16 | 同一结果重复通知、旧代次/轮次迟到 | 覆盖 PASS/偏差/故障三个结果类型；一个 attempt 决策提交一次、一个 correction 扣数一次；在核心事务前更换 generation 后旧结果只能审计，两类计数及偏差关闭不能改变 |
| A17 | 需求不完整或等待用户 | 明确需用户决定的事项；不造偏差、不自动猜测需求、不宣布全部完成 |
| A18 | 必需文件缺失、评审对象缺失/重复/未知 | 不能将少数对象 PASS 当全局 PASS；未被读取的必需文件也不能漏掉 |
| A19 | 文件在验收中/验收后/发送提交前后修改 | 有关证据失效；SEND_COMMITTED 前阻止旧成功提交，其后标在途/历史快照过期，不承诺收回；无关文件不无故使本任务失效 |
| A20 | 取消、需求 pending、文件变化及确认丢失的竞争点 | 夹具覆盖核心提交前、核心提交后但 READY、SEND_COMMITTED 后未调用发送、已发未确认、UNKNOWN、ACKED；核对原子守卫、不可重复扣数、发送最多一次、未知不重发、晚回执只更新交付审计；队列计数不能当 ACKED |
| A21 | 控制器崩溃或重启，核心提交/派发/发送状态不确定 | 仅发布有提交标记的评审/预算/事件；候选不能变成当前 PASS；SEND_COMMITTED 无回执恢复为 UNKNOWN，先查回执不重发；状态可读，不能重复模型调用或副作用 |
| A22 | 两会话并行、同一任务重复控制器 | 状态/反馈不串会话；同一 task 唯一有效控制器；查询不被整轮互斥锁卡住 |
| A23 | reviewer 嵌套调用/伪造控制前缀/纠正后复验 | reviewer 不能创建控制器或其他 reviewer；worker 不能创建子控制器；真实修正后的正常复验仍执行 |
| A24 | 进度乱序、重连、长等待 | 迟到事件不覆盖当前阶段；显示正确文件/尝试/等待时间；计时不产生虚假后端活动或延长截止时间 |
| A25 | 注入故障全部检测到，但 design/tasks 仍错 | 检测覆盖与文档质量独立；design/tasks 不得 PASS；完整闭环不能因发现问题而通过 |
| A26 | 原始三文件任务完整闭环 | 逐文件坏快照、finding、反馈回执、最小修正和有效复验可追溯；仅 Write/Edit，唯一目录，无应用代码写入，配置 hash 不变 |
| A27 | 固定版本能力契约及网页真实操作 | 先断言 reply_dispatch 不含 recorder、MessageSid 与 transcript ID 不混用、命令缺消息 ID 时不能做变更、Gateway commandId 同键异内容冲突；再测普通发送/Queue/Steer 的身份、接收、查询、补充、停止、重验和历史。分别记录各入口结果，独立 RPC/状态页成功不能替代网页聊天通过 |
| A28 | 终端聊天及独立 CLI 控制入口 | 分别测 TUI chat.send 的身份/编号、忙碌查询、取消、进度、历史及最终回复；另测 CLI 调用 Gateway 的稳定 commandId、响应丢失后查回执、无认证/越权拒绝。二者各自出结论，不能把 CLI RPC 成功算作 TUI 聊天通过 |
| A29 | 三宿主及安装回归 | 原源码测试、OpenClaw 新旧专项、三宿主构建、临时配置安装、禁用受控执行与回退均验证；不改宿主或用户配置 |

建议服务指标（目标，未验证）：在本机健康 Gateway、reviewer 被测试夹具挂起时，插件状态读取及报告生成不超过 1 秒；网页/终端端到端状态回复 p95 不超过 2 秒，统计至少 20 次。分别报告浏览器排队时长、服务端处理时长和交付时长，不能从请求尚未到达插件时就承诺插件已接收。

## 13. 实施顺序与发布门槛

1. **落实已选入口与能力契约。** 实现认证 Gateway 控制服务、只读插件命令、原生任务及 Steer 接入；按第 2 节逐入口验证，不再把缺失 recorder 留作“优先验证”或期望兼容导入补出。
2. **先解决可见性。** 加可信交互分类、只读状态投影、反馈采纳链和确定性失败报告；复现并消除查询被当作补充要求、有效解释被统一提示覆盖的行为。
3. **先完成核心提交保护，再启用有状态控制。** 实现 verify_only、新有限验收窗口和授权修正一次扣数；将两条阻断分支、PASS、故障及偏差关闭纳入同一受保护事务；再接通变更、停止和重验控制请求，以及 SEND_COMMITTED/UNKNOWN 交付状态机。
4. **补全事件与双结论。** 文件/评审/纠正阶段准确可见，测试覆盖与成果质量分别出结论。
5. **运行完整验证。** 先确定性夹具，再隔离 GLM/原生模型测试，最后网页及终端原始任务；完成三宿主回归和临时安装。

新包版本为 `1.9.1-openclaw.7`；安装、关闭受控执行和退回 `.6` 见 [使用说明](openclaw.md)。任何真实入口尚未满足，验收报告列为未验证或不通过，不宣称全面适配。禁用受控执行后仅有 Hook 行为的限制需明确；不能把关闭验收作为解决问题或“验收通过”的方式。

专业评审追踪：P1 入口能力对应第 2 节及 A27/A28；P1 verify_only 与新时间窗对应第 3.3 节及 A11/A12；P1 核心事务对应第 4.1 节及 A08/A09/A16/A20/A21；P1 发送未知窗口对应第 8.1 节及 A09/A19/A20/A21；混合消息与可信身份对应第 3.1 节及 A05/A06。

本次实现仅在隔离 Gateway 与临时工作区安装联调，未替换用户安装或修改用户 `.runtime-corrector/`。下述设计条款是验收目标；不能据设计条文本身认定已通过。实际通过、限制和未验证项，以 [A01–A29 验收记录](openclaw-acceptance-7.md) 为准。

## 14. 实现索引

- `runtime-v2/decision-scope.mjs`、`task-store.mjs`：计算阶段暂存，短事务校验后发布不可变提交清单；预算、问题、事件及最新诊断共同提交；重启仅恢复已提交投影。
- `runtime-v2/orchestrator.mjs`：两条阻断分支支持 `verify_only`；授权修正单独提交派发意图。`reviewer.mjs` 增加受影响文件及独立文件质量结论；不替换原指标判断。
- `openclaw/interaction-store.mjs`、`control-service.mjs`：会话绑定、命令去重、新验收窗口、停止和独立回执。
- `openclaw/native-query.mjs`、`interaction-router.mjs`、`transcript.mjs`：受信查询和混合消息子动作映射；不以同文本或提示词标记猜身份。
- `openclaw/report.mjs`、`native-runs.mjs`：只读报告、逐文件反馈链、真实调用与未结束运行记录。
- `openclaw/control-entry.mjs`、`ui/`：四个 Gateway 方法、独立状态页、终端命令和只读聊天命令。
- `openclaw/evidence.mjs`、`delivery.mjs`：实际读内容/文件指纹、交付守卫和 UNKNOWN 核对。
- `openclaw/supervised.mjs`、`runtime.mjs`：执行控制与取消、真实阶段、防嵌套，以及原生心跳/后台输入的身份隔离。后台消息不能覆盖等待授权的任务。
