# Runtime Corrector MVP Proposal

> 状态：MVP 已实现<br>
> 面向场景：客户已有自己的 multi-agent SDD 工作流，希望在部分阶段加入运行时纠偏<br>
> 设计目标：机理可解释、规则易修改、接入成本低、生成纠偏产物但不自动应用

## 1. 一句话说明

Agent 写完阶段产物后，Runtime Corrector 读取产物，执行明确规则并按需运行隔离 Agent 审阅，生成诊断结果和候选 Git Patch；这些纠偏产物会交给主 Agent，但插件不自动修改目标产物，也不替主 Agent 决定后续处理。

```text
Agent 写产物
    -> 确定性规则检查
    -> 按需运行一次性隔离 Agent 审阅
    -> 生成诊断文件和候选 Git Patch
    -> 把内容与文件路径交给主 Agent
    -> 主 Agent 决定修正、忽略、转人工或终止
```

用户只需要理解三类策略文件；JSON 产物额外使用标准 Schema 作为可执行字段契约：

```text
.runtime-corrector/
├── config.yaml       # 检查哪些阶段产物
├── rules.yaml        # 可以确定判断的规则
├── reviewer.md       # 需要理解语义的 Agent 审阅标准
└── schemas/*.schema.json # JSON 字段、必填项、枚举和嵌套结构

.runtime-correction/
├── latest/<stage>/<artifact>/               # 最新一轮滚动结果
│   ├── diagnostic.md
│   ├── spec.md
│   └── patch.diff
└── runs/<stage>/<artifact>/<run-id>/        # 不可变的历史 Run
    ├── diagnostic.md
    ├── spec.md
    └── patch.diff
```

## 2. 背景与问题

客户的 SDD 流程由多个 Agent 分阶段协作，例如：

- 需求澄清；
- IR 或需求文档生成；
- 需求拆解；
- 任务规划；
- 代码实现；
- 测试与验证。

每个阶段的文档都会成为后续 Agent 的输入。Agent 输出具有概率性，常见偏差包括：

- 必需内容缺失；
- 保留 TODO、TBD 等未完成内容；
- 验收标准不可执行；
- 文档内部存在矛盾；
- 新增了原始需求没有要求的范围；
- 多份关联文档之间不一致；
- 偏差继续传播到下游阶段。

客户希望在选定阶段加入纠偏，但不希望引入复杂平台、常驻服务或难以解释的模型决策。

## 3. MVP 目标

MVP 提供以下能力：

1. 写文件后通过 Claude Code `PostToolUse` Hook 自动检查；
2. 通过 CLI 主动检查，供客户自己的 SDD 编排器调用；
3. 使用项目内 `config.yaml` 声明阶段产物；
4. 使用项目内 `rules.yaml` 声明确定性规则；
5. 使用项目内 `reviewer.md` 声明 Agent 语义审阅标准；
6. PostToolUse 按需创建一次性隔离 reviewer，并在同一次反馈中返回硬规则诊断、语义诊断和候选 Git Patch；
7. 主 Agent 可以一次性看到结构偏差和语义偏差，减少重复纠偏轮次；
8. 生成包含问题级别、规则 ID、位置、证据和修改建议的诊断文件；
9. 能安全表达修改时生成带上下文的 Git Unified Patch，并记录源文件 SHA-256 基线；
10. 将诊断、Patch 内容和产物路径返回主 Agent；
11. 不修改原文、不自动应用 Patch、不替主 Agent 决定是否阻断；
12. 每次检查重新读取配置，用户修改后立即生效。

## 4. 非目标

MVP 不负责：

- 启动独立的模型服务或管理模型密钥；
- 连接独立第三方模型服务或在项目策略中管理模型密钥；
- 自动接受 Agent 或规则的判断作为最终处置结论；
- 自动修改或覆盖客户产物；
- 提供可视化规则管理后台；
- 监听整个文件系统或运行常驻进程；
- 替代客户已有的 SDD 编排器；
- 自动执行无限纠偏循环；
- 完整解析所有 YAML 语言特性。

Agent 审阅复用当前 Claude Code 会话：PostToolUse 从可恢复的父 session 创建一次性只读
fork，执行节点和直接入边 reviewer，再通过 `additionalContext` 返回合并结果。CLI 没有父
session，只在结构化结果中返回 `agentReview.status = requested`。无论哪种入口，诊断和
候选 Git Patch 都只作为主 Agent 的决策输入。

## 5. 用户可见的运作机理

### 5.1 第一步：识别产物

插件读取 `.runtime-corrector/config.yaml`，根据文件路径判断当前文件属于哪个阶段。

```yaml
version: 1

artifacts:
  - name: requirements
    stage: requirements
    type: requirements
    patterns:
      - docs/requirements.md
      - docs/*.requirements.md
    rules:
      enabled: true
      file: rules.yaml
    review:
      enabled: true
      criteria: reviewer.md
```

普通用户不需要编写 matcher、collector 或 JavaScript 扩展。

### 5.2 第二步：执行确定性规则

`rules.yaml` 只描述能够稳定判断的内容。

```yaml
version: 1

rules:
  - id: REQUIRE-OVERVIEW
    type: require-heading
    heading: 目标与范围
    aliases:
      - 产品概述
      - 背景与目标
    severity: error

  - id: REQUIRE-ACCEPTANCE
    type: require-checklist
    under: 验收标准
    minimum: 1
    severity: error

  - id: FORBID-PLACEHOLDER
    type: forbid-text
    values:
      - TODO
      - TBD
      - 待补充
    severity: error
```

当前核心提供一组 stage-neutral 规则；具体 stage 只在 YAML 中组合这些规则：

| 类型 | 含义 |
|---|---|
| `require-heading` | 必须存在指定章节，允许配置别名 |
| `require-checklist` | 指定章节至少包含若干条 `- [ ]` 检查项 |
| `require-text` | 文档至少包含指定文本之一 |
| `forbid-text` | 文档不得包含指定文本 |
| `require-artifacts` | 声明 bundle 必需文件，并可在不完整时保持 `pending` |
| `json-schema` | 使用项目 Schema 校验 JSON 字段和结构 |
| `graph-invariants` | 按 YAML 字段映射校验图引用、端点类型、重复与有向环 |
| `markdown-records` | 校验重复 Markdown 记录、字段和上游 ID 覆盖 |

每条规则都可以配置：

- `id`：稳定、可检索的规则编号；
- `severity`：`error`、`warning` 或 `info`；
- `message`：面向 Agent 和用户的问题说明；
- `suggestion`：修改建议；
- `enabled: false`：临时关闭规则。

### 5.3 第三步：按需执行隔离 Agent 审阅

插件读取 `reviewer.md`。PostToolUse 在节点或直接入边的 `review.enabled: true` 时，从当前
可恢复 session 创建一次性只读 reviewer，审阅磁盘上的当前快照，并将语义 finding 与硬规则
诊断合并。即使已经存在确定性 `error`，reviewer 仍会完成现有证据足以支持的检查，避免先修
结构、下一轮才发现范围膨胀或需求偏离。

```markdown
# 需求文档 Agent 审阅标准

## 必须检查

1. 每项功能是否说明用户动作、系统响应和关键失败路径。
2. 验收标准是否能由测试人员实际执行。
3. 是否增加了原始需求没有提出的范围。
4. 不同章节之间是否存在矛盾。

## 不要检查

1. 不要求固定章节顺序。
2. 不评价文案风格是否优美。
3. 不建议本期范围外的新功能。

## 输出约束

- 每个问题必须引用当前产物中的具体证据。
- 无法确认时标记为“待人工确认”。
- 不扩张需求范围。
```

这里的边界是：Agent 按照项目标准审阅，不临时发明标准；上游只读，finding、编辑计划和
候选 Patch 都只能指向当前可编辑节点。手动 CLI `check` 不创建 session，只返回待执行的
reviewer 请求。

### 5.4 第四步：生成诊断文件和候选 Git Patch

典型反馈：

```text
[ERROR] REQUIRE-ACCEPTANCE docs/requirements.md
问题：“验收标准”中缺少可勾选的检查项。
建议：增加使用“- [ ]”格式、包含可观察结果的检查项。

历史 Round 产物：
- .runtime-correction/runs/requirements/requirements-a1b2c3d4/20260723T101112Z-12345678/diagnostic.md
- .runtime-correction/runs/requirements/requirements-a1b2c3d4/20260723T101112Z-12345678/patch.diff

Latest 指针：
- .runtime-correction/latest/requirements/requirements-a1b2c3d4/diagnostic.md
- .runtime-correction/latest/requirements/requirements-a1b2c3d4/patch.diff

隔离 reviewer：completed
请主 Agent 同时处理确定性与语义诊断，并决定是否采用候选 Git Patch。
```

诊断文件记录：

- 状态和命中的 criteria；
- 规则 ID 和严重度；
- 文件、章节和行号；
- 触发规则的证据；
- 建议处理方式；
- 是否生成了候选 Git Patch，以及生成时的源文件 SHA-256 基线。

当插件能够安全、确定地表达局部修改时，额外生成带上下文的 Git Unified Patch。Patch 使用 `a/<path>`、`b/<path>` 标头，兼容 `git apply --check` 和 `git apply`。无法安全表达时仍生成 0 字节 `patch.diff`，不编造 Patch。

主 Agent 应用前必须先运行 `git apply --check <patch-file>`。Patch 还包含 `baseHash`；如果目标文件不再匹配生成时基线，应重新诊断，不能继续使用旧 Patch。

### 5.5 第五步：移交主 Agent 决策

插件把结构化诊断、候选 Git Patch、诊断文件路径和 Patch 文件路径一起返回主 Agent。插件不会自动应用修改。主 Agent 可以决定：

- `passed`：进入下一阶段；
- `warning`：忽略、记录、修正或转人工；
- `failed`：修正、忽略、转人工或终止当前阶段；
- 存在 Patch：先校验，再应用、手工修改或拒绝。

严重度表达问题强弱，不等于插件拥有工作流控制权。

## 6. 接入方式

### 6.1 Claude Code Hook

插件继续提供现有 Hook：

```powershell
claude --plugin-dir C:\absolute\path\to\runtime-corrector
```

同一运行时也接受兼容宿主提供的 `CODEAGENT3_PLUGIN_ROOT`。`dual-host-plugin-root` 扩展只负责把 `CLAUDE_PLUGIN_ROOT` 或 `CODEAGENT3_PLUGIN_ROOT` 规范化成唯一插件根；若两者同时存在但不等价则立即报 `PLUGIN_ROOT_CONFLICT`。它不改变下述 `claude-plugin-core-hooks-json-stdio` 事件、输入、输出或判定逻辑，也不按宿主版本选择实现。固定 Node 启动器可在 Windows cmd/PowerShell、Linux 和 macOS POSIX shell 中使用，要求 Node.js >= 18。兼容宿主若使用不同清单外形，应提供薄声明映射并保留相同 Hook 语义。

Claude Code 使用 `Write` 或 `Edit` 写入匹配文件后，插件自动运行，并通过 `PostToolUse.additionalContext` 把反馈交还当前 Agent。

启用语义审阅时，父会话必须可恢复，不能以 `--no-session-persistence` 启动。一次性 reviewer
子会话使用该参数并在返回结构化结果后释放；父会话不可恢复时，本轮保留确定性诊断并明确
增加 `AGENT-SEMANTIC-REVIEW-FAILED`。

Hook 不依赖 Agent 当前 shell 的临时工作目录：它从被写入文件向上查找最近的项目策略目录。Planning 的三个产物共享稳定的 artifact key；任一成员写入都会审阅当前 bundle 快照并刷新状态，缺失成员对应的跨文件检查保持 `pending`。每次快照检查先保存不可变的 `runs/<stage>/<artifact>/<run-id>/` 产物，再刷新对应的 `latest/<stage>/<artifact>/`；两处都包含 `diagnostic.md` 与 `patch.diff`，无安全候选补丁时 patch 为 0 字节。

0.10 的产物纠偏不在 `UserPromptSubmit` 阶段注入任何插件 prompt。0.11 的可选 v2 生命周期 Hook 只计算真实回合并触发到期的 Skill 检查，不预加载整套插件工作流。Agent 写入命中产物后仍执行 PostToolUse 检查；本轮为 `failed` 且活动 transcript 缺少命令导航时，反馈补充 `/runtime-corrector:spec <stage>` 与 `/runtime-corrector:help`。

新用户加载插件后，优先在 Claude Code 中执行：

```text
/runtime-corrector:init
```

也可以直接表达“请初始化 Runtime Corrector”或“创建 `.runtime-corrector`”。插件内置的
`runtime-corrector-init` Skill 会通过固定 Node 启动器解析当前宿主的插件根并调用自带
`scripts/cli.mjs`，因此不依赖全局 PATH 或 shell 变量展开。Skill 创建并核验默认关闭的通用 `config.yaml`、`example.rules.yaml`、
`example.reviewer.md` 和说明文件；已有 `.runtime-corrector` 时停止且不覆盖。

`--plugin-dir` 只负责加载 Claude Code 插件，不负责安装终端 CLI。如果客户的外部 SDD 编排器需要直接调用命令，可在插件目录可选执行一次：

```powershell
npm link
runtime-corrector --help
```

恢复会话时仍需显式加载插件：

```powershell
claude --plugin-dir C:\absolute\path\to\runtime-corrector --resume <session-id>
```

在 Claude Code 输入框中直接输入 `runtime-corrector init` 会被视为自然语言，并可触发
`runtime-corrector-init` Skill；需要强制作为 shell 命令执行时使用
`!runtime-corrector init`。

### 6.2 客户 SDD 编排器

客户可以主动调用 CLI：

```powershell
runtime-corrector init --cwd C:\path\to\customer-project
runtime-corrector check docs/requirements.md --format json
```

仓库内调试时也可以使用：

```powershell
npm run check -- check docs/requirements.md --format json
```

退出码：

| 退出码 | 含义 |
|---|---|
| `0` | `passed` 或只有 warning |
| `1` | 存在 error，状态为 `failed` |
| `2` | 配置错误、文件未匹配或执行失败 |

JSON 结果示例：

```json
{
  "status": "passed",
  "diagnostics": [],
  "metadata": {
    "stage": "requirements",
    "artifactType": "requirements",
    "triggerFile": "docs/requirements.md",
    "ruleSetIds": ["project:rules.yaml"]
  },
  "diffs": [
    {
      "path": "docs/requirements.md",
      "format": "git-unified-diff",
      "applyMode": "git-apply",
      "baseHash": "sha256:...",
      "proposedHash": "sha256:...",
      "requiresBaseMatch": true,
      "unifiedDiff": "diff --git a/docs/requirements.md b/docs/requirements.md..."
    }
  ],
  "agentReview": {
    "status": "requested",
    "path": ".runtime-corrector/reviewer.md",
    "criteria": "# 需求文档 Agent 审阅标准..."
  },
  "outputFiles": [
    ".runtime-correction/runs/requirements/requirements-a1b2c3d4/20260723T101112Z-12345678/diagnostic.md",
    ".runtime-correction/runs/requirements/requirements-a1b2c3d4/20260723T101112Z-12345678/patch.diff",
    ".runtime-correction/latest/requirements/requirements-a1b2c3d4/diagnostic.md",
    ".runtime-correction/latest/requirements/requirements-a1b2c3d4/patch.diff"
  ],
  "roundOutputFiles": [
    ".runtime-correction/runs/requirements/requirements-a1b2c3d4/20260723T101112Z-12345678/diagnostic.md",
    ".runtime-correction/runs/requirements/requirements-a1b2c3d4/20260723T101112Z-12345678/patch.diff"
  ],
  "latestOutputFiles": [
    ".runtime-correction/latest/requirements/requirements-a1b2c3d4/diagnostic.md",
    ".runtime-correction/latest/requirements/requirements-a1b2c3d4/patch.diff"
  ]
}
```

每次匹配写入都在历史 Round 和 Latest 两组输出中成对保存 `diagnostic.md` 与 `patch.diff`；没有安全候选 Patch 时 diff 是 0 字节文件，`diffs` 为空。PostToolUse 先执行 `rules.enabled: true` 的硬规则；节点或直接入边存在 `review.enabled: true` 时，才使用当前 `session_id` 创建一次性 low-effort fork。两类 review 全部关闭时不创建 fork。依赖缺失成员的判断保持 `pending`。hook 校验计划、生成候选 Diff 并执行 `git apply --check`，然后才统一持久化本轮结果。

## 7. 规则与 Agent 的职责边界

| 检查内容 | 硬规则 | Agent 审阅 |
|---|---:|---:|
| 文件、章节是否存在 | 是 | 否 |
| Checklist 数量 | 是 | 否 |
| 禁止词和明确文本 | 是 | 否 |
| ID、格式和结构 | 是，可由 Schema、图和记录规则配置 | 否 |
| 需求是否清晰 | 否 | 是 |
| 验收条件是否真正可执行 | 部分 | 是 |
| 是否偏离原始需求 | 否 | 是 |
| 是否存在隐含矛盾 | 否 | 是 |

原则：能稳定判断的内容使用硬规则；必须理解业务语义的内容才交给 Agent。

## 8. 信任设计

为了让客户能理解并信任插件，MVP 坚持：

1. 用户标准都保存在自己的仓库中；
2. 修改文件后，下一次检查立即使用新标准；
3. 每条硬规则有稳定 ID；
4. 诊断说明来源、位置、原因和建议；
5. 硬规则结果可重复；
6. Agent 审阅与硬规则明确区分；
7. Agent 标准使用自然语言 Markdown；
8. 硬规则诊断和隔离 Agent 审阅结果一次性合并，减少重复轮次；
9. 诊断和 Diff 都有独立、可审计的文件；
10. 诊断和 Diff 同时返回主 Agent；
11. 插件不改原文、不应用 Diff、不替主 Agent 决策；
12. 不另建后台服务或数据库；语义审阅复用当前 Claude Code 的模型连接。

## 9. 配置优先级和兼容性

如果项目存在 `.runtime-corrector/config.yaml`，插件优先读取项目 YAML。

如果不存在，插件继续兼容原有：

- `.runtime-corrector.json`；
- 插件内 `config/runtime.yaml`；
- `knowledge/ir/*.json`；
- 自定义 matcher 和 collector。

高级接口继续保留，但不作为普通客户的首要使用方式。

项目 YAML 先按 `config/schemas/project-config.schema.json` 校验结构。无论来源是项目 YAML、
旧 JSON、程序化配置还是插件默认值，配置都只经过一个策略编译器，生成同一种扁平
RuntimePlan。matcher、Workflow DAG、correlation、Stage 选择和 rules/review 策略不会在加载
层与运行层重复解释；旧 `simpleMode` 仅作为兼容视图保留在边界。

## 10. YAML 边界

为了保持零第三方依赖，MVP 内置一个严格、有限的 YAML 读取器，支持本提案示例需要的：

- 两空格缩进的对象；
- `-` 列表；
- 字符串、数字、布尔值和 `null`；
- 简单的行内数组；
- `#` 开头的独立注释行。

不支持 YAML anchor、tag、多行标量和复杂行内对象。遇到不支持的格式时直接返回文件名和行号，不进行猜测性解析。

## 11. MVP 验收标准

- [x] 保留现有 Claude Code Hook；
- [x] 提供宿主无关的 `checkArtifact` 核心入口；
- [x] 提供 `runtime-corrector check` CLI；
- [x] 支持 `.runtime-corrector/config.yaml`；
- [x] 支持项目级 `rules.yaml`；
- [x] 支持 `reviewer.md`；
- [x] PostToolUse 在同一次反馈中返回硬规则诊断和已完成的隔离 Agent 审阅结果；
- [x] 支持生成独立诊断文件；
- [x] 能安全表达修改时生成可通过 `git apply --check` 的独立 Git Unified Patch；
- [x] Patch 包含源文件和候选文件的 SHA-256 哈希；
- [x] 自动化测试实际执行 `git apply`，覆盖末尾换行、无末尾换行、空文件和带空格路径；
- [x] 将纠偏内容和输出文件路径返回主 Agent；
- [x] 保持不自动修改原文；
- [x] 保持不自动应用 Patch；
- [x] 保持原有配置和知识规则兼容；
- [x] 提供可运行示例和自动化测试；
- [x] 项目 YAML 使用 JSON Schema 做结构校验；
- [x] JSON 产物支持项目自有 Schema；
- [x] 多 change Workflow 可通过 `pathTemplates + correlation` 隔离实例；
- [x] 所有配置来源只经过一个策略编译器并生成统一 RuntimePlan。

## 12. 后续演进

MVP 验证通过后，再考虑：

1. ~~`runtime-corrector validate` 单独校验规则~~（0.10.0 已实现：同时校验配置、规则、Reviewer、Schema、Workflow 图、匹配器和 Ground Truth 绑定）；
2. 规则正反例测试文件；
3. 阶段结束检查，用于发现从未触发写入的整个产物缺失；0.10.0 已提供可由 Write/Edit 触发的 checkpoint Artifact 示例，主动全节点扫描命令仍待实现；
4. Agent 置信度和人工确认策略；
5. JSON Schema 编辑器补全和可视化规则编辑器；
6. 继续保持业务 Stage 位于独立 example，核心 `init` 模板只提供通用配置字段和安全默认值。

这些能力不进入当前 MVP，以保持运行机理简单、透明。
