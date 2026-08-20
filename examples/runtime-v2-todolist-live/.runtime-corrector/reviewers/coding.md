# Coding Checkpoint 节点审阅标准

1. `status: PASS` 必须与 `browserRun.status` 及所有适用 requirement 状态一致；外层 PASS 不能掩盖内层 FAIL、BLOCKED 或缺失证据。
2. R09 必须由当前浏览器会话完整执行“新增两项 -> 完成一项 -> 筛选已完成 -> 编辑另一项 -> 精确删除”，Node 单元测试不能替代 DOM 交互证据。
3. R07 必须检查窄屏视口、可访问名称、非纯颜色状态表达和键盘可操作性。
4. 截图和步骤记录必须来自当前源码 revision；旧截图、推断结果或仅静态阅读不得判 PASS。
5. 本节点只诊断与反馈，不自行修改代码或证据。
