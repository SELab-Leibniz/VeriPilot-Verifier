# Runtime Corrector（运行时纠偏器）

> English version: [README.en.md](README.en.md) · [文档导航](docs/README.md)

**它是什么：** 一个 Claude Code 插件，在你的 coding agent 干活时对它做实时评审。agent 写代码，它对照任务要求检查并把问题反馈回去；agent 说"做完了"，它做验收——没做完就拦下来，附上具体待办，直到做完或用完纠偏预算。

**它不做什么：** 从不修改你的项目文件，从不自动应用补丁，从不因为自身故障阻塞开发（fail-open）。所有决定权始终在主 agent 和你手里。

## 30 秒看懂协作方式

```text
你发需求 ──────────► 纠偏器把需求记入任务基线（Ground Truth）
agent 写代码 ──────► 纠偏器审阅改动 ──► 把前 3 条问题 + 候选补丁递回给 agent
agent 修复或有据拒绝 ──► …（循环）
agent 说"完成" ────► 终止门验收：
    有硬性问题、预算未用完 ──► 拦下 + 给出待办清单 ──► agent 继续
    预算用完 ─────────────► 放行 + 声明"仍有未解决问题"（留档）
    验收通过 ─────────────► 放行
```

三个要点：

1. **agent 不需要知道纠偏器存在。** 双方零耦合——纠偏器挂在 Claude Code 的生命周期 Hook 上，换任何模型驱动的 coding agent 都一样工作。
2. **反馈有配额。** 每次最多递回 3 条最严重问题，其余完整落盘（agent 想看可以自己读），绝不刷屏淹没 agent 的上下文。
3. **只有"确定性证实的硬问题"才能拦截完成。** 推断出的疑点只提示、不拦截；拦截有预算上限（默认 3 次/epoch，`maxCorrectionsPerEpoch`），永远不会把会话困死。

## 1. 安装

要求：较新版本的 **Claude Code**（支持插件、Hook、Skill），**Node.js >= 18**。插件**零 npm 依赖**。

```bash
# 方式 a：marketplace 插件
claude
> /plugin marketplace add /path/to/runtime-corrector
> /plugin install runtime-corrector@runtime-corrector-local

# 方式 b：直接指定插件目录
claude --plugin-dir /path/to/runtime-corrector

# 方式 c：从 clone 开始
git clone <repository-url> runtime-corrector
claude --plugin-dir ./runtime-corrector
```

## 2. 快速开始（零配置）

装好插件，打开**任意**项目直接工作——不需要建任何配置。新任务的第一个事件上自动发生三件事：

1. **发现材料**：自动找到 `README*`、`docs/**/*.md`、名字含 `requirement`/`spec` 的文档，并识别平台（`oh-package.json5` → harmonyos）。结果记入 journal（`DERIVED_CONFIG` 事件）。
2. **建立任务基线**：两个独立的抽取器把材料和你的请求分解为原子要求，一个裁定器怀疑式合并，然后基线**冻结**——此后只有你的真实消息能改基线，agent 自己的推断不能。
3. **开始评审**：此后每次改动、每次宣布完成，都对照冻结基线检查。

第一次拦截通常长这样：

```text
[runtime-corrector] Terminal correction 1/3
任务未完成：README 要求的删除流程尚未实现。
- CR-003：材料要求滑动删除，但不存在任何删除路径
- M14：里程碑"列表交互"没有验证证据
继续任务并纠正上述偏差，或给出有证据的拒绝理由。
```

想看到并修改自动派生的配置：运行 `/runtime-corrector:init`，它会把派生结果物化为带注释的 `.runtime-corrector/config.yaml`。

## 3. 它与 coding agent 如何协作

### 什么时候触发

纠偏器挂在 Claude Code 生命周期 Hook 上，agent 在每个触发点是**同步暂停**的——反馈赶在下一步动作之前到达：

| 时机 | 纠偏器做什么 |
|---|---|
| 会话开始 | 校验/恢复本地状态；新任务则做基线建立（见上） |
| 你发消息 | 从你的话里提取新要求/变更，更新基线（唯一能改冻结基线的权威） |
| Skill 执行前 | 对照该 Skill 的冻结契约把关 |
| agent 写文件后 | 审阅该产物：确定性检查 + 隔离的语义评审 |
| agent 宣布完成 | 终止门：验收评审 + 实现检查（Kit 集成、构建/设备验证）→ 放行或拦截 |

### 信号怎么递回去

| 通道 | 性质 | 内容 |
|---|---|---|
| 上下文注入 | 建议性 | 前 3 条诊断 + 前 2 个候选补丁内联；完整清单的磁盘路径。补丁**绝不自动应用**，修复还是有据拒绝由 agent 决定 |
| Stop 拦截 | 强制性、有预算 | `decision: block` + 待办清单。只有硬性问题可拦截；试满 `maxCorrectionsPerEpoch` 次后放行并声明 `CORRECTION_BUDGET_EXHAUSTED` |
| 磁盘留痕 | 拉取式 | `.runtime-correction/` 下的完整诊断、账本、journal——agent 与人都可随时查阅 |

```text
.runtime-correction/
├── latest/<stage>/<artifact>/diagnostic.md   # 最新完整诊断
├── latest/<stage>/<artifact>/patch.diff      # 候选 Git Patch（绝不自动应用）
├── latest/<stage>/<artifact>/result.json     # 机器可读结果
├── runs/<stage>/<artifact>/<roundId>/        # 历史轮次归档
└── tasks/<taskId>/
    ├── ground-truth/current.md               # 冻结基线（人类可读）
    ├── evaluations/*.json                    # 各次评审报告
    └── journal/events.jsonl                  # 追加式事件流
```

### 评审员在哪里运行

每个评审员（抽取、裁定、Skill、产物、Stop、实现）都是**隔离的只读子会话**：只有 `Read`/`Grep` 两个工具，输出被 JSON Schema 强约束，跑完即释放。评审内容不会污染 agent 的上下文——除了上面那些有配额的反馈。

## 4. 五个名词

| 名词 | 含义 |
|---|---|
| Ground Truth（任务基线） | 从材料 + 你的消息中分解出的原子要求账本；建立后冻结 |
| 冻结 | 冻结后只有你的显式消息能增删基线条目，agent 推断永远不能 |
| finding（问题） | 一次评审发现的具体偏差，永远引用基线条目或客观证据 |
| 纠偏预算 | 终止门最多拦截几次（默认 3）；用完放行、问题留档——保证不困死会话 |
| 保证等级 | 本次验收实际验证到哪一层：static（静态）/ build（构建）/ device（设备），见 §6 |
| 开放问题 | 材料中的歧义会以"问题 + 默认安全解读"入基线，绝不虚构指令；你回一句话即可裁决 |

## 5. 配置

**多数项目不需要任何配置。** 需要时建 `.runtime-corrector/config.yaml`，优先级恒为：插件默认 < 自动派生 < 显式配置。

### 三个常用配方

```yaml
# ① 观察模式：只记录、零介入（用于对照评估）
shadowMode: true

# ② 关键门用独立模型交叉校验（推荐）：基线裁定 + 终止门
reviewers:
  modelPolicy:
    preset: critical-gates      # critical-gates = 上述两角色；all = 全部角色
    provider:
      baseUrl: https://api.example-provider.com
      apiKeyEnv: REVIEWER_API_KEY   # 环境变量的"名字"——配置里绝无机密
      model: example-reviewer-model

# ③ CI 强制设备级验证：没连设备算基础设施故障，直接拦截
implementationCorrection:
  device:
    mode: required
```

> **配置中没有机密。** `apiKeyEnv` 存的是环境变量*名字*；key 的值只在评审子进程环境中存在，绝不写入磁盘、journal 或日志。变量未设置时评审退回默认会话并记录 `REVIEWER_PROVIDER_DEGRADED`。

### 完整键参考

```yaml
version: 2                      # 2 启用运行时纠偏能力
locale: zh                      # 反馈语言

dynamicGroundTruth:
  enabled: true
  materialRoots: [docs/]        # 不写则自动发现
  panel:
    size: 2                     # 基线抽取 pass 数；0 关闭 onboarding
    adjudicator: true           # 怀疑式合并

stopCorrection:
  enabled: true
  maxCorrectionsPerEpoch: 3     # 终止门预算

implementationCorrection:
  enabled: true
  platform: harmonyos           # 平台适配器；不写自动识别；null 关闭 Kit 检查
  checklistPaths: [docs/kits.md] # 可选：显式 Kit 清单文档
  checklistSection: "10\\.1"    # 清单章节标题正则（默认按内容特征匹配）
  kitColumnIndex: 0             # 清单表中 Kit 名所在列
  device:
    mode: auto                  # auto=按环境降级 / required=CI 强制 / off=只静态
  deviceBudgetMs: 600000        # 构建/设备类验证的墙钟上限

evidenceRoots: [evidence]       # 证据唯一性守卫（不写则关闭）

output:
  directory: .runtime-correction
```

**评审角色。** 所有角色接受 `model`、`effort`、`timeoutMs`、`maxBudgetUsd`、`session`（`fork`/`independent`）、`provider`；`defaults` 兜底全部角色（effort `low`、超时 240 秒、session `fork`）。角色一览：`groundTruthExtractor`（材料→基线）、`onboardingAdjudicator`（合并冻结）、`skillReviewer`、`artifactReviewer`、`stopReviewer`（终止门）、`implementationReviewer`。显式角色配置始终优先于 `modelPolicy` 预设。

version 1 的产物/Stage 纠偏（逐文件硬规则、语义审阅、workflow 边）见 [docs/configuration.md](docs/configuration.md)；`/runtime-corrector:init` 会把完整参考保留为 `config.reference.yaml`。

### 命令

| 命令 | 作用 |
|---|---|
| `/runtime-corrector:init` | 把派生配置物化为可编辑的 `config.yaml` |
| `/runtime-corrector:help` | 项目感知的帮助与阶段状态 |
| `/runtime-corrector:validate` | 校验项目策略 |
| `/runtime-corrector:stages` | 查看/开关 v1 产物 Stage |
| `/runtime-corrector:explain <stage>` / `:spec <stage>` | 解释当前策略 / 完整 Stage 规范 |
| `/runtime-corrector:check <artifact>` | 手动检查一个产物 |

## 6. 验证深度：device / build / static

实现验收按环境条件自动选择验证深度。所有具体命令由平台适配器声明——核心不含任何平台命令：

| 档位 | 条件 | 实际执行 |
|---|---|---|
| `device` | 探测到设备/模拟器 + 工具链 | 构建门 + 安装/启动/截图冒烟 |
| `build` | 仅有工具链 | 构建门（同源缓存，不重复构建） |
| `static` | 皆无 / 平台未声明 / `mode: off` | 静态核验 |

三条纪律：**缺设备只降低保证等级，绝不改变判定方向**——跑不了的检查一律跳过并记录原因（绝不判通过，也绝不算 agent 的偏差）；真正跑了且客观失败的（构建报错、启动崩溃）才是拦截性问题；每次验收反馈都带一行保证等级声明，静态绿灯永远不会冒充设备级绿灯。

## 7. 出问题时

插件**失败即放行**：自身故障绝不阻塞开发。排障看 `.runtime-correction/tasks/<taskId>/journal/events.jsonl`：

| Journal 事件 | 含义 | 处置 |
|---|---|---|
| `DERIVED_CONFIG` | 信息性：自动派生了哪些材料/平台 | 无需处理；想覆盖就 `/runtime-corrector:init` |
| `ONBOARDING_DEGRADED` | 基线建立失败；退回增量抽取，账本未冻结 | 多为瞬时；检查评审超时/预算，会自动重试 |
| `REVIEWER_PROVIDER_DEGRADED` | 独立 provider 不可用；该次评审退回 fork | 导出 `apiKeyEnv` 指名的环境变量 |
| `STOP_ASSESSMENT_FAILED` | 终止评审出错；本次放行（fail-open）并留档 | 查看记录的错误；下次 Stop 重试 |
| `SKILL_REVIEW_FAILED` / `STOP_REVIEW_FAILED` | 某次隔离评审崩溃；标记 `UNVERIFIED` | 瞬时故障；反复出现再排查 |
| `DEVICE_VERIFICATION_UNAVAILABLE` | 无设备/工具链；验证降档并声明 | 按需连接设备；CI 用 `device.mode: required` |

Hook 自身崩溃时输出有限次的 `[runtime-corrector] v2 features failed open` 提示（观察模式下完全静默），会话继续。

## 8. 设计保证

- **只读评审。** 评审子进程仅有 `Read`/`Grep`；一切内容当证据而非指令。
- **绝不代改。** 不修改项目文件、不自动应用补丁；变更决定权在主 agent。
- **任何地方都没有机密。** 代码无端点/key 字面量；配置只存环境变量名字。
- **平台即数据。** 平台约定（模块命名、源码目录、设备命令）是 `config/platforms/*.json` 数据；未知或 `null` 平台只是跳过相应检查。
- **确定性检查与模型无关。** 硬规则、Kit 集成、构建门、证据唯一性、闭环归因都是纯代码，可复现。
- **不接管实例决策。** 插件不负责决定用户是在继续旧 change 还是创建新 change，也不会按修改时间选择“最新”文件；只配置 `patterns` 而不配置 correlation 时，所有命中文件按设计同属一个 legacy bundle。
- **观察模式。** `shadowMode: true` 记录完全相同的检测但零介入。

## 更多文档

完整导航见 [docs/README.md](docs/README.md)：

- v2 设计与配置：[docs/runtime-corrector-v2-design.md](docs/runtime-corrector-v2-design.md)
- v1 产物/Stage 配置与规则：[docs/configuration.md](docs/configuration.md)
- 一轮纠偏的端到端机理：[docs/how-it-works.md](docs/how-it-works.md)
- 命令、CLI、Hook JSON、自定义 Matcher：[docs/interfaces.md](docs/interfaces.md)
- 教程：[docs/tutorial.md](docs/tutorial.md)、[docs/six-stage-workflow-from-zero.md](docs/six-stage-workflow-from-zero.md)
- `examples/` 下可直接复制的业务示例
