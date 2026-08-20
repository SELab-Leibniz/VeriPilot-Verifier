# 完整使用教程

如果你的目标是创建一个全新的 stage（例如专门纠偏 `**/design.md` 的 `app-design`），请直接打开根目录 [交互式自定义 Stage 教程](../tutorial.html)。它可离线独立运行，并逐步演示注册、启用、诊断、最小纠偏和复检；第二个 `mini-planning` 示例还会展示一个 Stage 如何同时收集和纠偏 `PilotPlan.md` 与 `relations.json`。

本教程以鸿蒙 TodoList 为例，复制并运行
[IR → Planning → Selection → PRD Contract 示例](../examples/ir-planning-selection-prd-contract/README.md)，
完成插件加载、产物生成、纠偏、阶段控制和规则定制。`/runtime-corrector:init` 只用于从零
创建通用模板，不自动安装这套业务流程。

## 1. 准备项目

确认已安装：

- Claude Code；
- Node.js 18+；
- 一个可写项目目录。

进入项目：

```powershell
cd C:\path\to\todo-project
```

## 2. 加载本地插件

```powershell
claude --plugin-dir C:\path\to\runtime-corrector
```

本地开发版每次新建或恢复 Claude 会话时都应带上 `--plugin-dir`：

```powershell
claude --plugin-dir C:\path\to\runtime-corrector --resume <session-id>
```

不要为主会话增加 `--no-session-persistence`。语义 reviewer 需要恢复这个父 session
并创建一次性只读 fork；父会话不可恢复时，插件会显式报告语义审阅失败。

## 3. 复制四阶段示例规则

在项目外的 PowerShell 中复制示例策略：

```powershell
Copy-Item `
  -Recurse `
  -LiteralPath C:\path\to\runtime-corrector\examples\ir-planning-selection-prd-contract\.runtime-corrector `
  -Destination C:\path\to\todo-project\.runtime-corrector
```

回到 Claude 对话窗检查：

```text
/runtime-corrector:help
/runtime-corrector:stages
```

示例目录是项目策略，不会创建 `.runtime-correction/`，也不会生成业务产物。目标项目已有
`.runtime-corrector/` 时不要覆盖；应显式评审并合并。

## 4. 生成四阶段产物

将示例 `workflow.yaml` 的完整内容作为 prompt 交给同一个 Claude 会话，并追加具体需求：

```text
具体需求：实现一个鸿蒙 TodoList，该 app 有 Todo 事项的新增和删除功能。
请按 workflow.yaml 顺序执行并处理每次 Runtime Corrector 反馈。
```

推荐顺序：

1. IR：`ir.md`
2. Planning：`PilotPlan.md`、`relations.json`、`granularity-choice.json`
3. Selection：`kit-map.md`
4. PRD Contract：`PRD.md`

Agent 在首次编写每个 stage 前会读取完整地图。也可以手动查看：

```text
/runtime-corrector:spec ir
/runtime-corrector:spec planning
/runtime-corrector:spec selection
/runtime-corrector:spec prd-contract
```

每次 `Write` 或 `Edit` 命中对应路径后，PostToolUse Hook 自动运行。

## 5. 理解 `pending`

Planning 三件套尚未写全时，可能看到：

```text
Status: pending
```

这表示流程尚未齐备，不是最终失败。插件仍会 fork 一次性 X1，检查已有文件的结构、Schema 和可独立判断的语义 criteria，并为当前快照持久化诊断与候选 diff。必须依赖缺失成员的检查保持 `pending`。

继续写完剩余文件即可。Selection 和 PRD 同样等待所需上游文件。

## 6. 手动做最终检查

全部文件写完后，可以分别运行确定性复检：

```text
/runtime-corrector:check ir.md
/runtime-corrector:check PilotPlan.md
/runtime-corrector:check kit-map.md
/runtime-corrector:check PRD.md
```

手动 `/check` 不携带 PostToolUse 的 `session_id`，因此不会创建隔离语义审阅 fork。它会重新执行匹配、bundle 收集、已启用硬规则、Schema、确定性 Patch 和持久化，并在节点或直接入边存在 `review.enabled: true` 时返回 `agentReview.status = requested`。

检查某 stage 实际使用的 criteria：

```text
/runtime-corrector:explain planning
/runtime-corrector:explain selection
/runtime-corrector:explain prd-contract
```

结果状态：

- `passed`：没有发现当前规则覆盖的偏差；
- `warning`：存在非阻断问题；
- `pending`：bundle 尚未齐备；
- `failed`：存在 error 级偏差。

自动 PostToolUse 检查中的 `passed` 表示所有已启用检查均未发现偏差；手动 `/check` 中的 `passed` 只表示确定性部分通过，已启用 review 仍是 `requested`。两者都不代表绝对正确。

## 7. 处理失败诊断

一条诊断通常包含：

```text
[ERROR] <RULE-ID> <file>:<line> — <message>
建议：<suggestion>
```

处理顺序：

1. 读取 `ruleId`、路径、行号和证据；
2. 确认问题属于当前需求范围；
3. 让主 Agent 依据当前违规做最小修正；
4. 只有需要精确格式、完整规则或上下文压缩后缺失规范时，运行 `/runtime-corrector:spec <stage>`；不了解其他入口时运行 `/runtime-corrector:help`；
5. 再次运行 `check`；
6. 只有真正需要产品决策或规范互相矛盾时才转人工。

失败反馈总会明确显示：

```text
候选 Git Patch：0
```

或实际数量。PostToolUse 自动检查中的 `0` 表示确定性规则和隔离语义审查都没有安全候选修正；手动 `/check` 中的 `0` 只覆盖确定性候选。比如缺少 Kit 选择理由时，插件不能代替用户编造理由。完整规范仍会写入历史 Run 和 Latest 两处 `spec.md`。当 `persist: true` 时，反馈还会给出对应的 Run 与 Latest `patch.diff` 路径；没有候选内容时两份文件都是 0 字节。

如果 `.diff` 非空：

```powershell
git apply --check ".runtime-correction\runs\<stage>\<artifact-key>\<run-id>\patch.diff"
```

使用反馈中列出的实际 Round 路径替换占位符。校验成功后仍由主 Agent 或人工决定是否应用。不要直接自动应用。

bundle 任一成员命中 PostToolUse hook 后，hook 先执行已启用硬规则。节点或直接入边存在 `review.enabled: true` 时，才从当前 session 创建一次性隔离 fork 并调用内部 `/runtime-corrector:semantic-review`；全部关闭时跳过 fork。缺失成员相关判断保持 `pending`。

hook 核对计划中的目标范围、原始行号和内容，生成 Unified Diff 并执行 `git apply --check`，然后统一写出本轮 diagnostic、specification 与 diff。fork 退出后不保留可恢复 session，hook 只把诊断和实际 diff 交还主 Agent。证据不足时空 diff 会保留并明确标为“未能生成”，由主 Agent 决定是否需要人工输入。

如果 Agent 连续用不同 Markdown 写法尝试同一错误，停止试错，不要读取插件测试。运行 `/runtime-corrector:spec <stage>`，按其中的精确语法和当前项目 criteria 一次修正。

## 8. 只启用需要的阶段

查看状态：

```text
/runtime-corrector:stages
```

关闭 Planning：

```text
/runtime-corrector:stages planning off
```

也可以直接说：

```text
只开启 Selection 和 PRD Contract 纠偏。
```

Skill 会先查询实际安装状态，再开启请求的 stage、关闭其余已安装 stage，并返回最终完整状态。规则文件不会被删除。

## 9. 修改一条硬规则

例如临时关闭 IR 的占位符检查，在 `.runtime-corrector/ir.rules.yaml` 找到目标规则：

```yaml
- id: IR-FORBID-PLACEHOLDER
  type: forbid-text
  values:
    - TODO
    - TBD
  severity: error
  enabled: false
```

保存后再次检查：

```text
/runtime-corrector:check ir.md
```

建议保留规则和 ID，只使用 `enabled: false`，便于团队审计和恢复。

## 10. 修改 Agent 审阅标准

例如要求 Selection reviewer 对每个 Kit 给出更严格证据：

1. 打开 `.runtime-corrector/selection.reviewer.md`；
2. 在“必须检查”中增加团队标准；
3. 规定每个结论必须引用 SR、Kit 和上游原文；
4. 保存后让 Claude 再次 `Edit` `kit-map.md`，触发包含新 reviewer 的自动检查。

也可以在 Claude 中明确要求：

```text
把 Selection reviewer 改为：每个 Kit 选择都必须引用对应 SR 和官方能力证据；不要修改其他标准。
```

Claude 应先定位实际 reviewer，只修改用户指定内容，并总结变化。

## 11. 修改 Planning JSON 契约

Planning JSON 的字段契约位于：

```text
.runtime-corrector/schemas/relations.schema.json
.runtime-corrector/schemas/granularity-choice.schema.json
```

修改 Schema 后，还要同步检查：

- `planning.rules.yaml` 中的字段映射；
- 现有 JSON 文件；
- `PilotPlan.md` 与关系图/分组的一致性。

使用不支持的 Schema 关键字会立即报错。支持列表见 [配置参考](configuration.md#json-schema)。

## 12. 在终端或编排器中使用

可选安装 CLI：

```powershell
cd C:\path\to\runtime-corrector
npm link
```

然后在任意目标项目执行：

```powershell
runtime-corrector stages --cwd C:\path\to\todo-project --format json
runtime-corrector spec selection --cwd C:\path\to\todo-project --format text
runtime-corrector check kit-map.md --cwd C:\path\to\todo-project --format json
```

需要从零配置另一个流程时才运行：

```powershell
runtime-corrector init --cwd C:\path\to\another-project
```

该命令生成默认关闭的通用注释模板，不生成本教程的四阶段规则。

编排器应同时读取 JSON `status` 和进程退出码。CLI `check` 不会创建 Claude 隔离 session；已启用 review 会以 `agentReview.status = requested` 返回，由编排器决定如何执行。完整契约见 [外部接口参考](interfaces.md#cli)。

## 13. 常见问题

### Claude 中没有命令

确认本次会话通过以下方式启动：

```powershell
claude --plugin-dir C:\absolute\path\to\runtime-corrector
```

并运行：

```text
/runtime-corrector:help
```

### `init` 提示目录已存在

这是覆盖保护。先查看已有 `.runtime-corrector/`，不要删除团队规则后重新初始化。需要升级规则时做显式评审和合并。

### `stages` 提示未初始化

本教程应复制四阶段 example 的 `.runtime-corrector/`。如果要从零设计其他流程，运行
`/runtime-corrector:init` 并按中文注释配置真实 Stage；未初始化项目不会看护任何业务文件。

### 旧项目没有 `enabledStages`

这是兼容状态，CLI 将所有已安装 stage 视为开启。第一次执行 stage 开关命令时会写入显式列表。

### 文件没有触发

检查：

1. stage 是否开启；
2. 文件路径是否命中 `artifacts[].patterns`；
3. 文件是否位于项目策略根目录内；
4. 操作是否为 Claude `Write` 或 `Edit`；
5. 是否命中 `ignorePatterns`。

使用 `/runtime-corrector:explain <stage>` 查看实际匹配配置。

### 同一诊断反复失败

运行 `/runtime-corrector:spec <stage>`。该命令会一次性返回全局精确格式、当前 rules、全部引用 Schema 和 reviewer；stage 关闭时也可以读取。如果反馈和完整规范互相矛盾，应报告插件缺陷，而不是继续猜格式。

### `.diff` 不存在或为空

先看 `output.persist`。为 `true` 时，每次快照检查会在本轮 Run 和 Latest 目录各生成一个 `patch.diff`；`候选 Git Patch：0` 对应两处 0 字节空文件。diff 不再有独立开关。

节点或直接入边存在已启用 review 时，PostToolUse 才从当前 session fork 并调用内部 `/runtime-corrector:semantic-review`；全部关闭时只返回确定性结果。没有证据支撑的安全修改时仍保留空文件，但反馈会说明这是“未能生成”，不是“诊断通过”。若需要 fork 但 hook 输入缺少 `session_id` 或启动失败，反馈会保留诊断并明确报告语义审查失败。

### 隔离语义审阅无法启动

先确认 Claude Code 原生可执行文件可从 Hook 环境访问。如果它不在 PATH 中，可设置 `RUNTIME_CORRECTOR_CLAUDE_EXECUTABLE`；也兼容 `CLAUDE_CODE_EXECUTABLE`。Windows 会继续尝试标准 npm 原生安装路径和 `claude.exe`。变量值应指向原生可执行文件，而不是需要额外 shell 包装的命令字符串。

### 隔离语义审阅超时

默认审阅上限是 240000 毫秒。长会话或多文件 bundle 可在项目配置中提高，例如：

```yaml
limits:
  semanticReviewTimeoutMs: 1200000
```

允许范围为 1000～1200000 毫秒。插件自己的 PostToolUse Hook 外层上限是 1260 秒，只影响
Runtime Corrector，不会改动其他 Hook 的超时；未命中的 Write/Edit 不会等待该时长。

### 修改规则后没有生效

确认修改的是当前项目 `.runtime-corrector/` 中由 `explain` 列出的文件，并重新写入或手动 `check` 对应产物。

### 诊断目录没有生成

检查 `output.persist`。为 `true` 时，bundle 不完整也会为当前快照写入 `diagnostic.md` 与 `patch.diff`。
