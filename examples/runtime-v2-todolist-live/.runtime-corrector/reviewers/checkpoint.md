# Final Checkpoint 节点审阅标准

1. `status: PASS` 只有在 `evidence/test-output.txt` 存在、来自当前实现且显示 `npm test` 全部通过时才成立。
2. `testEvidence: NOT_RUN`、`revision: pre-verification-probe` 或仅有计划性文字时，必须判定为偏差；这正是受控探针预期触发的反馈。
3. R01–R09 每一项必须引用当前实现或测试的具体路径；不能用同一句泛化断言替代逐项证据。
4. R09 必须有一条完整测试证明“新增两项 -> 完成 -> 筛选 -> 编辑 -> 精确删除”，不能用多个无关联测试拼接冒充。
5. 不建议范围外功能，不把格式合法视为语义通过，不自动修改产物。
