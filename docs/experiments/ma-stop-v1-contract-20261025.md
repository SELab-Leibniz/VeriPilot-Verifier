# MatrixAssistant Stop v1.1 隔离接线记录

2026-10-25；分支 `codex/stop-correction-refactor` 的未提交实现。

**实际 Gateway 接线通过；真实模型语义、TodoList 和性能验收仍未完成。**

读取的宿主为 `C:/Users/user/workspace/program_workspace/MatrixAssistant/resources/openclaw`，包版本 `2026.7.1-2`。没有修改 MatrixAssistant 或其内置 OpenClaw 代码，没有替换日常插件，没有接入日常业务会话。新插件副本、Gateway 配置、会话、源码和证据全部位于本仓库的隔离测试目录。

运行脚本：[stop-correction-ma-contract.mjs](../../scripts/diagnostics/stop-correction-ma-contract.mjs)。它使用真实 Gateway、公开生命周期 Hook、真正的 SDK 读取和单项提交工具，模型端为本机 HTTP 确定性提供器，外部模型调用为 0。SDK 依赖链接到本仓库已安装的固定版本；没有替换评估器或关闭 M16 PASS 证明。

受控业务只有三个无状态函数，冻结要求是分别返回 x+1、x+2、x+3。初次业务写入固定反例；Stop 独立保存三条反证，通过原生续作提交一条反馈引用，启动前附上重新核对的正文。宿主收到后写入正确实现，再次 Stop 逐项提交完整证明并 PASS。

- K=1：两次 Stop 共 6 组，6 条有效回执；实际纠偏 1 次；受控用例约 13.598 秒。
- K=3：两次 Stop 共 2 组，6 条有效回执；实际纠偏 1 次；受控用例约 8.166 秒。
- 两组均只建立一个真实用户输入流程。排队和审查没有扣业务次数；可信 model.call.started 后才转为一次已用。
- 两组都保留初次 DEVIATION，并在后续 PASS 后释放该流程全部 Stop 等待。
- 最终实际文件与受控正确实现相符。K 只改变 Agent 分组，不改变三个原始要求或六个逐项结果。

这组耗时来自固定回答的本地提供器，不能推导真实模型提速、准确率或复杂业务覆盖。它不覆盖 Electron UI 的实际显示、真实 17/20 分钟长时边界、全部排队故障、真实模型 TodoList 或需求第 18.5 节性能验收。

实际证据保存在被 Git 忽略的测试目录：

- [.runtime-correction/test-temp/ma-stop-v1-contract-20261025-07/contract-result.json](../../.runtime-correction/test-temp/ma-stop-v1-contract-20261025-07/contract-result.json)
- 同目录 K1-ledger.json、K3-ledger.json：会话、流程、反馈、真实开始及释放事实。
- 同目录 K1-scope.json、K3-scope.json：组、调度和逐项保存回执。
- 同目录 provider-requests.json、gateway.jsonl、wire.jsonl：本地请求与真实 Gateway 轨迹。

此前失败也保留：第一次因执行环境拒绝本机回环连接而未连上已就绪 Gateway；随后真实运行发现 sessions.create 不发 session_start，初始会话头又可能由原生会话管理器暂存。实现补上了固定宿主协议下的完整首轮历史核对，未将未知活跃历史或任务计数直接当作零。一次本地提供器遗漏了必填 applicabilityKind，按未核验退出、无续作、无扣费；修正的是受控提供器格式，没有放宽生产校验。

本次还有 168 项定向回归通过；完整旧测试兼容迁移尚未完成，不能据接线通过宣称需求 v1.1 整体交付完成。
