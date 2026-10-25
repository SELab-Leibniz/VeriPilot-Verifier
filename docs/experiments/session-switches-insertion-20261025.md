# 项目与 Session 开关：插入排序隔离实测

2026-10-25，分支 `codex/session-rc-switches`。按用户要求，本轮只验收开关的准入、取消和状态保留；不处理 Stop 判定问题，不把 Stop PASS 或纠偏修复质量作为通过条件。

## 结果

- 12 种核心组合全部通过：项目 `enabled` 的两种状态 × `sessionDefaults.enabled` 的两种状态 × Session 继承／明确开启／明确关闭。3 种准入开启，9 种准入关闭。
- 2 项兼容检查通过：没有项目配置时不启动 RC；旧配置省略两个新增字段时延续默认开启。
- 6 项动态切换的原始结果为 5 项通过、1 项未通过。未通过项是手改重新开启后未观察到新的 Stop 复审派发；普通 RC 的工具前后检查已恢复。按用户要求，保留该 Stop 记录，不继续定位或修复，也不宣称完整 Stop 重开链路通过。

核心组合与兼容结果取自 [05 原始报告](../../experiments/live-session-switches-insertion-20261025-05/report.json) 的 `cases`。动态切换以 [07 原始报告](../../experiments/live-session-switches-insertion-20261025-07/report.json) 为准，覆盖：

1. 等真实审查模型请求开始后关闭 A；同项目 B 可以独立开启，A/B 使用不同 taskId，两个算法文件均通过验收。
2. 重新开启 A 后产生新的审查派发，保留原 taskId 和计数。本轮实际纠偏计数为 0，不涉及非零预算恢复验收。
3. 项目总关闭覆盖已明确开启的 A，保留 A 开／B 关的选择，恢复项目后按原选择启用。项目关闭期间的真实算法任务不派发新审查。
4. 手改 `sessions.local.yaml` 后，经正常状态检查点生效；关闭时没有 RC 工具检查，重新开启后恢复 `UserPromptSubmit`、Write/Exec 的工具前后检查。额外的新 Stop 派发断言未通过。
5. `/rc-session off/on`、查询及宿主重启保留会话身份、选择、taskId、预算和 epoch；这些控制操作不新增审查。
6. 宿主侧 `plugins.entries.runtime-corrector.config.enabled: false` 阻止 RC，算法任务仍可正常完成，恢复后解除上层阻断。

## 方法与边界

使用 MatrixAssistant 内置 OpenClaw `2026.7.1-2`、原生项目目录桥和已有 `custom/deepseek-v4-flash` 配置。创建独立 Gateway、端口、宿主状态目录、工作目录、插件副本及临时 Session，不使用用户正在运行的宿主或会话。

每个业务任务均要求模型实际写一个 `insertion_sort.py`。观察器只写配置、正式要求和独立验收器，不代写算法。验收器检查 36 组输入，包含空列表、负数、重复值和固定随机样本，禁止调用 `sorted`、`list.sort`；另已检查 14 个组合产物使用了插入排序的移位与插入循环。

开启的验收依据是创建独立 RC 任务并派发私有审查；关闭的验收依据是实际完成算法任务，同时 RC 任务、私有审查和 Stop 记录均为零。UI 验证调用按钮将使用的认证接口 `runtime-corrector.session.get/set`，没有把尚未接入的 UI 按钮操作计作已测试。

测试策略保留动态需求处理和 Stop M08，关闭其他纠偏功能；`materialRoots: []`、`panel.size: 0` 用于避免额外的首次基线预处理。未据此声称其他指标、Skill、产物纠偏或完整错误修复链路通过。

05 和 07 的 161 份 `lib/`、`config/` 源文件摘要相同，构建副本按既有宿主转换规则核对。源码基点为 `6189edd9e43e9e4a61548808bc2572782b316566`，未提交的实际实现以报告 `sourceHashes` 为准。本轮没有修改插件实现。

07 的真实审查模型请求在 `04:43:50.946 UTC` 开始，关闭请求在 `04:43:51.209 UTC` 发出，之后对应审查记录结算，任务仍为 `ACTIVE`。这项检查没有使用 Stop PASS 作为条件。

[开关检查补充审计](../../experiments/live-session-switches-insertion-20261025-07/switch-only-audit.json) 对手改关闭／开启的真实业务回合逐条核对：关闭回合的 RC Hook 事件为 0；开启回合有 5 条需求／工具检查事件。开启后的文件摘要匹配当时的 RC 文件变更记录，独立重跑 36 组算法验收通过。此证据确认普通开关准入恢复，不替代缺失的 Stop 派发证据。

关闭后，本地取消及迟到结果隔离与宿主已接收请求的物理清理分开观察。宿主旧运行记录可能稍后才结算；观察器允许最多 90 秒清理等待，这不是开关生效时间。

## 原始失败与重测

历史试跑均保留，没有改写成通过。01 包含早期 Stop 终审超时，后来按用户要求排除该验收项；02–04 是范围、模型或预处理配置调整时主动中断。

05 的整体状态为 `MIXED`：14 项组合全部通过，但恢复检查过早读取了历史审查记录。06 改为等待新派发，并增加真实模型请求开始的证据；其 30 秒清理等待又被宿主约 31 秒的延迟结算超出，且该次失败留下关闭配置，导致后续检查串扰。07 修正观察器等待，并用 `finally` 恢复实验配置后重测；插件源码保持相同。07 仍为 `MIXED`，保留上述 Stop 未重新派发的失败。05–07 的观察器源码及其摘要保存在对应实验目录。

## 复现

```powershell
$env:RC_INSERTION_PROVIDER = 'primary'
node scripts/diagnostics/session-control-insertion-live.mjs experiments/live-session-switches-insertion-NEW all
```

输出目录必须不存在。只重跑六项动态切换时，将最后一个参数改为 `transitions`。脚本读取已有模型配置，密钥仅通过进程环境传递，不写入报告或输出；运行记录位于被 Git 忽略的 `experiments/live-*/`。

最终隔离 Gateway 已关闭，05 和 07 均确认原宿主配置摘要未变、宿主默认工作目录没有 RC 产物。全部七个实验的进程核对见 [清理记录](../../experiments/live-session-switches-insertion-20261025-07/process-cleanup.json)。检查了 52 个报告、配置及日志输出文件，未发现原始模型密钥。
