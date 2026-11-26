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

## 2026-11-26 · security_tool_2 端到端验证预检

**停在上机前。** 在保留历史宿主事件时间戳的重放中，带确证偏差的 Stop 两次超过 30 分钟放行门槛。计时从原生 CLI 请求 `mabench.awaitStopReview` 起，到历史试点修正后的 supervisor 首次返回 `READY` 止。三类输入均通过 SHA-256 核对，取自交付版 `16ba3b0` 的公开结果。重放使用交付包的调度器、历史试点的放行代码和两条归档 Autopilot 状态轨迹。宿主派发回调由重放提供。[基础重放](../../../Experiments/rc-deliver-16ba3b0-security2-20261126/preflight/replay-results.json) · [逐次计时和状态证据](../../../Experiments/rc-deliver-16ba3b0-security2-20261126/preflight/timeline-results.json)

| 交付版公开结果 | 历史 run0 的放行时间 | 历史 run1 的放行时间 | 结果 |
| --- | ---: | ---: | --- |
| `NO_DEVIATION_FOUND / allow` | 1 分 53.684 秒 | 1 分 53.282 秒 | 放行，0 次纠偏 |
| `UNVERIFIED / allow`，1 项未审 | 2 分 06.852 秒 | 2 分 06.526 秒 | 放行，保留未审结论，0 次纠偏 |
| `UNVERIFIED / block`，1 项确证偏差，随后复审为 `UNVERIFIED / allow` | **31 分 32.684 秒** | **39 分 50.571 秒** | 重放 1 轮纠偏及复审，最终放行，两条均超时限 |

在两条超时限轨迹的第 30 分钟，RC 均已处于 `IDLE / UNVERIFIED`，待办为 0。Autopilot 仍处于 `running / claimed`，放行器返回 `WAIT`。Autopilot 进入 `paused / blocked / max_retries_reached`，通过历史放行器的稳定期和终态身份核验后，才允许阶段交接。从复审公开 `allow` 到放行分别为 17 分 04.938 秒和 17 分 05.650 秒。原生传输回归也验证了同一张放行凭据只转发一次 Stop，交付版配套的 91 项离线测试全部通过。[传输回执](../../../Experiments/rc-deliver-16ba3b0-security2-20261126/preflight/transport-regression.json) · [离线测试日志](../../../Experiments/rc-deliver-16ba3b0-security2-20261126/preflight/rc-transport-tests.tap)

**计时对宿主调度敏感。** 上表保留历史宿主接手纠偏、提交复审及 Autopilot 重试的原始时刻，并代入交付版已测得的 Stop 用时。另一次重放假定首次审查提前多少，后续宿主动作也整体提前多少。此时两条纠偏路径分别在 24 分 47.493 秒和 28 分 15.303 秒放行。真实新运行会采用哪种时序仍待上机验证。本次观察到的是宿主交接等待，尚无交付版 RC 异常的证据。[两种时序对照](../../../Experiments/rc-deliver-16ba3b0-security2-20261126/preflight/timeline-results.json)

交付包在宿主机上成功读入历史配置，Stop 为 `until_pass`，单流程和单会话纠偏上限均为 3，审查预算为 7,200,000 毫秒。按预检停点，本次启动 VM 0 台，新增原生开发轮次 0，业务和 RC 模型调用均为 0，新增模型 tokens 为 0。插件在客体中的加载、真实反馈及修复、原生 `completed/done`、真实 RC 成本、独立 F2P/P2P 和 Checklist 均未验证。本轮未产生可与历史成绩比较的新分数。正式终审继续停在 §10.3。[配置解析结果](../../../Experiments/rc-deliver-16ba3b0-security2-20261126/preflight/effective-profile.json)

## 2026-11-26 · security_tool_2 本机实跑

使用独立本机 Gateway、交付包 `16ba3b0` 和用户指定的 dae36f7 原始 YAML 实跑一轮。插件正常加载，提案 Stop 触发并完成一轮原生纠偏和复审，17 分 40 秒后放行。编码模型曾以 `stopReason=length` 提前结束，原生 CLI 在三次 Autopilot 续跑未启动模型后自动继续。编码后停在 20/21 项，剩余 ViewModel 单元测试在业务会话中被 MA 工具策略拦截。最近 RC 结论为 `UNVERIFIED / STOP_ORIGINAL_SCOPE_INCOMPLETE`，原生 `completed/done` 和独立评分均未取得。对照历史试点时，需考虑本次开启 Brief 注入并使用默认上下文引擎。 [本机报告](../../../Experiments/rc-local-security2-16ba3b0-20261126/report.md) · [状态和计时证据](../../../Experiments/rc-local-security2-16ba3b0-20261126/status-summary.json)

## 2026-11-26 · 快速交付线 RC 修复与验证

候选包来自 `codex/lc-deliver-20261126` 的 RC 工作树，基于记录提交 `c79cc40`，原交付产品提交为 `16ba3b0`。OpenClaw 和 MA 使用本机原有版本，插件包的 293 个文件均按 SHA-256 复核。正式终审仍暂停在 §10.3。 [构建凭据](../../../Experiments/rc-quick-hardening-20261126/candidate.json) · [验证过的 RC 插件包](../../../Experiments/rc-quick-hardening-20261126/runtime-corrector-openclaw-quick-20261126.zip) · [压缩包 SHA-256](../../../Experiments/rc-quick-hardening-20261126/archive-sha256.json)

- **Reviewer 超时。** 在 Stop 结算窗口仍有效时，已落盘且证据当前有效的偏差可随 `UNVERIFIED / block` 送出，未审范围同时保留。受控真计时用例保留 1 项已证实偏差，给出 1 次纠偏预约。过期窗口和修改后的失效证据均放行且无纠偏预约。 [回归结果](../../../Experiments/rc-quick-hardening-20261126/regression.tap)
- **大需求中断与收尾。** 无抽取项时也保存已收到的原文分页。相同原文的后续用户轮可以从第 11 行继续导航，并重新核对前段及当前交付证据。单独的 1,005 行、128 KiB 以上用例在绑定多行条款和确认背景后返回 `NO_DEVIATION_FOUND`。试图用宽泛条目或背景范围盖过独立要求时，漏项继续显示为 `UNVERIFIED`。现有 4,557 行中断用例完成偏差送出及修后重审，剩余原文范围继续显示待核实。 [回归结果](../../../Experiments/rc-quick-hardening-20261126/regression.tap) · [长原文续审](../../../Experiments/rc-quick-hardening-20261126/early-delivery/observations.json) · [独立原件范围检查](../../../Experiments/rc-quick-hardening-20261126/scope/result.json)
- **宿主链路。** 在独立本机 OpenClaw 2026.7.1-2 Gateway 加载候选包并核实原生终结钩子、会话持久化和认证。历史 `security_tool_2` 放行器重放的三类公开结果均到达 `READY`。带确证偏差的一路只预约一次纠偏，收到修后复审后只转发一次 Stop。该重放使用模拟宿主回调，真实放行耗时未重新测量。 [Gateway 凭据](../../../Experiments/rc-quick-hardening-20261126/gateway-final/result.json) · [放行器重放](../../../Experiments/rc-quick-hardening-20261126/replay-results.json)
- **验证结论。** 213 项回归中 212 项通过。混合清单的执行记录导航断言在候选和 `16ba3b0` 上均返回相同的 `2 !== 1`。本次派发模型 0 次，新增业务用量为 0。本机原生 `security_tool_2` 的最新实跑证据仍来自 `16ba3b0`，已经完成一轮提案纠偏和复审，未执行的 Hvigor 测试仍是业务完成和独立评分的阻塞点。候选包的 `completed/done`、F2P/P2P、Checklist、真实 Stop 延迟及模型用量待真实 Run 验证。 [候选回归](../../../Experiments/rc-quick-hardening-20261126/regression.tap) · [原版同一失败](../../../Experiments/rc-quick-hardening-20261126/baseline-16ba3b0-known-failure.tap) · [本机实跑状态](../../../Experiments/rc-local-security2-16ba3b0-20261126/status-summary.json)

## 2026-11-26 · RC 市场安装与三路本机并行验收

以 `codex/lc-deliver-20261126` 的 `8d6be1f` 为基础构建并冻结 RC 市场候选包。市场条目的 `installPath` 为 `~/.openclaw/extensions`，实际放置在各独立 OpenClaw 状态目录的 `extensions/runtime-corrector-1.11.0`。OpenClaw 原生扫描加载 RC。三个 `openclaw.json` 均无 RC 的 `plugins.load.paths` 条目。升级回归验证了清理旧 MA 版 RC 的专用加载路径，其他插件的路径保留。31 项市场安装回归全部通过。 [市场包](/C:/Users/user/workspace/program_workspace/Experiments/rc-market-3way-20261126/release/runtime-corrector-ma-1.11.0.tgz) · [市场注册清单](/C:/Users/user/workspace/program_workspace/Experiments/rc-market-3way-20261126/release/runtime-corrector-ma-1.11.0.registry.json) · [安装回归](/C:/Users/user/workspace/program_workspace/Experiments/rc-market-3way-20261126/market-tests.log)

北京时间 18:09:47 通过同一派发门槛启动。三路各用独立本地 Gateway、项目目录和 OpenClaw 配置，MA 与 OpenClaw 使用本机现有版本。两项常规任务使用用户指定的 dae36f7 原始 YAML 原样副本，大仓使用同一压力场景的专用 YAML。三路使用同一 SHA-256 的市场包，逐一匹配 296 个安装文件。 [包的 SHA-256 和来源](/C:/Users/user/workspace/program_workspace/Experiments/rc-market-3way-20261126/market-release.json) · [并行派发回执](/C:/Users/user/workspace/program_workspace/Experiments/rc-market-3way-20261126/dispatch-release.json)

- **`security_tool_1`** 原生 `completed/done`。实现清单 11/11，公开 Hypium 461/461，OpenSpec 严格校验通过。本会话 3 次 Stop 均结算，审查分别用时 211.313 秒、223.748 秒、431.242 秒，最长实测放行等待 442.996 秒。最终 RC 为 `UNVERIFIED` / `STOP_ORIGINAL_SCOPE_INCOMPLETE`，状态 `IDLE`。 原生 Run `run-1795687787483-70dd83`。 [运行回执](/C:/Users/user/workspace/program_workspace/Experiments/rc-market-3way-20261126/s1/experiment/runs/market-security_tool_1/operator-operational-summary.json) · [Gateway 收尾](/C:/Users/user/workspace/program_workspace/Experiments/rc-market-3way-20261126/s1/experiment/runs/market-security_tool_1/gateway-close.json)
- **`security_tool_2`** 原生 `completed/done`。实现清单 16/16，公开 Hypium 749/749，OpenSpec 严格校验通过。本会话 4 次 Stop 均结算，审查分别用时 259.732 秒、366.592 秒、516.380 秒、578.370 秒，最长实测放行等待 1331.431 秒。最终 RC 为 `UNVERIFIED` / `STOP_ORIGINAL_SCOPE_INCOMPLETE`，状态 `IDLE`。 RC 触发 1 轮纠偏。 原生 Run `run-1795687787251-c008ac`。 [运行回执](/C:/Users/user/workspace/program_workspace/Experiments/rc-market-3way-20261126/s2/experiment/runs/market-security_tool_2/operator-operational-summary.json) · [Gateway 收尾](/C:/Users/user/workspace/program_workspace/Experiments/rc-market-3way-20261126/s2/experiment/runs/market-security_tool_2/gateway-close.json)
- **超长需求和大代码仓** 1,573 个跟踪文件，需求 1,216 行、231,585 字节。业务及纠偏回合的原生结束状态均为 `ok`。RC 发现注入的重试配置偏差并触发一轮纠偏，独立产物检查通过。两次 Stop 分别用时 94.510 秒、230.153 秒。最终 RC 为 `UNVERIFIED` / `STOP_ORIGINAL_SCOPE_INCOMPLETE`，状态 `IDLE`。 [运行回执](/C:/Users/user/workspace/program_workspace/Experiments/rc-market-3way-20261126/large/operator-operational-summary.json) · [Stop、产物与 Gateway 收尾](/C:/Users/user/workspace/program_workspace/Experiments/rc-market-3way-20261126/large/result.json)

两项常规任务均在原 Run 内完成自动修复。部分业务回合的 openspec status 查询失败，随后原生验证仍继续。`security_tool_1` 修复了测试代码的 ArkTS 类型错误，`security_tool_2` 补齐了 OpenSpec 的规范关键词。审查期间出现上下文溢出，OpenClaw 自动压缩后继续。复审提交曾因缺少逐项审查判断被工具退回，模型重新提交后 Stop 正常结算。 [首轮 ArkTS 校验记录](/C:/Users/user/workspace/program_workspace/Experiments/rc-market-3way-20261126/s1/first-native-verify-failure.json) · [首轮 OpenSpec 校验记录](/C:/Users/user/workspace/program_workspace/Experiments/rc-market-3way-20261126/s2/first-openspec-verify-failure.json)

**可用性验收通过。** 三路均加载 RC、到达原生结束态、结算全部记录的 Stop，并关闭各自 Gateway。未观察到 RC 崩溃或纠偏循环。最终 `UNVERIFIED` 保留各审查的未核实范围。本轮记录公开验证和大仓独立产物检查，属于可用性验证。共享用户配置与市场线上发布保持原状。正式终审仍停在 §10.3。
