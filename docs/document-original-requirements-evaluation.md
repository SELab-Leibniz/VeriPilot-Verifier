# 文档纠偏脱离动态基线：原型与评估（2026-11-04）

分支 `exp/doc-original-basis`，基于 `c11be88`。主工作区与 MatrixAssistant 均未改动。离线部分使用脚本化 reviewer；真实运行部分使用 MatrixAssistant 内置 OpenClaw 与其已配置的 `custom/deepseek-v4-flash`，见“真实模型对比”。

## 结论

文档纠偏可以直接对照原始需求审阅，不需要先提取基线。改动量约 220 行生产代码和提示词，外加 336 行测试，在 OpenClaw 与 Claude Code 两个入口都验证通过。

真实模型下，3 个样例两种模式各跑一次。原始需求模式 3/3 通过，总耗时 351 秒；基线模式 2/3 通过，总耗时 1374 秒，前者少约 74%。基线模式多出的时间几乎全部是基线提取：10 次提取共 965 秒，而且都发生在首轮反馈之前。业务模型写完初稿后等待首轮反馈的时间，原始需求模式为 19–49 秒，基线模式为 217–485 秒。基线模式唯一的失败就是历史上反复修的那类问题：提取的覆盖核验没通过，首轮审阅只能在没有基线的情况下进行。

动态基线的设计初衷之一是“上下文压缩后仍能看到需求原文”。新模式用一份只保存用户原话的会话日志覆盖了这个目标，不存项目副本。宿主把 transcript 截短重写时，旧需求仍然可见，这一点有测试证明。

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

“截短发生在首次写文档之前”一项做过变异检查：去掉 `UserPromptSubmit`/`PreCompact` 的记录后，该项失败，只剩压缩后的那条消息。

### 回归

- 文档相关 18 个测试文件（199 项）全部通过。
- 最终全量：277 个文件、2909 项，30 个文件共 280 项失败。在未改动的 HEAD 副本（`rc-wt/head-baseline`）上逐一复跑，这 30 个文件同样失败，失败用例数一致（280 = 280），属于既有问题；主工作区的未提交改动涉及其中多数测试文件。
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

环境：Windows，MatrixAssistant 内置 OpenClaw 2026.7.1-2（只读，每次运行使用独立的 gateway 配置），模型为 MatrixAssistant `openclaw.json` 中的默认模型 `custom/deepseek-v4-flash`，选项文件 `examples/document-e2e/dynamic-benchmark-options.json`。同一机器、同一代码，两种模式依次运行，每个样例每种模式各 1 次。结果数据在 `docs/document-original-requirements-live-results.json`。

任务是复制型文档任务：业务模型先把含 4 处受控偏差的 `draft.md` 原样写成 `design.md`，再根据自动反馈修复，直到与 `requirements.md` 一致。

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

代码版本：两种模式都运行本分支代码，基于 `c11be88`。主工作区在评测期间（11-04 11:59）提交了 `efb0577 fix(rc): stabilize baseline extraction and Stop review`，改动了基线提取，也涉及 `orchestrator.mjs`、`runtime.mjs`、`reviewer.mjs`。上表的基线模式数据不包含该提交的改进。

这组样例的局限：除基线模式中的 1 条 `AGENT-GT-DEVIATION` 外，所有首轮发现都是确定性的 `DOCUMENT-COPY-MISMATCH`，因此它衡量的是流程开销和稳定性，不衡量语义审阅能力。每种组合只跑了 1 次，耗时包含共享云端接口的波动。

运行前后对 MatrixAssistant 的 `resources/openclaw` 做了快照（文件数 22207、总字节 248556049、最新修改时间 2026-10-19），两次完全一致。模型凭据只在进程内存中使用，并以只读方式从 OpenClaw 的 agent 鉴权库读取；运行后扫描全部 2549 个输出文件，均不含该密钥。

## 已知限制

1. 行为变化：开启 `dynamicGroundTruth` 但关闭基线审阅的现有配置，写文档不再预热基线，Stop 和 Skill 会在需要时自行刷新。现有 Stop 和 runtime-v2 测试没有新增失败。
2. 会话日志按会话 ID 记录。用户回退分支时，被放弃分支上的消息仍会保留。换新会话续做同一任务时，只包含新 transcript 里有的消息。
3. OpenClaw 通过 `prependContext` 注入到用户消息里的纠偏反馈只做了标记（`containsCorrectorFeedback`），没有剥离。提示词要求 reviewer 不把标记后的文字当作用户权威。
4. 请求里的消息路径按轮次变化，因此原始需求模式下，文档审阅的精确输入缓存预计不会命中。
5. 真实模型对比只覆盖复制型样例，语义偏差的准确率、漏报和误报仍没有数据。
6. 本分支基于 `c11be88`。主工作区的改动已提交为 `efb0577`，与本分支在 `orchestrator.mjs`、`runtime.mjs`、`reviewer.mjs` 上可能有小冲突。本分支在这三个文件中的改动共 27 行。

## 后续建议

1. 补一组语义样例：需求只出现在对话中，中途强制压缩，草稿含语义偏差而非逐字差异，检验压缩后能否仍然发现偏差。这是两种模式真正可能拉开差距的地方。
2. 把本分支变基到 `efb0577`，用其稳定后的基线提取重跑基线模式，再与原始需求模式比较。
3. 每个组合重复 3 次，确认耗时差距不是单次波动。

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
  --output-root .runtime-correction/doc-original-live-<日期>/<样例>-original-001
# 基线模式把 --original-requirements 换成 --dynamic-baseline
```

`--openclaw-profile` 读取 `openclaw.json` 中 `agents.defaults.model` 指向的 provider 和模型（可用 `--openclaw-model <provider/model>` 改选），只复制端点与该模型的定义；密钥从同目录 `agents/main/agent/openclaw-agent.sqlite` 的 `<provider>:default` 鉴权条目只读取出，只经由临时环境变量交给隔离 gateway，不写入配置或报告。对应实现在 `scripts/helpers/native-gateway-evaluation.mjs` 的 `nativeGatewayHostProfileProvider`。

工作树内的 `lib/review-task/node_modules` 是从主工作区复制的依赖（已被 `.gitignore` 忽略），仅用于运行测试。
