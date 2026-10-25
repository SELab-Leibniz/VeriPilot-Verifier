# PRD Contract Stage Agent 纠偏标准

同时读取 `ir.md`、Planning 三件套、`kit-map.md` 和刚写入的 `PRD.md`。只修正 PRD；IR、Planning 和 Selection 是只读事实源。

## 穿刺任务

1. `Overview` 准确说明本期产品闭环、平台和明确的范围外能力，不把推断或未来项写成已确认需求。
2. `Input Source Trace` 对实际存在的 IR、Planning 和 Kit Map 记录真实来源；文件已存在时严禁标为 `missing`。缺失输入、保守推断及其置信度必须可追溯到 Assumptions/Open Questions。
3. `Feature Kit Mapping Table` 逐 SR 对齐 Planning，使用 Selection 已选 Kit，并给出可实施的具体目标文件。不得新增 SR、Kit 或功能来填表。
4. `Data Structures And Keys` 写清支撑当前功能所需的字段、唯一标识、状态归属与存储键；如果 Planning 明确是内存态，不得偷偷加入持久化。
5. `Permission Matrix` 与 Kit/能力一致；无权限时明确 `none`。不得因为模板存在而虚构权限。
6. `Routes And Module Placement` 给出 HarmonyOS entry 模块、UIAbility、页面、组件/状态层和资源落点，且与映射表目标文件一致。
7. `Acceptance Checklist` 逐 SR 给出稳定 `*_OK` 标识、可执行动作、可观察结果和证据类型。删除必须验证只删除目标项；新增必须覆盖非空输入和即时可见结果。
8. `Assumptions And Open Questions` 区分用户事实、必要推断、可逆默认值和待确认问题；不能把模型选择冒充用户批准。
9. `Implementation Guardrails` 保护范围、上游只读、唯一 ID/精确删除和输入校验等关键不变量。
10. `External Configuration Placeholders` 只记录真实的签名、设备/模拟器或外部服务配置；没有后端、账号、网络时明确无此配置。

## 跨文件反证

- PRD 中每个 SR、里程碑归属、Kit 和范围边界都必须能在上游文件中找到证据。
- PRD 不得出现与上游冲突的持久化、完成态、编辑、提醒、登录、同步、搜索、标签或多设备交付。
- 同一字段、Kit、路径和验收标识在各章节之间必须一致；不确定时保留开放问题，不得编造。

## 完成条件

- `prd-contract.rules.yaml` 的确定性诊断为 passed。
- 十个章节均为实现就绪内容，逐 SR 映射和验收可执行且与上游一致。
- 修正只落在 `PRD.md`，上游产物保持不变。
