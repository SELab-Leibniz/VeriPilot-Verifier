# Runtime Corrector 快速交付验收

交付产品提交为 `16ba3b02266ed9c78c98548b90c3ef0e76393bcf`，分支为 `codex/lc-deliver-20261126`。按 §13.4 的可用性底线，这一版可交付。五条标准中，前四条在本次范围内通过，小任务成本项未通过。

## §13.1 逐条结果

1. **不崩溃 · 通过。** 独立源码工作树上的 30 次机制 Stop 和交付版 7 次真实 Stop 都返回公开结果，产品技术故障 0。30 个机制 `UNVERIFIED` 均有三个分栏，全部在各自截止时间前结算。真实 164K 续审在 Stop 内 117.308 秒返回 3 个分栏。此时最后一个 HTTP 200 流随 Reviewer 截止而终止，缺 1 条供应商用量回执，Stop 的公开结算仍完整。上下文中断、未定范围截止、内部异常和独立安装回归已通过。 [逐例结果](results.json) · [续审公开结果](/C:/Users/user/workspace/program_workspace/Experiments/rc-deliver-v3-20261126-paired/second/public-stop.json)
2. **零否决 · 通过。** 30 例机制扫描和真实冒烟结构扫描均为 0 否决。跨阶段正确例与超长单行缺证例均返回 `UNVERIFIED`。真实千文件缺陷例与长单行缺证例保留结构评分及独立语义裁决草稿，快速交付使用结构否决证据，正式语义评分仍待裁决。 [逐例结果](results.json)
3. **首次 Stop 送达偏差 · 通过。** 164K 必读用例首次 Stop 提交了一条当前密封重试配置的偏差，并向执行侧发出 `block`。从原生调用启动到执行侧收单为 48.506 秒。按该反馈修复后才运行续审。 [首次执行侧回执](/C:/Users/user/workspace/program_workspace/Experiments/rc-deliver-v3-20261126-paired/first/executor-receipt.json) · [修复回执](/C:/Users/user/workspace/program_workspace/Experiments/rc-deliver-v3-20261126-paired/repair.json)
4. **未审和缺证分开，支持续审 · 通过。** 真实第二次 Stop 首次读取原件从第 201 行开始，输出确认偏差 0、已审缺证 0、尚未审到 1。离线回归在有缺证判定时验证了它会单列，并验证了省略工具 offset 时的自动定位。早期已交付但仍未逐项核对的范围可以显式回读，仍会阻止整体通过。 [续审公开报告](/C:/Users/user/workspace/program_workspace/Experiments/rc-deliver-v3-20261126-paired/second/public-report.json) · [逐例结果及调用证据](results.json)
5. **小任务不退化 · 成本未通过。** 真实正确例与 `8a9b662` 均返回 `NO_DEVIATION_FOUND`。同一用例中，交付版用了 372,546 tokens、103.756 秒，对照为 339,980 tokens、79.025 秒，分别增加 9.6% 和 31.3%。另外三组同输入的离线小任务结论一致，交付版模板 token 合计约多 0.8%。真实对照每版只执行一次。 [真实与对照逐例结果](results.json) · [离线小任务对照](/C:/Users/user/workspace/program_workspace/Experiments/rc-large-sdd-3x3-20261125/runs/unified-evaluator/batches/deliver-v3-20261126/small-mechanism-comparison.json)

## 已知限制与交付凭据

- 机制扫描审完 3/30。长原件中尚未逐项核对的范围会保留为未审，已证实偏差可先交付。跨会话接力、整组判定和超长单行完整抽取留给正式优化。
- 最终验证新增真实 Stop 7 次，已记账 4,749,078 DeepSeek tokens。两次淘汰的验证也计入探索预算。快速交付合计 22 次真实 Stop、已记账 14,139,943 tokens，含中止流的不完整小计。
- 初版 `f118a76` 因跨阶段错误报通过淘汰。第二版 `6cd309f` 因续审截止时缺结构化报告淘汰。此报告的验收证据来自独立验证的 `16ba3b0`，小任务比较另用标明的 `8a9b662`。 [初版归档](/C:/Users/user/workspace/program_workspace/Experiments/rc-large-sdd-3x3-20261125/runs/unified-evaluator/batches/deliver-v1-20261126/veto-archive.json) · [第二版归档](/C:/Users/user/workspace/program_workspace/Experiments/rc-large-sdd-3x3-20261125/runs/unified-evaluator/batches/deliver-v2-20261126/publication-archive.json)
- 独立安装的 OpenClaw 插件构建回执绑定了该产品提交和运行入口。 [构建回执](/C:/Users/user/workspace/program_workspace/Experiments/rc-large-sdd-3x3-20261125/qualification/native/runtime-16ba3b02266ed9c78c98548b90c3ef0e76393bcf/ready.json)
