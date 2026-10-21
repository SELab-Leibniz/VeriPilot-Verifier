# MA 等待 RC 审查的存续验证（2026-10-22）

分支：`codex/rc-visible-review-liveness`；对照基线：`f51ef1d`。只修改 RC，不修改 MA 或 OpenClaw 安装文件、默认会话和配置。

## 原因与实现

MA 1.10.1 在五分钟没有事件后调用 `agent.wait`，只等三秒。其客户端把 `status: timeout` 当成运行丢失，随后设置 `RESPONSE_TIMEOUT` 并调用 `chat.abort`。RC 的诊断活动上报不经过这条客户端事件通道，因此不能刷新客户端的空闲计时。

等待原生 reviewer 时，RC 立即并每 30 秒发送公开的 `agent` 事件，流名为 `runtime-corrector.progress`。事件使用真实父 runId/sessionKey，携带 reviewer 身份、耗时、原有绝对截止时间、最近真实活动的时间及类型。事件没有 `text/content/message/role/state`，不会进入助手文本缓冲，也不作为模型或工具输出。仍保留原有的一次阶段提示。

计时器不调用诊断 `reportProgress`，不能冒充审查取得进展。真实模型/工具活动仍按原逻辑上报。关闭审查、父运行结束、恢复请求、取消及绝对截止时间均清理计时器和订阅；状态消息不延长角色或 Hook 预算，也不阻止用户停止。

此处的兼容措施依赖 MA 当前通用 Agent 事件处理器刷新空闲计时。客户端正确区分短轮询超时和真正终止仍是更根本的修复；未来客户端改变事件过滤时需要重做本验收。

## 验证方法

运行安装包内未修改的 MA renderer 和真实 OpenClaw `2026.7.1-2`。无界面 Chromium 只运行隔离页面，测试适配器提供 Electron IPC/存储边界，通过真实 Gateway RPC 传递事件和停止请求。没有使用电脑控制，未改写客户端处理器、五分钟计时器或 `agent.wait` 响应。

旧版与候选各使用独立配置、状态目录和项目，统一使用当前默认模型。代理先取得第一个真实 RC 审查请求的模型响应，再将原始 SSE 片段按顺序分布在 360 秒内传递；片段内容和顺序不变。宿主持续收到真实的私有审查进展，主聊天则等待 Hook 完成。主助手读取夹具并只写隔离项目的 `result.txt`。随后另启审查，通过原版客户端 `abortRun` 验证手动停止。

模型请求记录只保存角色、摘要哈希和是否包含状态元数据，不保存凭据。候选成功后检查宿主实际生成的主模型请求及 SessionManager 构建的上下文。此项只证明新增状态事件不进入模型；不改变宿主对历史阶段提示的处理规则。

复现（输出目录必须尚不存在；需要本机已安装的 MA、Chromium 和有效默认模型配置）：

```powershell
node scripts/diagnostics/ma-review-liveness-live.mjs `
  "C:\Users\user\workspace\program_workspace\MatrixAssistant" `
  ".runtime-correction\ma-liveness-live-new" all
```

`smoke` 只验证无界面加载和自定义事件；`candidate` 只运行候选。基线默认 `f51ef1d`，可通过 `RC_LIVENESS_BASE_REF` 选择其他本地 Git 版本。

## 本次记录

- 完整回归：851 项，845 通过、6 跳过、0 失败。
- 三种插件构建通过；差异空白检查通过。
- 原版 MA renderer 无界面加载、事件接收冒烟通过。
- 旧版在 310.539 秒被客户端误终止：一次 `agent.wait`、一次 `chat.abort`，客户端错误为 `RESPONSE_TIMEOUT`。
- 候选在 441.544 秒正常完成：客户端没有调用 `agent.wait` 或 `chat.abort`，收到 16 条状态事件。第一个真实模型响应的 91 个 SSE 片段完整传递；前五分钟除新增状态外没有父运行聊天/Agent 事件，排除了其他正文偶然刷新计时的情况。
- 手动停止实际收到宿主 `aborted`，之后继续观察 32 秒，新增状态为 0。原版 renderer 的最终会话元状态为 `error`，但错误字段为空；本次没有修改客户端的取消状态呈现逻辑，验收通过项是实际取消及停止发送状态。
- 候选的 5 次主模型请求没有状态元数据。宿主 SessionManager 实际构建的正常完成上下文为 6 条消息，取消上下文为 4 条消息，二者均无新增状态数据；本次也没有旧阶段提示文本。此结果不扩大为所有宿主历史提示都保证过滤。
- 两组 renderer SHA-256 完全相同；实测候选两份生产文件与工作分支逐字节相同。可核对[脱敏记录](ma-review-liveness-20261022.json)。

最初使用完全静默的代理等待，但宿主自己的模型无输出保护在 120 秒后先取消请求并重试，不能验收客户端五分钟路径，未计为通过。SSE 注释也不代表模型进展。最终使用真实模型片段的慢速传递，不修改或延长宿主的保护规则。本实现同样不会阻止该模型无输出保护、真实预算耗尽或用户取消。

原始隔离证据保存在忽略目录 `.runtime-correction/ma-liveness-live-20261022-6/`，不纳入 Git。诊断脚本与脱敏结果纳入 Git。验证覆盖原版 renderer 和真实 Gateway/模型链路；不声称覆盖完整 Electron 进程、实际桌面交互、所有未来客户端或其他宿主版本。
