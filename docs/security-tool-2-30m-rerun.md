# security_tool_2 临时项目 30 分钟阶段重跑

用户要求在临时目录重跑 security_tool_2，并将项目 config.yaml 各阶段最大时间阈值设为 30 分钟。本轮保持生产候选 7cbd698、原版 c33bae6 和公共导航 0b72285，重新运行两版，不复用或混入此前 10 分钟的成绩。使用用户指定 `C:/Program Files/Huawei/command-line-tools`，不打开 DevEco Studio IDE，不修改 MatrixAssistant/OpenClaw。

## 固定配置与边界

- 系统临时根目录：`C:/Users/user/AppData/Local/Temp/rc-s2-30m-DzngAd`。模型和评分源码均为既有对象缓存的独立 Git worktree，不复制 RC 仓库。
- 临时比较目录：`pair`；实际业务项目及评分源码在 `w/.runtime-correction/b/` 中，避免 ArkTS 深层路径限制。
- 项目 `.runtime-corrector/config.yaml`：`reviewers.defaults.timeoutMs`、`limits.semanticReviewTimeoutMs`、`stopCorrection.assessmentTimeoutMs`、`implementationCorrection.deviceBudgetMs` 均为 **1800000**。
- Stop 的 30 分钟是单次基线准备、审查与反馈的总窗口，含 30000ms 反馈预留；Reviewer 单角色上限仍为 30 分钟，受当前 Stop 共享窗口约束。只启用与原比较一致的 M16，纠偏额度仍为 1。
- 隔离宿主：业务/纠偏默认 1800 秒，插件 Hook 和 Reviewer 上限均为 1800000ms。真实宿主无模型预检通过，外部模型请求 0。
- 业务 `chat.send`、准备、公开构建/测试操作及独立原生评分阶段均同步 30 分钟；移除本轮沿用旧业务 10 分钟、整轮 16 分钟、父比较进程 18 分钟提前终止的路径。
- 整流程看护留足主业务、原轮终态核对、首次 Stop、一次纠偏、纠偏终态核对及复验这六个窗口（181 分钟失控兜底），外层进程窗口更长。正常结束即评分；阶段超时或明确失败须记录未完成，不能改写成 PASS。
- 超时后若公开终态核对仍不能结算，会保留运行异常并单列实际产物的补充评分；未完成运行不计正常端到端成功，不自动重试。
- 新增阶段配置、临时路径和实际 YAML 解析回归 15/15 通过；真实宿主已加载冻结候选且确认 30 分钟参数。旧实验、失败和旧协议均保留。

## 运行与压缩恢复

持久索引：`.runtime-correction/system-optimization/security2-30m-001/experiment.json`，包含全部绝对路径、冻结版本与参数。状态查看临时比较目录 `pair/progress.json`；不要重新启动已有模型。

- 顺序：当前版 → 原版，业务原生检查和隐藏评分串行。
- 终端句柄：`45095`。控制端 owner 记录在持久目录 `owner.json`、`child-owner.json`；运行本身的 owner 位于临时 `pair/manifest.json`。
- 实际配置副本会保存为每组输出中的 `project-config.yaml`。示例和实际解析验证在持久目录 `project-config.example.yaml`、`transport-preflight.json`。
- 原始主日志：持久目录 `run.log`。结束后控制端将比较目录的证据复制到持久目录 `evidence/`，不复制临时业务源码工作树；临时源码目录保留供核对。
- 生产代码未在本轮调整；只修改了开发评测入口的显式阶段配置、临时路径和结束状态记录。运行时不更改冻结产物或协议脚本。

结果尚在运行中。以真实业务自然结束、RC 实际结算和原生隐藏测试为依据；触发 30 分钟阶段上限仍须如实标为未完成。

### 15:35 恢复点与上下文压缩观察

- 控制端 owner `23600`，比较 owner `20296`，当前版模型 owner `27300`；终端仍为 `45095`，不要重复启动。当前版真实业务开始于 15:24:48。
- 15:32 宿主日志记录 `Context overflow: estimated context size exceeds safe threshold during tool loop.`，随后 `attempting auto-compaction`。约 45 条消息、上限 128000；20 次模型开始观察中包含压缩调用。仍没有成功 write/edit。
- 此时 `session.ended status=error, aborted=false, timedOut=false` 是中间嵌入尝试，**不能替代外层 agent.wait 的正式终态**。模型提供方仍有压缩请求在途，RC 的 FINALIZING 在等待外层任务完成，不应据此提前中止或伪造已完成。
- 后续应观察是否压缩成功并恢复业务，再判断是否进入 RC。当前未触发 30 分钟业务时限；本轮不缩短窗口、不添加针对本例的实现提示，也不将中间错误直接作为完整任务结论。
