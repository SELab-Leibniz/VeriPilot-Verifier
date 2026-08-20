# Selection Stage 全局规范

这是 `kit-map.md` 的完整格式与语义地图。以下语法来自实际确定性解析器，不需要读取插件测试或 JavaScript 猜测。

## Bundle 与修改边界

默认输入：`ir.md`、Planning 三件套、`kit-map.md`。只修改 `kit-map.md`；IR 和 Planning 是只读事实源。

## 文档前导区：精确语法

H1 标题后必须出现两条非空裸行：

```markdown
# Kit Map: <项目名称>

Input status: <输入状态及来源>
Input confidence: <输入置信度及不确定性>
```

强制要求：

- 行首只能有空白，随后必须直接是 `Input status:` 或 `Input confidence:`；
- 不得写成 `- Input status:`、`* Input status:` 或 `## Input status:`；
- 冒号可用 `:` 或 `：`；
- 冒号后必须有非空值。

## 逐 SR 章节

Planning 中每个 SR 都必须有且只有一个对应章节；可用 H2 到 H6，推荐 H2：

```markdown
## SR-1 <需求名称>

- Selected kits: ability-kit, arkui
- Rationale: ability-kit 承载 UIAbility；arkui 实现页面和本地状态。
- References: recall=unavailable; 使用本地 Ability Kit 与 ArkUI 参考。
- Rejected candidates: arkdata，因为当前 Planning 不要求持久化。
- Recipe: ability-kit -> arkui
- Confidence: auto-pass; recall=unavailable; auto_selected_recommended
- Open questions: none; non-blocking
```

每个 SR 必须包含七个非空字段：

1. `Selected kits`
2. `Rationale`
3. `References`
4. `Rejected candidates`
5. `Recipe`
6. `Confidence`
7. `Open questions`

字段允许 `- ` bullet、无 bullet 或粗体 label；推荐固定使用上面的 bullet 格式。`Selected kits` 不得为 `none`。单 Kit 时 `Recipe: none` 合法。

`Confidence` 至少包含一个可识别标记：`auto-pass`、`ask-human:<reason>`、`provisional-<source>`、`confirmed`、`needs_confirmation`、`recall=<status>` 或 `auto_selected...`。

## 占位符与 SR 集合

- 禁止 `TBD`、独立 `TODO`、`needs-input`、`待补充`、`待填写` 和 `{{...}}`。
- SR ID 从 Planning 的 relation nodes 与 PilotPlan 中收集并归一为 `SR-<n>`。
- 缺少 Planning SR 会失败；新增 Planning 不存在的 SR 也会失败。

## 语义要求

- 每个 SR 选择满足需求的最小 HarmonyOS Kit 集。
- 每个选入 Kit 在 Rationale 中承担具体职责。
- References 必须是真实本地文档、真实 recall 结果，或诚实声明 `recall=unavailable`。
- Rejected candidates 记录真实候选和弃选理由；没有候选时写 `none`。
- Open questions 只保留会改变 Kit 决策的真实缺口，并标明是否阻断。
- 不得借 Selection 引入 Planning 未声明的登录、同步、通知、搜索、标签、编辑、完成态等功能。

## 通过条件

- 文档前导区精确匹配；
- Planning 中每个 SR 都有完整七字段章节；
- 没有未规划 SR 或占位符；
- 当前 `selection.rules.yaml` 通过；
- Reviewer 确认 Kit 最小、证据真实、范围忠实。

## Patch 规则

如果 `Input status` / `Input confidence` 已有值但误写成 bullet，插件可以生成只移除 bullet 的确定性 Patch。字段完全缺失或值需要语义判断时，插件不会编造值；反馈会明确显示 Patch 数量为 0，并要求按本规范补写。
