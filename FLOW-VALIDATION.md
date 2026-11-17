# 实验状态控制与总时限验证

2026-11-17，时间为 Asia/Shanghai。只修改独立实验执行器，MA/OpenClaw 与 RC 插件源码保持不变。机器可读摘要见 [validation/flow-20261117.json](validation/flow-20261117.json)。

## 结果

增加实验状态接口后的最终 `npm run test:windows`：**61/61 通过，0 跳过**。包含本地状态/控制测试、真实 RC 包、Windows PowerShell 5.1 宿主准备、1 毫秒准备超时、进程组及异常清理测试；不调用模型。总时限阶段的原始验证摘要为 47/47，保留在原机器可读记录中。

另有三次真实模型实验：一次完整纠偏与观察恢复，两次两分钟总时限验证。它们都是执行控制测试，不包含独立评估或评分。

## 外层实验状态接口追加验证

接口说明见 [教程](tutorials/04-experiment-status.md)，本轮机器可读结果见 [validation/status-20261117.json](validation/status-20261117.json)。这一轮没有新增模型调用，也没有改写前面模型实验的原始结果。

- 真实 Windows 宿主准备过程中，外层连续读取 `experiment-status.json`，实际观察到 `PREPARING → STARTING → CREATING_SESSION → ENABLING_RC → READY → STOPPING_GATEWAY → PREPARED`；收尾前的 `canScheduleNext` 始终为 false，清理并准备完成后才为 true。
- Windows 进程组测试由独立结果守护继续发布状态；原观察停止后仍保持占用，到期清空组内子孙进程并完成摘要后，状态为 `TIMED_OUT`、`canScheduleNext: true`。
- 真实 CLI 查询支持中文/空格路径，标准输出只有 JSON。查询失败时保留 `UNKNOWN` 和禁止调度，查询失败实验本身则返回有效结果。
- 覆盖 RC 当前轮 ENDED/TERMINATED 但实验未收尾、状态过期、查询卡住、错误 Session/回执、准备失败与截止清理未确认等路径；均不把“没有收到状态”当成“实验完成”。
- 对前面已完成的真实模型尝试执行只读查询：正常闭环为 `COMPLETED / NO_DEVIATION_FOUND`，硬截止为 `TIMED_OUT / INTERRUPTED / UNVERIFIED`，原 `run.json` 和 `result.json` 的哈希保持不变。
- 正常结束的旧实验在原截止时间之后再查询，仍保持 `COMPLETED`，不会被时钟误判成超时。缺少进程组释放证明的旧记录不自动释放调度槽位。

## 健康纠偏不被观察超时误杀

`runs/quicksort-flow-check-20261117T113627646Z-041ed04f/`

- 19:36:27 开始，19:49:16 归档，约 12 分 49 秒。
- 一次观察窗口为 180 秒，整个实验上限为 30 分钟。
- 首次观察返回 `NEEDS_ATTENTION / OBSERVER_DEADLINE_EXPIRED`。随后通过 RC 公开自检入口确认 `RUNNING / stop-reviewer`、`FRESH`、`active: true`、`ended: false`。没有提前关闭 Gateway，也没有写入正常关闭请求。
- 恢复沿用原 Session、原首轮 runId 和绝对截止时间，没有重发提示词。
- RC 找到注入的 `return list(values)` 缺陷，自主派发一次修复。首轮和修复原生终态均为 `ok`，最终为 `ENDED / NO_DEVIATION_FOUND`。
- 队列、私有审查与准入结算完成后，关闭前再次核对状态，最后正常清理独立 Gateway。进程组回执为 `NORMAL_CLEANUP / activeProcesses: 0`。
- 项目自身的 9 项 unittest 通过。这是样本自测，不是独立评分。

关键证据是该目录的 `flow-test.json`、`rc-status/soft-timeout-live-check.json`、`history.jsonl`、`sample-stop-receipt.json` 和业务/私有审查轨迹。

## 总时限到期结束整个样本

以下两次的 `maxRuntimeMs` 均为 `120000`，观察窗口为 `1000`。不调用 RC 的手动“只终止当前轮”接口，而是清理该实验独立进程组及其排队续跑。

- `runs/quicksort-hard-timeout-20261117T113705449Z-7dac7167/`：先退出观察函数，由独立守护到期收尾。进程组在截止后 **37 毫秒**确认清空，最终 `TIMED_OUT`，RC 自检为 `INTERRUPTED / UNVERIFIED`。
- `runs/quicksort-hard-timeout-20261117T114137467Z-6f9f4a4a/`：真实 CLI 观察进程返回退出码 2 并退出，比总截止时间提前约 **86 秒**。没有人工调用 resume，独立守护在截止后 **50 毫秒**确认清空并保存 `TIMED_OUT`。RC 同样保留 `INTERRUPTED / UNVERIFIED`。

超时没有伪造宿主原生成功终态；未完成私有审查仍保留最后观察状态，并在 `experiment-timeout.json` 中注明被中断。第二次以 checkpoint 保留原始工作树、状态和日志，不复制整棵项目来拖长超时收尾。

两次硬截止期间，完整纠偏样本继续正常运行。三次模型实验结束后，逐一检查其 Gateway、进程组守护及结果守护 PID，均已退出。执行器只处理本次独立环境。

## 异常路径与 Windows 回归

- 健康 WAITING/RUNNING/STOPPING 长时间停留在同一阶段，不触发“停滞误杀”；总时限独立生效。
- UNKNOWN、连续查询失败、查询不返回、最终核对失败均有限返回待核对；迟到查询不会被接受为完成。
- 当前轮 TERMINATED，但还有排队用户、私有审查、保留准入或修复派发时，不做正常关闭。
- 新轮次恰好出现在结束候选和最终核对之间时，继续观察该轮。
- 子进程、分离的孙进程随本次 Windows Job 一起被清理；另一个进程组外的进程保持存活。
- 进程组守护异常退出不会提前杀死健康工作；恢复打开原命名 Job，沿用原截止时间。
- PID、创建时间、Job 或清理回执不匹配时，不宣称清理成功；没有进程组身份的旧记录不能授权自动关闭进程。
- 溢出、零值或无效总时限在提交模型任务前拒绝；准备阶段到期记录 `TIMED_OUT`，不启动 Gateway 或模型。

本次实测还发现并修复两处 Windows 问题：PowerShell 5.1 在 Node `detached` 模式下不执行守护命令；以及已退出进程仍被其他句柄引用时，单看创建时间会误认其存活。后者改为检查内核退出信号，新增真实“保留已退出 Gateway 句柄”的回归用例，正常清理不会再等待该句柄释放。Windows 的对象生命周期说明见 [Microsoft 文档](https://learn.microsoft.com/en-us/windows/win32/procthread/terminating-a-process)。

发生过的零模型准备失败保留在机器可读摘要的 `preservedFailure`，没有覆盖成成功。最终代码的 Windows 准备、硬截止、守护恢复和保留句柄清理回归全部通过；真实模型链路在本次开发过程中完成，保留句柄修正由最终原生回归覆盖。

## 范围

模型实测使用关闭 `requirementFrame.enabled` 的受控样本，RC 的其他审查预算保持原值。完整默认配置的前置热钩子问题仍按 [既有记录](CORRECTION-VALIDATION.md) 保留，本次没有修改或宣称修复它。尚未在第二台物理 Windows 机器或鸿蒙项目上执行。

普通子孙进程属于本实验 Job；通过计划任务、WMI、外部服务或远端另行启动的作业需要项目自己的清理机制。结果守护异常时，进程组截止保护仍执行，操作方法见 [故障教程](tutorials/03-troubleshooting.md)。

复测命令：

```powershell
npm run test:windows
node scripts/test-flow.mjs
node scripts/test-flow.mjs --hard-timeout
```

后两条会真实调用模型，每条产生新目录，保留原尝试。
