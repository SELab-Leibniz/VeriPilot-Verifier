# Stop 基线刷新 task

## 适用范围

OpenClaw/MA 的 `ground-truth-extractor` 在 `reviewScope.kind: baseline` 且 `boundedBasis: true` 时走专用抽取 task。该标记由任务级普通刷新及 Stop 前置刷新设置；项目内复用串行的私有提取会话，每轮来源凭据独立。初始 onboarding 抽取与裁决、Skill/文档专用抽取保持原协议；停止分类使用专用 classification task；逐项/分组审查保留其裁决协议。粒度、笔记、生命周期和实验见 [基线提取优化](baseline-extraction-optimization.md)。

`task-session.mjs` 共用原生会话启动、模型与 effort 选择、会话身份、精确工具绑定、取消和绝对截止。执行层从 worker 取得工具、提示词和完成判断，不根据 `submit_review` 名称决定完成。基线工具不会得到业务 Agent 的工具权限，也不能写业务文件或正式 Ground Truth。

抽取执行与候选发布分别受各自的截止时间约束。角色限时只限制抽取、修复和工具调用；已经完成的来源绑定候选，可以在所属 Stop 的共享截止时间内发布。发布仍检查原始材料、原基线、任务归属和取消状态。没有父审查截止时间时沿用抽取截止时间；不会产生无限期候选，也不能在父审查到期后发布。后续指标审查耗时超过抽取角色限时，不应单独导致未变来源被误报为过期。

## 来源与候选协议

程序冻结完整原始请求、原基线、用户来源及已授权材料/项目约束；长原文按最多 16KiB 的 UTF-8 字节部分交付，不生成语义摘要。请求身份绑定来源目录、原文摘要、任务、事件及原基线版本。当前实现保守地要求本次列出的全部必要文件均已确认读取，尚未实现按变化来源缩减必读集合。

基线会话拥有 `source_read`、`source_grep`、`source_find`、`source_ls`、`review_history`、仅作导航的 `baseline_notes` 和两个独立提交工具：

- `save_baseline_batch` 保存连续、稳定的批次编号、原有 operation schema、原始来源绑定与读取凭据。批次上限 50KiB，完整 delta 仍遵守现有 schema 的操作条数限制。相同请求/代次/批次的相同内容返回原持久化回执；冲突内容拒绝。回执之前发生的异常可通过相同提交恢复，不将候选写入正式账本。
- `finish_baseline` 要求显式列出完整批次序列，核对真实读取覆盖、冻结输入、原基线和任务身份。空增量也须完整读取，缺失结果不等于 NO_CHANGE。程序组装完整 delta，模型无需再次输出全部操作。

短来源默认使用逐段草稿协议：每个非空原文行得到 `S{来源序号}L{行号}`。模型用 `keep` 保留完整段落、`split` 分离独立流程、`merge` 合并连续同流程段落，或用带理由的 `exclude` 排除非义务/已入账重复内容。拆分必须覆盖所有顶层分号条款且不得重复；结束时检查全部段落是否都有决策，缺失不能静默完成。原文含引号/括号时不在其内部拆分。程序复制原文、绑定当前读取凭据，模型仍决定语义分组和权限元数据；逐段覆盖不等于已经证明语义正确。

每条草稿明确指定 `verificationTarget`，代码义务另须 `implementationRole`。共享默认值可用逐段 `overrides` 和拆分组 `metadata` 覆盖；只在 overrides 中出现的段落也视为保留整段。不同检查归属的义务分别成条，有效元数据不同的段落不得合并。新用户段落不能被自由排除，只有完整原文与指定的当前 USER_EXPLICIT/USER_MESSAGE 条目一致时才可作为已存在的重复要求排除。

默认协议只生成 ADD。已有 claim 的改动、综合表述、来源分片、超过 128 行或 200 个草稿单元时使用完整文字协议。模型可用 `fullTextReason` 请求切换，沿用同一会话、已存批次、修复次数和截止；SUPERSEDE 仍须真实 claimId 并保留该 claim 内未变条件。决策、未处理单元和分组名称进入私有检查点及分页历史，不进入宿主上下文。详见 [第二轮方案及配对实验](baseline-token-time-optimization.md)。

完整协议也优先使用 `outcome` + `textFrom`，由程序捕获原文、来源和已经签发的真实读取回执。可用 `file` 加工具显示的分片内 `start/end`，或 `sourceIndex` 加原始文件行号；两种坐标不能混用。边界处的不完整原始行须使用原始坐标，避免把残句当完整要求。冻结请求的 `sourceNavigation` 给出每片 `startLine/endLine`，分片内行号加 `startLine - 1` 可定位原文；它只是导航信息，不授予读取或权限。跨分片的行须有所有相交部分的连续读取覆盖，未持久化或缺失的回执不能补足证据。跨来源综合仍使用完整 text/source/bindings；动作、权限和适用性须明确提供，程序不会推断。此优化不赋予完整协议逐段决策完成保证。

原始来源引用继续经过 `bindSourceSelections` / `validateSourceBindings`。引用范围须由绑定到该来源的真实读取凭据覆盖。未知、别的会话、导航、摘要和历史检索不会产生新的证据或 USER_EXPLICIT 授权。程序从冻结原文捕获 excerpt；模型提供的引文不充当原文证明。

读取覆盖复用宿主同步 `tool_result_persist` 最终消息边界：只有非 synthetic、会话绑定正确、调用 ID 和完整披露字节都匹配的消息才进入 RC 自己 fsync 后的读取凭据。普通工具遥测和模型自行声明不能产生覆盖。MA 的该钩子位于最终消息持久化流程中、文本脱敏之前；无模型契约测试执行真实 Hook Runner，并核对真实传输的参数，完整宿主进程中的失败恢复仍需后续真实验收。

## compact、检查点和限制

基线 Agent 不再按累计读取字节数硬中止；读取量、工具返回量和重复读取行数只用于诊断统计。上下文窗口管理与压缩由宿主负责，沿用宿主原生配置。基线与停止分类 Agent 禁止使用编辑、写入、补丁、命令和代码执行工具；私有工具保存候选、进度和结果的能力保留。RC 保留分页、OpenClaw Stop 的 200 个累计助手响应轮次和 32768 单次输出 token 上限、有限修复次数和一个绝对截止；compact、批次保存、协议修复、领域修复都不重置该截止。停止分类 Agent 同样不使用累计字节中止条件，不设插件上下文大小或读取次数阻断，正常分页和最终交付证明见 [读取边界](stop-review-bounds.md)。

`review-checkpoint.json` 保存请求身份、来源目录和摘要、原基线版本、已确认读取范围/凭据、候选批次回执、待处理文件范围、阶段、候选代次、累计轮次/修复次数及原截止时间。候选批次本体保存在 `candidates-N/batch-ID.json`，不混入正式账本。

压缩前后沿用宿主钩子保存检查点。模型压缩后调用 `review_history` 的 `state` 恢复进度；`taskState.nextStateOffset` 分页抽取进度，顶层 `nextOffset` 分页读取凭据，两者是独立游标。`search/read` 可以找回持久化候选和历史观察；这些内容只是导航或候选，不替代原始来源。原文仍在冻结目录，必要时可重新读取。

只保证同一运行内 compact 后继续。检查点落盘不意味着支持跨进程自动恢复或自动重启旧会话。

## 正式应用和一致性

完成后的 handle 保留 `result`、`requestDirectory`、`followUp`、`close` 接口。原编排层继续执行 schema、领域、来源权限等级、冻结规则、claimId 和版本校验。领域校验失败后使用新候选代次修复；保留之前候选供审计，不覆盖旧批次，不重置轮次、修复次数和截止。

仅完整 delta 进入正式应用。原文及基线变化时旧候选失效。正式 delta、应用回执和来源游标在同一任务事务 head 下发布，提交前及 head 发布前再次检查来源/取消/截止。相同请求的相同 delta 重试不会重复应用；已应用请求收到不同 delta 明确拒绝。日志已写、head 未发布的尾部不是已提交结果；head 已发布后丢失回执则通过正式应用记录恢复。

状态分别表现为：

- `NO_CHANGE`：完成必要读取后提交的空增量。
- `BASELINE_INCOMPLETE` / `BASELINE_REPAIR_LIMIT`：未完成全部依据或耗尽有限修复机会。
- `BASELINE_SOURCE_INVALID` / `BASELINE_SCHEMA_INVALID` / `BASELINE_INPUT_CHANGED`：来源、结构或输入版本失败。
- `REVIEWER_DEADLINE`、原取消原因、`REVIEWER_RUN_FAILED`：截止、取消或模型执行失败。

检查器失败保留 UNVERIFIED，部分候选不能推进来源游标或被当成完整基线进入后续指标分组。

## 自动化验证和后续小规模验收

先在仓库内建立临时目录，只对当前测试进程设置 TEMP/TMP：

```powershell
New-Item -ItemType Directory -Force .runtime-correction/test-temp | Out-Null
$env:TEMP = (Resolve-Path .runtime-correction/test-temp).Path
$env:TMP = $env:TEMP
node --test test/stop-baseline-task.test.mjs test/openclaw-task-runtime.test.mjs test/stop-task-group.test.mjs
```

无模型宿主契约需要显式指定只读参考安装中的 OpenClaw 根目录：

```powershell
$env:RC_OPENCLAW_HOST_ROOT = '<MA安装目录>/resources/openclaw'
node --test test/stop-baseline-task.test.mjs
```

该项执行真实 Hook Runner，检查真实结果持久化边界代码，使用隔离的脚本化模型循环；不启动真实业务会话、不修改安装目录或全局配置。`test/fixtures/stop-baseline-budget.json` 只保存已观察失败的去敏预算元数据；原失败私有请求已被清理，回归使用合成长原文，不声称逐字重放原业务轨迹。

构建仅生成仓库内产物：

```powershell
npm run build:plugin -- --host openclaw
```

后续若明确安排真实验收，应使用仓库内独立业务夹具、独立宿主状态目录和会话，先运行小规模单次基线抽取，再安排真实 compact，最后才是长 Stop。不要指向正在运行的 MA 状态目录，也不要把上述构建命令当作安装。

协议测试验证读取凭据、恢复状态、事务围栏和回归行为；真实模型受控回放的材料、准确性检查、token/耗时与局限另见上述第二轮实验。两者仍不能证明真实 compact 摘要质量、完整 Electron 长时行为或整个应用开发闭环。
