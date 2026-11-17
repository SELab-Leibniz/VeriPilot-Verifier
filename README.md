# RC 实验执行 MVP

一个样本目录，一个命令。脚本准备工作副本，启动隔离 Gateway，创建新 Session，开启 RC，提交提示词，等待收尾后保存产物和轨迹。当前支持 **Windows + MA OpenClaw 2026.7.1-2 + RC 1.11.0**，无 npm 依赖，不包含独立评估或评分。

新机器从 [Windows 教程](tutorials/README.md) 开始。当前完整默认配置存在前置热钩子超时问题；自动纠偏已在关闭 requirementFrame 的隔离样本中跑通，见 [纠偏实测记录](CORRECTION-VALIDATION.md)。

状态控制、观察恢复与单个实验总时限的测试见 [流程验证记录](FLOW-VALIDATION.md)。

## 新机器配置

先安装兼容的 Node（22.22.3 起的 22.x、24.15 起的 24.x 或 25.9+）、Git、MA/OpenClaw，以及包含 Session 运行状态接口的 RC 1.11.0 MA 插件包；在这台机器的宿主配置好模型和凭据。鸿蒙项目另需安装匹配版本的 SDK、Java、OHPM、Hvigor。脚本复用已安装工具，不自动安装它们。

```powershell
Copy-Item machine.example.yaml machine.yaml
```

**换机器只改 `machine.yaml` 的机器设置。** 路径支持空格，Windows 路径使用 `/`；相对路径以该配置文件所在目录为基准，支持 `${USERPROFILE}` 等环境变量。

- `paths`：Node、Git、可选 Python、OpenClaw 目录、RC 的 MA 插件 `.tgz`、已有宿主配置/状态目录、结果目录。
- `harmony`：DevEco、SDK、Java、OHPM、Hvigor 目录。非鸿蒙样本可将对应值设为 `""`，或省略整个段落。
- `extraPath`：其他工具的 bin 目录。
- `env`：其他构建环境变量，例如项目需要的 `HOS_SDK_HOME`。此处不允许覆盖脚本的宿主隔离变量。
- `models`：默认 `auto`，读取宿主已配置的默认 Agent、业务模型和 RC reviewerModel；也可指定确切 ID。只校验配置存在，不宣称联网可用，不自动换模型。

脚本向自身、Gateway 及其业务子进程注入 `DEVECO_HOME`、`DEVECO_SDK_HOME`、`JAVA_HOME`、`OHPM_HOME`、`HVIGOR_HOME`，并将 Node、Git、可选 Python、Java/OHPM/Hvigor 的 bin 及 `extraPath` 加入 PATH。它不修改系统环境变量，也不替换项目里写死的绝对路径；鸿蒙项目应通过环境变量或自身构建配置使用这些路径。

`machine.yaml` 和 `runs/` 已被 Git 忽略。凭据从宿主配置和所选 Agent 的鉴权文件读取；机器环境、配置副本、Profile 和轨迹都可能含私有信息。整个运行目录按私有资料处理，分享时按需选取并检查内容。

## 跑一个样本

```powershell
# 先检查路径、模型配置和输入哈希，不启动 Gateway，不调用模型
node scripts/doctor.mjs --network
node scripts/run-experiment.mjs examples/quicksort/experiment.yaml --plan

# 可选：真实启动 Gateway、创建 Session、启用 RC，然后关闭；不提交任务
node scripts/run-experiment.mjs examples/quicksort/experiment.yaml --prepare-only

# 真正执行 Python 快速排序和 unittest 样本
node scripts/run-experiment.mjs examples/quicksort/experiment.yaml
```

可使用 `--machine D:/experiment/machine.yaml` 指定机器配置。每次执行创建新的运行目录，不覆盖既有记录。

样本结构：

```text
sample/
  experiment.yaml   # id、项目/提示词/RC配置路径、执行参数
  prompt.md
  rc-config.yaml
  project/
```

样本内的路径相对 `experiment.yaml` 解析。两个示例都包含完整的输入与 RC 配置，可以单独复制整个样本目录。

RC 配置来自原先指定的 `default_rc_config/config.yaml`。初始化沿用 RC 自身的函数，仅将评审模型适配到当前机器；保存原始及实际配置。RC 自身的审查预算保持原值，但整个实验受样本总时限约束。

每个包在 `experiment.yaml` 配置自己的最大运行时间，单位为毫秒。例如单个实验最多两小时：

```yaml
execution:
  maxRuntimeMs: 7200000
```

默认总上限为六小时。从创建运行目录开始，包含准备、业务任务、私有审查、所有自动纠偏和排队任务；`--resume` 沿用原截止时间。到期终止该实验独立 Gateway 及其进程组，保留部分输出和日志，记录 `TIMED_OUT`（退出码 4）。进程清理未确认时记录 `TIMEOUT_CLEANUP_FAILED`（退出码 5）。手动“终止当前轮纠偏、保留后续用户任务”的 RC 接口语义保持独立。

`observerTimeoutMs` 只限制一次观察窗口，默认六小时；`uncertainTimeoutMs` 限制持续无法确认状态的等待，默认五分钟；`queryTimeoutMs` 限制单次查询，默认十五秒。它们需要正整数。观察超时返回 `NEEDS_ATTENTION`，保留正常工作和独立截止守护进程；总时限到期仍会清理该实验。`businessTimeoutMs: 0` 表示业务运行只受实验总时限约束。

多个包按顺序调用同一个命令即可；某个命令返回非零时停止批次并检查该次结果，不自动重试：

```powershell
foreach ($sample in Get-ChildItem D:/samples -Directory) {
  node scripts/run-experiment.mjs "$($sample.FullName)/experiment.yaml"
  if ($LASTEXITCODE -ne 0) { break }
}
```

## 输出与恢复

终端会输出 `runs/<run-id>` 的绝对路径。主要文件：

- `run.json`：输入哈希、模型、Session/运行 ID、实际工作目录、阶段、`experimentStartedAt` 和 `experimentDeadlineAt`。
- `experiment-status.json`：供外层控制器读取的实验状态、心跳、RC 阶段、截止时间与调度标志；约每秒自动更新。
- `result.json`：宿主终态、RC 终态及原因；`ARCHIVED` 代表执行已收尾留档，不代表程序通过独立评估或 RC 语义通过。
- `artifacts/project/`：正常归档后的项目，包含业务生成的测试及输出；`artifacts/changes.patch` 是已跟踪文件的 diff，新文件以项目副本为准。超时不再复制整棵项目，部分产物保留在 `result.json.partialProject`，避免大项目复制拖住超时收尾。
- `transcripts/`：业务及 RC 私有会话原始 JSONL 和索引。
- `rc-status/latest.json`、`history.jsonl`、`raw/`：状态快照、观察历史和 RC 原始工作记录。
- `rc-status/sample-stop-receipt.json`：本实验进程组清理回执；`activeProcesses: 0` 才确认清理。超时详情见 `experiment-timeout.json`。
- `config/`：输入副本、实际 RC 配置、脱敏宿主配置。
- `runtime/`：隔离宿主配置、鉴权、插件、工作树及运行状态，属于私有运行目录。
- `logs/`：Gateway 和脚本日志。

宿主返回的实际业务 Worktree 路径保存在 `run.json.identity.projectRoot`，其当前状态文件是 `<projectRoot>/.runtime-correction/session-runtime-status.json`。

提交任务时，程序将上述实际 Worktree 目录加入提示词，指明文件工具与 PowerShell 命令的目标位置。`config/prompt.md` 保留原始输入，`config/submitted-prompt.md` 保留实际提交文本，其哈希记录在 `run.json.submittedPromptSha256`。

外层查询使用 `node scripts/experiment-status.mjs "D:/experiment/runs/<run-id>"`，输出纯 JSON。函数入口为 `lib/experiment-status.mjs` 的 `queryExperimentStatus(runDir)`。释放本次实验槽位看 `canScheduleNext`，不要仅凭 RC 的 `ended` 或观察脚本退出判断结束。字段、状态与轮询用法见 [实验状态接口](tutorials/04-experiment-status.md)。

正常收尾同时等待业务/自动纠偏运行的准确 ID 原生终态、RC 当前轮结束、调度队列与私有审查结算，并在关闭 Gateway 前再次查询。已失效但仍为 RESERVED 的启动准入也会阻止收尾。长期处于健康 RUNNING/WAITING/STOPPING 不按阶段停留时长误杀。RC `UNVERIFIED` 等结果原样记录，不变成成功。

退出码：`0` 为正常收尾或准备成功，`1` 为配置/入口错误，`2` 为待核对，`3` 为已留档但宿主运行出错，`4` 为总时限到期且清理确认，`5` 为到期但清理未确认。RC 的语义结果单独保存在 `result.json.rc`，退出码不对它进行评分。

脚本观察中断、Gateway 连接错误或终态未知时记录 `NEEDS_ATTENTION`（退出码 2），保留 Gateway 和原 ID。确认没有旧观察进程后恢复观察：

```powershell
node scripts/run-experiment.mjs --resume "D:/experiment/runs/<run-id>"
```

恢复只观察原运行，不重新提交提示词、不新建 Session、不重新启动死掉的 Gateway。总时限到期时直接核实原进程组清理并保存超时结果。若中断发生在提交之前，检查 `run.json` 和日志。正常结束只关闭本次启动且进程身份匹配的 Gateway。`Ctrl+C` 停止脚本观察，后台工作继续受原总时限约束。

## 本地检查

```powershell
npm test
# 使用 machine.yaml 验证真实 RC 包与 Windows 宿主准备，不调用模型
npm run test:windows
# 指定其他机器配置
npm run test:windows -- --machine "D:/experiment/machine.yaml"

# 以下两项真实调用模型，分别验证观察恢复和两分钟硬超时
node scripts/test-flow.mjs
node scripts/test-flow.mjs --hard-timeout
```

`lib/yaml.mjs` 来自 RC 提交 `846eb7b` 的轻量 YAML 解析器；配置使用两空格缩进、不支持 YAML anchors/复杂标记。宿主适配使用已安装 OpenClaw 的公开 Gateway SDK，项目初始化使用该次提取的 RC 插件函数。MA/OpenClaw 安装目录和已有宿主配置保持只读。

## 触发一次自动纠偏

需要交给同事的完整演示包，可用 `node scripts/build-quicksort-demo.mjs --machine machine.yaml` 构建。它包含实验程序、RC 包、快排样例和独立入口，使用方法见 [快排 Demo 模板说明](demos/python-quicksort/README.md)。

```powershell
# 可选：检查真实 Gateway 能加载测试钩子，不提交模型任务
node scripts/test-correction.mjs --prepare-only

# 执行带受控缺陷的快速排序样本
node scripts/test-correction.mjs

# 隔离前置模块问题时使用：只关闭该样本的 requirementFrame
node scripts/test-correction.mjs --without-frame
```

这个专用测试入口使用普通 MVP 流程，并在隔离 Gateway 中增加一个测试插件。插件只在首轮真实业务运行结束前，将交付的 `quicksort.py` 替换为“返回原列表”的错误实现；随后由 RC 自己审查、派发修复并复验。它不修改 RC 代码、状态、审查结果或业务会话记录，后续修复轮不会再次注入缺陷。

输入位于 `examples/quicksort-correction/`，默认 RC 配置沿用完整默认值；`--without-frame` 对应另一份配置，只把 `requirementFrame.enabled` 从 true 改为 false，预算及 Stop 纠偏保持原值。两个配置的结果应分别解释。`rc-status/fault-injection.json` 记录实际首轮运行 ID、注入时刻及前后哈希，对应代码副本也保存在同目录。仅看到最终正确代码不足以证明纠偏发生；还需核对 RC 偏差记录、自动修复原生运行及复验终态。直接用普通 `run-experiment.mjs` 运行这个样本不会注入缺陷。
