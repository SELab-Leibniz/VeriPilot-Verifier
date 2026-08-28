# 外部接口参考

Runtime Corrector 支持四类稳定的客户入口：Claude 命令、Claude Skill/自然语言、CLI、Claude Code Hook。高级兼容模式还支持自定义 Matcher 和 Collector。

## Claude 命令

所有入口都在当前 Claude Code 工作目录执行。`help`、`init`、`validate`、`stages`、`explain`、`spec` 和 `check` 通过 `${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs` 调用插件自带 CLI，不依赖系统 PATH。PostToolUse hook 内部使用一次性 `semantic-review` 技能，主 Agent 无需调用它。

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
接受项目 `artifacts[]` 中注册的任意合法 Stage，例如 `app-design`。四阶段业务流程位于
`examples/ir-planning-selection-prd-contract/`。

这些入口共享同一个配置边界：项目 YAML、旧 JSON、程序化配置和插件默认值先归一为
RuntimePlan，再由 CLI、Hook、`explain` 和 `spec` 使用。内部模块导出不是公共配置接口，
调用方不应绕过 RuntimePlan 直接依赖未编译的项目策略对象。

## Claude Skills 与自然语言

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

版本 2 注册 `UserPromptSubmit`、`PreToolUse(Skill)`、全工具 `PostToolUse` 与 `Stop` 等生命周期 Hook。全工具 `PostToolUse` 使用较早版本 Claude Code 已支持的事件完成真实回合对账和到期 Skill 检查；仅当 `Write/Edit` 命中产物时，才继续执行版本 1 的产物写后链路。`UserPromptSubmit` 不预加载插件说明，只计算真实回合并触发到期的 Skill 检查。完整 v2 事件、状态和配置契约见 [Runtime Corrector v2 design](runtime-corrector-v2-design.md)。

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

Claude Code 可执行文件按以下顺序解析：

1. `RUNTIME_CORRECTOR_CLAUDE_EXECUTABLE`；
2. `CLAUDE_CODE_EXECUTABLE`；
3. Windows 已知的原生安装路径，或系统中的 `claude.exe`；
4. 非 Windows 系统中的 `claude`。

前两个环境变量适合 Claude Code 不在 Hook PATH 中时显式指定原生可执行文件。隔离审阅默认
最多运行 240 秒，可通过项目配置 `limits.semanticReviewTimeoutMs` 调整为 `1000`～`1200000`
毫秒。Runtime Corrector 自己的 PostToolUse Hook 外层上限为 1260 秒；它只约束本插件命令，
不会改变其他 PostToolUse Hook 的超时。

## CLI

### 调用方式

插件目录内：

```powershell
node scripts/cli.mjs <command>
npm run check -- <command>
```

可选安装全局命令：

```powershell
npm link
runtime-corrector --help
```

`--plugin-dir` 只加载 Claude 插件，不会自动把 `runtime-corrector` 安装到系统 PATH。

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

## Claude Code Hooks

插件声明一个全工具写后 Hook。普通工具只进行版本 2 的回合对账和到期 Skill 检查；`Write/Edit` 命中已启用产物时，继续执行版本 1 的确定性检查、隔离语义审阅和候选 Patch 链路：

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/post-tool-use.mjs"],
            "timeout": 1260,
            "statusMessage": "Runtime Corrector 正在隔离检查并生成诊断与候选 Diff…"
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

`1260` 秒是 Runtime Corrector 这个 Hook 命令自己的外层安全上限，不是 Claude Code 的全局
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

未匹配时不输出。`passed`、`warning` 和 `pending` 不补充命令导航；`failed` 只报告当前违规，并在活动上下文缺少导航时追加 `/runtime-corrector:spec <stage>` 与 `/runtime-corrector:help`。完整规范不展开到反馈中，仍可通过公开命令或持久化的 `spec.md` 获取。写入文件位于当前项目之外且没有自己的 Runtime Corrector policy 时也静默忽略，避免 Claude memory 等全局文件制造无关错误。诊断异常会作为 `additionalContext` 返回，并明确说明原文件未被插件修改。

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
