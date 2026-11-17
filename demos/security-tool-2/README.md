# security_tool_2 实验 Demo

这是第二个可独立交接的实验包。它复用现有实验程序，在新的 Session 和工作树中运行一个真实的鸿蒙 ArkTS 修复任务。**单次实验最多两小时，不包含独立评估或评分，不注入人为错误。**

## 任务和输入

权限管理模块刷新应用列表时，没有应用服务器返回的账号策略快照；选择某个应用查看详情时，又多余地重新抓取整个账号策略。任务要求修复这两个行为，并在刷新时保留已选应用已加载的 3D 权限详情。

`PUBLIC-INPUT.json` 只保存原始公开任务字段。原始项目来自 `Deslord319/security_tool` 的提交 `d72abe27c935b878363f4e849bd370b017abf3ea`，完整原始树保存在 `assets/security-tool-2-base.zip`，来源和哈希见 `SOURCE.json`。不含参考补丁、隐藏测试、评分脚本或历史实验修复。

`project/` 是本次运行的输入。它在原始项目基础上只增加 `requirements.md` 和 `demo-checks.ps1`，未预先修改业务代码。基线自带上游公开的 OpenHarmony 测试签名材料；本 Demo 只构建 unsigned HAP，不签名、不安装、不连接设备。

## 新机器配置

需要 Windows PowerShell 5.1、兼容 Node、Git、Python 3.9+、MA OpenClaw **2026.7.1-2** 完整安装，以及 **HarmonyOS API 24 / 6.1.1** 工具链、Java、OHPM、Hvigor。模型与鉴权先在本机宿主 Profile 中配置好。包内已附 RC MA 1.11.0，不含个人 Profile 或模型凭据。

在本文件夹打开 PowerShell：

```powershell
Copy-Item machine.example.yaml machine.yaml
```

按本机实际环境修改这一个 `machine.yaml`：

- `paths`：运行实验程序的 Node、Git、Python、OpenClaw、宿主 Profile、私有结果目录。包内 RC 路径可以保留。
- `harmony`：DevEco、API 24 SDK、Java、OHPM、Hvigor 的实际目录。
- `env.DEVECO_NODE_HOME`：鸿蒙工具链所用 Node 的目录。它与运行 OpenClaw 的 `paths.node` 分开配置；当前工具链自带 Node 18，OpenClaw 使用兼容的新 Node。
- `models`：默认 `auto`，读取本机已配置的 Agent、业务模型和 RC reviewerModel。缺少 reviewerModel 时，填写一个已经配置的 `provider/model`。

所有路径集中在这个文件中，使用 `/`，允许中文与空格。相对路径按 machine.yaml 所在目录解析。把结果放在包外的短目录；默认是 `%LOCALAPPDATA%/Temp/vp-st2/`。若 Git 或工具链仍提示路径太长，可以改成 `C:/rc2` 等更短目录。

## 检查与运行

```powershell
# 路径、模型配置和输入检查，不调用模型
node runner/scripts/doctor.mjs --sample experiment.yaml --machine machine.yaml
node run-demo.mjs --plan

# 真实创建隔离宿主、Session、启用 RC，随后清理；不提交模型任务
node run-demo.mjs --prepare-only

# 执行一次真实实验，会调用模型
node run-demo.mjs
```

可用 `--machine D:/lab/machine.yaml` 指定外部配置。启动后终端会输出 `Run: <绝对运行目录>`。每次重新执行普通 run 命令都会新建一次尝试，不覆盖旧结果。

这是普通实验入口，没有快排 Demo 的受控缺陷插件。RC 使用关闭 requirementFrame 的 Stop 配置，避免已有的前置热钩子超时；是否发现偏差和启动修复，以这次真实记录为准。公开测试或构建通过，也不等于隐藏评测通过。

## 两小时上限、查询和恢复

`experiment.yaml` 明确配置：

```yaml
execution:
  maxRuntimeMs: 7200000
  observerTimeoutMs: 7200000
```

`maxRuntimeMs` 从创建运行目录开始累计，包含准备、主任务、私有审查和全部自动纠偏轮。到期结束本实验独立进程组，保存 `TIMED_OUT` 和清理回执。清理未确认时保留 `TIMEOUT_CLEANUP_FAILED`，不会把它当作正常结束。

另开终端查询当前运行：

```powershell
node run-demo.mjs --status "C:/.../<run-id>"
```

输出纯 JSON。查看 `status`、`rc.stage`、`rc.health`、`observer.state`、`deadlineAt`、`remainingMs`；**`canScheduleNext: true` 才能确认本次槽位可以释放。** 不要仅凭 RC 当前轮 ended、终端暂时没输出或观察进程退出判断结束。

Ctrl+C 只停止观察，后台工作仍受原两小时截止时间保护。继续观察同一次运行：

```powershell
node run-demo.mjs --resume "C:/.../<run-id>"
```

恢复不重发任务、不换 Session，也不重新计算两小时。网络、鉴权或输出长度错误会原样保留，不自动换模型或重跑。

隔离宿主的 `agents.defaults.timeoutSeconds` 同步设为 7200 秒，避免宿主仍按较短的单轮默认预算提前终止复杂任务。独立守护进程继续执行原绝对截止时间；宿主预算不会把实验总时限延长到两小时以后。

## 检查哪些结果

- `<runDir>/experiment-status.json`：外层控制器查询的实验状态文件。
- `<runDir>/result.json`：原生宿主终态、RC 终态、收尾原因；`ARCHIVED` 表示流程收尾，不是业务评分。
- `<runDir>/artifacts/project/`：正常留档的最终项目。项目中的 `demo-output/` 保存公开检查日志、每次调用的退出码和 `checks.jsonl`。
- `<runDir>/rc-status/history.jsonl`：RC 审查、等待纠偏、自动修复等状态变化。
- `<runDir>/rc-status/sample-stop-receipt.json`：清理回执，`activeProcesses: 0` 确认后台工作释放。
- `<runDir>/transcripts/`、`logs/`：需要定位问题时查询原始过程。

到期时不复制整棵项目，部分产物路径见 result.json 的 `partialProject`。运行目录包含私有 Profile 与轨迹，交接时使用原始 Demo 包，按需分享检查过的精选结果。

正常项目归档省略可重建的 `oh_modules/`、`node_modules/`，避免复制 Windows 依赖 junction；原始工作树完整保留。源码、公开测试报告与 unsigned HAP 仍保存在归档中。

如需交接已经结束的某次结果，可导出精选快照，输出目录必须是新的：

```powershell
node collect-result.mjs "C:/.../<run-id>" --out "results/my-run"
```

导出保留成功、失败、超时与未验证的原始状态，并挑选公开检查回执、业务改动和状态时间线；不重新执行模型或评分。交付版的 `example-result/` 是历史实跑快照，不能作为新机器的当前状态。

`demo-checks.ps1` 的 `install`、`test`、`build`、`docs` 分别使用真实 OHPM、Hvigor 和项目文档检查脚本。它保留工具退出码，`test` 是原项目公开测试；运行成功本身不能证明执行了非零测试，应同时看原始报告。SDK/API 不匹配、缺少 Java、依赖下载失败、旧 Hvigor 缓存等问题，先依据日志处理环境，再观察原实验，不盲目补发任务。

`demo-output/*.json` 和 `*.log` 是对应阶段最近一次调用的记录；`checks.jsonl` 保留调用时间和退出码，先前调用的完整终端输出还保存在原生会话轨迹中。两小时是总上限，任务正常完成或宿主明确报错时可以提前收尾。

## 从源码构建交接包

本目录在源码仓库中是模板；没有 runner/ 或完整 project/ 时，先在仓库根目录执行：

```powershell
node scripts/build-security-tool-2-demo.mjs --machine machine.yaml
```

生成 `dist/security-tool-2-demo/` 与 zip。已有目标不覆盖，可用 `--out dist/新目录` 保留不同版本。BUNDLE.json 记录实验程序基础提交、工作区覆盖文件及最终文件哈希。接收者直接使用构建好的文件夹，不需要克隆上游代码或完整评测数据集。

包内 `runner/` 是无 `.git` 的程序快照。构建交接包需在实验程序源码的 Git 检出中执行；便携快照的测试会跳过两项依赖 Git 历史的打包回归，运行和宿主验证照常可用。
