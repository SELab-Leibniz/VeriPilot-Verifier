# 文档纠偏脱离动态基线：原型与评估（2026-11-04）

分支 `exp/doc-original-basis`，已变基到 `efb0577`（`fix(rc): stabilize baseline extraction and Stop review`）；变基前基于 `c11be88` 的版本保留在 `exp/doc-original-basis-c11be88`。主工作区与 MatrixAssistant 均未改动。离线部分使用脚本化 reviewer；真实运行部分使用 MatrixAssistant 内置 OpenClaw 与其已配置的 `custom/deepseek-v4-flash`，见“真实模型对比”。

## 结论

文档纠偏可以直接对照原始需求审阅，不需要先提取基线。改动量约 220 行生产代码和提示词，外加 336 行测试，在 OpenClaw 与 Claude Code 两个入口都验证通过。

真实模型下做了两轮对比，3 个样例两种模式各跑一次。在 `efb0577` 上，两种模式都是 3/3 通过：原始需求模式总耗时 289 秒，基线模式 877 秒，前者少约 67%。业务模型写完初稿后等待首轮反馈的时间，原始需求模式为 17–54 秒，基线模式为 208–262 秒。

`efb0577` 让基线提取稳定了：每个样例只做一次提取和一次独立覆盖审计，一次发布成功，没有修补和重试；变基前同样 3 个样例共做了 10 次提取，constraints 样例因覆盖核验没通过而失败（总耗时 351 秒对 1374 秒）。但稳定之后，这两步每次仍要 173–198 秒，全部排在首轮反馈之前。两轮里两种模式发现的偏差相同，最终文档都与需求一致，所以基线模式多花的时间没有换来更多发现。

动态基线的设计初衷之一是“上下文压缩后仍能看到需求原文”。补测的语义样例（需求只在对话里，中途由宿主真实压缩，草稿含 5 处语义偏差）给出两个结论：

- MatrixAssistant 默认的摘要式压缩只在会话文件末尾追加摘要，旧消息仍在父链上。两种模式的首轮审阅都发现了全部 5 处偏差，没有误报。原始需求模式 168 秒通过；基线模式的基线提取跑了 9 次仍未发布，首轮反馈等了 1070 秒，业务运行最终撞上宿主 30 分钟上限而失败。
- 截断式压缩会真正删掉旧消息，两种模式都丢了需求：原始需求模式只靠文档内部矛盾发现 2/5，基线模式 0/5。原始需求模式那份会话日志在真实宿主里没有起作用，因为截断之前 RC 一次也没把第一轮记下来。离线测试里这一点能通过，是因为脚本化的钩子总能按时触发；真实宿主里，第一轮没有工具调用时日志没有写入，而 RC 的压缩前钩子在手动压缩时会卡满 30 秒超时（见“语义样例”一节）。

## 开关与行为

```yaml
artifactCorrection:
  originalRequirementsEnabled: true
  groundTruthReviewEnabled: false   # 两者互斥，配置加载时报错
  stageMetricsEnabled: false        # 同上
dynamicGroundTruth:
  enabled: false                    # 可关闭；materialRoots 未写时自动发现 README、*requirement*/*spec*、docs/
```

文档写入后，审阅请求附带 `originalRequirements`：

| 字段 | 内容 |
| --- | --- |
| `userMessages` | 本会话全部真实用户消息，按顺序；全文写入文件，24 KiB 内联，超出部分只给 300 字预览和文件路径 |
| `materials` | 需求材料（复用 `materialRoots`，OpenClaw 的材料冻结与篡改检查照常生效） |
| `referencedFiles` | 用户消息里点名的项目文件，最多 20 个 |
| `projectFiles` | `AGENTS.md` / `CLAUDE.md` 等宿主指令文件 |

配置的产物文件（例如被审的 `design.md`）始终排除在需求来源外。reviewer 可以按需读取项目内任何其他文件作为证据，但只有用户消息或需求来源才构成义务（见 `skills/semantic-review/SKILL.md` 新增的 “Original requirements” 一节）。被点名文件的角色由点名它的那条消息决定：用户要求遵循的文件是需求来源，只作为输入、模板、草稿或待替换对象提到的文件不是。

### 压缩与会话日志

`readOpenClawTranscript` 沿父链读取，宿主只追加压缩记录时，旧消息本来就在。若宿主把文件截短重写，`persistTranscript` 会丢掉旧消息。为此新增 `.runtime-correction/original-requirements/<会话哈希>.jsonl`，只追加用户原话。写入时机有三个：`UserPromptSubmit`、`PreCompact` 和每次文档审阅。即使任务尚未创建也会记录。已不在 transcript 中的消息标记为 `retainedAfterCompaction: true`，仍然有效。

在 MatrixAssistant 原生钩子下，前两个时机在真实运行中都没有写入：第一轮只回复 “Noted”、没有工具调用时，第一轮结束后日志仍不存在；手动压缩时 `before_compaction` 钩子被宿主以 30 秒超时中断。原因是 `sessions.compact` 在会话生命周期互斥区内执行，而 RC 的每个原生钩子都先调用 `runWithWorkAdmission` 申请同一会话的工作许可，两者互相等待。摘要式压缩不受影响，因为旧消息仍在会话文件里；截断式压缩（`sessions.compact` 带 `maxLines`）本身不触发钩子，所以第一轮需求在截断后无法找回。

## 测试结果

### 新增测试（`test/document-original-requirements.test.mjs`，11 项全部通过）

| 场景 | 结果 |
| --- | --- |
| 排除 meta、tool_result、内部消息；排除产物；识别被点名文件；摘要随输入变化 | 通过 |
| 会话日志：截断后保留旧消息、容忍半行损坏、会话之间隔离 | 通过 |
| 长消息：文件保留全文，内联受预算限制 | 通过 |
| 不开 `dynamicGroundTruth` 也能启用并自动发现材料；与基线审阅同开时报错 | 通过 |
| OpenClaw 打包插件：文档写入只调用 reviewer，不调用基线提取；发现偏差，修复后通过 | 通过 |
| OpenClaw 压缩：只追加型压缩；截短型压缩；截短发生在首次写文档之前 | 3 项通过 |
| Claude Code `PostToolUse` 钩子：fork 收到相同的需求包，包括被点名文件 | 通过 |
| 评测脚本的策略生成：`--original-requirements` 打开新开关且不开基线审阅 | 通过 |
| 对照：基线模式先提取并发布基线再审阅；仅 transcript 模式不再提取 | 通过 |

“截短发生在首次写文档之前”一项做过变异检查：去掉 `UserPromptSubmit`/`PreCompact` 的记录后，该项失败，只剩压缩后的那条消息。这些测试由脚本直接触发钩子，不覆盖真实宿主里钩子是否按时触发；真实宿主下的表现见“语义样例”一节。

语义样例评测脚本另有 `test/document-semantic-e2e.test.mjs`（5 项全部通过）：样例加载与偏差行号校验，独立检查（草稿 5 处全部不合格，人工修复版本通过，漏修或丢失合规内容时报出对应项），发现按段落归属，压缩后上下文判定（摘要式与截断式），以及两种模式生成的策略都能被配置加载器接受。

### 回归

- 文档相关 18 个测试文件（199 项）全部通过。
- 变基到 `efb0577` 后的全量：280 个文件、2972 项，20 个文件共 297 项失败。未改动的 `efb0577` 副本（`rc-wt/head-baseline`）同时跑全量：279 个文件、2961 项，失败的 20 个文件完全相同，失败用例数一致（297 = 297），属于既有问题。本分支多出的唯一文件是新增测试，11 项全部通过。
- 变基前（`c11be88`）的全量：277 个文件、2909 项，30 个文件共 280 项失败，与当时的 HEAD 副本一致。
- 首轮全量曾多出一个由本改动引入的失败：`document-agent.test.mjs` 的 “额外源文件读取应禁用精确缓存”。原因是缓存资格判断把请求文件所在目录整体视为本轮请求范围，现已收窄到 `user-sources/` 子目录，复跑通过。

## 与基线模式的对比

| 方面 | 基线模式（`groundTruthReviewEnabled`） | 原始需求模式 |
| --- | --- | --- |
| 文档写入前的模型调用 | 基线提取 + 审阅 | 仅审阅 |
| 审阅依据 | 提取出的 10–26 条 claim | 用户原话 + 需求文件全文 + 按需读取项目文件 |
| 提取失败时 | 基线停在 v0，此后每次写文档都会重试提取（离线夹具中复现：claim 文本未写产物路径即被准入拒绝） | 无此环节 |
| 压缩后的需求 | claim 账本保存 | 会话日志保存原话 |
| 偏差家族循环上限、`violatedGroundTruthIds`、阶段指标 | 有 | 无（不适用；仍有 v1 的失败恢复提示） |

已记录的真实运行（仓库内 5 份结果，24 次运行）中，私有模型运行共 86 次，其中基线提取 29 次，审阅 57 次。也就是说，纯文档流程里约三分之一的私有运行是基线提取。这些运行都同时声明了 `groundTruth: [original-requirements]`，审阅本来就直接拿到了需求文件。这些旧结果没有按角色记录耗时；按角色的耗时见下一节。

## 真实模型对比（2026-11-04）

环境：Windows，MatrixAssistant 内置 OpenClaw 2026.7.1-2（只读，每次运行使用独立的 gateway 配置），模型为 MatrixAssistant `openclaw.json` 中的默认模型 `custom/deepseek-v4-flash`，选项文件 `examples/document-e2e/dynamic-benchmark-options.json`。同一机器、同一代码，两种模式依次运行，每个样例每种模式各 1 次。共两轮：先在 `c11be88` 上，再在变基到 `efb0577` 后重跑。结果数据在 `docs/document-original-requirements-live-results.json`。

任务是复制型文档任务：业务模型先把含 4 处受控偏差的 `draft.md` 原样写成 `design.md`，再根据自动反馈修复，直到与 `requirements.md` 一致。

### 第二轮：`efb0577`（稳定后的基线提取）

| 样例 | 模式 | 结果 | 总耗时 | 首轮反馈等待 | 审阅轮次 | 审阅运行 | 基线提取 | 模型请求 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| financial-document-processor | 原始需求 | 通过 | 63 s | 17 s | 2 | 2（31 s） | 0 | 13 |
| financial-document-processor | 基线 | 通过 | 272 s | 220 s | 2 | 3（39 s） | 2（198 s） | 23 |
| constraints-scheduling | 原始需求 | 通过 | 78 s | 24 s | 2 | 4（40 s） | 0 | 15 |
| constraints-scheduling | 基线 | 通过 | 263 s | 208 s | 2 | 4（56 s） | 2（173 s） | 24 |
| matplotlib-22719 | 原始需求 | 通过 | 147 s | 54 s | 3 | 5（91 s） | 0 | 27 |
| matplotlib-22719 | 基线 | 通过 | 342 s | 262 s | 2 | 5（84 s） | 2（198 s） | 28 |
| 合计 | 原始需求 | 3/3 | 289 s | | | 11 | 0 | 55 |
| 合计 | 基线 | 3/3 | 877 s | | | 12 | 6 | 75 |

观察：

1. 基线模式每个样例的 2 次提取运行，分别是一次提取和一次独立覆盖审计，都一次发布 4 条 claim，没有修补或重试。这和第一轮的 2–5 次、含一次失败相比，是 `efb0577` 的实际改进。
2. 改进的是稳定性，不是开销。两步合计 173–198 秒，与第一轮的成功样例（195–196 秒）相当，仍全部排在首轮反馈之前。
3. matplotlib 上轮次不同：基线模式的 reviewer 在 5 条确定性 `DOCUMENT-COPY-MISMATCH` 之外又给了 5 条 `AGENT-COPY-*` 说明，其中一条讲清了文件末尾缺少空行，业务模型一轮全部修好；原始需求模式只有确定性发现，第 208 行的文件末尾差异第一轮没修好，多了一轮（约 18 秒）。第一轮对比时两种模式在这个样例上都是 3 轮，所以单次运行不能把这一轮归因于基线。
4. 额外的审阅运行仍是 `first-repair` 阶段的输出格式修补，每次 3–12 秒，两种模式都有。

### 第一轮：`c11be88`（变基前）

| 样例 | 模式 | 结果 | 总耗时 | 首轮反馈等待 | 审阅轮次 | 审阅运行 | 基线提取 | 模型请求 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| financial-document-processor | 原始需求 | 通过 | 78 s | 19 s | 2 | 2（31 s） | 0 | 13 |
| financial-document-processor | 基线 | 通过 | 267 s | 217 s | 2 | 2（32 s） | 3（195 s） | 24 |
| constraints-scheduling | 原始需求 | 通过 | 103 s | 35 s | 2 | 4（57 s） | 0 | 16 |
| constraints-scheduling | 基线 | 失败 | 665 s | 485 s | 2 | 2（45 s） | 5（574 s） | 37 |
| matplotlib-22719 | 原始需求 | 通过 | 170 s | 49 s | 3 | 5（90 s） | 0 | 24 |
| matplotlib-22719 | 基线 | 通过 | 441 s | 307 s | 3 | 6（176 s） | 2（196 s） | 38 |
| 合计 | 原始需求 | 3/3 | 351 s | | | 11 | 0 | 53 |
| 合计 | 基线 | 2/3 | 1374 s | | | 10 | 10 | 99 |

观察：

1. 两种模式在首轮审阅都定位到了全部 4 处受控偏差，6 次运行的最终文档都与原始需求一致，审阅轮次相同。差别只在等待和花费上。
2. 基线提取发生在首次写文档之后、首轮审阅之前，业务模型在这段时间里一直在等反馈。financial 样例的提取经历了一次 `GROUND_TRUTH_DELTA_REPAIRED` 修补；constraints 样例提取 7.7 分钟后报 `GROUND_TRUTH_REFRESH_FAILED` 与 `BASELINE_COVERAGE_UNVERIFIED`（“Independent original coverage remains unresolved”）。首轮审阅只能在基线 v0 下进行，修复写入时又重试提取，最后才发布 4 条 claim。评测脚本因此判定“审阅没有绑定到已发布的基线”而失败，尽管文档本身已修好。
3. 两种模式都会出现额外的审阅运行，阶段为 `first-repair`，是 reviewer 输出格式修补，每次 5–11 秒，与是否使用基线无关。
4. 基线模式的审阅在 matplotlib 样例上也更慢（176 s 对 90 s），首轮单次审阅 89 s 对 44 s，审阅请求里多了 claim 账本。

代码版本：这一轮两种模式都运行本分支基于 `c11be88` 的代码，不包含 `efb0577` 对基线提取的改动。

### 两轮共同的局限与安全检查

这组样例的局限：除基线模式中的 `AGENT-*` 发现（第一轮 1 条 `AGENT-GT-DEVIATION`，第二轮 matplotlib 的 5 条 `AGENT-COPY-*`）外，所有首轮发现都是确定性的 `DOCUMENT-COPY-MISMATCH`，因此它衡量的是流程开销和稳定性，不衡量语义审阅能力。每种组合每轮只跑了 1 次，耗时包含共享云端接口的波动。

每轮运行前后都对 MatrixAssistant 的 `resources/openclaw` 做了快照（文件数 22207、总字节 248556049、最新修改时间 2026-10-19），前后完全一致。模型凭据只在进程内存中使用，并以只读方式从 OpenClaw 的 agent 鉴权库读取；运行后扫描输出文件（第一轮 2549 个，第二轮 2447 个），均不含该密钥。

## 语义样例：需求只在对话中，中途压缩（2026-11-04，`efb0577` 之上）

样例 `examples/document-e2e/semantic-ledgerlite-export`（虚构的 `ledgerlite export` 设计说明），脚本 `scripts/evaluate-openclaw-semantic-document-e2e.mjs`，环境与模型同上。流程：

1. 第一轮：用户在对话里给出 8 条需求（只输出 CSV、金额用整数分、日期为 UTC 的 `YYYY-MM-DD`、完全离线、输出文件已存在时拒绝写入并以 2 退出（除非 `--force`）、按日期再按 id 升序、`note` 默认不导出、退出码 0/1/2），要求模型只回复 “Noted”。项目里没有需求文件。
2. 由宿主压缩会话，两种方式各跑一次：
   - 摘要式：`sessions.compact { key }`，即宿主真实的模型摘要压缩，沿用 MatrixAssistant 配置中的摘要设置（`safeguard` 模式、自定义指令等），只把保留窗口调到最小（`keepRecentTokens: 1`、`recentTurnsPreserve: 0`），让第一轮离开业务上下文。默认配置下保留约 20000 token 和最近 3 轮，第一轮要等后续对话足够长才会被压掉。
   - 截断式：`sessions.compact { key, maxLines: 2 }`，宿主把会话文件截到最后一行并归档原文件。
3. 第二轮：要求业务模型把 `draft.md` 原样写成 `design.md`，再按自动反馈修到“满足我先前在本会话中提出的全部需求”。草稿有 5 处语义偏差（金额写成浮点美元、`note` 默认导出、按金额降序、直接覆盖已有文件、启动时检查更新并上报用量），其余段落用不同措辞复述了需求，用来检验误报。
4. 判定：脚本按段落用正则独立检查最终文档（5 处偏差都已消除、3 处合规段落仍保留），不依赖 RC 的审阅结论；并用会话文件确认压缩后第一轮确实不在业务上下文中，以及会话 ID 没有变。

| 压缩 | 模式 | 结果 | 总耗时 | 首轮反馈等待 | 首轮发现 | 审阅轮次 | 审阅运行 | 基线提取 | 模型请求 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 摘要式 | 原始需求 | 通过 | 168 s | 49 s | 5/5，无误报 | 2 | 4（69 s） | 0 | 21 |
| 摘要式 | 基线 | 失败：业务运行 30 分钟超时 | 1889 s | 1070 s | 5/5，无误报 | 1（第二轮未完成） | 5（83 s） | 9（1714 s），未发布 | 68 |
| 截断式 | 原始需求 | 失败：最终文档仍违反 4 处 | 259 s | 103 s | 2/5 | 2 | 5（136 s） | 0 | 20 |
| 截断式 | 基线 | 失败：最终文档 5 处全未修 | 337 s | 282 s | 0/5 | 1 | 2（46 s） | 2（234 s），发布 6 条 | 22 |

观察：

1. 摘要式压缩后，业务模型看到的只有摘要，但 RC 读会话文件时沿父链仍能拿到第一轮原话，两种模式的首轮审阅都逐条引用需求、定位到全部 5 处偏差，没有对复述段落误报。MatrixAssistant 的摘要本身也保留了全部 8 条需求。
2. 摘要式下的基线模式：首次写文档后，提取和覆盖修补用了约 16 分钟，最后报 `GROUND_TRUTH_REFRESH_FAILED`（“Independent original coverage remains unresolved”），基线停在 v0。首轮审阅在没有基线的情况下照常给出 5 条发现，业务模型据此把文档修好（独立检查通过），但修复写入又触发了新一轮提取，第二轮审阅没能在宿主 30 分钟的运行上限内完成。复制型样例在 `efb0577` 上每次一次发布成功；需求只在对话里、没有需求文件时，覆盖审计仍会反复失败。
3. 截断式下，第一轮从会话文件中消失，业务模型和 RC 都看不到需求：
   - 原始需求模式的会话日志只记录到第二轮那条消息。首轮审阅仅凭文档内部矛盾发现 2 处：“覆盖已有文件”与退出码表中的 2 冲突，“只读本地文件”与检查远程地址冲突。最终审阅通过，但独立检查显示金额、`note`、排序 3 处仍违反需求，`--force` 也没有补上。
   - 基线模式发布了 6 条 claim，全部来自第二轮的流程指令（“只能编辑 design.md”“修到审阅通过为止”等），没有一条业务需求，首轮审阅直接通过。之后业务模型调用 `apply_patch` 失败，运行以错误结束。
4. 每次摘要式压缩耗时 39–41 秒，其中 30 秒是 RC 的 `before_compaction` 钩子等不到会话工作许可、被宿主超时中断（宿主日志 `[hooks] before_compaction handler from runtime-corrector failed: timed out after 30000ms`，3 次摘要式压缩均出现）。这意味着装了 RC 后，用户在 MatrixAssistant 里每次手动压缩都会多等 30 秒。相关代码（`compact` 钩子与 `withState` 中的 `runWithWorkAdmission`）本分支没有改动，与 `efb0577` 相同，但没有在 `efb0577` 上单独复现。截断式压缩不触发钩子，约 0.2 秒。
5. 首次试跑因评测脚本解析 `sessions.compact` 响应出错而在压缩后中止，记录保留在 `harness-attempt-summary-original`，不计入上表。

安全检查：运行前后 MatrixAssistant 快照一致；输出目录 2058 个文件和 7 个控制台日志均不含密钥。每种组合只跑 1 次，结论只适用于这一个虚构样例。

## 已知限制

1. 行为变化：开启 `dynamicGroundTruth` 但关闭基线审阅的现有配置，写文档不再预热基线，Stop 和 Skill 会在需要时自行刷新。现有 Stop 和 runtime-v2 测试没有新增失败。
2. 会话日志按会话 ID 记录。用户回退分支时，被放弃分支上的消息仍会保留。换新会话续做同一任务时，只包含新 transcript 里有的消息。
3. OpenClaw 通过 `prependContext` 注入到用户消息里的纠偏反馈只做了标记（`containsCorrectorFeedback`），没有剥离。提示词要求 reviewer 不把标记后的文字当作用户权威。
4. 请求里的消息路径按轮次变化，因此原始需求模式下，文档审阅的精确输入缓存预计不会命中。
5. 语义偏差的真实数据只有一个虚构样例、每种组合 1 次，准确率、漏报和误报还不能下一般结论。
6. 本分支已变基到 `efb0577`，无冲突。与 `efb0577` 重叠的文件是 `orchestrator.mjs`、`runtime.mjs`、`reviewer.mjs` 和 `packaging/runtime-modules.json`，本分支在其中的改动共 28 行，变基后逐处核对过仍然完整。
7. 截断式压缩之后，原始需求模式找不回压缩前的需求：在 MatrixAssistant 原生钩子下，会话日志只在 RC 观察到会话文件时写入，第一轮没有工具调用就不会写；`before_compaction` 钩子在手动压缩时等不到会话工作许可而超时，截断本身又不触发钩子。宿主的 `truncateAfterCompaction`（压缩后换新会话 ID）也没有测过，日志按会话 ID 记录，换 ID 后同样找不回。

## 后续建议

1. 修 `before_compaction` 的工作许可死锁：压缩钩子不应申请宿主正在占用的会话许可。修好后既省掉每次手动压缩的 30 秒，也让原始需求模式能在压缩前补记用户消息。
2. 在第一轮结束时（`agent_end` 或 `before_agent_finalize`）也补记用户消息，不依赖本轮是否有工具调用。这两项修好后重跑截断式样例，才能检验会话日志的真实作用。
3. 需求只在对话里时，基线模式的覆盖审计会反复失败（摘要式样例 9 次提取、约 29 分钟仍未发布）。若保留基线模式，需要单独排查这一路径。
4. 每个组合重复 3 次，确认耗时差距不是单次波动，也确认 matplotlib 上 `AGENT-COPY-*` 说明省掉一轮修复是否可重复。如果可重复，可以考虑在原始需求模式下让 reviewer 对确定性差异也给出说明，而不需要基线。

## 复现

```powershell
cd C:\Users\user\workspace\program_workspace\rc-wt\doc-original-basis
node --test test/document-original-requirements.test.mjs
node ./scripts/test.mjs

# 真实运行（使用 MatrixAssistant 已配置的模型；--output-root 必须是新目录）
node scripts/evaluate-openclaw-document-e2e.mjs --live --original-requirements `
  --benchmark-case examples/document-e2e/terminal-bench-financial-document-processor `
  --host-root C:\Users\user\workspace\program_workspace\MatrixAssistant\resources\openclaw `
  --openclaw-profile C:\Users\user\.openclaw\openclaw.json `
  --config examples/document-e2e/dynamic-benchmark-options.json `
  --output-root .runtime-correction/doc-original-live-<日期>-<基线提交>/<样例>-original-001
# 基线模式把 --original-requirements 换成 --dynamic-baseline

# 语义样例：--compaction summary|truncate，--mode original|ledger
node scripts/evaluate-openclaw-semantic-document-e2e.mjs --live `
  --case examples/document-e2e/semantic-ledgerlite-export --compaction summary --mode original `
  --host-root C:\Users\user\workspace\program_workspace\MatrixAssistant\resources\openclaw `
  --openclaw-profile C:\Users\user\.openclaw\openclaw.json `
  --config examples/document-e2e/dynamic-benchmark-options.json `
  --output-root .runtime-correction/doc-semantic-live-<日期>/summary-original-001
```

`--openclaw-profile` 读取 `openclaw.json` 中 `agents.defaults.model` 指向的 provider 和模型（可用 `--openclaw-model <provider/model>` 改选），只复制端点与该模型的定义；密钥从同目录 `agents/main/agent/openclaw-agent.sqlite` 的 `<provider>:default` 鉴权条目只读取出，只经由临时环境变量交给隔离 gateway，不写入配置或报告。对应实现在 `scripts/helpers/native-gateway-evaluation.mjs` 的 `nativeGatewayHostProfileProvider`。

工作树内的 `lib/review-task/node_modules` 是从主工作区复制的依赖（已被 `.gitignore` 忽略），仅用于运行测试。
