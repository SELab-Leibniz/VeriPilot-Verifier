# Runtime Corrector（运行时纠偏器）

> English version: [README.en.md](README.en.md)

面向 coding agent 的运行时评审器（runtime critic），以 Claude Code 插件形态交付。它通过生命周期
Hook 观察开发会话，自建任务 Ground Truth，在隔离的只读会话中审阅 agent 的工作，并以有配额、可追溯
证据的方式介入纠偏——包括一个阻止“过早宣布完成”的终止门（termination gate）。

 · [文档导航](docs/README.md)

## 1. 它是什么

Runtime Corrector 由四个机制构成：

1. **基于自建运行时 Ground Truth 的事件驱动介入。** 任务的第一个 Hook 事件上，onboarding panel
   将全部任务材料（README、需求/规格文档、用户的真实请求）分解为原子 Ground Truth 声明；仲裁
   reviewer 以怀疑原则合并各 pass 的提案，随后账本**冻结**——冻结后只有真实用户消息能改变基线，
   agent 自己的推断不能。
2. **隔离审阅。** 每个 reviewer（抽取、仲裁、Skill 审阅、产物审阅、Stop 审阅、实现审阅）都运行在
   独立的只读 Claude 会话中（仅 `Read`/`Grep`，输出由 JSON Schema 强约束）。reviewer 还可以配置为
   在独立 provider/模型上运行，实现异构交叉校验。
3. **有配额的反馈与严格归因的闭环。** 送达的诊断有上限（产物检查正文只列最严重的前 3 条、每
   Skill 反馈有预算、每 epoch 的 Stop 纠偏有预算），其余全部持久化到磁盘。每个 finding 形成一个
   deviation family，其闭环被严格归因——只有在实际送达之后修复的问题才计入 critic 的贡献。
4. **终止门。** agent 试图结束时，Stop reviewer 依据冻结的指标 population 与未闭环 finding 作出
   判断：未完成的工作会以具体的 to-do 清单阻断 Stop，直到用完配置的纠偏预算；预算耗尽后放行，
   未解决的 finding 留档。

```text
              Claude Code 开发会话
   SessionStart · UserPromptSubmit · PreToolUse · PostToolUse · Stop
                        |
                        v  （插件 Hook）
 +-------------------- Runtime Corrector ----------------------+
 |                                                             |
 |  零配置派生 ──> 配置编译（插件默认 < 派生 < 显式配置）        |
 |                        |                                    |
 |  任务 onboarding：材料 ─> 抽取 panel ─> 仲裁                 |
 |                          └──> Ground Truth 账本（冻结）      |
 |                        |                                    |
 |  隔离只读 reviewer（fork 或独立 provider）                   |
 |    · 产物审阅  · Skill 看护  · 实现审阅                      |
 |    · 确定性检查（硬规则、Kit 集成）                          |
 |                        |                                    |
 |  deviation family ──> 有配额的反馈 ──> Stop 终止门           |
 |  journal 与评估结果持久化于 .runtime-correction/             |
 +-------------------------------------------------------------+
                        |
                        v
        诊断 / 候选 Patch / 阻断或放行决定
```

插件**从不修改项目文件、从不自动应用 Patch**——它只诊断、留痕，并把可执行的决定交还主 agent。

## 2. 安装

要求：支持插件、Hook 与 Skill 的 **Claude Code**（较新版本），**Node.js >= 18**。插件**零 npm
依赖**。

**a) 作为 marketplace 插件**

```bash
claude
> /plugin marketplace add /path/to/runtime-corrector   # 或托管本目录的 git 地址
> /plugin install runtime-corrector@runtime-corrector-local
```

**b) 直接指定插件目录**

```bash
claude --plugin-dir /path/to/runtime-corrector
```

**c) 从 clone 开始**

```bash
git clone <repository-url> runtime-corrector
claude --plugin-dir ./runtime-corrector
```

## 3. 零配置快速开始

装好插件，打开**任意**项目直接工作，无需 `.runtime-corrector/` 目录。新任务的第一个 Hook 事件上：

1. **自动派生**：发现任务材料（`README*`、`docs/**/*.md`、名字含 `requirement`/`spec` 的
   markdown，封顶且确定序），并对平台做指纹识别（`oh-package.json5` → `harmonyos`；纯
   `package.json` 项目暂无适配器 → 确定性 Kit 检查保持关闭）。派生结果每任务记录一次
   `DERIVED_CONFIG` journal 事件。
2. **任务 onboarding**：两个独立抽取 pass 分解材料与用户请求，仲裁合并，Ground Truth 账本冻结
   （journal 记录 `ONBOARDING_COMPLETED`）。
3. 此后纠偏器始终对照冻结基线审阅会话。第一次介入通常形如：

```text
[runtime-corrector] Terminal correction 1/3
任务未完成：README.en.md 要求的删除流程尚未实现。
- CR-003：材料要求滑动删除，但不存在任何删除路径
- M14：里程碑“列表交互”没有验证证据
继续任务并纠正上述偏差，或给出有证据的拒绝理由。
```

想让派生结果可见、可编辑，运行 `/runtime-corrector:init`——它把同一套派生物化为带注释的
`.runtime-corrector/config.yaml`。

## 4. 配置参考

配置位于 `.runtime-corrector/config.yaml`。优先级恒为**插件默认 < 派生值 < 显式配置**。关键键
一览：

```yaml
version: 2                      # 2 启用以下运行时纠偏能力

locale: zh                      # zh（默认）| en——送达诊断的语言

dynamicGroundTruth:
  enabled: true
  materialRoots:                # 任务材料；不写则自动发现
    - README.en.md
    - docs/requirements.md
  panel:
    size: 2                     # onboarding 抽取 pass 数；0 关闭 onboarding
    adjudicator: true           # 怀疑原则合并 panel 提案

stopCorrection:
  enabled: true
  maxCorrectionsPerEpoch: 3     # Stop 门预算；耗尽后放行并留档

implementationCorrection:
  enabled: true
  platform: harmonyos           # 平台适配器；不写则自动识别；null 关闭 Kit 检查
  checklistPaths: [docs/kits.md] # 可选：显式 Kit 清单文档
  checklistSection: "10\\.1"    # 匹配清单章节标题的正则
  kitColumnIndex: 0             # 清单表格中 Kit 名所在列
  device:
    mode: auto                  # auto=按环境降级 / required=CI 强制设备级 / off=只做静态
  deviceBudgetMs: 600000        # 构建/设备类确定性验证的墙钟上限

evidenceRoots: [evidence]       # 证据唯一性守卫监视目录（不写则关闭）

output:
  directory: .runtime-correction # 诊断与状态的写入位置
```

**Reviewer 角色。** 所有角色接受 `model`、`effort`（`low`…`max`）、`timeoutMs`、`maxBudgetUsd`、
`session`、`provider`；`defaults` 作用于全部角色：

| 角色 | 审什么 | 默认 |
|---|---|---|
| `defaults` | 所有角色的兜底 | effort `low`、超时 240 秒、session `fork` |
| `groundTruthExtractor` | 材料/会话 → 原子声明（含 panel pass） | 继承 |
| `onboardingAdjudicator` | panel 提案的怀疑式合并（冻结门） | 继承 |
| `skillReviewer` | Skill 执行 vs 其冻结契约 | 继承 |
| `artifactReviewer` | 写入产物 vs 冻结 Ground Truth / 阶段指标 | 继承 |
| `stopReviewer` | 会话可否结束（终止门） | 继承 |
| `implementationReviewer` | 已构建应用 vs 冻结 population | 继承 |

**异构审阅（推荐）。** 两个自洽性风险最高的门——onboarding 仲裁（冻结基线）与 Stop 审阅（决定
能否收工）——可以运行在**全新独立会话 + 不同 provider/模型**上，而不是父会话的 fork：

```yaml
reviewers:
  onboardingAdjudicator:
    session: independent        # 全新会话，不 --resume 父会话
    provider:
      baseUrl: https://api.example-provider.com
      apiKeyEnv: REVIEWER_API_KEY   # 环境变量的“名字”——绝不写 key 本体
      model: example-reviewer-model
  stopReviewer:
    session: independent
    provider:
      baseUrl: https://api.example-provider.com
      apiKeyEnv: REVIEWER_API_KEY
      model: example-reviewer-model
```

等价的预设简写（`critical-gates` 恰好覆盖上述两角色；`all` 覆盖全部角色；显式角色配置始终优先）：

```yaml
reviewers:
  modelPolicy:
    preset: critical-gates
    provider:
      baseUrl: https://api.example-provider.com
      apiKeyEnv: REVIEWER_API_KEY
      model: example-reviewer-model
```

> **配置中没有机密。** `apiKeyEnv` 是环境变量的*名字*。key 的值在 spawn 时读取，仅存在于
> reviewer 子进程环境中，绝不写入磁盘、journal 或日志。变量未设置或为空时，reviewer 退回默认的
> fork 会话并记录 `REVIEWER_PROVIDER_DEGRADED`。

version 1 的产物/Stage 纠偏（逐文件硬规则、语义审阅、workflow 边）见
[docs/configuration.md](docs/configuration.md)；`/runtime-corrector:init` 会把完整中文参考保留为
`config.reference.yaml`。

## 5. 使用——会话中你会看到什么

**送达诊断有配额。** 产物检查正文最多列前 3 条最严重 finding（外加候选 Patch 计数）；Skill 反馈
按 Skill 预算；Stop 纠偏按 epoch 预算。完整内容始终落盘：

```text
.runtime-correction/
├── latest/<stage>/<artifact>/diagnostic.md   # 最新完整诊断
├── latest/<stage>/<artifact>/patch.diff      # 候选 Git Patch（绝不自动应用）
├── latest/<stage>/<artifact>/result.json     # 机器可读结果
├── runs/<stage>/<artifact>/<roundId>/        # 历史轮次归档
└── tasks/<taskId>/
    ├── ground-truth/current.json             # 冻结账本
    ├── evaluations/*.json                    # stop/产物/实现审阅报告
    └── journal/events.jsonl                  # 追加式事件 journal
```

**如何响应纠偏。** 主 agent（或你）既可以修复偏差，也可以给出有证据的拒绝；两条路径都会被记录，
闭环归因保持诚实。

**解决 `OPEN_QUESTION`。** 材料中的歧义会以“开放问题 + 默认安全解读”的形式冻结，绝不虚构指令。
一条普通的用户消息即可解决它：冻结后只有 `USER_EXPLICIT` 权威能覆盖基线声明——直接说出你要什么
即可。

**Stop 门体验。** agent 过早宣布完成时，Stop 被 `Terminal correction n/N` 消息阻断，并列出阻塞
对象。尝试 `maxCorrectionsPerEpoch` 次后门放行（`CORRECTION_BUDGET_EXHAUSTED`），未解决 finding
留档。

**命令。**

| 命令 | 作用 |
|---|---|
| `/runtime-corrector:init` | 把派生配置物化为可编辑的 `config.yaml` |
| `/runtime-corrector:help` | 项目感知的帮助与阶段状态 |
| `/runtime-corrector:validate` | 校验项目策略 |
| `/runtime-corrector:stages` | 查看/开关 v1 产物 Stage |
| `/runtime-corrector:explain <stage>` / `:spec <stage>` | 解释当前策略 / 完整 Stage 规范 |
| `/runtime-corrector:check <artifact>` | 手动检查一个产物 |

## 6. 降级与排障

插件的普通检查**失败即放行（fail-open）**，但 active 模式的最终 `Stop` 门是唯一例外：最终审查
未能完成时会 fail-closed，阻止 Agent 把 `UNVERIFIED` 结果报告为“全部完成”。如需接受这一风险并
继续结束任务，开发者必须显式关闭 `stopCorrection` 或启用 `shadowMode`。查看
`.runtime-correction/tasks/<taskId>/journal/events.jsonl`：

| Journal 事件 | 含义 | 处置 |
|---|---|---|
| `DERIVED_CONFIG` | 信息性：本任务自动派生了哪些材料/平台 | 无需处理；想覆盖就 `/runtime-corrector:init` 物化 |
| `ONBOARDING_DEGRADED` | panel/仲裁/应用失败；退回增量抽取，账本未冻结 | 多为瞬时；检查 reviewer 超时/预算，新任务会重试 |
| `REVIEWER_PROVIDER_DEGRADED` | 独立会话 provider 不可用（环境变量未设置/为空或未配置）；该次审阅退回 fork | 导出 `apiKeyEnv` 指名的环境变量，核对 `provider.baseUrl` |
| `STOP_ASSESSMENT_FAILED` | Stop 审阅自身出错；本次 Stop 阻断（fail-closed）并留档 | 查看记录的错误；下一次 Stop 会重试 |
| `SKILL_REVIEW_FAILED` / `STOP_REVIEW_FAILED` | 某次隔离审阅崩溃；watcher 标记 `UNVERIFIED` | 瞬时故障；反复出现再排查 |

Hook 自身崩溃时，active `Stop` 会返回阻断；其他事件输出有限次的
`[runtime-corrector] v2 features failed open` 提示。observe-only 模式和配置尚未成功加载、因而无法
确定模式的故障仍保持完全静默。

### 6.1 设备级验证阶梯（device / build / static）

实现审查在静态检查之上叠加一个**按环境自动降级**的确定性验证阶梯，全部命令由平台
适配器的 `deviceCheck` 段声明（探测、构建门、冒烟步骤）——核心框架不含任何平台命令，
没有 `deviceCheck` 的平台自然封顶在 static 档：

| 档位 | 触发条件 | 实际执行 |
|---|---|---|
| `device` | 探测到已连接设备/模拟器 且 工具链存在 | 构建门 + 适配器声明的冒烟步骤（安装/启动/截图） |
| `build` | 仅工具链存在（如项目内 `hvigorw`） | 构建门（按源码清单摘要缓存，同源不重复构建） |
| `static` | 两者皆无 / 平台未声明 / `device.mode: off` | 仅静态核验（1.0.x 的全部行为） |

三条纪律：**缺设备只降低保证等级，不改变任何判定方向**——环境跑不了的检查一律
跳过并记录原因（绝不判 PASS，也绝不算开发者的偏差）；真正跑了且客观失败的
（构建报错、启动崩溃）才是阻断性发现（`impl:build:*` / `impl:device:*`）；每次 Stop
反馈都带一行保证级别声明（如 `Assurance: static-level verification only …`），
静态绿灯永远不会被误认为设备级绿灯。CI 环境用 `device.mode: required` 把
"没有设备"本身变成阻断性基础设施发现。

## 7. 设计保证

- **只读 reviewer。** 每个 reviewer 子进程仅有 `Read`/`Grep`；Write/Edit/Skill/Agent/MCP 全部
  禁用；角色 prompt 把一切内容当证据而非指令。
- **绝不代改。** 插件不修改项目文件、不自动应用候选 Patch；所有变更决定权在主 agent。
- **任何地方都没有机密。** 代码中没有 API 端点或 key 字面量；配置只存环境变量*名字*；provider
  凭据只存在于 reviewer 子进程环境。
- **平台适配器。** 平台约定（模块命名、源码目录）是 `config/platforms/*.json` 数据；未知或
  `null` 平台只是跳过 Kit 检查。
- **独立于 LLM 的确定性检查。** 硬规则、Kit 集成检查、证据唯一性、闭环归因都是纯代码——与任何
  模型无关、可复现。
- **不接管实例决策。** 插件不负责决定用户是在继续旧 change 还是创建新 change，也不会按修改时间
  选择“最新”文件；只配置 `patterns` 而不配置 correlation 时，所有命中文件按设计同属一个 legacy
  bundle。
- **观察模式。** `shadowMode: true` 记录完全相同的检测但零介入，用于在不受干预的运行上评估
  critic。

## 更多文档

完整导航见 [docs/README.md](docs/README.md)：

- v2 设计与配置：[docs/runtime-corrector-v2-design.md](docs/runtime-corrector-v2-design.md)
- v1 产物/Stage 配置与规则：[docs/configuration.md](docs/configuration.md)
- 一轮纠偏的端到端机理：[docs/how-it-works.md](docs/how-it-works.md)
- 命令、CLI、Hook JSON、自定义 Matcher：[docs/interfaces.md](docs/interfaces.md)
- 教程：[docs/tutorial.md](docs/tutorial.md)、
  [docs/six-stage-workflow-from-zero.md](docs/six-stage-workflow-from-zero.md)
- `examples/` 下可直接复制的业务示例
