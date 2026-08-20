# PRD Contract Stage 全局规范

这是 `PRD.md` 的完整格式与语义地图。只修改 PRD；IR、Planning 和 Selection 是只读事实源。

## Bundle

默认输入：

- `ir.md`
- `PilotPlan.md`
- `relations.json`
- `granularity-choice.json`
- `kit-map.md`
- `PRD.md`

## 十个 H2 章节

章节必须使用 H2（`##`），允许数字前缀，正文不得为空。推荐精确标题：

```markdown
## 1. Overview
## 2. Input Source Trace
## 3. Feature Kit Mapping Table
## 4. Data Structures And Keys
## 5. Permission Matrix
## 6. Routes And Module Placement
## 7. Acceptance Checklist
## 8. Assumptions And Open Questions
## 9. Implementation Guardrails
## 10. External Configuration Placeholders
```

中文别名可被识别，但使用上述标题最稳定。

## 确定性格式要求

- 禁止 `TBD`、独立 `TODO`、`needs-input`、`待补充`、`待填写` 和 `{{...}}`。
- Feature Kit Mapping 对 Planning 中每个 SR 至少有一行。
- 每个 SR 映射行必须包含具体目标文件路径，路径至少包含一个 `/`，并以 `.ets`、`.ts`、`.js`、`.json`、`.json5`、`.xml` 或 `.md` 结尾。
- 每个 SR 映射行必须提到 kit-map 为该 SR 选定的全部 Kit。
- Acceptance Checklist 对每个 SR 至少有一行，或一个 H3-H6 `SR-n` 子章节。
- 每个 SR 验收行/子章节必须包含稳定的大写 `_OK` ID，例如 `AC_ADD_OK`。
- Input Source Trace 必须记录现有 IR、PilotPlan/Planning 和 Kit Map/Selection；现有文件不得标为表格中的 `missing`。

## 推荐骨架

```markdown
# PRD: <项目名称>

## 1. Overview
<本期闭环、HarmonyOS 平台、范围外>

## 2. Input Source Trace
| Input | Source class | Summary |
|---|---|---|
| Intent Requirements (IR) | upstream | ... |
| Pilot Plan (Planning) | upstream | ... |
| Kit Map (Selection) | upstream | ... |

## 3. Feature Kit Mapping Table
| SR | Feature | Kits | Target files |
|---|---|---|---|
| SR-1 | ... | arkui | entry/src/main/ets/pages/Index.ets |

## 4. Data Structures And Keys
...

## 5. Permission Matrix
...

## 6. Routes And Module Placement
...

## 7. Acceptance Checklist
| SR | Check | Evidence expectation |
|---|---|---|
| SR-1 | AC_VIEW_OK: <动作与可观察结果> | runtime observation |

## 8. Assumptions And Open Questions
...

## 9. Implementation Guardrails
...

## 10. External Configuration Placeholders
...
```

## 语义要求

- Overview 忠实说明产品闭环、平台和范围外。
- Data Structures 区分唯一 ID、状态归属和存储；不得把内存态偷偷扩成持久化。
- Permission Matrix 与已选 Kit 一致；无权限时明确 `none`。
- Routes 与 Mapping Table 的目标文件一致。
- 验收必须可执行、可观察；新增覆盖非空输入和立即可见，删除验证只删除目标项。
- Assumptions 区分用户事实、必要推断、可逆默认和待确认项。
- External Configuration 只记录真实签名、设备或外部服务配置，不虚构后端/账号/网络。

## 通过条件

- 十个 H2 章节存在且非空；
- 每个 Planning SR 都有 Kit/目标文件映射和 `_OK` 验收；
- 来源记录与实际文件一致；
- PRD 内 SR、Kit、路径、状态和范围互相一致；
- 当前 `prd-contract.rules.yaml` 与 reviewer 均通过。

## Patch 规则

章节正文、SR 映射、路径和验收属于语义内容。插件无法安全推导时不会生成 Patch；反馈必须明确 Patch 数量和原因，并提供本完整规范包。
