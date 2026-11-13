# 纠偏检查体系

RC 的纠偏不是“什么都纠”，也不是“只看用户一句话”。每个检查项都要回答同一组问题：依据哪段原文、本次需求是否触发、Stop 能否判断、现在是否该检查。这套体系由三部分组成：五个指标族、任务开始时的检查项提议者，以及 Stop 终审。M01–M16 的编号和开关保持不变。

## 准入规则

一个条目进入纠偏清单，必须同时满足：

1. **原文权威**：绑定用户消息、项目文档或已加载 Skill 的具体行。程序或模型生成的文字只是检查方法，与原文不一致时以原文为准。
2. **当前触发**：完成本次需求会触发它。只在更窄条件下生效的规则保留其条件，Stop 按条件判断是否适用。
3. **可以判定**：Stop 能从源码、文档或执行记录判断是否满足。
4. **时机正确**：属于已经交付的工作。尚未开始的后续输出不算偏差。

不满足任一条的内容不进入清单，也不会为了得分而要求 agent 补写文档或调用 Skill。整个流程不向用户提问，也不替用户做需求决定。

## 五个族

| 族 | 指标 | 原文来源 | 谁提出检查项 |
|---|---|---|---|
| `clarification` 需求澄清 | M01–M07 | 需求、验收、测试契约等工作流工件 | Stop 审查员从原文建立 |
| `skills` Skill 遵循 | M08 | 本任务实际加载的 `SKILL.md` | Skill 规则图；过程中由 Skill 看护实时纠偏 |
| `projectRules` 项目规则 | M09–M11 | `AGENTS.md`、`CLAUDE.md` 和其它项目文档 | 项目规则提议者，以及 Stop 审查员 |
| `fulfillment` 需求实现 | M12、M16 | 用户消息 | Stop 审查员；需求框架的 G/S 提示辅助 |
| `verification` 验证闭环 | M13–M15 | 项目定义的验收、完成标准、里程碑和关键旅程 | 验证要求提议者，以及 Stop 审查员 |

族开关 `stopCorrection.families` 设为 `false` 时关闭成员指标，见 [Stop 指标开关](stop-metric-switches.md)。

Skill 纠偏沿用现有的 Skill 看护（`skillCorrection.enabled`）和 M08：只检查本任务实际加载的 Skill，不限定某个 Skill 套件。项目文档中“修改某类代码时必须使用某个 Skill”这类规则由项目规则提议者作为 M11 PROCESS 检查项提出；Skill 自身的步骤不重复提出。

## 流程

1. **任务开始**：需求框架（`requirementFrame`）在后台读取任务开始时的 Git 提交。代码提议者产生实现提示 G* 和行为场景 S*。开启 `requirementFrame.checks` 后，每个有开启指标的族各运行一个检查项提议者，扫描仓库中的 Markdown 文档。`AGENTS.md` 和 `CLAUDE.md` 排在最前；`SKILL.md`、`node_modules`、`.git` 和 RC 状态目录被排除。
2. **过滤**：
   - 程序先校验：引用的文档和行号存在且少于 80 行，指标属于本族且已开启，义务文字和触发说明都非空。义务限 600 字，采用引用行的短原文摘录（允许规范空白），拒绝新增细节；能识别的整条义务前置条件必须原样保留在 applicability 中。分号、换行及条件分支本身不代表多个检查目标，后续分支的条件不能被误当成整条义务的前提。
   - 选择器再逐条审查：引用行本身是否陈述了义务，用户消息是否触发它，它是否不是 Skill 步骤、需求复述、描述或风格偏好。一个条目只检查一种目标，文件结果与修改、回读等过程动作须拆开；原前提和例外不得被 activation 放宽。语义忠实度、隐含条件和复合动作仍需选择器审查，程序不声称能完整理解自然语言。
   - 最后保留置信度不低于 0.75 的项，每族最多 5 项，总数最多 10 项，编号为 K1、K2……。
3. **简报**：选中的检查项作为“完成前要遵守的项目规则”送达 agent，与 G/S 提示同一条消息。
4. **过程**：Skill 看护按已加载 Skill 的要求检查调用和步骤。
5. **Stop 终审**（仅 `stopCorrection.originalRequirementsBasis` 模式）：
   - 审查员读完必读原文后，用 `set_original_checklist` 建立自己的清单。
   - 程序随后按原文位置把 K 项并入清单，`review_checklist` 中这些条目带有 `proposedCheck` 标记。
   - 在 `deviationOnly` 模式下，每个 K 项都要在 `finish_stop_review.frameDispositions` 中给出处置：成立或不适用为 CHECKED，已保存偏差为 DEVIATION，无法判断为 UNVERIFIED。
   - 在完整审查模式下，K 项与普通条目一样逐项给出结论。

## 提议者与终审的分工

- **提议者负责找**：在任务开始时扫描文档并定位到具体行，终审不需要再在全仓库搜索项目规则。
- **终审负责判**：K 项只是候选，引用行决定义务是否存在。引用行没有陈述约束、或本需求没有触发它时，K 项不构成偏差。
- **去重**：审查员建立的条目若与 K 项完全相同（指标、文字、条件、目标和行号一致），两者共用一个 objectId，只审一次。提示词也要求审查员不要换个说法重建 K 项。上一轮已交付的偏差优先沿用原编号。
- **跨文档去重与归属**：选择器只保留一条同义义务；程序按规范化的义务、条件、目标去重，不再把文档路径和指标差异视为新的义务。代码、文档或编码的结果属性归 M09；引用原文明确说明的历史经验才归 M10；命令、顺序和修改后回读归 M11；验收结果归 M13；显式里程碑归 M14；命名的端到端旅程归 M15。正确指标关闭时不转投其它指标。
- **冻结依据**：每个 K 项绑定任务开始时文档的副本及其 sha256。任务中修改文档不会改变检查依据；副本内容不符的 K 项被丢弃。

## 配置示例

```yaml
version: 2
artifactCorrection:
  originalRequirementsEnabled: true
skillCorrection:
  enabled: true
requirementFrame:
  enabled: true
  checks: true
stopCorrection:
  enabled: true
  originalRequirementsBasis: true
  deviationOnly: true
  families:
    clarification: false
  metrics:
    M11: true
```

## 限制

- 检查项需要 OpenClaw 宿主和需求框架；Stop 只在原文清单模式下使用它们。
- 只扫描 `.md`、`.markdown`、`.mdx` 文件，单个文件不超过 1 MB，最多 200 个。
- `clarification` 和 `fulfillment` 没有单独的检查项提议者：前者依赖工作流工件，由 Stop 从原文建立；后者由需求框架的 G/S 覆盖。
- 提议者与审查员都可能出错。检查项只决定“看什么”，不决定“是否违反”；偏差仍需要具体反证。

## 代码位置

- `lib/runtime-v2/metric-policy.mjs`：`STOP_METRIC_FAMILIES` 与族开关展开。
- `lib/runtime-v2/requirement-frame.mjs`：检查项提议者、校验、选择、文档副本、简报、`readStopFrame` 和 K 项处置计数。
- `lib/runtime-v2/stop-workspace-review.mjs`：K 项来源注册、并入清单、去重和处置校验。
