# 纠偏触发与 Windows 迁移验证

日期：2026-11-17，以下时间使用 Asia/Shanghai。没有独立评估或评分。

## 结论

**Stop 自动纠偏链路在关闭 requirementFrame 的隔离样本中完成一次真实闭环。完整默认配置仍有前置热钩子超时，不能据此宣布默认配置全部正常。**

成功样本位于：

`runs/quicksort-correction-no-frame-20261117T100634452Z-ec15222c/`

18:06:34 开始，18:18:07 留档结束。业务提示词提交一次，RC 自动启动一次修复，未人工补发修复提示词、修改审查结果或修改运行中的 RC 配置。

## 受控缺陷与自动修复证据

测试钩子在首轮真实业务交付结束前，将 `quicksort.py` 改成 `return list(values)`。它只改变交付文件，不伪造宿主终态或业务会话，不修改 RC 代码、状态、调度、评审结果。后续修复轮不会再次注入缺陷。

- 首轮 runId：`d5571396-1997-40eb-b66c-99885e90684c`，原生终态 `ok`。
- RC 首次审查：`STOP_REVIEW_SETTLED / DEVIATION`，18:13:27。
- 自动修复 runId：`rc-stop-379471756af6ff0a55c31005d029a9bdba736380694462045dab310afd475a12`。
- 对应准入为 `USED / STARTED / DELIVERED`，原生修复终态 `ok`，18:14:32。
- 对应修复 runId 的复验：`STOP_REVIEW_SETTLED / NO_DEVIATION_FOUND`，18:18:04。
- 最终公开状态为 `ENDED`、`active: false`、`ended: true`、`pendingUserTasks: 0`；两个私有 Stop 审查运行均 `SETTLED`。
- 业务与修复保持同一个 Session：`217c054b-ad60-4bde-85e0-9e88fcb8f011`。
- 原生终态、RC 状态、调度、私有审查和启动准入均收尾后，MVP 自动关闭其专属 Gateway。
- 留档交付再次运行 `python -m unittest -v`：**9/9 通过**。这是样本自身的单元测试，不是独立评分。

复验总体状态是 `NO_DEVIATION_FOUND`，细项进度仍记录 **5 项中 1 项 UNVERIFIED**。这不等于所有语义验收项都 PASS；这里证明的是偏差触发、自动修复和收尾链路，以及该排序缺陷通过样本测试。原始状态与未验证项均保留。

证据位置：

- `rc-status/fault-injection.json`：注入时刻、精确 Session/首轮运行及前后哈希。
- `rc-status/quicksort.before-injection.py`、`quicksort.injected.py`：故障前后源文件。
- `rc-status/latest.json` 与 `history.jsonl`：公开状态及原始 ledger。
- `run.json`、`result.json`：两次原生运行终态、最终 RC 结果、Gateway 关闭记录。
- `artifacts/project/`：最终代码、测试、真实测试输出。
- `transcripts/`：4 份捕获轨迹，索引无缺失来源标记；未将此扩展为独立的全量轨迹审计声明。

故障前与最终交付 SHA256 均为 `f1a35edce50b7a8debcee645ea4ebb83aba19e77af8f363dbd6daea28cb2cfd8`；注入后为 `0aaa6c7b39850a04321d29882da44ef2e4a0ef4a0c2379fcffe5e9991db52d72`。这次是预设缺陷验证，不能推算自然任务中的纠偏召回率。

## 完整默认配置的失败记录

以下两次均完整保留，未被成功样本覆盖：

1. `runs/quicksort-correction-20261117T095458254Z-8f634aaf/`：前置钩子出现 `RC_HOOK_UNAVAILABLE`，且初版测试钩子误用默认 workspace 校验实际 Session Worktree，缺陷没有注入。还有网络连接重置与 PowerShell 命令错误。该次自动结束，未发生纠偏。其后一次定向 abort 请求遇到已关闭的 Gateway，没有送达，未重试。
2. `runs/quicksort-correction-20261117T100315284Z-28d16f86/`：测试钩子修正后成功注入，但 RC 已在前置阶段因同样的 `RC_HOOK_UNAVAILABLE` 结束，结果为 `UNVERIFIED`，没有自动修复。

源码中热钩子上限为 10 秒，内部调用留有返回余量，前置调用超时会释放当前 RC 运行；把 Stop 审查预算设为两小时不能扩大这个上限。本次没有改 RC 插件代码，也没有把未知结果改成成功。

隔离配置与默认 RC YAML 的差异仅为 `requirementFrame.enabled: true -> false`，其余 RC 开关和预算相同。样本提示词同时补充了 PowerShell 使用方式，并加入保存真实 unittest 输出的标准库运行器。因此这些尝试用于功能诊断，不作为严格单变量性能对照。

## 新机器适配检查

本轮补充了：

- 独立 `doctor` 预检、可选无鉴权 HTTP 连通检查。
- 宿主 JSON5 读取、隐式 main 和真实默认 Agent 选择。
- 错误 Git 可执行文件、SDK/环境变量缺失、输入/输出互相包含、旧 RC 配置目录等预检。
- 公开计划脱敏，运行时保留实际环境；父 SDK 和子 Gateway 都清除继承的 OpenClaw Profile/Token 路由变量。
- Gateway 离线时记录 `NEEDS_ATTENTION / GATEWAY_UNAVAILABLE`，保留原 ID，不新建 Session 或重发任务。
- 本次 Git 种子仓库关闭本地签名并使用独立空 hooks 目录，保留用户全局配置。
- 测试入口从 `machine.yaml` 读取路径；离线测试默认不启动 Gateway，Windows 准备测试不调用模型。

本机已实测：PowerShell 7.6.9；Windows PowerShell 5.1.26100.9711；Node v26.13.0；Git 2.54.0.windows.1。Windows 原生准备测试采用中文/空格路径、JSON5 Profile、隐式 main、故意残留的旧 Profile/Token、开启全局 Git 签名和失败 pre-commit 钩子，结果为 `PREPARED`，无业务请求，原全局 Git 配置未被修改。

最终检查结果：`npm test` 为 24 项通过、2 项宿主检查按设计跳过；`npm run test:windows` 为 **26 项通过、0 失败、0 跳过**。后者从 `machine.yaml` 自动读取测试路径，验证了新版统一测试入口。

三次真实尝试的精简元数据保存在 [validation/correction-20261117.json](validation/correction-20261117.json)，失败未被成功记录替代。

教程见 [tutorials/README.md](tutorials/README.md)。尚未在另一台物理 Windows 或鸿蒙项目上实跑；这些边界在教程中明确保留。
