# 阶段3/4：真实 Stop 与厨房端到端隔离入口（准备完成，尚未 live）

2026-10-24 核对。只新增本实验目录文件，没有启动 Gateway、调用模型、修改原宿主配置/原项目/session。默认预检只读元数据；`--live` 才会创建新环境并联网。原有 `127.0.0.1:18789` 不使用。

## 当前可用环境

- 宿主：`C:/Users/user/workspace/program_workspace/MatrixAssistant/resources/openclaw`，2026.7.1-2。它含 MA 的 spawnedCwd 回移；此次没有找到另一个已验证的2026.10.3安装，不虚报双版本真实实验。
- Node：24.16.0；Python：`C:/Users/user/miniforge3/python.exe`。PATH 中没有 python3.13。
- 已授权模型：custom/deepseek-v4-flash，openai-completions，contextWindow=204800、maxTokens=65536、reasoning=true。当前模型元数据无 cost，使用此前 task adapter 已验证的兼容路径；没有打印key。
- Skill、正式合同、21场景 verifier 全部使用仓库原始字节。子宿主 PATH 提供 `python3.13.cmd` 转发固定 Python，设置 UTF8 环境并继承到实际验证子进程，不修改 Skill/verifier 来适配 Windows。

## 不可直接照搬的旧入口

1. `offline-kitchen-live.mjs` 写死 Python3.13、旧 `/rc-project bind` 和2026.7.1-2断言，还包含故障注入业务指令。它可作为协议参考，不能直接跑当作新版效果。
2. 本机2026.7.1-2公开 `sessions.create` schema 不接受 cwd；只有 worktree=true 原生准备工作目录。新入口先在**本次新建** default workspace 准备spec/Skill、初始化git，再由 `sessions.create({worktree:true})` 获取持久化 spawnedCwd，查询 `/rc-project status` 验证 source=host 和enabled=true。不旁路改 session store，不调用legacy bind。
3. 业务权威材料路径不能包含 `.runtime-correction`。准备脚本在 lab 私有目录，live环境位于仓库 `experiments/live-kitchen-*`；宿主state/home、token占位配置、源码/原始会话均在该run内，需由root把 `experiments/live-*` 加 `.gitignore`。
4. 插件 build 不复制 node_modules。preparePlugin 在新产物根内 `npm ci --ignore-scripts --omit=dev`，再核对嵌套SDK lock与仓库一致；安装发生在 Gateway admission 之前。认证只在进程内取得，生成配置用 env 占位，不把原配置整体写入实验。

## 复用入口

脚本：[gateway-kitchen.mjs](gateway-kitchen.mjs)。它导入既有 `scripts/diagnostics/lib/isolated-openclaw.mjs`，不改变生产插件或helper。已完成 `node --check` 和默认 `--mode=develop` 预检，预检无模型/网关调用。

已另外用生产 `loadProjectConfigDocument`（含真实JSON Schema校验）及 `loadConfig` 编译同一份 [kitchen-policy.yaml](kitchen-policy.yaml)，结果 [policy-preflight.json](policy-preflight.json) 为PASS：dynamic GT、Skill、artifact GT/stage、implementation、Stop全部开启；artifact的rules/review显式enabled合法，Python源码格式为text；assessmentTimeoutMs与waitTimeoutMs均为null，沿用产品默认值。不是只做脚本语法检查。`stageMetricsEnabled`配置为真，源码artifact没有metricCheckpoint，完整指标审查由Stop负责，不在每次源码写入枚举全部指标。

从仓库根启动（root在全指标接入完成后再执行；整个 Node 进程需要网络/子进程的 scoped escalation）：

```powershell
node .runtime-correction/all-metrics-lab-20261024/e2e-plan/gateway-kitchen.mjs --mode=stop --live --output=experiments/live-kitchen-stop-20261024-01
node .runtime-correction/all-metrics-lab-20261024/e2e-plan/gateway-kitchen.mjs --mode=develop --live --output=experiments/live-kitchen-develop-20261024-01
```

两个run均创建独立随机空闲端口，独立 Gateway/state/home/session/native worktree；不会修改原宿主安装和原进程。每次必须新输出目录，不覆盖失败轨迹。入口finally只关闭本次子进程。

## 阶段3：现有正确厨房上的整体验收

`--mode=stop` 预置仓库归档厨房源码，正式模型读取原合同并真实运行bundled verifier，完整Stop走真实分类、动态Ground Truth、实际非空 population、collector与实现审查。启用文档/Skill/实现/Stop纠偏，记录哪些真的触发。

不强迫模型“造出15个指标类别”。结果必须逐M01-M15记录population数量：空分母不算通过。15指标的精确语义全覆盖由root另一个集成隔离实验承担。此模式是完整Stop健康/误报检查，正确样例零次纠偏是合法结果，并不证明修复收益。

可选 `--mode=stop-negative` 只在新run里把归档实现的扣库存改成保持原量，记录前后hash；接入后观察者不再改源码。第一业务轮只读验收并如实报告，RC反馈后已授权模型修复。该提示含实验阶段顺序，分类可能合法为INTERMEDIATE；如果发生，必须记录试验覆盖不足，不能固定TASK_COMPLETE、改写GT或当作产品漏报。建议先完成stop/develop主验证，再决定是否需要此负向闭环。

## 阶段4：空代码起步

`--mode=develop` 确认工作树里没有kitchen.py，真实 `/skill build-offline-kitchen` 从零开发，观察器不写/恢复/复制业务实现。原21场景验收在业务模型中真实执行，完成后观察器再独立执行相同verifier。业务功能、最终Stop状态、Skill看护、实现审查、文档评审分别记录；只有全部所需终态有依据才报相应通过。

配置启用动态GT面板1、Skill纠偏、artifact groundTruth/stage纠偏、实现纠偏、Stop纠偏。沿用插件预算默认值/既有宿主hook上限，没有扩大产品预算或删合同。artifact配置目标是实际写入的kitchen.py（通用产物审查）；这是源码产物事件，不是新文档交付需求。若没有文档编辑/文档review事件，要标“已配置、未触发独立文档评审”，不能冒充全模块实测。

## 保存与判定

- 原始Gateway wire、console、会话和任务记录；首次终稿、进度、最终runtime-state。
- 每轮真实单项worker verdict/metrics/elapsed及population分母；原生Stop/续作receipt是否observed/finished。
- 独立verifier退出码、完整stdout/stderr、21场景数；原Skill/spec/配置/verifier及原宿主配置/cache前后hash。
- 失败也写report.json和runtime-at-failure.json，不静默改预算/断言重跑；记录每轮新目录。

没有HTTP代理，不能据SDK事件推断精确请求次数或费用；live的modelCalls为null。开启纠偏不代表所有角色真实触发。原宿主与新子宿主的认证缓存必须留在忽略目录，不随交付包发布。

## 目前未做、需要root gate的事项

真实 Gateway/模型尚未启动；须待隔离实验1全指标选择、阶段2接入完成后root明确通知。届时先检查当前代码与profile hash，再启动新run。插件预算/GT与全部真实角色结果取决于后续实际轨迹；本计划不预测PASS。
