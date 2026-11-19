# 配置与规则参考

本页保留版本 1 的 artifact、node/edge 与规则配置参考。任务 Ground Truth、Skill 看护、M01–M16 和 Stop 纠偏属于显式启用的 `version: 2` 能力，完整字段与默认值见 [Stop 审查](stop-task-review.md) 与本页的 v2 配置。

### 新项目模板与旧配置

新项目模板以用户需求原文审查 OpenSpec 的 proposal、差量规格、design、tasks 及配置的入边，关闭文档阶段指标和基线审查。差量规格使用 `openspec/changes/{changeName}/specs/**/{capability}/spec.md`，通过 `changeName` 关联同一变更的 proposal。Stop 启用原文清单及仅偏差模式（B12），检查有原有代码或测试佐证的既有行为回归。实现纠偏、Skill 看护与压缩恢复关闭。项目开关与首次会话默认仍为关闭。

已有配置中省略字段的解释继续沿用旧缺省值。要切回基线模式，将 dynamicGroundTruth.enabled 和 artifactCorrection.groundTruthReviewEnabled 设为 true，将 artifactCorrection.originalRequirementsEnabled 和 stopCorrection.originalRequirementsBasis 设为 false。需要完整逐项 Stop 审查（A）时将 stopCorrection.deviationOnly 也设为 false。保留仅偏差审查则是 B2。按需要单独启用 artifactCorrection.stageMetricsEnabled。

在版本 2 项目中，`artifactCorrection.requireOpenSpecProposalCoverage: true` 会在 Proposal 启动时启用需求覆盖审批。配置也会启用对原始用户消息的文档审查。操作员通过 `runtime-corrector.openspec.approve` 提交 `expectedRevision` 和 `requiredAtoms`。每个条目包含 `requirement` 及 `source`，其中 `source` 提供原始用户消息的 `ref`、`sha256` 和从 1 开始的 `start`、`end` 行号。最多提交 48 项。评审记录的义务措辞须与清单一致，同一原文范围可对应多项不同义务。

`artifactCorrection.requireOpenSpecPlanReadiness` 默认 `false`。开启后也会启用上述需求覆盖审批和原文审查，并要求当前完整方案对每个实际 OpenSpec 复选框任务给出 `READY` 评估，才可审批并绑定 Apply。标题、备注或任务描述中的“未验证”不会让复选框失去完成约束。Proposal 阶段的后续工作不必已经执行，但已知且未解决的必要前提须保留为 `BLOCKED` 或 `UNVERIFIED`；不能为放行而删掉原始要求明确规定的验证。可选示例也不应擅自变成强制任务。程序核对任务标识、版本、范围和已读取的引用；执行方法是否可行仍是审查器根据证据作出的语义判断，工具目录中未出现某项不能单独证明它无法执行。

在发送 Proposal 前，通过具备 `operator.write` 权限的 Gateway 调用 `runtime-corrector.openspec.prepare`，提供 `sessionKey`、`sessionId`、`runId`、`changeName`、`sourceRunId`、`sourceSha256` 及 `requirements`。初次 Proposal 的 `sourceRunId` 与 `runId` 相同。`sourceSha256` 取自即将发送的完整用户消息，每个条目提供 `start`、`end` 和 `requirement`。插件在原生会话中核对原文后，才向私有审查器提供这份清单。审查器仍须读取原文和当前方案并逐项提交证据。`PREPARED` 表示清单已登记，继续执行 `approve` 和 `arm` 才能绑定 Apply。

已显式启用 `artifactCorrection.requireOpenSpecProposalCoverage: true` 的项目，也可在该次 `prepare` 请求中传入 `requirePlanReadiness: true`。仅设置 `originalRequirementsEnabled: true` 不满足此接口的前提，`prepare` 会拒绝登记，不会隐式扩大原始需求范围。此选择绑定到原始消息和 Proposal 运行，后续审批或绑定 Apply 不能将它降级。私有审查器通过现有 `rc_document` 的 `plan_checklist` 分页读取任务导航，再读取实际源行并提交独立的 `planReadiness`。程序从所有任务行推导总状态；漏项、重复项、过期引用及超出限额都会使就绪状态无法确认。当前限额为 128 个实际复选框、每行 4096 字节和每页 8192 字节；空清单也不能得到 `READY`。复选框不会因此获得原始需求的权威。

就绪清单支持以 `-` 或 `*` 开头的顶层复选框任务。遇到带前导空格、制表符或混合缩进的复选框行时，严格就绪检查会返回 `UNSUPPORTED_TASK_SYNTAX`，保持无法确认，而不会只审查顶层子集后声明 `READY`。这不改变默认 Apply 解析方式，也不将这些行解释为新的原始需求或自动删除它们。

插件用当前宿主会话中的用户原文重建条目来源，并检查与方案版本完全一致的最近一次全方案审查。每项都须有唯一的 `COVERED` 记录。缺项、`GAP`、`UNVERIFIED` 和过期来源都会阻止审批。审批返回 `inventorySha256`，调用 `runtime-corrector.openspec.arm` 时须将它作为 `expectedInventorySha256`，并继续提供同一 `expectedRevision`。

`requiredAtoms` 应填写本次任务中需要交付的无条件生产代码行为。Apply 结束时，插件在原始需求 Stop 审查中逐项核对当前生产路径。请启用 `stopCorrection.enabled`、`stopCorrection.originalRequirementsBasis`、`stopCorrection.deviationOnly` 和 M16。缺失的当前证据会使完成状态变为 `UNVERIFIED`。已确认的代码偏差仍可在原会话内获准修正，并在修正结束后按同一清单复查。文档、流程和条件义务仍由各自的审查规则处理。

绑定到已批准方案的 Apply 在成功写入 OpenSpec 文档后，会立即比较当前方案与批准版本。确认改动的文件直接返回方案偏离反馈，并跳过该次写入的语义审查。正常勾选、方案无法读取和未绑定的运行仍进入原有审查路径。最终 Stop 会独立重新核对方案。

Stop 指标开关使用 `stopCorrection.metrics.M01` 至 `M16` 的布尔值；默认只开启 M08、M09、M12、M13、M15、M16。`stopCorrection.families` 是上一层的族开关，设为 `false` 的族会关闭其全部成员指标。配置格式、生效时机、全关行为与完整 `.runtime-corrector/config.yaml` 示例见 [Stop 指标审查开关](stop-metric-switches.md)，各族含义见 [纠偏检查体系](correction-checklist.md)。其它写入规则和文档/Skill 总开关继续独立生效。

`stopCorrection.deviationOnly` 默认 `false`。开启后只提交有反证的 Stop 偏差，扫描完成且无偏差时以“未发现偏差”放行。

`stopCorrection.requireCurrentProductionCoverage` 默认 `false`，随任务冻结。与 `originalRequirementsBasis` 和 `deviationOnly` 一同开启后，`TASK_COMPLETE` 终审对原文中当前无条件适用的硬性 M16 生产要求逐项核查。已符合的条目需说明每个适用路径如何从原操作得到可观察结果，并标注已读取的入口和结果消费位置。入口和消费位置位于不同文件时，还须标注值的传递位置。直接产生结果的操作可用同一段源码证明入口与结果。公开探针只覆盖实际运行的用例。缺少足够证据的条目保留为未验证，其他已证实的偏差仍可进入纠偏。

Stop 的 `reviewCoverage.denominator` 记录本轮清单分母来自已绑定的封存必需清单、审查器从原文选择的清单，还是任务基线。`requirementCount` 统计本轮清单义务；封存清单另列 `requiredAtomCount` 和 `inventorySha256`。这些数量不代表原始请求的全部义务数，`originalRequirementCompleteness: NOT_PROVEN_BY_DENOMINATOR` 明确保留这个边界。清单扫描完成只说明该范围已完成审查；封存身份和逐项证据也不能单独证明清单没有漏掉原始需求。旧记录未保存来源时显示为未记录。此元数据只用于结果、状态和已有反馈，不改变审批、验收、纠偏额度或模型调用。

`stopCorrection.requireProductionOriginCoverage` 默认 `false`，同样随任务冻结。开启后，已要求生产覆盖的条目还须通过 `review_production_origin` 调查上游来源。生产覆盖可由上面的开关启用，也可由已批准的 Proposal 需求清单要求；来源开关本身不会启用生产覆盖或重新开启 M16。宿主提供有界的调用者及文件选择标识候选，审查器须读取当前源码，对观察到的候选给出 `VERIFIED` 上游传递证明或有依据的 `OUT_OF_SCOPE` 解释。发现不完整、版本过期或来源不可用时，严格来源核验保留为 `UNVERIFIED`，不能据此启动缺陷修复。

来源候选目前限于可分析的 TS、JS、ArkTS 关系，以及至少包含两个路径段的文件选择字面量。字面量命中只是待调查位置，不能证明注册、路由或分支可达；程序也不保证发现全部调用者或证明语义正确。保持默认关闭时，原有生产覆盖检查继续适用，包括无法建立语义图时基于当前源码的人工判断，其覆盖保证不因此扩大。

`stopCorrection.originalRequirementsBasis` 默认 `false`，开启后 Stop 在同一个审查会话中直接从需求原文生成清单，M08 继续使用 Skill 规则图。用户消息取自 `.runtime-correction/original-requirements/` 下按会话记录的日志（与 `artifactCorrection.originalRequirementsEnabled` 共用），宿主压缩上下文删掉的早期消息仍保留在清单来源中。

对于已固定 SHA-256 的可信公开验收探针，`stopCorrection.regressionCheck.requirementBindings` 可按 `testId` 将具名失败限定到唯一匹配的生产实现条目。各项的 `quote` 使用准确的原文，配置示例与未绑定用例的处理见 [公开验收用例绑定](stop-task-review.md#公开验收用例绑定)。

可以将 `stopCorrection.regressionCheck.reportProtocol` 设为 `completed-suite-v1`，要求受信的回归测试命令完成后输出一行机器回执，例如 `RC_REGRESSION_INVENTORY {"complete":true,"executedTests":2,"failures":[]}`。`executedTests` 必须大于零，且只计入已得出结果的用例。每个失败用例须包含唯一的 `id` 和可读的 `title`。约定退出码 0 对应无失败，1 对应有失败。缺失、重复、截断、未完成或与退出码不一致的回执会使本次验证不可用，也不会进入缓存。命令及其测试来源由项目配置者选择。省略此字段时继续使用已有的退出码判定。

项目可用 `testSource` 声明验证命令运行任务开始时的测试（`task-start`）或当前测试（`current`）。仅在命令支持 `--requirement-only` 和 `--regression-only` 时设置 `verifierProtocol: split-requirement-v1`。支持 `--exclude-cases` 和对应回执的命令可通过 `collateralProtocol: exclude-cases-v1` 启用授权变更排除后的复测。`routeEnvironment` 可列出用于区分测试环境的变量名。插件用这些变量值的摘要确认验证和缓存引用的是同一环境。

在原文仅偏差模式下，修改或删除既有源文件、SQL 或常见运行及构建清单（如 `package.json`、`pyproject.toml`、`go.mod`）会触发回归审查。单独更新 OpenSpec 任务清单属于文档改动。是否进入纠偏取决于既有行为被破坏的具体证据。

Stop 回归缓存同时核对工作区与验证命令。把外部验证器或固定输入文件的绝对路径作为单独的命令参数，可使文件内容、权限或符号链接目标的变更触发重新验证。读取不稳定或超出指纹读取上限时，本次命令照常执行，结果跳过缓存。通过环境变量、脚本内部引用、目录内容或 `--选项=路径` 间接传入的文件需要由验证命令自身管理。

在 OpenClaw 项目中，可通过 `acceptanceFeedback.tool` 选择一个受信的验证工具。流程控制器在 Apply 派发时绑定原生 `runId`。验证工具将执行结果投影到 `details.runtimeCorrectorVerification`，字段为 `runId`、`kind`（`acceptance` 或 `supporting`）和 `status`（`PASS`、`FAIL` 或 `INCOMPLETE`）。只有已确认失败的独立验收会开启提示计数。三次辅助检查尝试后，原工具输出会附加一条复验建议，每个原生运行最多一次。该配置为可选项，`shadowMode` 下仅记录提示事件。

辅助检查确认本次运行留下未完成的报告时，可在 `supporting`、`INCOMPLETE` 回执中增加 `incompleteReason: RUNNER_REPORT_INCOMPLETE`。同一原生运行内，同一辅助检查连续三次出现此结果后，纠偏器建议先排查最新报告的中断点。每个运行最多提示一次。其他辅助检查结果会重置计数，独立验收仍使用自己的结果。ArkTS 适配器用成功编译、真实报告和未完成的具名用例来识别这种情况。

OpenClaw／MatrixAssistant 的项目与会话开关使用根级 `enabled` 和 `sessionDefaults.enabled`，两个字段缺省均为 `true`，版本 1/2 配置均可使用。前者整体关闭本项目 RC，后者只决定首次登记 Session 的初始选择；独立会话选择保存于本地 `.runtime-corrector/sessions.local.yaml`，应加入项目的 Git 忽略规则。UI 或 `/rc-session on|off|status` 使用同一控制逻辑。完整示例、优先级及生效时机见 [项目与 Session 开关](session-control.md)。

`/rc-project init` 从插件的 `.runtime-corrector-default` 创建项目配置，显式设置上述两个开关为 `false`，并将 `reviewers.defaults.model` 填为当前宿主 RC 的 `reviewerModel`；不会覆盖已有目录。`/rc-project on|off|status` 和 `/rc-session-default on|off|status` 分别控制这两个字段。既有配置省略字段时按 `true` 解释的兼容语义不变；这些开关不改动具体纠偏功能的参数。

### Agent 单次输出上限

版本 1/2 的 `.runtime-corrector/config.yaml` 均支持根级 `maxOutputTokens`，默认 `32768`（32K），用于所有 RC agent，包括抽取、裁决、Skill/产物/实现评审、停止分类、Stop 单项/分组审查、基线刷新以及受监督执行的私有 worker。版本 2 评审可按默认值或角色单独覆盖：

```yaml
maxOutputTokens: 32768
reviewers:
  defaults:
    maxOutputTokens: 32768
  stopReviewer:
    maxOutputTokens: 65536
```

评审优先级为 `reviewers.<role>.maxOutputTokens` > `reviewers.defaults.maxOutputTokens` > 根级 `maxOutputTokens` > `32768`。受监督执行 worker 使用根级值。值必须是正安全整数；省略配置也会应用 32K。格式修复与续问沿用当前角色设置。

这是每次模型响应的输出上限，与上下文窗口、累计 token 预算和超时时间分别配置。OpenClaw/MatrixAssistant 在私有调用的模型参数副本中传入 `maxTokens`，不会改写宿主模型目录；CLI 子进程通过 [`CLAUDE_CODE_MAX_OUTPUT_TOKENS`](https://code.claude.com/docs/en/env-vars) 接收该值（自定义 CLI 包装器须支持或转译这一环境变量）。模型和宿主自身的能力上限仍然有效。

`patterns` 与 `pathTemplates` 可以直接声明源码产物。读取层将 `.ets`、`.ts`、`.tsx`、
`.js` 等源码以及 `.json5` 视为 UTF-8 `text`，所以 HarmonyOS ArkTS 的 Write/Edit 能与
文档产物走同一条 PostToolUse 纠偏链。构建、测试和设备结果仍须由独立证据提供。

### Reviewer 思考强度

版本 2 的 `reviewers.defaults.effort` 与 `reviewers.<role>.effort` 接受 `off`、`low`、`medium`、`high`、`xhigh`、`max`。角色设置优先于 defaults，未配置时默认为 `low`。

```yaml
reviewers:
  defaults:
    model: custom/deepseek-v4-flash
    effort: "off"
  stopReviewer:
    effort: high
```

OpenClaw/MatrixAssistant 将 `off` 原样作为私有调用的 `thinkLevel`，适用于基线、停止分类、逐项/分组审查及其他 reviewer。GLM 的额外 effort 提示在 `off` 时不再添加；具体思考开关由宿主及所选模型负责。`off` 不关闭审查，不改变工具、证据校验、单次输出上限或截止时间，也不修改主会话的思考设置。

本机目标 OpenClaw 的 DeepSeek V4 `openai-completions` 原生兼容路径在 `off` 时发送 `thinking: { type: "disabled" }`，移除 `reasoning_effort`。自定义代理、其他 API 格式及必须思考的模型仍取决于其宿主适配，不能仅由 RC 配置保证零思考。CLI 后端沿用原有 `--effort` 传参，是否接受 `off` 由对应 CLI 决定。参见 [OpenClaw 思考档位](https://docs.openclaw.ai/tools/thinking)与 [DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)。

### 高频源码写入：checkpoint-review 拓扑

实现型 Agent 会在一个里程碑内连续 Edit 多个源码和测试文件。如果每次 Edit 都启用隔离
语义审阅，延迟会随写入次数线性累积。推荐把源码/测试 Artifact 保持启用但关闭节点
`review`，让每次 Write/Edit 只完成产物匹配和确定性规则；再建立一个 checkpoint Artifact，
通过 `relatedPatterns` 与启用的入边收集本轮源码、测试和 Ground Truth，并只在 checkpoint
写入时执行一次完整语义审阅。

checkpoint 必须同时配置 `file-digest-manifest`。这样聚合审阅之前会重算当前快照文件
SHA-256；任一摘要陈旧、重复、缺失或未被当前 bundle 收集，都会先确定性失败。这个拓扑
降低日常编辑延迟，但不会把源码存在、语义审阅或旧测试结果当成当前构建/设备证据。

推荐使用项目内简单模式：所有客户可修改内容都放在 `.runtime-corrector/`，修改后下一次匹配写入或手动检查立即生效。

## 初始化后的目录

```text
.runtime-corrector/
├── README.md
├── config.yaml
├── example.rules.yaml
└── example.reviewer.md
```

`/runtime-corrector:init` 生成结构完整但默认关闭的通用模板。最小配置见 [快速开始](tutorial.md)。

## 配置来源与优先级

| 优先级 | 来源 | 用途 |
|---|---|---|
| 1 | 程序化调用传入的 `config` | 测试或进程内集成 |
| 2 | `.runtime-corrector/config.yaml` | 推荐的项目自有简单模式 |
| 3 | `.runtime-corrector.json` | 旧版高级兼容模式 |
| 4 | `config/runtime.yaml` | 未初始化项目的空 artifact 默认值与通用运行基线 |

只要 `.runtime-corrector/config.yaml` 存在，就不会同时加载 `.runtime-corrector.json`。

所有来源在合并各自兼容默认值后，都交给同一个策略编译器，并只生成一次扁平
RuntimePlan。项目 YAML 加载层只负责读取和受控 YAML 解析；随后由
`project-config.schema.json` 校验结构。artifact matcher、Workflow 图、correlation、Stage
选择及 rules/review 路径策略均由统一编译器生成，运行时不会根据配置来源再次解释这些字段。

### Reviewer 可执行程序（v1 / v2 共用）

Reviewer 会话协议由安装产物决定，不由配置或 executable 名称决定。仓库默认
`plugin-target.json` 为 `codeagent`；`npm run build:plugins` 会生成两个互斥安装产物。
源码根目录没有自动发现 manifest，不能直接安装。项目配置只覆盖可执行程序：

```yaml
reviewerRuntime:
  executable: 'C:/Program Files/CodeAgentCLI/bin/codeagentcli.exe'
  argsPrefix: []
```

`executable` 必填，`argsPrefix` 默认 `[]`。该对象同时用于 v1 和 v2。旧版
`reviewerRuntime.sessionDialect` 字段已删除，出现时会明确报迁移错误。旧环境变量
`RUNTIME_CORRECTOR_AGENT_SESSION_DIALECT` 已失效：运行时会忽略它并在启动 reviewer
子进程前将其清除。launch plan 固定为冻结的 `{ executable, argsPrefix }`。

启动程序优先级：

| 优先级 | 来源 | 参数前缀 |
|---|---|---|
| 1 | `RUNTIME_CORRECTOR_AGENT_EXECUTABLE` | `[]`，不继承配置 wrapper |
| 2 | 显式 `reviewerRuntime` | 自身的 `argsPrefix` |
| 3 | 当前宿主专用环境变量 | `[]` |
| 4 | 当前宿主已知原生安装路径 | `[]` |
| 5 | 当前宿主 PATH 命令 | `[]` |

没有 `reviewerRuntime` 和新环境变量时，旧配置行为不变。已声明的对象必须通过校验，
不能用环境覆盖掩盖 `null`、缺少 executable、空白字符串、错误类型、未知字段或 NUL
字符。新环境变量设置为空也会报错；取消覆盖请删除该变量。选中的程序无法启动时会
报告错误，不会再尝试更低优先级的程序。

Claude 专用变量为 `RUNTIME_CORRECTOR_CLAUDE_EXECUTABLE`、`CLAUDE_CODE_EXECUTABLE`；
CodeAgent 专用变量为 `RUNTIME_CORRECTOR_CODEAGENT_EXECUTABLE`。Windows 已知原生路径
分别包括 npm Claude Code 的 `bin/claude.exe` 和
`%ProgramFiles%/CodeAgentCLI/bin/codeagentcli.exe`，最后回退到各自 PATH 命令。

不含路径分隔符的 executable 按 PATH 查找；绝对路径直接使用；配置中的相对路径
（例如 `./tools/codeagent`）在加载时固定到该配置所属的项目根，随后不受 reviewer
会话 cwd 影响。程序化配置和旧 JSON 使用调用时传入的项目根。直接调用编译接口时，
相对 executable 需要显式 `projectRoot`。新环境变量只接受 PATH 命令或绝对路径。

参数按字面 argv 传递，不执行 shell 展开，不把字符串拆成命令行。`argsPrefix` 的
脚本入口应使用绝对路径；例如 Windows 上通过 Node 启动已知入口：

```yaml
reviewerRuntime:
  executable: 'C:/Program Files/nodejs/node.exe'
  argsPrefix:
    - 'C:/Tools/CodeAgent/entry.js'
```

入口路径须替换为实际安装路径。Windows 支持原生可执行文件和这种显式 Node 入口；
`.cmd`、`.bat`、`.ps1` shell shim 会给出诊断，不会自动启用 shell。启动配置在创建
reviewer handle 时固定，首次请求、修复和后续请求都沿用同一组启动参数。

两种产物 fresh 都不传会话参数。Claude 恢复使用 `--resume <id>`；CodeAgent 恢复使用
`--sessions <id>`。恢复并 fork 时追加 `--fork-session`，一次性恢复追加
`--no-session-persistence`。CodeAgent fresh 由宿主创建可持久化会话并从 JSON envelope
取得 `session_id`；缺失 ID、resume 返回不同 ID，或 fork 未返回新 ID均为协议失败。
CodeAgent 启动前拒绝 `--session-id`、`--resume`、`--continue`。公共参数保持不变，
包括准确拼写的 `--max-budget-usd`。

所有宿主的 semantic/v2 reviewer 默认超时统一为 20 分钟，范围为 1000～86400000 毫秒，最大 24 小时。项目显式
timeout 继续覆盖默认值。CodeAgent independent reviewer 可使用 Anthropic 环境变量
形态连接兼容网关：

```yaml
reviewerRuntime:
  executable: 'C:/Program Files/CodeAgentCLI/bin/codeagentcli.exe'
  argsPrefix: []

limits:
  semanticReviewTimeoutMs: 900000

reviewers:
  defaults:
    session: independent
    timeoutMs: 900000
    provider:
      baseUrl: https://your-gateway.example
      apiKeyEnv: CODEAGENT_REVIEWER_API_KEY
      model: glm-5.3
```

嵌套项目中，v1 语义审阅使用命中产物的配置；v2 审阅使用其 runtime 所属项目的配置。
这两者可能不同，不能用父会话的 cwd 或另一份配置替换。CLI 的会话、JSON 输出和工具
限制协议仍须由所选程序支持；仅替换 executable 不代表完成了该程序的全部兼容验证。

## 全局规范与项目 criteria

每个 stage 的完整地图由两层合并，不存在只藏在实现中的第三层客户规则：

- 插件通用规范：说明 Stage 注册、修改边界、规则语法和 Patch 能力；
- 项目 criteria：`config.yaml`、`*.rules.yaml`、Schema 和 `*.reviewer.md`，由用户或团队直接修改。

使用 `/runtime-corrector:spec <stage>` 可查看合并后的实际地图。`explain` 适合快速看“用了
哪些来源”，`spec` 适合编写产物或排查重复失败时看“完整内容”。

所有业务 Stage 都使用通用 Stage 规范，并完整合并项目 artifact、rules、Schema 和 reviewer。
Stage 同样支持 `stages`、`stage <name> on|off`、`explain`、`spec` 和失败时的规范留痕。

## `config.yaml`

该文件在进入语义编译前，会先按照插件内
`config/schemas/project-config.schema.json` 校验字段结构。Schema 只负责类型、
必填项和枚举；相对路径安全、Stage 引用、Workflow 节点和 DAG 环检测仍由策略
编译器负责。

配置版本仍是 `version: 1`。新增 stage 不要求新增 JavaScript 分支：在 `artifacts[]`
声明路径、格式和开关，在 `*.rules.yaml` 声明确定性检查，在 `*.reviewer.md` 声明复杂
语义标准；JSON 产物的字段结构放在项目 `schemas/*.schema.json`，再由 `json-schema`
规则引用。

### 完整结构

```yaml
version: 1

enabledStages:
  - example-document

groundTruth:
  - id: user-request
    type: user-confirmed-requirement
    version: request-001
    authority: user
    required: true
    patterns:
      - prompt/user-request.md

artifacts:
  - name: example-document
    stage: example-document
    type: example-document
    format: markdown
    editable: true
    patterns:
      - docs/example-document.md
    relatedPatterns: []
    relatedRoot: project
    groundTruth: [user-request]
    rules:
      enabled: true
      file: example.rules.yaml
    review:
      enabled: true
      criteria: example.reviewer.md

ignorePatterns:
  - "**/.runtime-correction/**"

output:
  persist: true
  mode: centralized
  directory: .runtime-correction

limits:
  maxRelatedFiles: 20
  maxFeedbackChars: 12000
  maxReviewerChars: 6000
  semanticReviewTimeoutMs: 1200000
```

### 顶层字段

| 字段 | 必需 | 说明 |
|---|---:|---|
| `version` | 是 | 当前固定为 `1` |
| `enabledStages` | 否 | 启用的 stage；省略表示全部已安装 stage；`[]` 表示全部关闭 |
| `artifacts` | 是 | 至少一个 artifact 声明 |
| `groundTruth` | 否 | 命名、版本化的只读依据来源；由 Artifact 显式引用 |
| `workflow` | 否 | 直接入边一致性检查；省略、`null` 或 `edges: []` 表示关闭 |
| `ignorePatterns` | 否 | 不参与匹配的 glob |
| `output` | 否 | 诊断持久化配置；未声明字段继承插件默认值 |
| `limits` | 否 | 文件收集和上下文长度限制；未声明字段继承默认值 |

`enabledStages` 只能包含 `artifacts[].stage` 中已安装的唯一值。未知或重复 stage 会报错。

### Artifact 字段

| 字段 | 必需 | 默认值 | 说明 |
|---|---:|---|---|
| `name` | 条件必需 | `type` | artifact 唯一可读名称；`name` 与 `type` 至少提供一个 |
| `stage` | 否 | `name` | 阶段标识；小写字母开头，只含小写字母、数字、连字符，最多 64 字符 |
| `type` | 否 | `name` | 传给诊断器的 artifact 类型 |
| `format` | 否 | `markdown` | `markdown`、`json`、`text` 或 `auto` |
| `editable` | 否 | `true` | `false` 表示可检查、可产生 Finding，但不能生成或应用候选编辑 |
| `outputKey` | 否 | 根据触发文件生成 | 固定该 artifact 在 `runs/` 与 `latest/` 下的目录名；多文件 bundle 可用它让所有成员共享同一结果目录 |
| `patterns` | 条件必须 | — | 相对项目根目录的非空 glob 列表；与 `pathTemplates` 二选一 |
| `pathTemplates` | 条件必须 | — | 可提取单个路径段中的占位符，可使用一个 `/**/` 匹配零个或多个中间目录；与 `patterns` 二选一 |
| `relatedPatterns` | 否 | `[]` | 关联文件 glob |
| `relatedRoot` | 否 | `artifact-directory` | `artifact-directory` 或 `project` |
| `groundTruth` | 否 | `[]` | 引用顶层 `groundTruth[].id`；文件只读并进入输入摘要与语义审阅 |
| `rules` | 否 | 关闭 | 硬规则开关与文件；使用 `{ enabled, file }` |
| `review` | 否 | 关闭 | 节点语义审查开关与附加标准；使用 `{ enabled, criteria }` |

`rules.file`、`review.criteria` 和规则引用的 Schema 必须使用策略目录内的相对路径，不能通过 `..` 或绝对路径逃出 `.runtime-corrector/`。

Ground Truth 的 `id` 必须唯一；`patterns` 相对于项目根目录。`required: true` 的来源缺失时，检查结果为 `GROUND_TRUTH_UNRESOLVED`，不能据此判定目标产物通过或偏离。Corrector 记录声明版本、授权来源、实际文件和摘要，但不会按文件修改时间自行解决来源冲突。

组件拥有的 PRD、manifest、handoff 等文件可设为 `editable: false`。语义 Reviewer
仍能把 Finding 指向这些目标，但本轮可编辑白名单为空；修复必须回到组件公开的
feedback/revision 流程。

`rules` 与 `review` 省略时对应能力关闭。配置后必须显式写 `enabled: true` 或
`enabled: false`；`null`、空字符串和旧版路径简写均会明确报错。关闭时可以保留
`file` 或 `criteria`，方便只切换一个布尔值后恢复：

```yaml
rules:
  enabled: false
  file: selection.rules.yaml
review:
  enabled: true
  criteria: selection.reviewer.md
```

- `rules.enabled: false`：不加载、不执行该节点的确定性规则；
- `review.enabled: false`：不执行该节点的 Stage 语义审查；
- `review.enabled: true` 且省略 `criteria`：只执行插件通用语义审阅基线；
- `review.deferUntilBundleComplete: true`：节点自身的 bundle 尚不齐备时，保留确定性诊断并延后语义审阅。补齐后，下一次对该节点的检查执行完整审阅。建议让同一节点的触发路径匹配所有 bundle 成员。此选项不影响配置了前序审阅、Ground Truth 来源或运行时指标审阅的节点。
- `review.skipApprovedTaskProgress: true`：原生 OpenClaw 的自动文档写入可跳过获批任务清单中允许的勾选状态变化所触发的重复语义审阅，默认关闭；整组 OpenSpec 方案覆盖层显式启用它。它要求当前原始 Apply 已绑定严格需求清单，先前完整方案的语义审查通过，且当前方案、节点范围、策略与审查标准、会话及控制版本仍与获批依据一致。确定性规则与变更记录仍执行，最终 Stop 仍须取得当前代码证据。宿主只记录方案完整性观察，不产生新的语义 PASS。
- `enabled: true` 且配置的 `criteria` 文件为空：明确报错；使用 `enabled: false` 关闭。

该优化不改变显式手动检查或默认行为。方案文字发生变化时，原有偏移检查仍立即反馈；未绑定、来源或策略陈旧、待定脚本写入、独立 Ground Truth、前序审阅和阶段指标等无法保留其独立检查的范围，沿用普通审阅。原始 Apply 中一旦出现触及该方案的后续语义审查，就不再沿用旧审批来跳过审阅，即使后续审查通过；已知的阻断或待验证结果不能被旧的通过依据掩盖。纠偏续跑也不使用这项优化。

仅当文档明确要求复制一份已声明的原始材料时，可设置 `review.copyFrom: <Ground Truth 来源 ID>`。该 ID 必须已列在当前 artifact 的 `groundTruth` 中，并且只能解析到一个可读源文件。`review.enabled: true` 时，生产文档检查会比较当前目标和该来源，返回 `DOCUMENT-COPY-MISMATCH` 及 JSON 转义后的当前行、来源行或 EOF 后缀；即使模型复审通过，仍有字符差异也不能通过。正文、缩进、行内空格、围栏代码块及所有换行严格保留，仅容许围栏代码块外的行尾空格/制表符不同。比较不改写文件，来源缺失时返回 pending。

该选项默认不启用，普通方案文档无需与需求原文相同。`rules.enabled: false` 同时关闭该节点的默认 Markdown 标题和锚点规则；显式启用的复制内容检查独立于这些风格规则。

### Glob 语义

- `*`：匹配单个路径段内任意字符；
- `?`：匹配单个路径段内一个字符；
- `**`：跨目录匹配；
- `**/`：允许零个或多个目录。

路径统一按 `/` 比较，Windows 路径也可使用上述 pattern。

### 路径模板与实例关联

同一项目保留多个 change 时，使用路径模板而不是宽泛 glob：

```yaml
artifacts:
  - name: requirements-report
    pathTemplates:
      - "spec/{YYYY-MM-DD}-需求分析报告-{changeName}.md"
  - name: code-understanding
    pathTemplates:
      - "spec/{YYYY-MM-DD}-代码理解报告-{changeName}.md"

workflow:
  correlation:
    keys: [changeName]
  edges:
    - from: requirements-report
      to: code-understanding
      review:
        enabled: true
```

占位符名称以字母开头，只能包含字母、数字、下划线和连字符。占位符匹配单个路径段内的非空文本，且必须闭合、不能重复。模板可使用一个独立的 `/**/` 匹配零个或多个中间目录，其余 `*` 和 `?` 不可用。

`correlation.keys` 非空、唯一并保持声明顺序。参与 workflow 边的每个 artifact 模板都必须
包含全部 key。未声明为 correlation key 的占位符只负责匹配，因此相同 `changeName` 可以跨
日期连接。key 比较大小写不敏感，诊断元数据保留触发路径中的原始值。

Write/Edit 的触发文件是本轮唯一目标。上游和 artifact-owned 的相关文件只收集相同实例；
`src/**/*`、`workflow.yaml` 等不属于任何 artifact 的文件仍可作为项目级只读证据。只有其他
实例的上游存在时，当前边仍为 `WORKFLOW-EDGE-SOURCE-MISSING / pending`。未配置 correlation
时继续使用 legacy bundle 行为，不做实例隔离。

### YAML 子集

为保持零第三方依赖，简单模式解析受控 YAML 子集：

- 两个空格缩进，禁止 Tab；
- 支持对象、列表、字符串、数字、布尔值、`null` 和简单行内列表；
- 支持 `#` 开头的整行注释；
- 键名使用字母开头，只含字母、数字、下划线和连字符；
- 不支持锚点、合并键、标签和多行 scalar。

## 阶段开关

推荐通过 Claude 命令修改：

```text
/runtime-corrector:stages
/runtime-corrector:stages planning off
/runtime-corrector:stages planning on
```

也可直接编辑：

```yaml
enabledStages:
  - selection
  - prd-contract
```

关闭 stage 不删除 artifact、rules、reviewer 或历史诊断。

## 注册自定义 Stage

在 `artifacts[]` 中首次声明一个新的 `stage` 值即完成注册；是否启用由 `enabledStages` 独立决定。推荐先注册为关闭状态，依次运行 `stages`、`explain <stage>` 和 `spec <stage>` 核对实际执行源，再通过 `stage <stage> on` 启用。

自定义 Stage 可在项目中注册；最小结构与检查步骤见 [快速开始](tutorial.md)，完整接口见 [接口参考](interfaces.md)。

混合格式 Bundle 应优先使用带 `artifact` 参数的目标型规则，例如 `json-schema` 和 `graph-invariants`。`require-heading`、`require-checklist` 和 `require-text` 只检查本次触发文件，`forbid-text` 则会扫描已收集文件；这些无 artifact 定向能力的规则不应直接同时套用到 Markdown 与 JSON pattern。跨格式、跨文件的业务一致性由 reviewer 核对。

## Workflow 入边一致性检查

Workflow 图是可选能力，仍使用 `version: 1`。`artifacts[].name` 就是节点 ID，不需要重复声明 nodes：

```yaml
workflow:
  correlation:
    keys: [changeName]
  edges:
    - from: requirements
      to: planning
      review:
        enabled: true
        criteria: requirements-to-planning.reviewer.md
```

写入 `planning` 节点时，插件执行已启用的节点检查，并把所有
`review.enabled: true` 的直接入边合并到同一次 Agent 审阅。每条启用边都检查目标
是否违背、遗漏或无依据扩张上游的意图、范围、约束、决策和可追溯标识。
`criteria` 可省略，此时只执行内置边基线；关闭边审查必须显式设置
`review.enabled: false`。

- 边只能引用当前 `artifacts[]` 中的 name，不能重复、自连或形成环；
- `from` 可以显式连接任意前序节点，但不会自动遍历祖先或触发下游；
- 前序 stage 关闭后仍可作为只读事实源，目标 stage 关闭后不触发检查；
- Source 收集继续服从 `ignorePatterns`，并排除 `.runtime-corrector/` 策略目录和 legacy 配置文件；
- 完全找不到前序产物时状态为 `pending`，其余节点和入边仍继续检查；
- 上游文件只读，诊断修正路径和候选 Patch 只能指向当前目标节点；
- 边必须显式配置 `review.enabled`；空值和旧版 `reviewer` 字段会报错；
- 节点 review 与所有入边 review 都关闭时，PostToolUse 不创建隔离审查 session；
- 首版 Edge 只做 Agent 语义一致性检查，不支持 Edge rules、级联、优先级或执行模式。

`correlation` 不改变 DAG 结构，只定义如何从触发路径选择同一实例。调用者负责在写入前决定
继续哪个旧 change 或创建哪个新 key；插件不推断历史继承、不按 mtime 选文件、不保存 active
key，也不自动批量处理全部实例。

省略 `workflow`、配置 `workflow: null` 或使用 `edges: []` 时，行为与没有 Workflow 配置完全一致。内置 init 模板不会默认增加边。

## `*.rules.yaml`

### 通用结构

```yaml
version: 1

rules:
  - id: REQUIRE-OVERVIEW
    type: require-heading
    heading: 目标与范围
    aliases:
      - 产品概述
    severity: error
    suggestion: 补充应用目标和范围边界。
    enabled: true
```

通用字段：

| 字段 | 必需 | 说明 |
|---|---:|---|
| `id` | 是 | 文件内唯一、稳定的诊断 ID |
| `type` | 是 | 规则类型 |
| `severity` | 否 | `error`、`warning` 或 `info`，默认 `error` |
| `message` | 否 | 自定义诊断消息 |
| `suggestion` | 否 | 自定义修正建议 |
| `enabled` | 否 | 设为 `false` 时只关闭这一条规则 |

### 支持的规则类型

| 类型 | 关键字段 | 作用 |
|---|---|---|
| `require-heading` | `heading`, `aliases`, `level`, `template`, `emptyRuleId` | 要求 Markdown 章节，可生成确定性补章 Patch |
| `require-checklist` | `under`, `aliases`, `minimum`, `template`, `emptyRuleId` | 要求章节及最少 checklist 数量 |
| `require-text` | `values`, `caseSensitive` | 至少出现一个指定文本 |
| `forbid-text` | `values`, `caseSensitive` | 禁止指定文本 |
| `require-artifacts` | `artifacts`, `pendingUntilComplete` | 声明 bundle 必需文件 |
| `json-schema` | `artifact`, `schema` | 用项目内 Schema 校验 JSON |
| `file-digest-manifest` | `artifact`, `entriesPointer`, `pathField`, `digestField` | 重算当前快照文件 SHA-256，拒绝陈旧或缺失的证据引用 |
| `graph-invariants` | artifact、节点/边字段映射与约束 | 校验重复节点/边、节点引用、端点类型和有向环 |
| `markdown-records` | artifact、记录标题、字段与上游 ID 来源 | 校验 Markdown 重复记录的字段和上游覆盖 |

`emptyRuleId` 仅用于已有章节为空时的诊断 ID；省略时分别使用
`<规则 ID>-EMPTY` 或 `<规则 ID>-SECTION-EMPTY`。通常无需配置，只有需要保持既有诊断
ID 兼容时才声明。

### `require-artifacts`

```yaml
- id: SELECTION-REQUIRED-ARTIFACTS
  type: require-artifacts
  artifacts:
    - ir.md
    - PilotPlan.md
    - relations.json
    - granularity-choice.json
    - kit-map.md
  pendingUntilComplete: true
  severity: error
```

`pendingUntilComplete: true` 会把缺文件诊断降为流程中的 `pending`，而不是最终 `failed`。
`artifacts` 中只写文件名时按 basename 匹配；包含 `/` 或 `\` 时按项目相对路径
精确匹配。这可区分位于不同目录、但都叫 `manifest.json` 的协议文件。

### `graph-invariants`

```yaml
- id: PLANNING-RELATION-GRAPH
  type: graph-invariants
  artifact: relations.json
  caseSensitiveIds: false
  nodes:
    pointer: /nodes
    idField: id
    typeField: type
    typeRules:
      - id: RELATION-NODE-TYPE
        idPattern: "^SR-"
        expectedType: sr
      - id: RELATION-NODE-TYPE
        idPattern: "^M"
        expectedType: milestone
  edges:
    pointer: /edges
    fromField: from
    toField: to
    typeField: type
    endpointRules:
      - id: CONTAINS-DIRECTION
        edgeType: contains
        fromType: milestone
        toType: sr
      - id: REQUIRES-DIRECTION
        edgeType: requires
        fromType: sr
        toType: sr
        allowSelf: false
    acyclic:
      - id: REQUIRES-CYCLE
        types: [requires]
  severity: error
```

这个规则不认识 Planning、milestone 或 SR；它只按 YAML 中的字段映射和图约束工作。
节点字段是否存在、字符串格式、枚举、非空等格式规则仍由相邻的 `json-schema`
规则负责。这样新增同类 stage 时，只需提供 JSON Schema 和图约束配置，无需新增
JavaScript validator。

### `markdown-records`

`markdown-records` 校验由重复标题章节组成的 Markdown，例如逐需求决策、变更记录
或逐接口说明。标题正则的第一个捕获组是记录 ID：

```yaml
- id: RELEASE-RECORDS
  type: markdown-records
  artifact: release.md
  recordLabel: change
  bareFields:
    - id: STATUS
      labels: [Status]
  records:
    headingPattern: '^##\s+(C[-_\s]*\d+)\b'
    idPattern: '^C[-_\s]*(\d+)$'
    idReplacement: 'C-$1'
    expected:
      - artifact: catalog.json
        pointer: /items
        idField: key
        where:
          field: kind
          equals: change
    fields:
      - id: OWNER
        labels: [Owner]
```

`expected` 可以从 JSON Pointer 指向的数组读取 ID，也可以用 `pattern` 从文本产物
提取第一个捕获组。`bareFields` 要求文档级字段使用裸行；如果只是误加了列表或标题
前缀，规则会生成确定性候选 Patch。JSON 来源的字段结构仍应由 `json-schema` 负责。

## JSON Schema

`json-schema` 规则引用项目内 JSON 文件：

```yaml
- id: PLANNING-RELATIONS-SCHEMA
  type: json-schema
  artifact: relations.json
  schema: schemas/relations.schema.json
  severity: error
```

当前支持：

- 元数据：`$schema`、`$id`、`title`、`description`、`default`、`examples`
- 结构：`type`、`required`、`properties`、`items`、`additionalProperties`
- 取值：`const`、`enum`、`pattern`
- 下限：`minLength`、`minimum`、`minItems`
- 数组：`uniqueItems`

不支持的关键字会在策略加载时报告准确 JSON Pointer，不会静默忽略。

## `*.reviewer.md`

Reviewer 是项目自有的自然语言语义标准。PostToolUse 自动检查会在一次性隔离 fork 中执行它；手动 `check` 则把它作为待执行任务返回给调用方。建议固定包含：

```markdown
# Selection Agent 审阅标准

## 必须检查
1. 每个 SR 是否有上游证据。
2. Kit 是否为满足该 SR 的最小集合。

## 不要检查
1. 不建议本期范围外功能。

## 输出约束
- 每个问题引用具体 SR 和原文证据。
- 无法确认时标记“待人工确认”。
```

- `review.enabled: false`：关闭该节点的语义审查；
- `review.enabled: true` 且不配置 `criteria`：只执行插件通用语义审阅基线；
- `review.enabled: true` 且配置 `criteria`：执行插件通用基线和项目附加标准；
- review 已启用而 criteria 文件为空：明确报错，不把空文件解释为开关；
- 内容超过 `maxReviewerChars`：明确报错；
- reviewer 负责规则难以表达的语义与跨文件一致性；它不替代已经配置的硬规则，也不自动修改产物。

节点或任一入边的 review 开启时，PostToolUse 才创建一次隔离语义审查；全部关闭时只执行已启用的硬规则。手动 `/runtime-corrector:check` 和 CLI `check` 不创建隔离 session。

## 输出配置

```yaml
output:
  persist: true
  mode: centralized
  directory: .runtime-correction
```

| 字段 | 值 | 说明 |
|---|---|---|
| `persist` | `true/false` | 是否写诊断文件 |
| `mode` | `centralized` | 集中写入 `directory` |
| `mode` | `adjacent` | 写入触发文件所在目录下的局部 `.runtime-correction/` |
| `directory` | 路径 | 集中模式目录，默认 `.runtime-correction`；推荐使用项目相对路径 |

bundle 任一成员写入都会启动当前快照的语义审查。不完整 bundle 中，已有文件仍接受语义检查，依赖缺失成员的规则保持 `pending`。

`persist: true` 时，每次快照检查的 `diagnostic.md` 与 `patch.diff` 始终成对产生；没有安全候选 Patch 时写入 0 字节 diff。`persist: false` 时不创建 Round 或 Latest 文件，但 PostToolUse 仍会在隔离 fork 中完成语义审查并把结果返回主 Agent。旧配置中的 `generateDiff` 与 `diffStrategy` 会被忽略。

输出按“可变 Latest”和“不可变 Runs”分层，文件名只表达内容类型：

```text
.runtime-correction/
├── latest/<stage>/<artifact-key>/
│   ├── diagnostic.md
│   ├── patch.diff
│   └── spec.md       # failed
└── runs/<stage>/<artifact-key>/<run-id>/
    ├── diagnostic.md
    ├── patch.diff
    └── spec.md       # failed
```

每次匹配写入先执行已启用硬规则；节点或直接入边存在已启用 review 时，再创建一次性隔离 fork。两类 review 全部关闭时跳过 fork。之后统一校验候选 Patch 并执行 `git apply --check`，再创建不可变的 `runs/<stage>/<artifact-key>/<run-id>/` 目录并刷新同一 stage/artifact 的 `latest/` 目录。因此诊断和 diff 属于同一轮，不存在稍后回填覆盖新结果的问题。

## Limits

| 字段 | 作用 | 插件与 `init` 模板默认值 |
|---|---|---:|
| `maxRelatedFiles` | 一次检查最多读取的 artifact 数 | 20 |
| `maxFeedbackChars` | 非失败反馈的字符上限；失败时完整 Stage 地图为避免信息缺口不截断 | 12000 |
| `maxReviewerChars` | 单个 reviewer 字符上限 | 6000 |
| `semanticReviewTimeoutMs` | 单次隔离语义审阅超时，范围 `1000`～`86400000` 毫秒 | 1200000 |

在项目 `.runtime-corrector/config.yaml` 中设置时间（单位：毫秒），例如语义评审 30 分钟、角色评审默认 20 分钟、终审角色 90 分钟：

```yaml
limits:
  semanticReviewTimeoutMs: 1800000
reviewers:
  defaults:
    timeoutMs: 1200000
  stopReviewer:
    timeoutMs: 5400000
```

角色时间的优先级为 `reviewers.<role>.timeoutMs` > `reviewers.defaults.timeoutMs` >
`limits.semanticReviewTimeoutMs` > 20 分钟。基线抽取和裁决也遵守显式配置，不再通过内部下限延长时间。
所有角色字段与语义评审字段均校验整数及 1000～86400000 的范围；配置超出范围会报错。
同一次评审的格式修复、续问共用原截止时间；宿主取消、Hook 窗口和 RC 总评审窗口仍可使实际评审提前结束。
OpenClaw 的原生终审使用 RC 自己的总窗口；`stopCorrection.assessmentTimeoutMs` 属于多阶段总预算，不是单个角色的超时。
未命中 artifact、stage 已关闭或语义审阅未启用时，插件仍会快速返回，不会等待配置的完整时长。

## 高级兼容配置

只有在项目不存在 `.runtime-corrector/config.yaml` 时，才读取 `.runtime-corrector.json`。它支持旧版内置 knowledge，以及扩展模块：

```json
{
  "$schema": "<runtime-corrector>/config/schemas/project-config.schema.json",
  "version": 1,
  "artifacts": [
    {
      "stage": "ir",
      "type": "ir",
      "format": "markdown",
      "patterns": ["**/ir.md", "**/*.ir.md"],
      "relatedPatterns": [],
      "knowledge": ["ir/default"]
    }
  ],
  "ignorePatterns": ["**/.runtime-correction/**"],
  "extensions": {
    "matcherModule": "./tools/runtime-corrector-matcher.mjs",
    "collectorModule": "./tools/runtime-corrector-collector.mjs"
  },
  "output": {
    "persist": false,
    "mode": "centralized",
    "directory": ".runtime-correction"
  },
  "limits": {
    "maxRelatedFiles": 20,
    "maxFeedbackChars": 12000,
    "maxReviewerChars": 6000,
    "semanticReviewTimeoutMs": 1200000
  }
}
```

将 `$schema` 中的 `<runtime-corrector>` 替换为本机插件目录；它为编辑器提供字段校验，
运行时仍会经过同一个策略编译器做语义约束。

自定义扩展契约见 [外部接口参考](interfaces.md#自定义-matcher)。

## 版本 2 任务与 reviewer 配置

版本 1 保持 artifact、node/edge 和规则兼容；使用任务能力时设置 `version: 2` 并显式开启所需功能。最小配置见 [快速开始](tutorial.md)，规范 Stop 字段和旧字段迁移见 [Stop 审查](stop-task-review.md)。

```yaml
version: 2
artifacts: []
dynamicGroundTruth:
  enabled: true
  evidenceCapture: minimal
  materialRoots: [docs]
  panel:
    size: 2
    adjudicator: true
skillCorrection:
  enabled: true
  selection:
    mode: include
    include: [documents]
    exclude: []
  completionCheckIntervalTurns: 10
  maxWatchTurns: 30
  maxFeedbacksPerSkill: 1
artifactCorrection:
  groundTruthReviewEnabled: true
  stageMetricsEnabled: true
stopCorrection:
  enabled: true
  maxCorrectionsPerSession: 3
  maxCorrectionsPerFlow: 3
  assessmentTimeoutMs: 1200000
  feedbackReserveMs: 180000
  reviewGroupSize: 3
reviewers:
  defaults:
    timeoutMs: 1200000
  onboardingAdjudicator:
    session: independent
    provider:
      baseUrl: https://provider.example
      apiKeyEnv: REVIEWER_API_KEY
      model: registered-model
```

`panel.size: 0` 关闭 onboarding 小组，保留增量抽取。角色 `session: fork` 复用父上下文的隔离分叉，`detached` 使用环境身份新建会话，`independent` 使用指定提供器新建会话。OpenClaw 使用原生 reviewer 路径，模型须按宿主注册配置。角色级设置优先于 `reviewers.defaults`，再回退到 `limits.semanticReviewTimeoutMs` 和 20 分钟默认值；格式修复共享该角色绝对截止。

`compactionRestore.enabled` 默认为 `false`，开启后 OpenClaw 在压缩后的首次提示构建中从原文存档恢复需求，最多注入 24 KiB。

`reviewers.modelPolicy` 可使用 `off`、`critical-gates`、`all` 预设；critical-gates 仅覆盖 onboardingAdjudicator 与 stopReviewer。显式角色配置优先。写出配置时预设展开为角色字段。缺失密钥环境变量时记录 `REVIEWER_PROVIDER_DEGRADED` 并按实现回退，独立身份不会把父凭据送往第三方。抽取降级状态如 `DERIVED_CONFIG`、`ONBOARDING_DEGRADED` 可在任务日志中核对。

配置 Schema 是字段校验来源：`config/schemas/project-config.schema.json`；运行时仍须通过统一策略编译器的语义约束。

## 需求框架

```yaml
requirementFrame:
  enabled: false
  proposers: 3
  inject: true
  review: true
  checks: false
  timeoutMs: 600000
```

默认关闭。启用需要 OpenClaw 的版本 2 项目配置，以及通过 `artifactCorrection.originalRequirementsEnabled` 或
`stopCorrection.originalRequirementsBasis` 开启用户消息记录。观察模式下不生成。
`proposers` 接受 1 至 3，`timeoutMs` 是生成过程的总时限，单位为毫秒。非法值使用上面的默认值。

审查模型由 `reviewers.requirementFrame` 指定，未单独配置时沿用 `reviewers.defaults`。
生成在后台进行，依据任务开始时的 Git 提交和用户消息。结果保存在项目状态目录的
`requirement-frame/<会话哈希>/frame.json`。
`inject` 控制简报送达。已有框架时在真实用户回合开头送达，本回合新生成的框架则随下一次工具结果送达。
`review` 启用 Stop 对匹配任务开始提交的框架逐项记录处置，并在已有偏差反馈后追加复现要求。

`checks` 默认 `false`。开启后额外运行“项目规则”和“验证要求”两个检查项提议者，从任务开始提交的项目文档中找出本任务会触发的规则，选中的检查项编号为 K1、K2……。每个提议者只在其指标族至少有一个开启的 Stop 指标时运行；仓库中没有 Markdown 文档时不运行。检查项进入简报，并在 `stopCorrection.originalRequirementsBasis` 开启时并入终审清单。详见 [纠偏检查体系](correction-checklist.md)。

## OpenClaw 中核验获准的 OpenSpec 方案

在已启用纠偏器的项目和会话中，操作员可以通过 `openclaw gateway call <method> --params '<json>' --json` 调用下列方法。参数包括实际的 `sessionKey`、`sessionId`、`runId` 和 `changeName`。插件从宿主确认会话所属工作区，并要求该运行已成功结束且相关 Stop 审查已处理完毕。

1. Proposal 通过 OpenSpec 严格校验后，使用 Proposal 的运行编号调用 `runtime-corrector.openspec.preview`。核对文件内容及其 `revision`。
2. 确认接受该方案后，使用相同参数调用 `runtime-corrector.openspec.approve`，并将 `expectedRevision` 设为预览返回的值。此方法需要 `operator.write`，预览和核验需要 `operator.read`。方案在预览后发生变化时，需要重新审阅当前版本。
3. 如需在 Stop 自动核验，先用同一 Proposal 参数和 `expectedRevision` 调用 `runtime-corrector.openspec.arm`，再加上计划用于下一次 Apply 的 `applyRunId`。此方法需要 `operator.write`。通过 Gateway 发送 Apply 时，将该值作为 `chat.send` 的 `idempotencyKey`。只有同一会话中的下一次运行可以使用这次绑定。
4. Stop 等待对应的 Apply 运行结算后再自动比对。结果保存在该次原生 Stop 记录的 `openSpecPlan` 字段，也可从 `runtime-corrector.dispatch.get` 的 `reviewSummary.openSpecPlan` 读取。没有使用自动核验时，可在 Apply 和 Stop 结束后使用同一会话和变更、以及新结束的 Apply 运行编号调用 `runtime-corrector.openspec.verify`。

`PRESERVED` 表示获准的提案、设计、规范和任务文字得以保留，且允许按 OpenSpec 的格式勾选完成项。`CHANGED` 附带发生变化的文件路径。缺少可核验的方案时返回 `UNVERIFIED`。Stop 发现已绑定的方案被改写时，若自动修正已启用、原生协议可用且尚有额度，可通过同一原生修正队列请求恢复。该回合只能恢复已批准的范围，不能批准新方案。恢复后仍须沿用原始需求清单完成正常实现审查。证据不可用或清单仍有未完成项时，Stop 保留待验证状态。影子模式、禁用修正、额度耗尽或宿主协议不可用时，由操作员处理。审批和 Apply 绑定保存在当前会话状态中，宿主重启后需重新确认。

审批同时在宿主状态中保存有大小限制的准确文档内容。只有通过真实启动、使用和交付回执核验的恢复回合，才可调用 `runtime_corrector` 的 `approved-plan` 命令列出并分页读取对应原文；此回合沿用同一份原始需求。未启动、取消或伪造的请求不能读取或继承审批。审批目标版本和排队时观察到的改写版本分别核验，原文、策略、会话范围或队列证据变化时拒绝启动。同一份证据已实际尝试恢复后，不会再次消耗修正额度；新证据仍受同一会话和流程额度约束。恢复范围由指令、方案核对和最终审查约束，并非文件系统写入沙箱。

Apply 写入获准文档后，插件先核对方案。显式 `runtime_corrector check` 也会在调用语义审查器前核对同一绑定；确认改写时直接报告原有审批不匹配，保留最终 Stop 核验，避免语义复查掩盖尚未恢复的方案。勾选进度、未绑定的运行及无关文件仍走原有检查。

文档审查请求同时提供完整的冻结会话和不超过 24 KiB 的近期完整消息视图，附原文行号及工具回执行的定位。近期视图只用于导航，不增加证据权限。截断、未读历史或缺少回执只能留下待验证结论；指称未执行检查、源码未变或结果编造，需要当前的正面证据。

启用原文审查时，OpenClaw 文档审查器可用 `rc_document` 的 `read_original` 操作读取原始用户消息的确切行范围，并在文档发现中引用返回的 `originalSourceAnchorId`。Stop 在核对用户消息的可信读取后，为清单项保存相同的原文定位标识。标识依据消息、原文版本和准确的 UTF-8 字节范围生成。定位信息用于关联两个阶段的证据。每项义务是否覆盖仍需分别核对方案与实现。

文档审查器还可提交逐项的 `originalRequirementCoverage`。每项包含原文定位标识、可独立检查的要求、结论、理由及已读取的方案范围。结论可为 `COVERED`、`GAP` 或 `UNVERIFIED`。无具体位置的遗漏判定需要先读取本轮声明的全部方案文件。通过核验的记录随文档审查结果保存，并带有当前文件版本和实际审查范围。已保存的各项结论用于追踪本轮审查过的要求，整份方案的覆盖仍需逐项确认。

严格 Proposal 覆盖审批同时要求当前完整方案的审查通过。即使每项都标为 `COVERED`，当前方案中已完成的审查若有阻断错误，仍不能批准或绑定 Apply；同一批当前文档的较新局部审查发现阻断错误时也会暂停审批。未完成或检查器不可用的完整审查保持 `UNVERIFIED`。新的干净完整审查可以恢复核验，部分通过不能覆盖尚未解决的阻断结论。显式 `runtime_corrector check` 与写入后的审查使用同一套宿主记录，并可在不改写文件的情况下重新核对准确的私有需求清单。审批后仍只在同一 Proposal、同一方案版本及原文依据未变时向私有审查器提供这份清单。严格 Apply 绑定会在首次运行继承时复核，已过时的待执行绑定不再授予审批依据；这不会阻止宿主执行，也不会撤销已开始的合法 Apply 或修正续跑。

审批时，OpenClaw 插件从同一任务、会话和 Proposal 运行的已提交审查结果中选取记录。只有本轮审查的文档范围及内容与获准变更完全一致时，记录才会绑定到该版本。完成已绑定的 Apply 后，Stop 可按原文定位标识在清单旁显示相应方案段落。只要任务勾选改变了文件内容，原清单的精确引用及没有具体目标的范围级结论就不会带入。显示的方案段落用于定位，功能验收仍需当前实现和执行证据。
