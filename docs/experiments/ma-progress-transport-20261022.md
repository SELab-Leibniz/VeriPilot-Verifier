# MA 1.10.1 进度传输修复

分支：`codex/ma-progress-transport`。只修改 RC 仓库和构建产物，不修改 MA 安装包、OpenClaw 安装文件、默认会话或配置。

## 原因

旧补丁发送的 `agent/runtime-corrector.progress` 被桌面主进程 `shouldForwardNotificationToRenderer` 丢弃。早上的 renderer 适配器直接投递 IPC，跳过了此过滤。实际前端五分钟后将 `agent.wait` 的三秒等待超时判为运行丢失，调用 `chat.abort`。此前 PASS 不覆盖完整桌面链路。

## 实现

RC 使用明确命名的审查 UI 活动：`stream=tool`、`name=runtime-corrector.review`，按父 run 和真实 reviewer run 隔离。只发 `update/end`；不发 `start/result`、业务参数或业务工具结果。因此不插入模型 `tool_use`，也不清空或覆盖业务工具错误摘要。阶段提示通过进度视图显示，不进入助手正文。

MA 1.10.1 的实际握手为 `caps: []`，并订阅 `sessions.subscribe`。在 OpenClaw 2026.7.1-2 上，此连接通过 `session.tool` 接收进度，经过真实主进程 `chat:message` 转发后进入 renderer，刷新当前会话的空闲计时。不能仅把 `agent/tool` 直投给 renderer：声明 `tool-events` 的另一类连接使用不同路由。

普通审查保留 30 秒周期和真实活动诊断。Stop 等待复用同一通道，只为真正等待的请求 run 发送状态；后台评审不续活已经结束的业务 run。宿主 `before_dispatch` 不提供 runId 和取消信号，因此门控移到原生 `reply_dispatch`，其 event/context 提供当前请求身份和 abortSignal，仍在业务执行之前等待。没有当前 runId 时不发送状态。保留既有预算、取消和截止时间；终止后关闭监听和计时器，迟到的回调不得重启状态通道。超时结论由仍在等待的请求显示为结束进度，不作为验收通过。

## 验证边界与复现

`test/ma-progress-transport.test.mjs` 只读加载当前安装包及宿主中的原始函数，在隔离 VM 中回放：实际 Gateway 分流、MA 协议分发、主进程聊天转发、renderer 工具分支与五分钟计时器。Electron 窗口、应用存储和无关服务使用测试替身；预加载层检查实际通道白名单。六分钟等待使用模拟时钟，**不声称运行了六分钟真实桌面或真实模型**。

负对照用旧自定义流稳定触发空闲计时；新通道在两路审查和 Stop 等待中保持活跃。验证取消后无上报、截止/作用域失效、迟到加载、并发 reviewer 身份、模型消息/有序工具块不变，以及宿主业务工具错误摘要不被改写。原生 Stop 生命周期测试另外检查真实磁盘 transcript 不变、期限解除等待与迟到 PASS 的隔离。

```powershell
$env:RC_MA_ROOT = "<MA安装目录>"
node --test test/ma-progress-transport.test.mjs test/openclaw-review-activity.test.mjs test/openclaw-ui-progress.test.mjs test/openclaw-stop-wait-status.test.mjs
```

修复后的 `ma-review-liveness-live.mjs` 仍提供真实 Gateway/模型与原版 renderer 的长时实验，但 IPC 适配器现会先运行实际主进程过滤/转发函数，连接能力与会话订阅也和 MA 对齐。当前分支未执行该长时实验，完整 Electron 桌面与断连恢复仍需独立验收。未识别的 MA 版本或入口变更会使契约加载失败，不能退回到全量直投。

## 本次验收结果

- 相关测试 79 项与插件构建校验 7 项，共 86 项全部通过，包含实际安装包函数的六分钟模拟计时正反对照。
- 完整回归：当前分支 885 项中 861 通过、20 失败、4 跳过；未修改基线 `af7aeaf` 的 841 项中 817 通过、20 失败、4 跳过。失败测试名称集合一致，没有新增失败。完整回归后调整了 Stop 门控注册点与状态清理，相关 79 项另行重跑通过。
- 真实隔离 OpenClaw Gateway 的 Stop 门控实验通过 5 个场景：直接 PASS、纠偏并复验到 PASS、assessment 模式、纠偏次数耗尽、审查超时。五者都有当前等待请求的可见状态，聊天历史与后续模型输入均无状态文本；纠偏链路确实经历修正与复审。模型由本机确定性测试服务提供，外部模型调用为 0。
- 隔离实验将 `session.tool` 事件送入当前 MA 安装包的实际主进程函数，确认输出 `gateway:chat-message`；不是运行完整 Electron 窗口。摘要见 [验收结果](ma-progress-transport-20261022.json)。

隔离实验使用 `scripts/diagnostics/stop-wait-gate-contract.mjs`，并设置 `RC_MA_ROOT` 后运行。没有修改或重新启动 MA；构建的新 RC 包仍需安装后，才能影响原来的无人值守会话。
