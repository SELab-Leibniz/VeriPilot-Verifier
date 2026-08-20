# 配置与规则参考

本页保留版本 1 的 artifact、node/edge 与规则配置参考。任务 Ground Truth、Skill 看护、M01–M15 和 Stop 纠偏属于显式启用的 `version: 2` 能力，完整字段与默认值见 [Runtime Corrector v2 design](runtime-corrector-v2-design.md)。

`patterns` 与 `pathTemplates` 可以直接声明源码产物。读取层将 `.ets`、`.ts`、`.tsx`、
`.js` 等源码以及 `.json5` 视为 UTF-8 `text`，所以 HarmonyOS ArkTS 的 Write/Edit 能与
文档产物走同一条 PostToolUse 纠偏链。构建、测试和设备结果仍须由独立证据提供。

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

`/runtime-corrector:init` 生成的是结构完整但默认关闭的通用模板。四阶段可运行目录、JSON
Schema 与作者规范位于
[`examples/ir-planning-selection-prd-contract/`](../examples/ir-planning-selection-prd-contract/README.md)。

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
  semanticReviewTimeoutMs: 240000
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
| `pathTemplates` | 条件必须 | — | 可提取占位符的路径模板列表；与 `patterns` 二选一 |
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
- `enabled: true` 且配置的 `criteria` 文件为空：明确报错；使用 `enabled: false` 关闭。

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

占位符名称以字母开头，只能包含字母、数字、下划线和连字符。模板不允许使用 `*`、`?`，
也不允许重复或未闭合占位符。占位符匹配一个非空路径段。

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

完整的 `app-design` / `**/design.md` 配置、逐字段解释和可操作运行演示见根目录 [交互式自定义 Stage 教程](../tutorial.html)。同一教程还包含精简 `mini-planning` 示例，展示如何用一个自定义 Stage 收集 `PilotPlan.md` 与 `relations.json`，组合 JSON Schema、图关系规则和公开 reviewer。

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
| `semanticReviewTimeoutMs` | 单次隔离语义审阅实际超时，范围 `1000`～`1200000` 毫秒 | 240000 |

例如允许隔离 reviewer 最多运行 20 分钟：

```yaml
limits:
  semanticReviewTimeoutMs: 1200000
```

Runtime Corrector 自己的 PostToolUse Hook 使用固定的 `1260` 秒外层安全上限，为最长 20 分钟
审阅预留请求准备和结果落盘时间。该值只属于本插件的 Hook 命令，不会修改其他插件或用户
配置的 PostToolUse Hook。未命中 artifact、stage 已关闭或语义审阅未启用时，插件仍会快速返回，
不会等待配置的完整时长。

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
    "semanticReviewTimeoutMs": 240000
  }
}
```

将 `$schema` 中的 `<runtime-corrector>` 替换为本机插件目录；它为编辑器提供字段校验，
运行时仍会经过同一个策略编译器做语义约束。

自定义扩展契约见 [外部接口参考](interfaces.md#自定义-matcher)。
