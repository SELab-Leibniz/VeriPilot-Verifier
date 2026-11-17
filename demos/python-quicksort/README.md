# Python 快排纠偏 Demo

这是一个可以交给同事的独立演示包：自带实验程序快照、RC 插件包、快排任务、配置模板和运行入口。**不含 MA/OpenClaw 安装、个人模型凭据或私有运行目录。**

它演示的流程是：模型实现快排并测试 → 测试钩子在首轮交付后注入一次错误 → RC 审查发现偏差 → RC 自动派发修复 → 复验结束 → 实验程序确认全部收尾并保存结果。没有独立评估或评分。

## 1. 准备环境

收件机器需要 Windows、兼容 Node（22.22.3+ 的 22.x、24.15+ 的 24.x，或 25.9+）、Git、Python 3.9+、Windows PowerShell 5.1，以及完整的 **MA OpenClaw 2026.7.1-2** 安装。

先在这台机器的宿主 Profile 中配置可用模型和鉴权。RC 的 MA 1.11.0 包已经放在 `packages/`，实验时安装到隔离目录，无需改 MA 源码，也不会替换你平时使用的 Profile。Python 样例不需要鸿蒙 SDK，不需要 npm install 或 pip install。

在本文件夹打开 PowerShell：

```powershell
Copy-Item machine.example.yaml machine.yaml
```

编辑 `machine.yaml`，只需填写本机 Node、Git、Python、OpenClaw 和宿主 Profile 路径。包内 RC 路径可以保留。`models` 默认读取本机已配置的 Agent、业务模型和 RC reviewerModel；宿主没有配置 reviewerModel 时，将 `models.reviewer` 改为一个已配置的 `provider/model`。

路径使用 `/`，支持中文与空格；相对路径以机器配置文件所在目录为准。不要将示例中的 D 盘路径原样当成真实安装位置。`hostConfig` 和 `hostState` 必须属于同一个 Profile。

## 2. 先检查，再运行

```powershell
# 检查本机工具与样本，不调用模型
node runner/scripts/doctor.mjs --sample experiment.yaml --machine machine.yaml

# 查看解析到的输入、模型和路径，不调用模型
node run-demo.mjs --plan

# 真实启动宿主、创建新 Session、开启 RC，随后关闭；不提交模型任务
node run-demo.mjs --prepare-only

# 真正运行一次演示，会调用模型
node run-demo.mjs
```

也可用 `--machine D:/my-lab/machine.yaml` 指定外部机器配置。Node 未加入 PATH 时，用实际 `node.exe` 的完整路径替代命令中的 `node`。

`run-demo.mjs` 直接调用 `runner/` 内的实验程序及其现有受控缺陷夹具，不另造调度逻辑。终端会尽早输出 `Run: <绝对目录>`；本次状态从这时起就可以查询。

## 3. 为什么这次会触发纠偏

起始 `project/` 只有需求、约束和标准库测试启动器，业务 Agent 负责写出 `quicksort.py` 和 `test_quicksort.py`。在首轮真实业务交付结束前，夹具将交付的 quicksort.py 替换为：

```python
def quicksort(values: list[int]) -> list[int]:
    return list(values)
```

这个实现没有排序，违反项目需求。夹具只注入一次，随后由真正的 RC 和业务模型自己审查、派发及修复；它不修改 RC 状态、审查结果或宿主终态，也不对后续修复轮再次注入。

需求和提示词使用 `./quicksort.py` 这类明确的项目相对路径，让 RC 能唯一定位要检查的交付文件。改成自己的样本时，也请在原始需求中明确交付位置。实验程序会把宿主创建的实际 Session 工作树目录加到提交提示词开头；原始提示词与实际提交文本分别保存在 `config/prompt.md` 和 `config/submitted-prompt.md`。

`rc-config.yaml` 使用已验证的 Stop 纠偏配置，明确关闭 requirementFrame，以避开当前完整默认配置已知的前置热钩子超时。其他 RC 审查预算沿用原值。这只演示 Stop 自动纠偏，不表示所有 RC 模块都已验证。

Stop 审查可能需要数分钟。此前同类型运行约 13 分钟，本次时长仍取决于模型和网络；不要把一段时间没有新终端输出当作卡死。

## 4. 查询状态和恢复观察

另开一个终端，在本文件夹执行：

```powershell
node run-demo.mjs --status "D:/.../runs/<run-id>"
```

输出纯 JSON。主要看 `status`、`rc.stage`、`rc.health`、`observer.state` 和 `canScheduleNext`。正常过程中可能见到 `RUNNING / stop-reviewer`、自动修复与再次审查。**只有 `canScheduleNext: true` 才表示本次执行已结束且资源释放。** RC 当前轮 ended、观察进程退出或文件已生成，都不足以单独作此判断。

Ctrl+C 只停止观察，后台任务仍受本次总时限保护。恢复同一次运行：

```powershell
node run-demo.mjs --resume "D:/.../runs/<run-id>"
```

恢复保留原 Session、runId 和截止时间，不重新发送任务。已完成的运行无需恢复。重新执行不带参数的 run-demo.mjs 会创建新的尝试并再次调用模型。

## 5. 看哪些结果

默认结果在 `machine.yaml` 的 `outputRoot`，即 `%LOCALAPPDATA%/Temp/VeriPilotDemo/runs/`；每次运行各有独立子目录。放在包外的短路径既避免 Git 工作树路径过长，也让演示包保持可直接交接。

- `experiment-status.json`：整个实验的状态、RC 当前阶段、截止时间和调度标志。
- `result.json`：宿主执行结果及 RC 结果。`ARCHIVED` 表示控制流程收尾，不是独立业务评分。
- `artifacts/project/`：正常归档后的快排、unittest 和 test-output.txt。
- `rc-status/fault-injection.json`：缺陷实际注入的首轮 ID 和文件前后哈希；同目录还保存注入前后代码。
- `rc-status/history.jsonl`：运行与纠偏状态变化；`sample-stop-receipt.json` 确认本次独立进程组清理。
- `transcripts/index.json`、原始 JSONL 和 `logs/`：深入核对过程时使用。

交付版的 `example-result/` 附带本次实跑后的精选结果与说明，不含个人 Profile、凭据或原始私有轨迹。它是展示用的历史快照，当前状态应查询自己新建的运行目录。

自己的运行成功收尾后，也可导出同样的精选结果（目录必须是新的）：

```powershell
node collect-result.mjs "D:/.../runs/<run-id>" --out "results/my-run"
```

导出先核对真实缺陷、偏差审查、自动修复、最终复验和进程清理，再在复制出的代码上跑自身 unittest，不会把未完成或失败记录加工成成功，也不修改原始实验。

退出码：0 正常收尾或准备成功；1 配置/准备错误；2 待核对；3 宿主原生运行失败；4 总时限到期且清理确认；5 清理未确认。状态查询自身返回 0 只说明查询成功，实验结果在 JSON 里。

## 6. 时间上限与常见问题

`experiment.yaml` 中 `maxRuntimeMs: 1800000` 将单个实验限制为 30 分钟，准备、主任务和所有纠偏轮次累计计时，恢复不重置。达到总上限会结束本实验的后台工作和排队续跑，保存 `TIMED_OUT`；清理未确认时不会声称已结束。按机器和模型速度可自行调整这个值。

模型未配置、API 鉴权错误、限流或网络故障会保留为失败或未验证，不自动换模型或覆盖旧结果。`UNKNOWN`、`NEEDS_ATTENTION`、`TIMEOUT_CLEANUP_FAILED` 先查原记录，不重复提交同一个任务。更多说明在 `runner/tutorials/03-troubleshooting.md` 和 `runner/tutorials/04-experiment-status.md`。

若准备阶段出现 `fatal: '$GIT_DIR' too big` 或文件名/路径过长，将 outputRoot 改为 `D:/rc-runs` 这类短目录；单独启用 Git longpaths 不一定能消除原生工作树的路径长度限制。不要把输出放在很深的源码目录里。

自己跑过后的 `runs/` 可能含宿主凭据和私有轨迹，不能原样再分发。交付给同事时使用原始压缩包，或只分享已检查的精选产物。

## 开发者如何重建这个包

此目录在源码仓库中是模板；若没有 `runner/` 与 `packages/`，先在仓库根目录执行：

```powershell
node scripts/build-quicksort-demo.mjs --machine machine.yaml
```

生成 `dist/python-quicksort-demo/` 和对应 zip。BUNDLE.json 记录程序基础提交、明确列出的工作区修改和实际文件哈希；已有目标目录不会被覆盖，重建可用 `--out` 指定新目录。其他机器直接使用生成的文件夹即可，不需要先克隆仓库。
