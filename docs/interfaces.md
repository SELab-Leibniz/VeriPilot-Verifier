# 外部接口参考

Runtime Corrector 提供插件命令、Skill/自然语言、CLI，以及宿主对应的自动 Hook 入口。Claude Code / CodeAgent 使用 JSON-stdio Hook；OpenClaw / MatrixAssistant 使用原生插件注册、Gateway 方法和工具结果中间件。高级兼容模式还支持自定义 Matcher 和 Collector。

## OpenClaw / MatrixAssistant 原生入口

安装产物中的 `openclaw.plugin.json` 将 `main` 指向 `lib/openclaw/entry.mjs`。插件加载时注册原生接口；OpenClaw 不通过下文的 Claude/CodeAgent JSON-stdio Hook 启动这些能力。支持版本和安装方式见[宿主指南](openclaw.md)。

- **宿主初始化**：管理员命令 `/rc-setup`，不接受参数。补齐 RC 的 Hook 权限、默认 Reviewer 模型和 Hook 超时，识别主 Agent 并追加 `runtime_corrector` 工具授权，保留其他配置。通过宿主配置写入接口保存并请求自动重载；不创建项目配置或改变 Session 开关。行为和前提见[宿主初始化](openclaw.md#在-session-中初始化宿主设置)。

- **项目初始化与开关**：用户命令 `/rc-project init|on|off|status`。`init` 复制默认模板并填入当前 RC 模型，两个默认开关为 `false`，已有目录不覆盖；`on/off` 只改项目根级 `enabled`，并检查该项目全部活动会话的实际状态。项目目录沿用宿主 Session 解析，不能通过这些命令指定其他路径。
- **会话默认开关**：用户命令 `/rc-session-default on|off|status`，修改当前项目 `sessionDefaults.enabled`，不覆盖已登记会话。状态包含 `sessionDefaultEnabled`；修改需要可信用户及宿主写入权限，查询需要读取权限。这两个新增入口均为用户命令，没有新增模型工具或 Gateway 写入 RPC，见[命令说明](session-control.md#在-session-中初始化和开关)。

- **会话开关**：Gateway RPC `runtime-corrector.session.get/set`，以及可信用户命令 `/rc-session status|on|off`。输入为准确的 `sessionKey`、`sessionId`，设置时增加布尔值 `enabled`；输出包含项目、会话选择、实际状态、阻断原因和记录位置。完整输入输出、认证要求、代码位置与调用示例见[开关契约](session-control.md#宿主-gateway--ui-对接)。项目总开关在项目配置中修改，没有独立的项目开关 RPC。
- **项目查询**：用户命令 `/rc-project status`，或工具 `runtime_corrector` 的 `{"command":"project"}`。前者返回文本中的 JSON，后者返回工具的 `content[].text` 中的 JSON，包含项目来源、准入状态和原因。手动项目绑定仅在旧版缺少宿主项目目录时由可信用户命令提供，见[项目解析契约](session-projects.md)。
- **手动工具**：宿主注册名为 `runtime_corrector` 的工具，参数为 `command`、可选 `subject`、`enabled`、`format`。支持 `project`、`help`、`init`、`validate`、`stages`、`stage`、`check`、`explain`、`spec`。`check/explain/spec/stage` 必须提供 `subject`，`stage` 还需明确布尔值 `enabled`；`format` 可为 `text` 或 `json`。`init` 可在已可靠解析、配置尚未建立的项目运行；`help/project` 不要求 RC 已开启；其余命令要求当前作用域已启用。宿主工具上下文若没有工作目录或处于 sandbox，该工具不提供。

例如手动检查已配置产物时，输入为：

```json
{"command":"check","subject":"docs/requirements.md","format":"json"}
```

返回形式为 `{content: [{type: "text", text: "…"}], isError?: boolean}`；JSON 检查结果在 `text` 内，包含 `status`、`diagnostics`、`agentReview` 等字段，错误时可能只有错误文本。宿主原生 `check` 调用 `runtime.manualCheck`，可运行项目已启用的原生语义审阅；下文独立 CLI 的 `check` 则只返回待执行的语义工作。它不保证整个任务验收通过，也没有 Session 开关写入命令。

自动纠偏由 `entry.mjs` 注册的 `session_start`、`before_prompt_build`、`before_tool_call` 等生命周期回调、工具结果中间件和终止检查协调。宿主传递可信当前会话、项目及工具事件，RC 按有效配置运行并向主 Agent 返回反馈。私有 Reviewer 工具不是宿主 UI 的控制接口；开关也不绕过宿主业务工具权限。

查找可调用接口时以 `entry.mjs` 实际注册的内容为准。仓库虽保留 `control-entry.mjs` 中的 `runtime-corrector.status/feedback/control/receipt` 和独立 HTTP 页面代码，当前生产入口没有调用该模块的注册函数，不能因为源码文件存在就认为这些方法或页面已在宿主开放。

## Claude Code / CodeAgent 插件能力基线

插件兼容性由版本无关的 `claude-plugin-core-hooks-json-stdio` 能力契约定义，而不是由 Claude Code、Claude 插件或任何包的运行时版本定义。运行时不检测版本，也不按版本选择配置、命令或 Hook 处理路径。

该基线要求：Hook 从 stdin 接收一个 JSON 对象（可带 UTF-8 BOM），stdout 只会为空或输出一个以换行结束的 JSON 对象；使用 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`、`PreCompact` 和 `SessionEnd`；工具事件使用 `tool_use_id`，不要求 `hook_event_id`。`PowerShell` 与 `Monitor` 是可选工具：若宿主没有它们，插件的安装、其他 Hook 和其余工具处理仍保持正确。

构建期 host adapter 生成互斥安装产物：Claude 在 `.claude-plugin/` 中生成 `plugin.json` 与 `marketplace.json`，只读取 `CLAUDE_PLUGIN_ROOT`；CodeAgent 在 `.cac-plugin/` 中生成这两个文件，只读取 `CODEAGENT3_PLUGIN_ROOT`。当前宿主根会先规范化为 realpath；Windows Git Bash 的 `/d/...` 会先转换成原生盘符路径。只有错误宿主变量时返回 `PLUGIN_HOST_MISMATCH`；当前宿主变量存在时，另一宿主变量不参与冲突判断。Hook 从环境读取根路径；command/Skill 内容把宿主插件根占位符作为独立启动参数，环境变量只作为回退。固定 Node 启动器支持 Windows cmd/PowerShell、Linux 与 macOS POSIX shell，最低运行时为 **Node.js >= 18**。

CodeAgent 必须提供相同七事件、同步命令执行、JSON stdin/stdout 和超时语义。运行时代码不检测产品版本或 executable 名称；协议由已安装产物固定。

## 插件命令

所有入口都在当前宿主工作目录执行。`help`、`init`、`validate`、`stages`、`explain`、`spec` 和 `check` 通过同一固定 Node 启动器解析活动插件根，再调用插件自带 `scripts/cli.mjs`，不依赖系统 PATH。生成的 command 把 `${CLAUDE_PLUGIN_ROOT}` 或 `${CODEAGENT3_PLUGIN_ROOT}` 作为带引号的独立参数，不把路径拼入 JavaScript 源码；即使工具子进程未导出根变量，也可由宿主内联替换后的参数启动。PostToolUse hook 内部使用一次性 `semantic-review` 技能，主 Agent 无需调用它。

| 命令 | 参数 | 是否写配置 | 作用 |
|---|---|---:|---|
| `/runtime-corrector:help` | 无 | 否 | 显示项目是否初始化、常用命令、控制模型和阶段状态 |
| `/runtime-corrector:init` | 无 | 是 | 创建默认关闭、带中文注释的通用 `.runtime-corrector/`；已有目录时停止 |
| `/runtime-corrector:validate` | 无 | 否 | 校验配置、规则、Reviewer、Schema、Workflow 图和 Ground Truth 绑定 |
| `/runtime-corrector:stages` | 无 | 否 | 显示已安装 stage、开关、rules 和 reviewer |
| `/runtime-corrector:stages <stage> <on|off>` | stage + 状态 | 是 | 只修改 `enabledStages` |
| `/runtime-corrector:explain <stage>` | stage | 否 | 显示实际 config、patterns、rules、Schema、reviewer 和检查顺序 |
| `/runtime-corrector:spec <stage>` | stage | 否 | 展开全局精确格式、当前 rules、全部 Schema、reviewer 和恢复规则 |
| `/runtime-corrector:check <artifact>` | 项目内文件路径 | 可能写诊断 | 手动执行确定性检查并返回待执行 reviewer；不创建隔离 session |

`init` 不接收 Stage 参数，也不安装内置业务 Stage。`stages`、`stage`、`explain` 和 `spec`
接受项目 `artifacts[]` 中注册的任意合法 Stage，例如 `app-design`。最小配置步骤见 [快速开始](tutorial.md)。

这些入口共享同一个配置边界：项目 YAML、旧 JSON、程序化配置和插件默认值先归一为
RuntimePlan，再由 CLI、Hook、`explain` 和 `spec` 使用。内部模块导出不是公共配置接口，
调用方不应绕过 RuntimePlan 直接依赖未编译的项目策略对象。

## Skills 与自然语言

### `runtime-corrector-init`

触发意图：初始化、安装项目规则、创建 `.runtime-corrector`、报告规则目录缺失。

行为：

1. 确认目标项目；
2. 已存在策略目录则停止；
3. 调用插件 CLI `init`；
4. 核验通用配置、示例规则、示例 reviewer 和项目说明；
5. 明确模板的 `enabledStages` 为空，要求先配置真实 artifact 再启用；
6. 报告下一步入口。

### `runtime-corrector-control`

触发意图：帮助、查看状态、开启/关闭阶段、只开启某些阶段、定位或修改 rules/reviewer，以及获取完整规范或死锁恢复地图。

行为：

1. 通过 `stages --format json` 读取权威状态，或通过 `spec <stage>` 读取完整地图；
2. 把自然语言映射为规范 stage；
3. 只执行用户要求的开关或 criteria 修改；
4. 重新读取完整状态并报告；
5. 不编辑生成产物。

示例：

```text
只开启 Selection 和 PRD Contract 纠偏。
关闭 Planning，其他阶段不动。
把 PRD reviewer 的范围扩张判定改严格一些。
```

版本 2 注册 `UserPromptSubmit`、`PreToolUse(Skill)`、全工具 `PostToolUse` 与 `Stop` 等生命周期 Hook。全工具 `PostToolUse` 使用较早版本 Claude Code 已支持的事件完成真实回合对账和到期 Skill 检查；仅当 `Write/Edit` 命中产物时，才继续执行版本 1 的产物写后链路。`UserPromptSubmit` 不预加载插件说明，只计算真实回合并触发到期的 Skill 检查。完整 v2 事件、状态和配置契约见 [工作原理](how-it-works.md)。

### `runtime-corrector-workflow`

在使用 `pathTemplates + workflow.correlation` 的项目中，于首次写入前列出现有实例，并帮助用户
明确选择“继续已有 / 创建新的 / 仅把历史作为只读参考”。Skill 不设置 active key，不写入状态
文件，也不自动继承历史。

### `semantic-review`（内部）

任一 artifact 或 bundle 成员命中 PostToolUse hook 时，hook 从当前 session X 创建一次性 fork X1，并在 X1 中调用内部 `semantic-review` 技能。X1 只拥有读取能力，读取本轮请求文件与当前 bundle 快照，执行现有证据足以支持的语义审查，然后以受约束 JSON 返回：

- 语义诊断；
- 可选的多目标行级编辑计划；
- 一句审查摘要。

hook 验证所有目标都属于本轮 artifact 集合，要求原始行号与内容精确匹配，生成 Unified Diff 并执行 `git apply --check`。成功后才统一写入本轮 `diagnostic.md` 与 `patch.diff`；证据不足时保留 0 字节 diff。X1 使用 `--no-session-persistence`，返回后即释放，不能修改目标文件、应用 Patch、提交 Git 变更或继续派生 Agent。主 session X 只收到最终诊断与候选 Diff，由 X 自行决定是否使用。

主 session X 与 X1 的持久化要求不同：X 必须是可恢复会话，不能以
`--no-session-persistence` 启动；X1 才使用该参数。若 X 无法按 Hook 提供的
`session_id` 恢复，确定性结果仍保留，但本轮增加 `AGENT-SEMANTIC-REVIEW-FAILED`。

Planning bundle 未齐备时仍创建 X1；X1 检查已有成员，必须依赖缺失成员的判断保持 `pending`，结果仍成对持久化。如果 hook 输入缺少 `session_id` 或 fork 失败，本轮会持久化明确的 `AGENT-SEMANTIC-REVIEW-FAILED` 诊断，不会把空 Diff 描述为检查通过。

隔离审阅最多返回 100 条 finding、20 个编辑目标，每个目标最多 50 个单行操作。操作类型固定为 `remove-line`、`replace-line`、`insert-before` 和 `insert-after`；每个操作必须携带原始行号与精确 `expect` 内容。任一目标越界、原文不匹配或最终 `git apply --check` 失败时，候选 Patch 会被拒绝并留下明确诊断。

若语义结果已校验成功、仅候选编辑生成失败，总体仍为 `failed`，但语义状态为
`completed`、补丁状态为 `failed`；保留 findings，使用
`RUNTIME-PATCH-VALIDATION-FAILED`，不再误报 `AGENT-SEMANTIC-REVIEW-FAILED`。
完整的 v2 状态与来源约定见 [工作原理与信任边界](how-it-works.md)。

Reviewer 可执行文件按以下顺序解析：

1. `RUNTIME_CORRECTOR_AGENT_EXECUTABLE`；
2. 项目 `reviewerRuntime`；
3. 当前宿主专用环境变量；
4. 当前宿主已知原生安装路径；
5. 当前宿主 PATH 命令。

Claude 专用覆盖为 `RUNTIME_CORRECTOR_CLAUDE_EXECUTABLE` 和
`CLAUDE_CODE_EXECUTABLE`；CodeAgent 专用覆盖为
`RUNTIME_CORRECTOR_CODEAGENT_EXECUTABLE`。

会话协议不由 executable 名称推断。Claude 与 CodeAgent 审阅默认 20 分钟，
可通过项目配置 `limits.semanticReviewTimeoutMs` 调整为 `1000`～`3600000` 毫秒。完整行为见本页 Reviewer CLI 协议。Runtime Corrector 自己的主 PostToolUse Hook 外层上限为 1800 秒；它只约束本插件命令，
不会改变其他 PostToolUse Hook 的超时。

## CLI

### 调用方式

插件目录内：

```powershell
node scripts/cli.mjs <command>
npm run check -- <command>
```

这是显式的 standalone CLI 模式：入口由正在执行的 `scripts/cli.mjs` 自身确定插件目录，因此不要求宿主根变量。通过插件命令或 Skill 调用时仍必须由固定启动器解析 `CLAUDE_PLUGIN_ROOT` / `CODEAGENT3_PLUGIN_ROOT`；standalone 例外不会改变 Hook 的声明校验边界。

可选安装全局命令：

```powershell
npm link
runtime-corrector --help
```

`--plugin-dir` 只加载宿主插件，不会自动把 `runtime-corrector` 安装到系统 PATH。

### 命令签名

```text
runtime-corrector help [--cwd <directory>]
runtime-corrector init [--cwd <directory>]
runtime-corrector validate [--cwd <directory>] [--format json|text]
runtime-corrector stages [--cwd <directory>] [--format json|text]
runtime-corrector stage <stage> <on|off> [--cwd <directory>]
runtime-corrector check <artifact> [--cwd <directory>] [--format json|text]
runtime-corrector explain <stage> [--cwd <directory>] [--format json|text]
runtime-corrector spec <stage> [--cwd <directory>] [--format json|text]
```

通用规则：

- `--cwd` 默认当前工作目录；
- `--format` 默认 `text`；
- `help`、`init` 和 `stage` 不支持 `--format`；
- 被检查 artifact 必须位于 `cwd` 内；
- `init` 从不覆盖已有 `.runtime-corrector/`。
- `spec` 是只读接口；stage 关闭时仍可读取已安装标准。
- `check` 不接收 Claude session 上下文，因此不会创建隔离语义审阅；配置了 reviewer 时返回 `agentReview.status = requested`。
- `validate` 不检查业务 Artifact；它编译策略并加载全部启用规则、Reviewer 和 Schema，同时检查图、匹配器和 Ground Truth 绑定，返回稳定策略摘要。

### `spec --format json`

返回一份自包含恢复包，顶层字段为：

- `version`、`stage`、`stageEnabled`、`authority`；
- `config`：当前来源、路径、输出和限制；
- `recovery`：Claude command 与 CLI 命令；
- `globalSpecification`：插件全局精确格式；
- `criteria[]`：artifact 匹配、当前 rules 原文、全部 Schema 原文、reviewer 原文。

该接口适合 Agent 首次编写 stage 前预读，也适合连续失败后恢复。它不要求、也不建议读取插件测试或 JavaScript。

### 退出码

| 退出码 | 含义 |
|---:|---|
| `0` | 命令成功；`check` 状态为 `passed`、`warning` 或 `pending` |
| `1` | `check` 状态为 `failed` |
| `2` | 参数错误、配置错误、未初始化控制命令、artifact 未匹配或其他执行错误 |

### `stages --format json`

```json
{
  "config": "C:/project/.runtime-corrector/config.yaml",
  "stages": [
    {
      "stage": "selection",
      "enabled": true,
      "rules": {
        "enabled": true,
        "file": "selection.rules.yaml"
      },
      "review": {
        "enabled": true,
        "criteria": "selection.reviewer.md"
      }
    }
  ]
}
```

`config` 当前为绝对路径；`rules` 和 `review` 保留 `config.yaml` 中声明的对象结构，
便于调用方同时读取开关与项目相对路径。

### `explain --format json`

```json
{
  "stage": "selection",
  "configSource": "project-simple",
  "config": ".runtime-corrector/config.yaml",
  "mechanism": [
    "match artifacts",
    "validate project JSON schemas",
    "run visible deterministic rules",
    "run one isolated Agent semantic review for the current snapshot after PostToolUse",
    "persist one paired diagnostic and diff result for every matched snapshot"
  ],
  "artifacts": [
    {
      "type": "selection",
      "format": "markdown",
      "patterns": ["kit-map.md"],
      "relatedPatterns": ["ir.md", "PilotPlan.md", "kit-map.md"],
      "rules": ".runtime-corrector/selection.rules.yaml",
      "reviewer": ".runtime-corrector/selection.reviewer.md",
      "checks": [
        {
          "id": "SELECTION-KIT-MAP",
          "type": "markdown-records",
          "artifact": "kit-map.md"
        }
      ]
    }
  ]
}
```

### `check --format json`

JSON 输出是检查 `result`，不是 CLI wrapper：

下面示例假设检查状态为 `failed` 且启用了 `output.persist`，因此包含历史 Round、Latest、`spec.md` 和 `patch.diff` 路径：

```json
{
  "status": "failed",
  "diagnostics": [
    {
      "ruleId": "SELECTION-KIT-MAP",
      "severity": "error",
      "path": "kit-map.md",
      "line": 12,
      "message": "...",
      "evidence": ["SR-1"],
      "suggestion": "..."
    }
  ],
  "diffs": [],
  "metadata": {
    "stage": "selection",
    "artifactType": "selection",
    "triggerFile": "kit-map.md",
    "artifactFiles": ["ir.md", "PilotPlan.md", "kit-map.md"],
    "bundleComplete": true,
    "ruleSetIds": ["project:selection.rules.yaml"],
    "configSource": "project-simple",
    "projectRootSource": "provided-cwd",
    "durationMs": 8,
    "roundId": "20260723T101112Z-12345678",
    "generatedAt": "2026-07-23T10:11:12.123Z",
    "diffGeneration": {
      "enabled": true,
      "strategy": "always"
    }
  },
  "agentReview": {
    "status": "requested",
    "path": ".runtime-corrector/selection.reviewer.md",
    "criteria": "# Selection Agent 审阅标准\n..."
  },
  "specification": {
    "stage": "selection",
    "slashCommand": "/runtime-corrector:spec selection",
    "cliCommand": "...",
    "globalPath": "plugin:specs/custom-stage.md"
  },
  "outputFiles": [
    ".runtime-correction/runs/selection/kit-map-12345678/20260723T101112Z-12345678/diagnostic.md",
    ".runtime-correction/runs/selection/kit-map-12345678/20260723T101112Z-12345678/result.json",
    ".runtime-correction/runs/selection/kit-map-12345678/20260723T101112Z-12345678/spec.md",
    ".runtime-correction/runs/selection/kit-map-12345678/20260723T101112Z-12345678/patch.diff",
    ".runtime-correction/latest/selection/kit-map-12345678/diagnostic.md",
    ".runtime-correction/latest/selection/kit-map-12345678/result.json",
    ".runtime-correction/latest/selection/kit-map-12345678/spec.md",
    ".runtime-correction/latest/selection/kit-map-12345678/patch.diff"
  ],
  "roundOutputFiles": [
    ".runtime-correction/runs/selection/kit-map-12345678/20260723T101112Z-12345678/diagnostic.md",
    ".runtime-correction/runs/selection/kit-map-12345678/20260723T101112Z-12345678/result.json",
    ".runtime-correction/runs/selection/kit-map-12345678/20260723T101112Z-12345678/spec.md",
    ".runtime-correction/runs/selection/kit-map-12345678/20260723T101112Z-12345678/patch.diff"
  ],
  "latestOutputFiles": [
    ".runtime-correction/latest/selection/kit-map-12345678/diagnostic.md",
    ".runtime-correction/latest/selection/kit-map-12345678/result.json",
    ".runtime-correction/latest/selection/kit-map-12345678/spec.md",
    ".runtime-correction/latest/selection/kit-map-12345678/patch.diff"
  ]
}
```

可选字段：

- 诊断：`line`、`section`、`evidence`、`suggestion`；
- Patch：`path`、`format`、`applyMode`、`baseHash`、`proposedHash`、`requiresBaseMatch`、`unifiedDiff`；
- Agent review：CLI `check` 在节点或直接入边存在 `review.enabled: true` 时返回 `status = requested`；项目 criteria 非空时额外返回 `path` 和 `criteria`。它不会在 CLI 内变为 `completed`。
- PostToolUse：存在已启用 review 时，隔离审查成功使用 `status = completed`，失败使用 `status = failed`；全部关闭时不创建隔离 session，也不产生 `agentReview`。完整性由 `metadata.bundleComplete` 和 `pending` 诊断表达。
- `specification`：指向可重复获取的完整规范；完整正文由 `spec` 返回，避免常规 JSON 检查结果膨胀。
- `metadata.diffGeneration`：固定为启用且策略为 `always`。
- `metadata.workflow`：在当前 Artifact 配置了直接入边或实例关联时出现，包含节点 ID、可选
  `instance`、入边状态、只读 source 文件和当前节点可编辑文件。
- `agentReview.edges`：手动 `check` 存在已启用直接入边时出现，按 YAML 顺序列出边基线及可选 criteria；PostToolUse 把已启用节点和入边合并为一次隔离审阅。
- `outputFiles`：历史 Round 与 Latest 两组路径的并集；`roundOutputFiles` 和 `latestOutputFiles` 可直接用于机器解析。
- `result.json`：`runtime-corrector.result.v1` 机器结果，包含兼容 `status`、逐项 `assessments`、聚合 `classification`、Finding 指纹、建议动作、输入摘要和策略摘要。
- `diffs` 表示非空且已经校验的候选 Patch；`diffs: []` 时两组输出路径中仍返回 0 字节 `patch.diff`。

## JSON-stdio Hooks

插件声明一个全工具写后 Hook。普通工具只进行版本 2 的回合对账和到期 Skill 检查；`Write/Edit` 命中已启用产物时，继续执行版本 1 的确定性检查、隔离语义审阅和候选 Patch 链路：

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"<fixed dual-root bootstrap>\" \"scripts/post-tool-use.mjs\"",
            "timeout": 1800,
            "statusMessage": "Runtime Corrector 正在对账任务状态并检查命中的产物…"
          }
        ]
      }
    ]
  }
}
```

### `PostToolUse`

典型输入：

```json
{
  "cwd": "C:/project",
  "session_id": "parent-session-id",
  "transcript_path": "C:/Users/user/.claude/projects/.../parent-session-id.jsonl",
  "hook_event_name": "PostToolUse",
  "tool_name": "Write",
  "tool_input": {
    "file_path": "C:/project/kit-map.md"
  },
  "tool_response": {
    "success": true
  }
}
```

`session_id` 是隔离语义审阅的必需输入。缺失时确定性诊断仍会保留，但本轮最终状态变为 `failed`，并增加 `AGENT-SEMANTIC-REVIEW-FAILED`。`transcript_path` 用于判断活动上下文中是否已经存在公开命令导航；检测范围从最后一个 `compact_boundary` 开始。路径缺失或不可读时按“上下文缺少导航”安全降级。

`1800` 秒是 Runtime Corrector 这个 Hook 命令自己的外层安全上限，不是宿主的全局
PostToolUse 超时。所有 Write/Edit 会先进入快速匹配；只有命中启用的 artifact 且需要隔离语义
审阅时，才可能实际等待 `limits.semanticReviewTimeoutMs` 配置的时长。

命中 artifact 时输出：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "[runtime-corrector] selection 纠偏诊断：failed ..."
  }
}
```

未匹配产物时不输出产物诊断；若存在到期 Skill watcher 或运行时故障，仍可能输出对应的 watcher 反馈或 fail-open 警告。`passed`、`warning` 和 `pending` 不补充命令导航；`failed` 只报告当前违规，并在活动上下文缺少导航时追加 `/runtime-corrector:spec <stage>` 与 `/runtime-corrector:help`。完整规范不展开到反馈中，仍可通过公开命令或持久化的 `spec.md` 获取。写入文件位于当前项目之外且没有自己的 Runtime Corrector policy 时也静默忽略产物诊断，避免 Claude memory 等全局文件制造无关错误。诊断异常会作为 `additionalContext` 返回，并明确说明原文件未被插件修改。

## 自定义 Matcher

仅高级 `.runtime-corrector.json` 模式支持扩展模块：

```json
{
  "extensions": {
    "matcherModule": "./tools/runtime-corrector-matcher.mjs"
  }
}
```

模块接口：

```js
export function matchArtifact({ filePath, relativePath, cwd, artifacts }) {
  if (!relativePath.endsWith("model.md")) return null;
  return {
    stage: "ir",
    artifactType: "ir",
    format: "markdown",
    primaryPath: filePath,
    relatedPatterns: [],
    knowledge: ["ir/default"],
    relatedRoot: "artifact-directory"
  };
}
```

返回 `null` 表示不匹配。匹配对象必须包含 `stage` 和 `artifactType`；其他字段使用默认值。
correlation 模式下还必须返回包含全部 correlation key 的 `instance` 对象，否则本轮明确失败，
不会回退为扫描全部文件。

## 自定义 Collector

```json
{
  "extensions": {
    "collectorModule": "./tools/runtime-corrector-collector.mjs"
  }
}
```

模块接口：

```js
export async function collectRelated({ triggerFile, match, cwd, config }) {
  return ["path/to/another.ir.md"];
}
```

返回值必须是文件路径数组。触发文件会自动加入最终输入，结果去重后受 `maxRelatedFiles` 限制。

## 集成建议

- Claude 内交互：优先使用命令和 Skill；
- CI、SDD 编排器：使用 CLI `--format json` 和退出码；
- 特殊文件拓扑：使用高级 Matcher/Collector；
- 不建议把 `lib/*.mjs` 的内部导出视为稳定公共 API。

## Reviewer CLI 协议

## Launcher configuration

`reviewerRuntime` chooses an executable; it never chooses the host protocol:

```yaml
reviewerRuntime:
  executable: 'C:/Program Files/CodeAgentCLI/bin/codeagentcli.exe'
  argsPrefix: []
```

The launch plan is the frozen pair `{ executable, argsPrefix }`. Removed legacy
session-protocol configuration produces a migration error. The executable is
not inspected to infer a product.

Resolution priority is:

1. `RUNTIME_CORRECTOR_AGENT_EXECUTABLE`;
2. project `reviewerRuntime.executable`;
3. the active host's dedicated environment variable;
4. the active host's known native installation path;
5. the active host's PATH command.

Claude recognizes `RUNTIME_CORRECTOR_CLAUDE_EXECUTABLE`,
`CLAUDE_CODE_EXECUTABLE`, its known native Windows installations, then
`claude.exe` / `claude`. CodeAgent recognizes
`RUNTIME_CORRECTOR_CODEAGENT_EXECUTABLE`,
`%ProgramFiles%/CodeAgentCLI/bin/codeagentcli.exe`, then
`codeagentcli.exe` / `codeagentcli`.

On Windows, configure a native executable. `.cmd`, `.bat`, and `.ps1`
reviewer shims are rejected. A supported wrapper uses `node.exe` plus an
absolute JavaScript entry in `argsPrefix`. Arguments are literal argv values;
the launcher never invokes a shell.

## Session protocol

Both artifacts keep the common argument surface: `--print`,
`--output-format json`, `--json-schema`, `--effort`,
`--permission-mode`, `--tools`, `--allowedTools`,
`--disallowedTools`, `--strict-mcp-config`, `--plugin-dir`, and optional
`--model`, `--max-budget-usd`, `--fork-session`, and
`--no-session-persistence`.

For `onboarding-extractor`, `onboarding-adjudicator`, `skill-reviewer`,
`artifact-reviewer` and `implementation-reviewer`, the role launcher omits
RC's `--tools`, `--allowedTools`, `--strict-mcp-config`
and `--permission-mode` overrides so the host supplies its configured tools,
MCP connections and permissions. A role-scoped `--disallowedTools` list excludes
write, edit, patch, shell/process and code-execution tools while keeping read
and search tools available. Baseline and classification roles retain their
read-only tool scope. This applies to the initial invocation,
contract reminders, schema repairs and follow-ups. Other roles and the legacy
generic semantic-review launcher retain their scoped tool arguments.

| Operation | Claude artifact | CodeAgent artifact |
| --- | --- | --- |
| Fresh | no session flag | no session flag |
| Resume | `--resume <id>` | `--sessions <id>` |
| Resume and fork | `--resume <id> --fork-session` | `--sessions <id> --fork-session` |
| Temporary resume | `--resume <id> --no-session-persistence` | `--sessions <id> --no-session-persistence` |

CodeAgent creates and persists a fresh `--print` session without
`--session-id`, returns `session_id` in the JSON result, and resumes it with
`--sessions`. The CodeAgent adapter defensively rejects `--session-id`,
`--resume`, and `--continue` anywhere in the complete invocation.

A fresh CodeAgent result without `session_id` fails with
`REVIEWER_SESSION_ID_MISSING`. A resumed result may omit the ID and reuse its
known input ID; a different returned ID is a protocol error. A fork must return
a non-empty ID different from its parent. If the first envelope is parseable
but its structured output is invalid, format and schema repair resume that
returned session. An unparseable envelope cannot be retried safely as another
fresh session.

## Provider and timeouts

Claude and CodeAgent default semantic and v2 role reviews to 20 minutes (1200000 ms), with a configurable maximum of 60 minutes. Explicit project timeouts override the default. Format repair shares the original deadline.

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

Independent reviewers retain the existing
`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` injection and provider-model
override because CodeAgent accepts that gateway interface. Parent credentials
are cleared first. Tokens are never added to argv, request files, journals,
logs, or error output.

## Cross-role handoff

GT to Stop, Skill, and artifact review always creates a target handle, lease,
request directory, and journal identity. Compatible ambient roles may resume
the source reviewer session. Compatibility requires the same build host,
executable/prefix, project/task owner, session cwd, parent session, plugin root,
credentials, and host-specific reviewer context. Claude additionally compares
`CLAUDE_CONFIG_DIR`; CodeAgent does not.

`independent` and `detached` start fresh. Compatible handoff resumes the
source role; incompatible handoff forks from the original parent. Format
retry, schema repair, Ground Truth repair, follow-up, and every handoff route
through the same active host adapter.
