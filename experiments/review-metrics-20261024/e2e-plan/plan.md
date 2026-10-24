# 阶段3/4：真实 Stop 与厨房端到端隔离入口

2026-10-24 更新。首轮阶段3已在独立Gateway完成真实前置评审和部分Stop，再由实验控制器正规取消；下一轮02仅准备，等待root提交及准入。原宿主配置/原项目/session保持只读，原有 `127.0.0.1:18789` 不使用。默认预检不启动Gateway、不调用模型；有seed时会运行不变的本地21场景verifier，`--live` 才创建新环境并联网。

## 当前可用环境

- 宿主：`C:/Users/user/workspace/program_workspace/MatrixAssistant/resources/openclaw`，2026.7.1-2。它含 MA 的 spawnedCwd 回移；此次没有找到另一个已验证的2026.10.3安装，不虚报双版本真实实验。
- Node：24.16.0；Python：`C:/Users/user/miniforge3/python.exe`。PATH 中没有 python3.13。
- 已授权模型：custom/deepseek-v4-flash，openai-completions，contextWindow=204800、maxTokens=65536、reasoning=true。当前模型元数据无 cost，使用此前 task adapter 已验证的兼容路径；没有打印key。
- Skill、正式合同、21场景 verifier 全部使用仓库原始字节。子宿主 PATH 提供 `python3.13.cmd` 转发固定 Python。首轮实测verifier的 `-I` 应用子进程忽略父UTF8环境，默认cp1252；保留该平台事实，不能声称仅设UTF8环境就修好了子进程。不改Skill/verifier。
- 业务提示仅保留原Skill要求的“执行bundled verifier时使用项目workdir”；不添加“所有exec均须workdir”的全历史闸门，避免把一次无关探测变成无法补救的历史业务偏离。此项在admission前修改试验提示，原合同、Skill及冻结oracle字节不变。

## 不可直接照搬的旧入口

1. `offline-kitchen-live.mjs` 写死 Python3.13、旧 `/rc-project bind` 和2026.7.1-2断言，还包含故障注入业务指令。它可作为协议参考，不能直接跑当作新版效果。
2. 本机2026.7.1-2公开 `sessions.create` schema 不接受 cwd；只有 worktree=true 原生准备工作目录。新入口先在**本次新建** default workspace 准备spec/Skill、初始化git，再由 `sessions.create({worktree:true})` 获取持久化 spawnedCwd，查询 `/rc-project status` 验证 source=host 和enabled=true。不旁路改 session store，不调用legacy bind。
3. 业务权威材料路径不能包含 `.runtime-correction`。可复现脚本已保存到本目录，live环境位于仓库 `experiments/live-kitchen-*`；宿主state/home、token占位配置、源码/原始会话均在该run内，`experiments/live-*` 已加入 `.gitignore`，整个experiments也不进入插件产物。
4. 插件 build 不复制 node_modules。preparePlugin 在新产物根内 `npm ci --ignore-scripts --omit=dev`，再核对嵌套SDK lock与仓库一致；安装发生在 Gateway admission 之前。认证只在进程内取得，生成配置用 env 占位，不把原配置整体写入实验。

## 复用入口

脚本：[gateway-kitchen.mjs](gateway-kitchen.mjs)。它导入既有 `scripts/diagnostics/lib/isolated-openclaw.mjs`，不改变生产插件或helper。已完成 `node --check` 和默认 `--mode=develop` 预检，预检无模型/网关调用。

已另外用生产 `loadProjectConfigDocument`（含真实JSON Schema校验）及 `loadConfig` 编译同一份 [kitchen-policy.yaml](kitchen-policy.yaml)，结果 [policy-preflight.json](policy-preflight.json) 为PASS：dynamic GT、Skill、artifact GT/stage、implementation、Stop全部开启；artifact的rules/review显式enabled合法，Python源码格式为text；assessmentTimeoutMs与waitTimeoutMs均为null，沿用产品默认值。`stageMetricsEnabled`配置为真，源码artifact没有metricCheckpoint，完整指标审查由Stop负责，不在每次源码写入枚举全部指标。

从仓库根启动（root在全指标接入完成后再执行；整个 Node 进程需要网络/子进程的 scoped escalation）：

```powershell
node experiments/review-metrics-20261024/e2e-plan/gateway-kitchen.mjs --mode=stop --seed-app=experiments/live-kitchen-stop-20261024-01/before-operator-cancel/kitchen.py --live --output=experiments/live-kitchen-stop-20261024-02
node experiments/review-metrics-20261024/e2e-plan/gateway-kitchen.mjs --mode=develop --live --output=experiments/live-kitchen-develop-20261024-01
```

两个run均创建独立随机空闲端口，独立 Gateway/state/home/session/native worktree；不会修改原宿主安装和原进程。每次必须新输出目录，不覆盖失败轨迹。入口finally只关闭本次子进程。

业务发送前另有 [worktree-fence.mjs](worktree-fence.mjs) 只读归属证明：在sessions.create返回之后、连status命令之前，要求新目录在本run的state/worktrees、默认源仓库拥有独立.git、两者git-common-dir精确一致、HEAD等于冻结输入commit，并登记在源仓库git worktree list内；拒绝corrector源仓库、原业务树和default自身。随后status必须指向同一真实目录。本机宿主ManagedWorktreeService从resolveStateDir(env)/worktrees派生目录，既有隔离helper的OPENCLAW_STATE_DIR已将其定位本run，无需修改宿主配置。

纯本地Git小实验 [worktree-fence-preflight.json](worktree-fence-preflight.json) 通过正例及五个反例：corrector源仓库、default自身、错误state、原业务目录、错误git-common归属。该实验没有启动Gateway或模型，仍不能代替首次真实会话返回路径的现场fence检查。

## 阶段3：现有正确厨房上的整体验收

`--mode=stop` 默认预置归档源码；下一轮明确传入 `--seed-app`，精确复制首轮模型真正写出并已通过原verifier的02c4源码，观察器不编写实现。seed必须名为kitchen.py，入口在Gateway启动前再次真实验证21场景、核对源码hash不变；live保存完整 `seed-verifier-proof.json`，manifest记来源、SHA及原verifier SHA。`develop`和`stop-negative`拒绝seed。正式模型仍读取原合同、真实运行bundled verifier，完整Stop走真实分类、动态Ground Truth、实际非空population、collector及实现审查。启用的模块与实际触发分开记录。

首轮输出 `experiments/live-kitchen-stop-20261024-01/stage3-cancelled-summary.json`：92自然对象/93收集项。78个main-task对象受adapter标签不等价问题影响会回退native；13个CURRENT_TASK Skill对象本可进入新worker但取消前未排到；1个条件项本来就应native。实际新worker=0，因此首轮不能验证新task路由。最终业务源码SHA `02c4bfc9f2f35c15406f7aeb27be3b3966972adffa48ecd6e68f5657e21e2716`，真实verifier退出0、21场景PASS；这不等于Stop通过。

首轮在保存完整runtime/内部request/collection、原main JSONL及trajectory哈希、最终源码后，经本隔离Gateway公开 `sessions.reset`→`before_reset` 正规取消；Stop终态CANCELLED/RC_STOP_CANCELLED、harness exit1并关闭自己的56081端口。没有手写task/session，也没有自然耗尽产品预算。源码中 `runtime-corrector.control` 的注册函数没有被native入口调用，live实际返回unknown method，不能宣称该接口可用。

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

业务首轮RPC observer仍为20分钟，产品Stop预算沿用配置且不写其deadline字段。首轮实际Stop组合预算70分钟。首轮终稿后的旧30分钟observer可能早于产品deadline；新入口改为读取本隔离session的native-stop-review实际 `deadlineAt`，加15秒观察器落盘宽限，记录到 `observer-deadline.json`。未发现合法本session记录时才用有限30分钟后备；一旦观察到产品deadline，即使暂时少读一份记录也不退回较早后备。此修改调整观察窗口，不延长产品预算。

入口记录当前commit和stop adapter、worker、prompt/profile源SHA，并核对新产物复制后的SHA；新run使用全新输出、Gateway、task及缓存，不恢复首轮失败任务。

没有HTTP代理，不能据SDK事件推断精确请求次数或费用；live的modelCalls为null。开启纠偏不代表所有角色真实触发。原宿主与新子宿主的认证缓存必须留在忽略目录，不随交付包发布。

## 目前未做、需要root gate的事项

下一轮02尚未启动。等待root提交main-task路由修复并明确通知后，才按上面02命令创建全新环境。阶段4尚未准入，不运行。插件预算/GT及真实角色结果取决于实际轨迹；本计划不预测PASS。
