# Selection Stage Agent 纠偏标准

同时读取已通过的 `ir.md`、Planning 三件套和 `kit-map.md`。只修正 Selection；不得修改 IR、PilotPlan、relations 或 granularity choice 来迁就错误选型。

## 穿刺任务

1. 逐个核对 Planning 中的 SR。每个 `## SR-n` 必须只覆盖同名需求，不遗漏、不合并掉独立需求，也不新增 Planning 中不存在的功能。
2. 对每个 SR 选择真正实现它所需的最小 HarmonyOS Kit 集。基础 Kit 只有在承担具体职责时才纳入；登录、同步、通知、完成态、编辑、搜索、标签等未进入本期 Planning 的能力不得借选型扩张进来。
3. `Selected kits` 中的每个 Kit 都要在 `Rationale` 中对应到该 SR 的必要能力；能用 ArkUI 本地状态完成的操作，不要无依据引入网络、账号、后台、分布式或持久化 Kit。
4. `References` 必须写真实的本地文档、已执行的 recall 结果，或诚实记录 `recall=unavailable`；不得声称运行了未运行的 VeriKit recall。
5. `Rejected candidates` 要写候选及弃选原因；没有合理候选时明确写 `none`，不要伪造比较。
6. 多 Kit 组合时说明调用链或职责边界；单 Kit 时 `Recipe: none` 即可。
7. `Confidence` 必须保留输入来源、自动选择、recall 冲突/不可用、敏感权限或兼容性不确定性。可逆且非敏感的自动模式选择应使用保守 Recommended，并记录 `auto_selected_recommended`。
8. `Open questions` 只保留会影响 Kit 决策的真实缺口，并标注是否阻断；可逆默认值不能伪装成用户确认。

## 完成条件

- `selection.rules.yaml` 的确定性诊断为 passed。
- Kit 集与当前 IR/Planning 范围忠实一致，每个选入/弃选决定都有文件内证据。
- 修正只落在 `kit-map.md`，上游产物保持不变。
