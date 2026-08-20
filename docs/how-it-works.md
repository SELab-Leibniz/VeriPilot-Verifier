# 完整运作机理

Runtime Corrector 是“写入后的反馈回路”，不是独立生成器。它检查 Claude 已经写入的阶段产物，将偏差、候选修复和已完成的语义审阅结果返回给当前 Claude 会话，由主 Agent 决定是否以及如何修正。

## 运行链路

```text
用户提出生成或控制请求
  → Claude 自主按需调用公开命令
  → Claude Write/Edit 阶段产物
  → PostToolUse 接收写入事件
  → 发现项目策略根目录
  → 匹配启用阶段和 artifact
  → 收集同阶段及上游文件
  → 执行 rules.enabled: true 的确定性规则和 JSON Schema
  → 汇总 review.enabled: true 的节点与直接入边
  → 需要语义审查时同步 fork 当前 session 审阅现有快照
  → 校验语义编辑计划并统一生成候选 Patch
  → 合并确定性与语义诊断
  → 持久化诊断和候选 Patch；失败时同时保存规范包
  → fork 退出后通过 additionalContext 返回诊断与实际 Diff
  → 主 Agent 决定最小修正并再次写入
```

手动 `/runtime-corrector:check` 和终端 `runtime-corrector check` 复用匹配、收集、确定性诊断、Patch 与持久化链路，但没有 PostToolUse 的 `session_id`，因此不会创建 X1。手动结果在节点或入边 `review.enabled: true` 时返回 `agentReview.status = requested`，由调用方决定如何完成该审阅；只有 PostToolUse 自动检查会返回 `completed` 或 `failed` 的隔离语义审阅状态。

## 1. 用户 Prompt 阶段只做轻量生命周期处理

版本 1 不启用任何 prompt 级纠偏。版本 2 注册 `UserPromptSubmit` Hook，只用于识别真实用户回合、更新任务游标，并在 Skill 看护恰好到期时运行检查；它不会因为用户提到产物名、帮助或控制意图就预加载插件工作流。Claude 仍可通过 Skill 或以下常用公开命令渐进式获取信息：

- `/runtime-corrector:spec <stage>`：读取该 stage 的完整规范、当前 rules、Schema 与 reviewer；
- `/runtime-corrector:help`：查看项目感知的帮助和其他公开命令。

只有 PostToolUse 检查得到 `failed` 时，反馈才会报告本轮违规。Hook 同时读取 Claude Code 提供的 `transcript_path`：若最后一次 `compact_boundary` 之后的活动上下文还没有 Runtime Corrector 命令导航，则补充一次上述两个命令；已经存在时不重复注入。这样既不干扰正常 user prompt，也能在上下文压缩丢失导航后恢复。

## 2. 写入后触发

Claude Code 的 `PostToolUse` Hook 只监听 `Write` 和 `Edit`。以下情况不会运行产物诊断：

- 只是读取文件；
- 文件路径没有命中 artifact pattern；
- stage 已关闭；
- 文件位于忽略路径；
- 工具事件没有文件路径。

Hook 只把反馈写入 `additionalContext`，不阻止 Claude Code 写文件。

## 3. 项目根目录发现

插件从被写入文件所在目录向上查找 `.runtime-corrector/config.yaml`。因此 Claude 临时改变工作目录时，仍可按产物所在项目找到正确策略。

未找到简单模式配置时，依次尝试：

1. 项目根目录 `.runtime-corrector.json`；
2. 插件内置的空 artifact 默认配置。

程序化调用显式传入的 `config` 优先级最高。

无论配置来自项目 YAML、旧 JSON、程序化参数还是插件默认值，都会先编译成同一个
扁平 RuntimePlan。运行层只读取启用的 `artifacts`、完整的
`configuredArtifacts`、`reviewGraph`、Stage 开关和配置来源，不再判断配置模式。
旧 `simpleMode` 结构仅保留在加载边界作为兼容视图，不参与检查、规范输出或 CLI
解释逻辑。

配置边界固定分为三步：

```text
读取 YAML / JSON 或程序化输入
  → YAML 受控解析并按 project-config.schema.json 做结构校验
  → 唯一策略编译器生成 RuntimePlan
```

artifact matcher、`pathTemplates`、Workflow DAG、correlation、Stage 选择以及 rules/review
策略都只在这个编译器中解释一次。项目策略加载层不预编译 matcher 或图，运行层也不回读
原始配置。这样同一个声明不会因两套默认值或校验顺序而产生不同结果。

## 4. 阶段与文件匹配

简单模式先读取 `enabledStages`，过滤未启用 stage，再按 `artifacts[].patterns` 或编译后的
`artifacts[].pathTemplates` 匹配相对项目根目录的文件路径。artifact 按声明顺序归属，
重叠匹配继续遵守 first-match-wins。

- 缺少 `enabledStages`：兼容旧项目，所有已安装 stage 视为开启。
- `enabledStages: []`：所有 stage 关闭。
- 关闭 stage 只停止匹配，不删除规则或 reviewer。

核心没有默认业务阶段关系。以下关系仅来自
[`examples/ir-planning-selection-prd-contract/`](../examples/ir-planning-selection-prd-contract/README.md)：

| Stage | 触发产物 | 检查上下文 |
|---|---|---|
| `ir` | `ir.md` | 当前 IR |
| `planning` | Planning 三件套任一文件 | IR + Planning 三件套 |
| `selection` | `kit-map.md` | IR + Planning + Kit Map |
| `prd-contract` | `PRD.md` | IR + Planning + Kit Map + PRD |

## 5. Bundle 收集

`relatedPatterns` 声明关联文件。`relatedRoot` 决定扫描范围：

- `artifact-directory`：触发文件所在目录；
- `project`：整个项目根目录。

触发文件始终包含在检查输入中。没有通配符的模式按精确路径直接读取，避免大型
项目先耗尽扫描预算后漏掉协议文件；包含 `*` 或 `?` 的模式从静态目录前缀开始
有界扫描。最终数量仍受 `limits.maxRelatedFiles` 限制，扫描自动跳过 `.git`、
`node_modules` 和 `.runtime-correction`。

示例中的 Planning、Selection、PRD 使用 `require-artifacts` 判断 bundle 是否齐备。缺文件时：

- 状态为 `pending`；
- 已存在文件仍执行本地结构或 Schema 检查；
- hook 仍从当前 session fork X1，对已有文件执行可判定的语义审阅；
- 依赖缺失成员的规则保持 `pending`；
- 当前快照同时持久化 `diagnostic.md`、机器可读 `result.json` 与 `patch.diff`。

## 5.1 Workflow 直接入边

项目可以通过 `workflow.edges` 显式声明 Artifact 节点之间的一致性关系。当前节点写入后只查询 `review.enabled: true` 的直接入边，按 YAML 顺序追加前序文件，并与已启用的节点 review 合并为一次隔离审阅；不会遍历传递祖先、检查出边或级联触发下游。

## 5.2 Workflow 实例关联

配置 `workflow.correlation.keys` 后，实例完全由本次 Write/Edit 触发路径的模板 capture 派生。
插件不扫描时间戳来推断最新文件，也不保存 active key。workflow source 必须与目标的全部 key
相同；artifact-owned 的其他实例从 related bundle、`metadata.artifactFiles` 和 semantic
request 中排除。非 artifact 的源码与 workflow prompt 仍作为全局只读证据。同一 key 跨日期
仍是同一实例；磁盘上只有其他 key 的上游时，当前直接入边保持 `pending`。

语义审阅的读取集合可以包含上游文件，但可编辑集合只包含当前节点文件。Finding 的修正路径、语义编辑和最终 Patch 都经过同一白名单校验，不能反向修改上游事实源。完全缺少某条边的 source 文件时，确定性阶段增加 pending 诊断，Agent 只审阅现有证据。

## 6. 确定性检查

每个 artifact 通过 `rules.enabled` 明确开关确定性检查。开启时由 `rules.file`
引用一个项目内 `*.rules.yaml`；关闭时不加载规则文件。规则按文件中的顺序加载，
主要分为：

- Markdown 结构和文本规则；
- Bundle 完整性规则；
- 项目内 JSON Schema；
- YAML 配置的图不变量；
- YAML 配置的重复 Markdown 记录。

Planning、Selection、PRD 等具体业务语义不由核心规则类型识别。JSON 字段格式交给
Schema，图和 Markdown 记录约束交给通用规则；跨文件忠实性、映射与验收语义交给
项目自己的 reviewer。

规则输出包含稳定的 `ruleId`、严重级别、文件位置、消息、证据和建议。无法识别的规则类型、重复 ID、非法字段或不支持的 Schema 关键字会明确报错，不会静默跳过。

## 7. 状态计算

状态按以下优先级计算：

```text
存在 error   → failed
否则有 pending → pending
否则有 warning → warning
否则          → passed
```

`info` 诊断不会单独改变 `passed` 状态。

机器结果同时生成逐项 classification：`PASSED`、`DEVIATION`、`UNVERIFIED`、`GROUND_TRUTH_UNRESOLVED`、`EXTERNAL_UNAVAILABLE` 或 `CHECKER_FAILURE`。兼容 `status` 继续服务现有 Hook/CLI；逐项 classification 用于把目标偏离、证据不足、依据未决、外部条件和检查器自身故障分开表达。

每轮还保存输入文件清单与 SHA-256 `inputDigest`，以及配置、规则、Reviewer、Schema 和运行时基线的 `policyDigest`。同一 Finding 使用规则、路径、消息和策略摘要生成稳定 fingerprint。

CLI `check` 对 `failed` 返回退出码 `1`；`passed`、`warning` 和 `pending` 返回 `0`；参数、配置或匹配错误返回 `2`。

## 8. Agent 语义审阅

`*.reviewer.md` 是项目自有的自然语言附加标准，不再承担开关职责。节点使用
`review.enabled` 控制语义审查，边使用 `workflow.edges[].review.enabled` 控制一致性
审查。任一节点或入边 review 开启时，匹配写入才会从当前 session fork 一次性 X1；
两者全部关闭时不会创建 X1。

- `review.enabled: false`：关闭对应节点或边的语义审查；
- `review.enabled: true` 且未配置 `criteria`：只执行插件通用基线；
- 配置了 `criteria`：在通用基线上增加项目标准；
- criteria 文件不存在或为空：策略加载明确报错；
- Bundle 完整：X1 执行完整的文件内及跨文件审阅；
- Bundle 不完整：X1 审阅现有成员，依赖缺失成员的判断保持 `pending`；
- X1 返回后：`agentReview.status = completed`。

父 session 必须可恢复。主 Claude Code 若以 `--no-session-persistence` 启动，Hook 虽然仍能
完成确定性检查，但无法按 session ID 创建 X1；本轮会明确增加
`AGENT-SEMANTIC-REVIEW-FAILED` 并保持失败，不会降级成“语义审阅通过”。X1 自身仍使用
`--no-session-persistence`，返回结构化结果后立即释放。

X1 的实际等待时间由 `limits.semanticReviewTimeoutMs` 控制，默认 240000 毫秒，可配置范围为
1000～1200000 毫秒。Runtime Corrector 自己的 PostToolUse Hook 外层上限固定为 1260 秒，
只为最长 20 分钟审阅预留收尾时间，不影响其他 Hook；未命中产物时仍立即返回。

手动 `check` 不执行上述 fork；只要节点或入边 review 开启，就返回
`agentReview.status = requested`。关闭只能使用显式 `enabled: false`，不再通过
`null`、空字符串或空文件推断。

Reviewer 应明确上游事实源、范围扩张判定、必须引用的证据和完成条件。X1 必须引用现有产物中的具体证据，不能把 reviewer 文本当作检查结果。

## 9. 候选 Patch

插件为确定性规则和 X1 返回的证据充分、无需新产品决策的编辑计划生成 Git Unified Patch。每个 Patch 包含：

- `baseHash`：生成时目标内容的 SHA-256；
- `proposedHash`：候选内容的 SHA-256；
- `requiresBaseMatch: true`；
- `unifiedDiff`。

Patch 不会自动应用。使用前必须确认文件仍匹配基线，并执行：

```powershell
git apply --check <patch-file>
```

确定性规则与 X1 不再各自拼接 Patch。两类修正统一进入同一个补丁管线：基于原文和候选全文生成标准 Unified Diff，规范化单个 Patch，按固定分隔符合并多文件 Patch，再把当前目标文件复制到隔离校验目录，对完整集合执行一次最终 `git apply --check`，通过后才允许持久化。隔离目录以 Corrector 发现的项目策略根为基准，因此即使该项目嵌套在另一个 Git worktree 或被父仓库忽略，Patch 也不会被 Git 静默跳过。该管线保留 LF、CRLF、无末尾换行和尾部空白上下文行的语义。最终校验失败时会清空候选集合、记录 `RUNTIME-PATCH-VALIDATION-FAILED`，并写出 0 字节 `patch.diff`，避免损坏补丁被误认为可用结果。

每次反馈明确显示 `候选 Git Patch：N`。语义值缺失、候选内容无法唯一推导或修改可能改变用户意图时，`N = 0`，反馈会解释“插件不会编造内容”。

## 10. 完整 Stage 规范地图

每个 stage 都有一份插件全局格式规范。`spec` 在运行时把它与当前项目实际生效的内容合并：

1. 插件全局精确格式与修改边界；
2. 当前 config、开关和 artifact patterns；
3. 当前 `*.rules.yaml` 原文；
4. 规则引用的全部 JSON Schema 原文；
5. 当前 `*.reviewer.md` 原文；
6. 恢复命令与再次检查规则。

因此规范不是隐藏在测试或解析器中的知识。stage 即使已关闭，仍可用 `/runtime-corrector:spec <stage>` 查看其地图。

当检查为 `failed` 时，Hook 反馈只返回当前违规、候选 Patch 和必要的处理状态，不再展开整份规范地图或 reviewer 正文。完整地图仍写入对应 Run 与 Latest 目录的 `spec.md`，也可以由 Claude 在确实需要精确格式时运行 `/runtime-corrector:spec <stage>` 获取。为避免当前违规本身被截断，`failed` 反馈不应用 `maxFeedbackChars`；其他状态仍遵守该限制。

## 11. 诊断持久化

`output.persist` 决定是否写入磁盘：

- `centralized`：集中写入 `.runtime-correction/` 或自定义目录；
- `adjacent`：写在触发产物旁边。

输出分为不可变的 `runs/<stage>/<artifact-key>/<run-id>/` 和滚动的
`latest/<stage>/<artifact-key>/`。每次匹配写入都会对当前快照成对保存
`diagnostic.md` 与 `patch.diff` 并刷新 Latest；失败时同时保存 `spec.md`。没有安全候选
补丁时 `patch.diff` 是 0 字节空文件。配置了固定 `outputKey` 的多文件 bundle 共享同一
artifact key；其他集中式输出带触发路径短哈希，避免同名文件碰撞。

存在已启用节点或入边 review 时，PostToolUse 检查才使用 hook 输入中的
`session_id` 执行 `--resume <X> --fork-session`，在一次性 low-effort session X1
中调用内部 `/runtime-corrector:semantic-review`。X1 只读当前已有产物、规则与
criteria，并以受约束 JSON 返回语义诊断和多目标行级编辑计划。两类 review 全部
关闭时跳过 X1，直接持久化确定性结果。bundle 不完整时，X1 仍检查已有成员，只暂缓
必须依赖缺失成员的判断。hook 核对目标范围与原文，生成候选 diff 并执行
`git apply --check`，然后才统一持久化诊断与 diff。

插件忽略自己的 `.runtime-correction/` 诊断目录，避免递归触发。

## 信任边界

插件会：

- 读取命中的项目产物和项目自有策略；
- 生成确定性诊断、语义审阅上下文和可选 Patch；
- 为失败检查提供完整、当前生效的 Stage 地图；
- 将结果反馈给主 Agent。

插件不会：

- 自动修改目标产物；
- 自动应用 Patch；
- 删除关闭 stage 的 criteria；
- 用隐藏实现替代项目内规则；
- 要求 Agent 读取测试或实现源码猜测格式；
- 把 `pending` 当成最终失败。
