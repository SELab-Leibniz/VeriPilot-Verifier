# 给外层控制器的实验状态接口

每次实验自动维护一个文件：

```text
<machine.yaml 的 outputRoot>/<run-id>/experiment-status.json
```

也就是终端输出的 `Run: <目录>` 下的 `experiment-status.json`。一个运行目录对应一个尝试，`runId` 与 `sampleId` 分开；同一样本重跑会有新的 `runId`。

外层启动脚本后即可从标准输出读取这条 `Run:` 信息并查询，无需等待启动命令退出。新运行的状态文件在输出该路径前已开始写入。

## 查询命令与函数

```powershell
node scripts/experiment-status.mjs 'D:/rc-lab/runs/<run-id>'
```

标准输出只有 JSON，适合被 PowerShell、Python、Node 或其他外层控制器调用。查询成功的退出码为 `0`，即使被查询实验是 `FAILED` 或 `TIMED_OUT`。查询失败退出码为 `1`，输出 `UNKNOWN`、错误码及 `canScheduleNext: false`；不能当作实验已完成。

Node 函数入口：

```javascript
import { queryExperimentStatus } from './lib/experiment-status.mjs';

const state = await queryExperimentStatus(runDir, { timeoutMs: 5000 });
if (state.canScheduleNext) {
  // 本次工作已结束且执行资源已释放。
  // 根据 executionExitCode、rc.outcome 和自己的失败策略决定是否继续。
}
```

函数默认最多等待五秒，失败或超时会抛出异常。查询重新读取本次 `run.json`、结果、RC 公开状态和进程组回执；不写这些文件，不调用 Gateway、不自检修改 RC、不重新提交任务或创建会话，也不重置截止时间。RC 状态通过其公开只读函数读取；`rc.source` 表示来自公开文件、近期观察或最终结果，不把读取文件宣称为一次 Gateway 实时确认。

查询兼容已有运行目录，不要求它先有 `experiment-status.json`。旧记录没有进程组清理证明时，`resourcesReleased` 可能为 `null`，不会仅凭一个旧 PID 或 `gatewayStoppedAt` 放行。目录包含原机器身份和绝对路径，不作为跨机器续跑包。

## 外层主要看什么

- `schemaVersion`：当前为 `rc-experiment.status.v1`。
- `runId`、`sampleId`、`identity.sessionId`、`firstRunId`：实验尝试、样本和宿主身份。不要把样本 ID 当作一次运行 ID。
- `status`：整个实验的状态，见下文；`phase` 保留具体执行阶段，例如 `CREATING_SESSION`、`OBSERVING`、`ARCHIVING`。
- `terminal`：实验执行已到达终态；不表示业务正确或 RC 审查通过。
- `resourcesReleased`：本实验执行环境已确认释放；`null` 表示没有足够证明。
- `canScheduleNext`：`terminal` 且资源确认释放时为 `true`。外层释放该实验槽位使用这个字段；失败后是否继续跑下一个样本仍由外层策略决定。
- `attentionRequired`、`reason`、`issues`：需要接管、恢复观察或核对的原因。
- `executionExitCode`：执行结果对应的退出码。运行中为 `null`；它与查询命令自身的退出码不是同一个概念。
- `rc.status`、`rc.stage`、`rc.active`、`rc.ended`、`rc.health`、`rc.outcome`：纠偏状态。RC 当前轮结束或 TERMINATED 不等于整个实验结束，不能用它们单独释放实验槽位。
- `observer.state`：观察器为 `ACTIVE`、`STOPPED`、`STALE` 或 `UNKNOWN`。观察停止后，业务和 RC 可能继续运行，`canScheduleNext` 仍为 `false`。
- `deadlineGuard.state`：本实验进程组截止守护的当前心跳状态；清理确认后为 `STOPPED`。
- `deadlineAt`、`remainingMs`、`elapsedMs`、`timeoutExpired`：原截止时间、剩余预算和耗时。时间戳为 Unix 毫秒，持续时间也是毫秒；已结束时剩余值为 0。早已正常结束的实验不会因为查询时超过原截止时间而变成超时。
- `resultFinalized`：`run.json` 与 `result.json` 已完成一致收尾。硬截止的进程组回执可先确认结束，此时状态可为 `TIMED_OUT`、`canScheduleNext: true`，而此字段仍为 `false`；收集最终摘要前可以继续等它变成 `true` 或核对原记录。释放执行槽位不表示可以删除尚在收尾的运行目录。
- `artifacts`：结果文件、实际项目、轨迹索引和日志路径。

状态含义：

- `PREPARING`：复制输入、启动宿主、创建会话或准备提交任务。
- `RUNNING`：正在运行或恢复观察；RC 的具体阶段看 `rc.stage`。
- `FINALIZING`：正在关闭、归档或等待到期清理证明；不放行。
- `NEEDS_ATTENTION`：观察超时、中断或其他待核对情况；原工作可能仍在运行。
- `UNKNOWN`：无法确认当前执行状态；不放行。
- `PREPARED`：`--prepare-only` 已结束，未提交模型任务。
- `COMPLETED`：原生执行已正常收尾归档；不表示独立业务评分或 RC 语义结果通过。
- `FAILED`：准备失败，或已归档但宿主原生运行报错；是否释放要同时看 `canScheduleNext`。
- `TIMED_OUT`：总时限到期，已确认进程组清空，或准备阶段到期且未启动 Gateway。
- `TIMEOUT_CLEANUP_FAILED`：到期但清理未确认；不放行。到期后一段收尾时间内先显示 `FINALIZING`，超过 60 秒仍无证明会提示清理未确认，而不是无限保持等待状态。

## 心跳与读取方式

状态文件原子替换，正常约每秒更新一次，阶段变化也会更新。观察器退出后，独立结果守护继续发布状态，直到结束。发布心跳说明状态发布器有响应，不代表模型或纠偏一定健康；还需要看 `rc.health`、观察器及守护状态。

直接读文件时，用 `当前时间 - heartbeatAt > staleAfterMs` 判断非终态快照是否过期，默认 `staleAfterMs: 15000`。JSON 中的 `stale` 只代表生成那次快照时的判断，不会随时间自行变化。过期、缺失或读到异常时调用查询入口重新核对，不把它们当作完成。

状态发布写入失败时检查 `logs/status-publisher-error.json`。发布失败不会为了更新状态而提前终止健康的业务或纠偏；查询入口仍可重新读取原始记录核对。

终态和有效清理回执是稳定事实，不因发布器正常退出而变成过期未知。若守护结果收尾异常退出，查询仍能读取匹配的硬截止回执，确认 `TIMED_OUT`，并用 `resultFinalized` 如实区分摘要是否已完成；它不会修改原结果。

一个简单的外层轮询：

```powershell
$state = node scripts/experiment-status.mjs $runDir | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw '状态查询失败，保留原实验，先核对' }
if ($state.canScheduleNext) {
  # 收集结果，按 executionExitCode 和失败策略决定后续调度。
} elseif ($state.attentionRequired) {
  # 保留原 ID；需要恢复时使用 run-experiment.mjs --resume 原目录。
} else {
  # 继续等待并定期查询，不重复提交任务。
}
```

预检在分配运行目录前失败时没有本次状态文件，外层应处理启动命令的退出码与错误输出。整个运行目录仍按私有实验资料处理；状态 JSON 不包含模型凭据、完整配置或 RC owner token。
