# 纠偏插件状态显示统一方案

状态：已实施（2026-11-24）。修改文案时同步更新 `lib/openclaw/ui/status-copy.mjs` 与本文档。

目标：MA 输入框上方的状态行只说明纠偏插件在做什么、评审结果是什么，不提及 MA，也不描述 MA 的状态。控制台的状态栏预览与 MA 实际显示一致。以后修改措辞只改一张文案表，新增状态只加一条判定规则和一行文案。

## 已确认的需求

1. 所有用户可见的 “RC” 换成“纠偏插件”，范围包括输入框状态行、控制台和 MA 对话里的工具进度卡片。
2. MA 正在处理业务时，状态行不显示。
3. “正在终审”改为“评审中”。
4. 发现偏差后，无论是等待修复启动、修复运行中，还是修复期间的后台检查，都显示“纠偏评审结果：有偏差，正在自动修复”。
5. 修复运行结束后进入重新评审，显示“修复完成，重新评审”。
6. 空闲或结束且没有偏差，显示“纠偏评审结果：无偏差”。
7. 插件崩溃、评审未完成时，状态行也显示“纠偏评审结果：无偏差”。内部仍保留独立的状态名，控制台详情显示真实结论。
8. 结束时仍有偏差（修复次数用完、宿主拒绝反馈等），显示“纠偏评审结果：有偏差”。
9. 原始轮的后台检查要显示，例如“纠偏插件 正在后台检查”。
10. “新消息暂不可发送”一律不显示。修复期间 MA 仍然保留草稿、暂缓发送，这个行为不变。

## 现状问题

- **一行文字由三处拼成。** `lib/openclaw/session-runtime-text.mjs` 先生成 `display.line`。MA 补丁 `patches/rc-composer-status/renderer.js` 又在后面追加评审结论、Agent 活动和“当前无纠偏 Agent 在运行”，自己还另有 6 条 “RC · ...” 兜底文案。控制台 `lib/openclaw/ui/post-run.mjs` 也有自己的兜底。结果是控制台的状态栏预览和 MA 实际显示并不一致。
- **功能判断依赖中文文案。** 圆点是否脉动，看的是 `display.agents === "正在运行"`。控制台修复列表（`post-run.mjs` 第 151 行）也这样判断。改了这几个字，判断就会失效。
- **显示层不知道当前是不是修复轮。** 修复运行只能靠 `runId` 的 `rc-stop-` 前缀识别。这个判断分散在 `runtime.mjs`、`stop-start-protocol.mjs`、`repair-step-budget.mjs`、`session-runtime-details.mjs` 四个文件里。`list()` 返回的数据也没有 `runId`。
- **判断条件和措辞写在同一串 if/else 里。** 改一句话，得先读懂整段的优先级。

## 方案：先判断状态名，再查文案表

1. **新增 `lib/openclaw/ui/status-copy.mjs`。** 纯数据文件，不依赖 Node，插件端和控制台页面都能直接引用。内容包括品牌名 `BRAND`、状态文案表 `STATUS`（每个状态名对应文字和圆点样式）、后台检查文案表，以及控制台用的固定文字。
2. **`session-runtime-text.mjs` 改成先判断、再取文案。**
   - `classifySessionStatus(snapshot)` 按下文的有序规则，把当前状态归成一个状态名，只做判断。
   - 再用状态名查表，输出 `display.key`（状态名）、`display.line`（最终完整的一行，任何一端都不再追加）和 `display.indicator`（圆点样式：`running` / `waiting` / `passed` / `idle`）。
   - `round`、`agents`、`review`、`activities` 继续保留给控制台详情使用。
3. **快照增加 `repairRound`。** 在 `session-runtime-status.mjs` 中计算，`list()` 返回的数据也带上。同时把 `rc-stop-` 判断收拢成共享的 `isRepairRunId()`。
4. **MA 补丁 `renderer.js` 只负责显示。**
   - 直接显示 `display.line`；状态名为 `hidden` 时整行不渲染。
   - 圆点颜色和脉动看 `display.indicator`。
   - 删除追加详情的逻辑、对中文文案的比较，以及“已开启，等待本轮开始”这个特殊判断。
   - 本地只保留拿不到插件数据时的兜底文案。
5. **控制台。** 状态栏预览直接显示 `display.line`，修复列表改用结构化字段判断，固定文字改用 `BRAND`。
6. **工具进度卡片。** 只替换品牌名，措辞不变。这些文字只用于界面事件，不进入模型上下文。

不改动的部分：报错信息、日志、发给模型的纠偏反馈，以及 `CONTEXT.md` 中的术语。

## 状态文案表（可直接修改）

修改措辞时，只改“状态行显示”和“圆点”两列。新增状态时加一行，并在附录中补上判定条件。表格按匹配顺序排列，命中第一条即停止。

圆点取值：`running` 为绿色脉动，`passed` 为绿色，`waiting` 为琥珀色，`idle` 为灰色。

| 状态名 | 场景 | 状态行显示 | 圆点 |
|---|---|---|---|
| `stopping` | 正在停止本轮 | 纠偏插件 正在停止纠偏 | `waiting` |
| `terminated` | 用户手动停止了本轮 | 纠偏插件 本轮纠偏已停止 | `idle` |
| `aborted` | 确认插件崩溃或进程已退出 | 纠偏评审结果：无偏差 | `idle` |
| `sessionOff` | 本会话纠偏已关闭 | 纠偏插件 本会话纠偏已关闭 | `idle` |
| `armed` | 已开启，本轮还没开始 | 纠偏插件 已开启，等待本轮开始 | `idle` |
| `unregistered` | 本会话还没有纠偏记录 | 纠偏插件 尚无纠偏记录 | `idle` |
| `repairing` | 等待修复启动、修复中、修复轮里的运行和后台检查，或评审有偏差且仍保留输入 | 纠偏评审结果：有偏差，正在自动修复 | `running` |
| `rereviewing` | 修复轮进入收尾、排队或评审 | 修复完成，重新评审 | `running` |
| `reviewing` | 原始轮进入收尾、排队或评审 | 纠偏插件 评审中 | `running` |
| `background` | 原始轮运行中，且有后台检查 | 纠偏插件 {后台检查文案} | `running` |
| `hidden` | 原始轮运行中，没有后台检查；或正在启动下一轮 | （不显示） | — |
| `passed` | 结束，验收通过 | 纠偏评审结果：无偏差 | `passed` |
| `noDeviation` | 空闲或结束，结论为无偏差，或还没有结论 | 纠偏评审结果：无偏差 | `passed` |
| `deviationLeft` | 结束但仍有偏差 | 纠偏评审结果：有偏差 | `waiting` |
| `reviewIncomplete` | 结束，但评审超时、失败、取消或被配置关闭 | 纠偏评审结果：无偏差 | `idle` |

说明：

- `aborted` 和 `reviewIncomplete` 的文字按需求显示“无偏差”，圆点用灰色，以便和真正的无偏差区分开。如果希望显示绿色，把圆点改成 `passed` 即可。
- 插件暂时联系不上宿主（状态“待核对”）时不单独显示，沿用当前阶段的显示，避免修复中途闪一下“无偏差”。

### 后台检查文案

`background` 一行中的 `{后台检查文案}` 按当前检查类型取值。多项检查同时进行时，状态行只显示最新的一项，完整列表在控制台的“当前纠偏 Agent”中显示。

| 检查类型 | 文案 |
|---|---|
| `requirement-frame` | 提议 Agent 正在生成需求简报 |
| `background-review` | 正在后台检查 |
| `onboarding-extractor` | 正在提取需求 |
| `ground-truth-extractor` | 正在更新需求基线 |
| `ground-truth-reviewer` | 正在核对需求基线 |
| `skill-reviewer` | 正在核对 Skill |
| `artifact-reviewer` | 正在评审产物 |
| `implementation-reviewer` | 正在评审实现 |
| `stop-reviewer` | 评审中 |
| 其他 | 正在执行其他纠偏检查 |

### MA 补丁本地兜底文案

以下文字只在拿不到插件数据时由 `renderer.js` 显示，统一写在文件顶部。

| 场景 | 原文 | 改为 |
|---|---|---|
| 首次查询中 | RC · 正在查询 | 纠偏插件 等待接入 |
| 查询失败 | RC · 状态暂不可用 | 纠偏插件 等待接入 |
| 宿主会话尚未启动 | RC · 会话尚未启动 | 纠偏插件 等待接入 |
| 读不到项目 | RC · 当前项目状态不可用 | 纠偏插件 等待接入 |
| 当前项目未绑定 | RC · 等待当前项目绑定 | 纠偏插件 等待当前项目绑定 |

“RC · 已开启，等待本轮开始”改由插件端的 `armed` 状态提供，从补丁中删除。

## 控制台文案

| 位置 | 原文 | 改为 |
|---|---|---|
| 页面标题 | RC 会话控制台 | 纠偏插件会话控制台 |
| 预览标题 | MA 输入框状态栏预览 | 输入框状态栏预览 |
| 预览兜底 | RC 状态不可用 | 纠偏插件 状态不可用 |
| 历史会话预览 | RC 历史会话 | 纠偏插件 历史会话 |
| 修复输入标题 | 修复轮收到的 RC 输入 | 修复轮收到的纠偏插件输入 |
| 读取失败 | 当前会话没有可读取的 RC 项目 | 当前会话没有可读取的纠偏插件项目 |
| “纠偏运行”一栏 | MA 正在处理 | 暂无纠偏活动 |
| 评审结论 | 终审中 / 等待终审 | 评审中 |
| 当前纠偏 Agent | 正在终审 | 评审中 |

以下控制台文字暂不改动，如需统一为“评审”，直接在本表补充即可：“本轮终审”标题、“尚未终审”、“本轮未执行终审”、“终审已取消”、“终审记录不可用”、“终审超时”和“终审达到审查步数上限”。

## 工具进度卡片

只把 “RC” 替换为 `BRAND`，其余措辞不变。

| 文件 | 涉及文字 |
|---|---|
| `lib/openclaw/review-activity.mjs` | RC · Skill 核对、RC · Skill 读取、RC · 读取基线、RC · 整理基线、RC · 校正基线、RC · 基线待校验、RC 正在审查。 |
| `lib/openclaw/stop-wait-status.mjs` | 17 条以 “RC” 开头的结算说明，以及“正在等待 RC 评审与复验。” |
| `lib/openclaw/ui-progress.mjs` | RC 本轮审查已结束；以最终验收结论为准。 |
| `lib/openclaw/runtime.mjs` | 后续任务暂缓，正在等待 RC 审查结算和反馈交付。 |

待定：部分卡片文字描述了宿主的等待状态，例如“已解除等待”“后续任务暂缓”。按目前范围先保持原样。

## 扩展方式

- **改措辞：** 只改 `status-copy.mjs` 中对应的一行，并同步本文档的表格。
- **新增状态：** 在分类规则中加一条，在文案表中加一行，在测试中加一个状态样例。
- **新增显示位置：** 读取 `display.key` 或 `display.indicator`，不要比较中文文字。
- **测试改成表格式：** 每个状态样例只断言归入的状态名，另用一条测试检查文字取自文案表。以后改文案，不会牵连大量断言。

## 改动清单

插件仓库：

- 新增 `lib/openclaw/ui/status-copy.mjs`，并在 `packaging/runtime-modules.json` 登记；`post-run-controls.mjs` 的静态资源白名单加上该文件。
- 修改 `session-runtime-text.mjs`（分类与渲染）、`session-runtime-status.mjs`（`repairRound` 及 `list()` 返回字段）。
- 修改 `ui/post-run.mjs`、`ui/post-run.html`（控制台文案和结构化判断）。
- 把四个文件中的 `rc-stop-` 判断收拢为 `isRepairRunId()`。
- 替换 `review-activity.mjs`、`stop-wait-status.mjs`、`ui-progress.mjs`、`runtime.mjs` 中进度卡片的品牌名。
- 更新 `test/session-runtime-details.test.mjs`、`test/post-run-controls.browser.mjs`、`test/openclaw-review-activity.test.mjs`。
- 在 `docs/session-runtime-status.md` 中写明 `display.key`、`display.indicator`，并说明 `display.line` 是最终文字。

MA 仓库：

- 修改 `patches/rc-composer-status/renderer.js` 和 `README.md`。`patch.mjs` 的锚点不变。

## 上线注意

- 插件和 MA 补丁需要一起更新。旧补丁配新插件，会在新文案后面继续追加“当前无纠偏 Agent 在运行”。
- `patch.mjs apply` 发现已打过补丁会直接跳过。更新 `renderer.js` 时，先关闭 MA，执行 `node patches/rc-composer-status/patch.mjs revert`，再执行 `apply`。

## 验收场景

- 原始轮 MA 处理中、无后台检查：状态行不显示。
- 原始轮 MA 处理中、有后台检查：显示“纠偏插件 正在后台检查”等，不出现 MA 字样。
- MA 回复完成后进入评审：显示“纠偏插件 评审中”。
- 评审发现偏差：从等待修复启动、修复运行到修复期间的后台检查，始终显示“纠偏评审结果：有偏差，正在自动修复”。
- 修复结束后重新评审：显示“修复完成，重新评审”；再次发现偏差时回到上一条。
- 评审无偏差或空闲：显示“纠偏评审结果：无偏差”。
- 插件崩溃或评审超时：状态行显示“纠偏评审结果：无偏差”、圆点为灰色；控制台详情显示未验证或已中断。
- 修复次数用完仍有偏差：显示“纠偏评审结果：有偏差”。
- 任何状态下都不出现 “RC” 和“新消息暂不可发送”；控制台预览与 MA 状态行逐字一致。

## 附录：判定条件对应的快照字段

按顺序匹配，命中第一条即停止。“收尾类阶段”指 `FINALIZING`、`COEXIST_WAIT`、`REVIEW_QUEUED`、`REVIEWING`；“结束类阶段”指 `IDLE`、`ENDED`、`CLOSED`。

| 状态名 | 条件 |
|---|---|
| `stopping` | `status === "STOPPING"` 或 `phase === "RELEASING"` |
| `terminated` | `status === "TERMINATED"` |
| `aborted` | `status === "INTERRUPTED"` 或 `health === "OWNER_EXITED"` |
| `sessionOff` | `effectiveEnabled === false` 且 `!active` |
| `armed` | `!registered` 且 `effectiveEnabled === true` |
| `unregistered` | `!registered` |
| `repairing` | `phase` 为 `WAIT_CORRECTION` 或 `CORRECTING`；或 `repairRound` 且 `phase === "RUNNING"`；或 `inputMode === "WAIT"` 且 `outcome === "DEVIATION"` |
| `rereviewing` | `repairRound` 且处于收尾类阶段 |
| `reviewing` | 处于收尾类阶段 |
| `background` | `phase === "RUNNING"`，且 `stage` 或 `activities` 中有后台检查 |
| `hidden` | `phase` 为 `RUNNING` 或 `USER_DISPATCHING` |
| `passed` | 结束类阶段，`outcome === "PASS"` |
| `noDeviation` | 结束类阶段，`outcome` 为 `NO_DEVIATION_FOUND` 或为空 |
| `deviationLeft` | 结束类阶段，`outcome` 为 `DEVIATION` 或 `COMPLETED_WITH_HISTORICAL_DEVIATIONS` |
| `reviewIncomplete` | 结束类阶段的其他结论：`UNVERIFIED`、`CANCELLED`、`DISABLED`、`SKIPPED` 等 |

`status === "UNKNOWN"` 或 `hostReconciliation === "UNKNOWN"`，且进程没有确认退出时，不单独匹配，按 `phase` 走上面的规则。
