# 六阶段到 PRD 与 Build QA：完整受控 Workflow

本文把[六阶段 Workflow](six-stage-workflow-from-zero.md)继续串到 PRD Contract
和 Build QA。完整可复制资产：

- [Prompt Workflow YAML](../examples/veripilot-guarded-delivery/guarded-delivery-workflow/guarded_delivery_workflow.yaml)
- [Runtime Corrector 配置](../examples/veripilot-guarded-delivery/guarded-delivery-workflow/.runtime-corrector/config.yaml)
- [Planning projection 发布脚本](../examples/veripilot-guarded-delivery/guarded-delivery-workflow/scripts/publish-planning-projection.mjs)
- [逐步完成报告 Schema](../examples/veripilot-guarded-delivery/guarded-delivery-workflow/.runtime-corrector/schemas/stage-completion.schema.json)
- [运行 Skill 示例](../examples/veripilot-guarded-delivery/run-guarded-delivery/SKILL.md)

这版流程有一个刻意的设计：**不调用 Planning 插件，也不调用 IR 插件**。当前
Agent 直接从六阶段原始文档生成 `SR.md`、`PilotPlan.md`、`relations.json` 和
`granularity-choice.json`；PRD Contract 与 Build QA 仍完整使用各自的公开
`workflow auto` 黑盒。

## 1. 总体结构

```text
六阶段 6 份原始文档
        │
        ├── Agent 生成 Planning 四件套
        │        │
        │        └── Runtime Corrector Gate A：6 → 4
        │
        └── guarded-delivery 发布标准 delivery manifest
                         │
                         ▼
                  PRD Contract auto
                         │
                         ├── PRD.md
                         ├── acceptance-contract.json
                         └── 其他组件协议产物
                         │
                         └── Runtime Corrector Gate B：4 → 2
                                      │
                                      ▼
                               Build QA auto / scope all
                                      │
                                      ▼
                               完成后执行证据审计
                                      │
                                      ▼
                                  交付总结
```

两个产品语义 Gate 的文件范围是硬边界：

| Gate | Baseline | Subjects | 明确排除 |
|---|---|---|---|
| Stage 85 | 六阶段六份原始输出 | `SR.md`、`PilotPlan.md`、`relations.json`、`granularity-choice.json` | planning-source、IR、manifest/handoff |
| Stage 95 | Planning 四件套 | `PRD.md`、`acceptance-contract.json` | `traceability.json`、manifest/handoff、Build QA evidence |

因此 Runtime Corrector 回答两个问题：

1. Planning 四件套有没有遗漏、冲突或扩张六阶段意图？
2. PRD 两件套有没有遗漏、冲突、重切或扩张 Planning 四件套？

它不通过“多读一些文件”增加看似更全面、实际会混淆权威层次的证据。

## 2. 为什么不需要 IR.md

PRD Contract 的公开输入协议接受结构、身份、能力和 hash 有效的
`veripilot.delivery_manifest.v2`。所以本 Workflow 可以把 Agent 生成的 Planning
四件套发布成标准 delivery manifest，再通过 `--source-manifest` 交给 PRD。

发布者明确写成：

```yaml
producer:
  kind: orchestrator
  component_id: guarded-delivery
  version: 3.1.0
```

这不会冒充 Planning 插件，也不会伪造 `stages/20-planning/output/manifest.json`。
四件套位于：

```text
VeriPilotWorkspace/guarded-current/delivery/planning-projection/
├── SR.md
├── PilotPlan.md
├── relations.json
├── granularity-choice.json
└── manifest.json
```

因此本链路不需要 `IR.md`。只有未来某个消费者明确把 IR domain handoff 设为硬输入
时，才应新增 IR adapter；不能因为“可能有用”就扩大当前流程。

## 3. 为什么仍然创建统一 workspace

虽然不运行 IR/Planning，PRD Contract 和 Build QA 仍需要同一 VeriPilot v2
workspace identity、stage registry、request manifest 和 protocol capabilities。

Stage 70 只调用一次：

```text
/veripilot-v2:veripilot new "<planning-source.md>"
  --project-root "<project>"
  --workspace-name "guarded-current"
  --mode auto
```

一旦返回 `workspace_created` 就停止。禁止调用 `advance`，也禁止顺势启动 VeriPilot
内建的 IR/Planning pipeline。

若 `VeriPilotWorkspace/guarded-current` 已存在，必须先核对：

- `workspace.json` 的 request/workspace identity；
- active profile 与 stage locations；
- `input/manifest.json` 的 request、project、attachment hashes；
- planning-source 附件与当前源文件的 byte SHA-256；
- workspace 当前没有 recovery/reconcile blocker。

身份或 hash 不一致时不能手工修补协议文件。

## 4. Planning 四件套如何生成

Stage 80 由当前 Agent 直接写四个文件，不调用任何 Planning command。

### `SR.md`

- 每个 `SR-N` 都能追溯到六阶段需求、拆分、验收、方案或测试标识；
- 包含 Description、Acceptance、Dependencies、Priority、External conditions；
- 不把代码候选、测试手段或实现偏好提升成新产品能力。

### `PilotPlan.md`

- 使用稳定的 `## M<N>: 标题`；
- 每个 Milestone 明确列出 `Contains SR`；
- 每个 SR 恰好属于一个 Milestone；
- Milestone 是独立可验证增量，不为追求平均大小而改写业务边界。

### `relations.json`

- 声明 SR 与 Milestone 节点；
- `contains` 表达唯一归属；
- `requires` 只表达真实硬依赖；
- 禁止悬空引用、自环和依赖环。

### `granularity-choice.json`

- 记录 recommended、selected、milestone count、groups 和选择理由；
- groups 必须与 PilotPlan、relations 完全相同；
- auto 选择只能记录为 auto policy，不能写成人工批准。

Runtime Corrector 的 `planning-projection` node 把六阶段六份文件声明为直接入边。
四件套由 Agent 所有，因此候选 Diff 只允许指向这四个目标文件。

## 5. Planning projection manifest

Stage 85 通过后运行：

```powershell
node "<runtime-corrector>\examples\guarded-delivery-workflow\scripts\publish-planning-projection.mjs" `
  --workspace-root "<project>\VeriPilotWorkspace\guarded-current" `
  --source-root "delivery/planning-projection"
```

脚本只做确定性协议工作：

1. 读取 `workspace.json` 的 identity 和 negotiated capabilities；
2. 要求四个精确文件存在；
3. 计算每个文件当前 byte SHA-256；
4. 生成 `veripilot.delivery_manifest.v2`；
5. 使用与 VeriPilot protocol v2 相同的 canonical JSON envelope hash；
6. 把 producer 标记为 `guarded-delivery`。

恢复执行时用 `--check`，不会用旧 manifest 覆盖新源文件，也不会信任过期 hash。

## 6. PRD Contract auto

Stage 90 的唯一合法调用是：

```text
/prd-contract:workflow auto
  --workspace-root "<workspace>"
  --stage-id 40-prd-contract
  --source-manifest "delivery/planning-projection/manifest.json"
  --mode auto
```

不允许：

- 改成 prompt-only；
- 用 `--source-artifact` 绕开 manifest；
- 临时调用 Planning 插件“补一个标准输出”；
- 直接执行 PRD 内部 `prepare-input`、reviewer、publication 私有步骤；
- 手改 PRD、acceptance、traceability、manifest、handoff 或 runtime state。

PRD public terminal status 只有 `verified` 才能进入 Stage 95。`needs_human` 和
`blocked` 原样传播，并保留组件返回的唯一合法恢复动作。

Stage 95 只把：

```text
Planning: SR.md + PilotPlan.md + relations.json + granularity-choice.json
PRD:      PRD.md + acceptance-contract.json
```

放进产品语义比较。PRD 自己可以继续发布 `traceability.json`，但它不参与这个
Corrector Gate。

## 7. Build QA auto

Stage 100 先检查：

- Stage 85 与 Stage 95 control receipts 已通过；
- Planning projection manifest 的 identity、capabilities、四文件 hash 闭包有效；
- PRD output manifest 与 handoff 的 identity、lineage 和 hash 闭包有效；
- handoff 里程碑不超过 7；
- Stage 115 的显式证据集合预计不超过 120 个文件。

Stage 0 不自行断言 Harmony SDK 是否可用，也不要求业务项目根目录包含
`hvigorw`，更不要求 `local.properties` 或调用进程环境变量写死 SDK 路径。
工具链发现、同一安装包一致性校验和环境准入由 Build QA 3.6.0 在 Stage 110
独占完成；它能够发现 DevEco Studio 或 Command Line Tools 提供的 SDK、JBR、
Node、Hvigor、HDC、Previewer 与 Emulator。外层 Workflow 只传播其公开结果。

随后只调用：

```text
/build-qa-loop:workflow auto
  --workspace-root "<workspace>"
  --stage-id 50-build-qa-loop
  --target-project "<project>"
  --source-manifest "stages/40-prd-contract/output/manifest.json"
  --scope all
  --mode auto
```

Build QA 不需要再接收 Planning manifest；PRD output 已持有上游 lineage。禁止
同时传 `--milestone-dir`，也不能从外部拆解或替代 Build QA 的 input reviewer。

Stage 115 是完成后审计，只读取明确列名的：

- `input/execution-contract.json`
- `deliverables/milestone-result.json`
- `deliverables/evidence-chain.json`
- `deliverables/changed-files.json`
- `output/manifest.json`
- `output/handoff.json`
- `delivery/milestones/*/manifest.json`

它不使用 `deliverables/*`、`reports/*.md` 或 `output/*.json` 泛扫，也不声称
Runtime Corrector 在 Build QA 黑盒内部暂停过执行。

## 8. 每步完成报告

Workflow 共 18 个 Stage，包括最终 summary。每次尝试后都写：

```text
.workflow/current/reports/<order>-<stage>.completion.json
```

报告状态只有：

- `completed`
- `needs_human`
- `blocked`
- `not_run`

每份报告记录：

- stage、attempt、开始/结束时间；
- 输入/输出路径与真实 SHA-256；
- deterministic 与 agent review 结果；
- 组件 terminal status 与 manifest hash；
- diagnostics、blockers、唯一 next stage/action；
- `human_approval_recorded`。

如果中途停止，后续 Stage 写 `not_run`，Stage 120 仍生成 `incomplete` summary。
Stage 120 自己的 completion report 只能在 summary Gate 通过后写，不能形成自引用
hash。

## 9. 安装

在尚未安装 Runtime Corrector 策略的业务项目中：

```powershell
$runtimeCorrectorRoot = "C:\tools\runtime-corrector"
Copy-Item "$runtimeCorrectorRoot\examples\guarded-delivery-workflow\.runtime-corrector" ".runtime-corrector" -Recurse
Copy-Item "$runtimeCorrectorRoot\examples\guarded-delivery-workflow\guarded_delivery_workflow.yaml" "guarded_delivery_workflow.yaml"
```

如果 `.runtime-corrector` 已存在，不要直接覆盖。对照合并以下内容并由维护者确认
策略 Diff：

- 六阶段节点和原有直接入边；
- planning-source、planning-projection 与两个精确语义 Gate；
- Planning/PRD publication 协议节点；
- Build QA handoff/post-audit 和 delivery summary；
- 新规则、Reviewer 与 Schema。

这是一次策略变更，不应在无人知情时自动吞掉客户已有定制。

## 10. 验证与运行

先验证配置：

```text
/runtime-corrector:stages
/runtime-corrector:explain planning-projection
/runtime-corrector:spec planning-fidelity-gate
/runtime-corrector:spec prd-deliverables-gate
```

然后在目标业务项目根目录使用：

```text
$run-guarded-delivery
```

Skill 会完整读取 YAML，确认真实项目路径，按顺序执行并写每步报告。

## 11. 可以与不能声称的结果

完成后可以声称：

- 六阶段六份来源经过当前 hash 的 Runtime Corrector 验证；
- Agent 直接生成的 Planning 四件套与六阶段一致；
- PRD 两件套与 Planning 四件套一致；
- Planning/PRD 协议 hash 闭包有效；
- PRD Contract 与 Build QA 使用 auto；
- Build QA 全里程碑结果经过完成后证据审计；
- 每个 Workflow Stage 都有完成情况报告。

不能声称：

- Planning 或 IR 插件被调用过；
- `stages/20-planning` 是标准 Planning 组件输出；
- traceability、manifest 或 handoff 接受了产品语义审查；
- auto/verified 等于用户人工批准；
- Runtime Corrector 在 Build QA 黑盒内部暂停了实现；
- 超过收集上限的抽样证据等于全量审计。
