# 实现 Checkpoint 审阅标准

- Checkpoint 只是可审阅证据索引，不代表宿主流程已经接纳 Milestone。
- 测试、构建和设备证据必须绑定同一 revision；旧 revision 证据不得证明当前实现。
- 持久化旅程必须包含终止进程并重新启动，不能用卸载或清数据替代。
