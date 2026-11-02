# 原生组件预检与下一批设计

用户已将模型、资源与合理预算交由监督方规划，并允许修改 RC 内部指标/checklist/调度/表示。首批规划上限为估算 USD 30、60 次提供方请求、4 小时墙钟。当前累计四次真实请求：旧Anthropic两次401、费用未知保留USD0.454656；用户更正Coding Plan地址后，由监督方执行两次200，总用量完整，参考估算USD0.009842。累计按参考估算/旧预留合计USD0.464498，实际账户账单未知。当前无在途请求，不再派发。统一结算见 `.runtime-correction/native-component-preflight-20261030/settlement.json`。

本次未修改 RC 生产模块、安装宿主或启动容器；新增开发专用预算/合成验证接线及必要定向回归。此前冻结的源码与历史产物保留，不能将旧全量清单称为覆盖本次新增 helper。白名单事实位于 `.runtime-correction/native-component-preflight-20261030/facts.json`。

最新无模型准备已完成：复用现有evaluate-stop-workspace和生产factory，最小扩展native helper支持隔离openai-completions和两例共用的硬预算。最终同进程两例wire分别33340→46795和33340→46791字节，输出维持32768、默认适用M12/M16。五项定向检查通过，包含读取边界、未知usage停发、每例6/合计12、同一deadline、一次性claim及不回退认证。中性UUID身份、唯一外部虚构contract放行、profile/build隔离及机器标签中性化均为实验数据隔离，不算RC效果收益。详见[具体启动模板及待监督核验清单](rc-native-stop-pair-proposal-20261030.md)，最终记录在`native-stop-live-preparation-001/`；新增真实请求为零，无最终语义结论，未启动live模式。阶段绝对截止为2026-10-30T15:21:55Z，准备与等待计入墙钟。

## 历史：新认证恢复模式准备

用户已将新认证信息直接交给监督方；本线程没有收到、打印或持久化该密钥。专用`--approved-key-recovery`模式已准备，与两个旧审批模式互斥，只读取临时子进程env `RC_CALIBRATION_API_KEY`，随即移除env副本并在内存使用，不读旧配置/认证文件来回退。没有该非空值时在建批次前拒绝启动。

本批由监督方启动，使用新目录和独立五分钟窗口，不借用最初二十分钟期限。route/model固定`review/glm-5.3`，唯一目标路径为`https://open.bigmodel.cn/api/anthropic/v1/messages`；仍仅允许原四份412字节虚构材料、固定提示、通用source_read schema、模型自身输出及真实toy工具结果。两旧批均在途为零才准入，并继续保留USD0.454656未知消耗预留。

恢复批至多两次HTTP、串行、输入32768/输出8192含思考、maxRetries=0及redirect=manual，新增最坏估算上限USD0.8192；与旧两次合计最多四次、总最坏估算上限USD1.273856，实际账单仍未知。派发前重新冻结源码、虚构来源、提示及schema身份，任何错误/usage未知停发，不切路由。四项恢复模式检查及五项fetch契约检查通过，本线程只做离线准备，未执行此批。

监督方随后启动关闭回显launcher的申请被自动审批拒绝：尚缺用户对将新凭据用于确切 `https://open.bigmodel.cn/api/anthropic/v1/messages` 端点认证的明确批准。进程未创建，新凭据未传递，请求数未增加，恢复批没有启动。监督方已提交该具体两请求/五分钟/USD0.8192方案的确认，当前等待答复。runner及三个helper继续冻结，不代跑、不改入口绕过拒绝；已保留预留仍仅为旧两批USD0.454656，新增USD0.8192只是未执行的上限。

## 最新更正：Coding Plan Chat Completion 准备

用户随后明确批准两请求恢复校准，并更正base为`https://open.bigmodel.cn/api/coding/paas/v4`。监督方已创建的关闭回显launcher在递交认证前再次被审批拦截，凭据未传入，进程已终止，`key-recovery-live-001`未创建，真实请求累计仍为旧两次。旧Anthropic模式与其记录均作为历史保留，当前CLI已拒绝旧审批flag。

新的唯一模式是`--approved-coding-key-recovery`，api=`openai-completions`，实际路径严格固定为`/api/coding/paas/v4/chat/completions`。官方[接入说明](https://docs.bigmodel.cn/cn/coding-plan/tool/others)与[快速开始](https://docs.bigmodel.cn/cn/coding-plan/quick-start)将用户指定base列为OpenAI Chat Completion；没有改用标准API base、Responses或Anthropic。

复用已安装OpenClaw的`@openclaw/ai` OpenAI-completions serializer；该实现将`maxRetries:0`传给SDK请求，已用无网络200/500受控响应证明每次只进入一次fetch。全局宿主包装器的另一实现没有透传此选项，所以本次通道校准直接调用安装版serializer，未改宿主或主Agent。兼容参数固定`max_tokens`、`stream_options.include_usage=true`及文本system角色，固定虚构prompt和source_read内容保持不变。

新批仍仅临时env认证、二请求/五分钟、32768输入上界/8192输出、USD0.8192保守规划帽，旧USD0.454656未知费用不释放。guard核对完整实际JSON语义、唯一origin/path/model、输出字段和stream usage、manual redirects；缺总input/output、终态或完整HTTP body均停发。OpenAI的prompt_tokens按包含缓存的完整输入全价记账；未报告cached/reasoning分项保留null，ledger零缓存分配只表示不给缓存折扣。接受finish与usage同chunk或choices=[]尾usage；HTTP body完整且finish/usage有效时不强求[DONE]，但[DONE]不能补齐缺证据。官方[流式说明](https://docs.bigmodel.cn/cn/guide/capabilities/streaming)也将finish_reason与usage描述为末尾chunk字段。

新准备证据在`coding-recovery-preparation-001`：初始与四toy工具结果的实际wire JSON、历史源码归档、17项Coding/模式/隔离检查与5项共享fetch契约检查通过。首次因undefined缓存参数在JSON中被省略而误拒的失败已保留；现按完整JSON序列化语义比较，未知新增内容仍拒绝。只有假认证和受控响应用于离线检查，没有网络外发或新真实模型请求。当前源码与新协议清单重新冻结，监督方负责内存认证启动，本线程只读结果。

## Coding Plan 实际校准结算

监督方已用关闭回显/临时子进程env执行获准批次，目录为`coding-key-recovery-live-001`。两次实际HTTP均为200，目标均严格为`https://open.bigmodel.cn/api/coding/paas/v4/chat/completions`，model=`glm-5.3`，输出cap8192；累计8.733秒，最终因两请求帽停止，halted=null、在途0。六个本仓源码及安装版serializer SHA与派发前清单匹配，四个冻结runner/helper未改变。

提供方原始SSE分别报告prompt_tokens=428/582、completion_tokens=28/98、cached_tokens=0/384、reasoning_tokens=15/59，均有tool_calls终态和DONE，完整HTTP body已收齐。总输入1010、输出126、合计1136；输出含提供方报告的74 reasoning tokens。账本按1010全部prompt token全价估算，没有再把384缓存token加一遍或取得缓存折扣，参考成本为USD0.009842。它不是Coding Plan实际账单；宿主归一化usage不能替代这些原始字段。

模型实际生成四个source_read调用，依次读取request.txt、toy-document.md、SKILL.md及toy-code.mjs，工具回执均成功。第一份实际工具结果的完整文本SHA与第二次请求中对应tool_call_id的tool消息一致，证明真实回传。后三份读取发生在第二次模型响应之后，没有第三次请求，不能声称模型已经消费这三份结果。两次响应都以tool_calls结束，没有最终模型判断或任务解决结论。

独立只读核验记录为`coding-recovery-preparation-001/primary-result-audit.json`，没有新增测试、调用或读取新密钥。本批仅证明已更正通道与合成工具回路可用；原生RC四模块语义、反馈送达/修复闭环、bench成绩及模型效率仍未验收。[下一批一正一反Stop组件方案](rc-native-stop-pair-proposal-20261030.md)另行提议，尚未执行或获得额度。

## 已结算的纯合成首探

结果根目录为 `.runtime-correction/native-component-preflight-20261030/live-synthetic-001`。实际目标 `https://open.bigmodel.cn/api/anthropic/v1/messages`，route=`review/glm-5.3`，唯一一次实际fetch返回HTTP401。实际首个body为1614字节，max_tokens=8192，思考字段未显式提供。完整请求是已审固定提示、通用source_read schema及新编虚构材料；未加入真实仓库源码、私人上下文或认证内容。

首个账本guard计数1、在途0、usage未知，保留完整32768输入与8192输出的最坏估算预留USD0.4096；没有重试或在该账本切换通道。该预留使用监督方冻结的参考费率（GLM-5.3输入USD7/M、输出USD22/M，缓存输入按输入价），不是实际账单。提供方实际费用未知，宿主错误信封中的零用量不计作真实usage。

随后监督方依据两条既有配置使用不同凭据的新事实，单独批准`glm/glm-5.3-flash`认证校准，要求首账本封存、至多三请求、五分钟且不得超过首次清单创建后二十分钟。新目录为 `live-synthetic-flash-001`，在规定窗口内运行。首请求同样返回401：body1620字节，max_tokens=8192，usage未知、在途0、无重试，保留USD0.045056估算预留并停发。该批在派发前冻结了源码SHA、四份虚构来源、固定提示及schema；五个源码文件当前均与冻结摘要一致。

两个不同既有凭据分别在同一官方协议入口被401拒绝，服务原因未定。两批合计两次请求，没有模型生成的有效工具行为或成功模型回复；各自余下槽位均未使用。USD0.454656是保留的最坏估算金额，不是实付或已知消耗。它和两次请求计入首阶段USD30/60请求/4小时规划上限，不能因更换账本抹去首失败的未知成本。

这次401没有取得模型生成的有效工具调用或完成结论；离线人工构造的工具调用只用于捕获后续输入，不能算真实模型行为。模型通道、原生RC模块、官方bench及效果/效率均未据此通过。

`result.json`保留结算，`request-1.json`保留无认证的实际请求内容，`run-audit.json`记录源码身份限制：没有在派发前保存源码文件SHA，因此当前helper摘要不能伪装成当时冻结身份。运行清单和实际payload身份已保留；不得为补证据而重发。

监督方要求的adapter级`redirect:manual`补强及本地302回归发生在首次401之后；在该首账本无后续请求，独立Flash校准发生于补强之后。已安装宿主本身在这条路径使用manual重定向；首次收到401，没有发生跳转。补强后的回归证明第二目标未被访问、一个302占一个槽并按未知usage停发。

离线认证诊断位于 `auth-diagnostic-001/result.json`：三条配置均为字符串环境模板，review取自state dotenv的`REVIEWER_API_KEY`，glm/工作通道取自`ANTHROPIC_AUTH_TOKEN`；没有残留占位、值冲突或trim差异，runner与宿主配置替换及custom-provider解析结果一致。补充 `priority-result.json` 使用标准只读认证store和模型凭据选择函数，review适用profile为零，最终source为`models.json`、mode为api-key，与runner凭据逐字一致。只输出来源标签和布尔比较；无密钥/profile内容输出、无keychain提示、无网络调用或刷新。结论仅为当前实验发送的既有review凭据被该协议入口拒绝，不能断言key过期或服务拒绝原因。监督方已将本机认证/权限依赖交回用户；这里不重复询问或继续搜寻认证信息。

## 模型、推理及计费事实

下表是本机配置声明及环境引用解析后的白名单信息，不能升级为真实推理调用成功。三通道均指向官方公开 `https://open.bigmodel.cn/api/anthropic`，协议为 `anthropic-messages`，本地凭据引用可解析；没有输出凭据或完整配置。

| 用途/通道 | 模型 ID | 本地上下文/输出声明 | 推理声明 |
| --- | --- | --- | --- |
| 全局主模型 `glm-work` | `glm-5.3-flash` | 128000 / 16384 | `reasoning:false`，没有显式 thinking 默认值或模型参数覆盖 |
| 全局插件 reviewerModel 为 `glm/glm-5.3-flash` | `glm-5.3-flash` | 128000 / 81920 | `reasoning:false` |
| 已配置备选 `review` | `glm-5.3` | 128000 / 81920 | `reasoning:false` |

本仓没有活动 `.runtime-corrector/config.yaml`；仓内默认模板是 `custom/deepseek-v4-flash`、effort=low、通用输出32768且 Stop 默认关闭。项目 reviewer.model 的优先级高于插件 reviewerModel。因此上述全局默认不能当作本轮已冻结的实际主审配置，不能直接复制模板运行。原生 Stop 当前还有每次输出32768、最多200轮、2次协议尝试的固定策略；这些都不是提供方请求总额度。

`reasoning:false` 只表示本地能力元数据。已安装宿主的受控传输契约（上一轮70项中的一项）验证：此标记为 false 时请求省略 thinking 字段，true且off时才发 disabled。不能据此声称上游关闭思考或没有思考成本。实际通道首探应只捕获请求的 model/thinking/reasoning_effort/max_tokens 等非敏感字段，并核对真实 usage。

GLM-5.3 官方说明为1M上下文、最大128K输出，始终思考，low/high/max三档、默认max，不能disabled；这些是官方能力，不能拿来自动扩大本地限制。官方同时说明特定 Coding Plan 账户存在协议使用限制，当前账户套餐资格没有核实。[GLM-5.3 官方文档](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)

三个本地通道均无明确 cost 元数据。官方BigModel定价页是动态页面，本次获取内容没有给出可核对费率，实际账户计费仍未知。监督方另冻结公开Z.ai参考价五倍作为保守规划率：GLM-5.3输入/输出USD7/22每百万token；Flash为USD0.75/2.50。该来源为监督方冻结指令，不是本次已核验的BigModel账单或自动计费数据；不能填零。模型和配置在比较前固定，没有要求用户重新选择技术参数。[官方定价入口](https://bigmodel.cn/pricing)

## 原生入口与真实闭环资格

本机 OpenClaw 2026.7.1-2 可用；现有配置的认证 Gateway health 成功，只记录状态，没有读取会话内容或启动 Agent。已有 `scripts/evaluate-native-stop-loop.mjs --transport-check` 在新隔离目录使用本轮245文件 OpenClaw 产物通过：插件加载、会话持久化、原始转录读取、before_agent_finalize Hook、隔离 Gateway 健康及关闭。`modelStarts`为空，`startsModel:false`；未给该无模型运行提供计量 endpoint，因此 providerRequests=null，不能改写为观测到零次请求。

已有真实组件入口可复用：

- `scripts/evaluate-stop-workspace.mjs --live --engine workspace --transport native --host-root ... --production --case <单例> --trace-transport`：真实 native reviewer 和生产结算。`external-bug --repair` 是两次 verification-only Stop 之间的真实文件修复，不能称自动 until_pass 已通过。
- `scripts/evaluate-native-stop-loop.mjs --live --initial-turn --inject-defect --artifact <冻结产物> --host-root ...`：原始业务、真实终态、私有审查及自动续作的已有入口。本次只审查代码，没有运行此 live 分支。
- `scripts/bench-baseline-extractor.mjs`：已有 native 基线组件，要求结算 source-run、固定原始输入及空账本；不能为准备组件而复启旧 ArkTS 实验。
- 文档/Skill 可通过生产 `createOpenClawReviewerFactory` 的原生角色入口准入；已有文档/Skill live 脚本偏 CLI，不能当 OpenClaw watcher 全链路验收。先使用已有生产 factory 和模型前契约，不新建通用框架。

当前 live helper 存在明确执行资格缺口：`scripts/helpers/native-stop-evaluation.mjs` 会移除 maxBudgetUsd，单次固定32768输出；`provider-fetch-timing.mjs` 是被动请求计量器，没有派发拦截。已有 usage/continuation 汇总可以区分业务和私有会话，缺失用量诚实未知，但不能替代硬额度。因此不能直接执行上述 live 命令并声称已受 USD30/60请求约束。

本次仅为已审合成serializer路径新增开发admission primitive与真实fetch接线：检查真正URL及完整body，限制输出字段，预留完整输入，解析原始SSE中input/output/cache用量并在缺失时停发。OpenClaw的dispatcher-aware fetch可绕过global fetch，故在其显式开发runtime-dependency port处包装原fetch，保留原生网络策略及构造器；没有修改安装宿主。这不代表原生完整RC链的重试/压缩请求已经覆盖。输入32768是本小批保守假设，并用24576字节文本JSON上限另留协议空间、对真实usage再次核对；它不是一般tokenizer证明。

本次定向结果：budget guard十一项、合成隔离/实际fetch捕获四项、SSE与302接线五项通过。初始schema归一化不匹配、默认状态目录尝试和global-fetch无法覆盖runtime-fetch等失败保留，后续修正没有覆盖记录。未重新运行完整工程；上一轮187文件回归仍仅代表原合并源码快照。

## 机器与 bench 前置条件

Docker客户端/服务端均29.8.2，OrbStack Linux arm64服务可读，分配10 CPU、8392605696字节内存；110镜像、26容器、零运行容器。本轮只检查，没有启动/删除容器或下载镜像。镜像数量不证明所选bench版本/架构/环境可运行。

Harbor0.22.0已有只读bind与openclaw_config入口，但适配固定 `openclaw agent --local --json`；RC终态/续作依赖Gateway `agent.wait`/`chat.send`。隔离Gateway预检不能证明Harbor embedded local提供同一受信终态和调度，三套bench readiness保持未证明。当前用户Gateway是否加载当前冻结产物也未证明；不向正在运行的用户会话注入实验。

新增只读源码证据：本机宿主 `dist/selection-JInn13lc.js:13371` 在 `before_agent_finalize` 返回revise且 `event.hadDeterministicSideEffect` 为true时直接结束，不抑制终态交付。该事件字段包含消息投递、session spawn、cron、异步任务及replay-state潜在副作用的聚合判断（同文件2007、3914、3934、4055）；是否包括某个代码编辑仍取决于该工具的replaySafe分类，不能泛化为“所有文件编辑后均忽略revise”。RC `runtime.mjs:873` 的beforeFinalize优先调用registerPostCandidate；until_pass时注册异步post-run后返回，依赖真实终态与后续派发。此路径与“同步revise可否重入”不能混为一谈。记录见 `key-recovery-preparation-001/finalize-entry-note.json`；没有修改生产适配器，也没有用此静态分析升级Harbor接入资格。

## Codex机制对照：已有能力与待测缺口

本地Codex ea27864f99的只读源码复核由监督方提供，证据位于 `.runtime-correction/rc-supervision/codex-transfer-notes.json`。官方示例使用验证反馈驱动修复，工具及上下文指南强调真实工具结果与上下文管理；以下是迁移假设，不是RC已取得收益。[修复循环示例](https://developers.openai.com/cookbook/examples/codex/build_iterative_repair_loops_with_codex)、[Codex工具与上下文指南](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide)

| 机制 | RC 已经具备 | 真正待测的缺口/候选 |
| --- | --- | --- |
| 反馈→修复→复验 | 原生终态等待与续作、实际回执、反馈按来源去重；仅提示当前可修缺口；部分结果保存、完成项恢复 | workspace Stop仍要求每个派生checklist项提交，存在内部指标展开负担的可能；先测真实重复判断/漏项/调用成本，再决定是否将同一原始义务合并为单条证据账本 |
| 简短、具体、可行动的结论 | Stop提示已要求一两句原因/后果，不重复指标全文；submit_finding及原文引用已存在 | 自然契约归属与内部M标签强耦合是否造成错判或冗余尚未实测。候选可将M标签改为派生组织字段，仍完整检验原始条件、过程与实现义务，不能仅删标签换内部PASS |
| 按需上下文与恢复 | source分页/缓存、document与Skill导航笔记、review_history分页、压缩前后checkpoint和提交状态恢复 | 不新建恢复框架。首批测量压缩/中断是否丢失任务条件或重复大量读取；只在出现真实缺口后做有界调整 |
| 能力限定的并行取证 | 主任务会话显式拒绝并发run，决定/发布具有身份与时限隔离 | 私有工具注册未声明一套可直接采用的安全并行能力契约。先测独立只读取证是否为瓶颈；暂不并行化决策、修复、共享笔记或来源版本变化 |

不照抄Codex PR审查中“只找新增bug/必须在diff内”的范围；RC必须检查用户要求修复的既有缺陷，SWE-sweep也需找原有bug。学习机制不替换主Agent，不新造Codex运行时。

当前下一步是监督方核验已审原生payload的最终批次接线与源码身份，再在既有委托和累计限额内启动一正一反语义小批。旧未知usage账本不重开、不继续搜寻认证；新密钥仍由监督方保管。小批取得完整语义与成本后再选单个真实缺口消融，最后扩展到27例协议。

## 单个待实测候选与交付边界

候选仅记录为“按适用义务延迟披露专项审查指引”。静态复核当前workspace Stop的21个源码字符串字面量共8208字节，解码正文8165字节；其中最后四段M16专项字面量2404字节、解码2395字节，当前无条件拼入prompt。数值不包括COMPLETION_INSTRUCTIONS、工具schema、任务/原始依据及宿主信封，也不是token或提供方成本测量。原始计数见 `codex-candidate-lazy-guidance.json`。

先保留原任务的全部义务、条件、PROCESS/SOURCE证明归属、原文引用和逐项回执，仅在scope/checklist确定适用项时返回相应M08、过程、M16指引；范围尚未确定时不能先删潜在适用规则。披露版本/状态随checkpoint恢复，陈旧来源仍须失效。预期只是在无相应义务的任务上减少重复指引，不承诺降低实际token或提高准确率；有M16义务时完整规则仍须到达审查器。

重复对象合并暂作第二步分析：只有同一原始条款、适用条件、执行主体、证明归属和要求效果一致的对象才可能共用取证；不能因文字相似合并过程与实现义务，也不能用reviewer读取替代业务执行或将不同失败路径折成一个PASS。每个原始义务仍保留可追溯结果。不要与首个披露消融同时实现，以便归因。

恢复后先用固定的正确完成、缺过程证据、执行范围错误、条件豁免、多效果/异常边界和已有缺陷案例测当前行为，再比较一个披露策略；检查漏项、误报、引用失效、实际usage和时间。没有语义对照前不重写生产prompt或清单。Codex PR rubric中的新增bug/diff限制继续不采用。

本次生产修改清单沿用上一轮四文件：`source-tools.mjs`分页解析/取消、`live-source-tools.mjs`取消与搜索预算、`document-tools.mjs`首屏调度/披露资格、`skill-care.mjs`片段标记；本阶段未再修改。新增dev helper为 `provider-request-budget.mjs`、`synthetic-provider-preflight.mjs`、`synthetic-calibration-fetch.mjs`和专用 `calibrate-synthetic-provider.mjs`，配套三份定向回归。它们不进入插件产物，不构成新通用评测框架。

已完成：前轮离线生产修复及合并回归、无模型原生传输检查、纯合成通道200与一次实际工具结果回传、旧401封存及累计结算、生产Stop正反例无网络payload/隔离/同一账本资格、最小live入口准备。未完成：真实Stop语义判定、四模块语义/修复闭环、三bench接入与样本冻结、F2P/P2P及官方成绩提升、模型token和整任务耗时收益。

监督方已取得新认证并核验更正后的Coding Plan通道；无需用户再次回答技术配置问题。下一小批须使用全新输出目录和已冻结manifest，合计最多12请求/12分钟/USD15，并在阶段截止前停止；失败或未完成时保留全部证据，不把守卫/接线当作RC语义收益。
