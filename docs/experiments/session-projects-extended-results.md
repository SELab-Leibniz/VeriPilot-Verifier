# Session 项目作用域扩展实测结果

日期：2026-10-14。分支：`codex/session-project-scope`。被测实现：`ef3054e`。实测使用 OpenClaw `2026.7.1-2`、`2026.10.3` 的隔离网关，以及已获用户授权的 GLM-5.3-Flash。需求提取、Reviewer、纠偏预算和 Stop 核心代码没有修改。

**结论：项目识别与恢复有真实通过证据；完整新版 Stop 验收未通过。旧版真实修复和最终复验通过，但发现首轮终审回执的一致性缺陷。不能宣布整项需求全部验收通过。**

## 方法与结果

方案见 [实验设计](session-projects-extended-plan.md)。观察者只建立初始夹具、读取记录和运行独立验收，不替业务模型改代码，不写 Reviewer 结论，不直接编辑宿主 Session 数据库。

| 实验 | 结果 | 实测证据和边界 |
| --- | --- | --- |
| E1-L：旧版 Stop 重修 | 部分通过 | 初轮实际代码 BROKEN；正式评估 DEVIATION；原生反馈 ADMITTED、被模型读取；模型实际改为 READY；独立默认 CLI 与 help 均退出 0；最终 Stop PASS。用了 1/2 次机会，需求版本 1、epoch 1 未重开。首轮 checkpoint 却为 UNVERIFIED，因此严格脚本报 FAIL。 |
| E1-N：新版 Worktree Stop | 失败 | 宿主返回真实工作树目录，RC 使用该目录，完成需求基线；异步 Stop 刷新需求被宿主以 Gateway 不可用拒绝，没有进入真正 Stop Reviewer，也没有修复。 |
| E2-L：并发 Session 隔离 | 通过 | A/B 不同 taskId、Session 身份和基线；8 对实际 Reviewer 调用区间重叠；B CLI 仍为 PEER_READY，最终 Stop PASS，纠偏机会消耗 0；B 无 A 的反馈。两项目的保护文件哈希未变。 |
| E2-N：新版并发终审 | 未完成 | 与 E1-N 同一现场发生生命周期故障，不能把建基线/并发启动算作两 Session 都完成 Stop。 |
| E3-L：Stop 中改绑 | 通过 | 第三轮在真实 Stop Reviewer 启动后用可信 RC 管理命令改绑；旧 Stop CANCELLED；新 taskId、基线 1、预算 0；旧文件 BAD、新文件 NEW_B_ONLY，无旧反馈。初轮纯读取未触发 Stop；第二轮宿主 incomplete turn，均保留原始结果，未计通过。 |
| E3-N：Stop 中宿主切换 | 未完成 | 因 E1-N 无法启动真正 Stop Reviewer，改做下面的明确子实验。 |
| E3-N-onboarding：需求评审中宿主切换 | 通过 | 真实需求 Reviewer 已启动；宿主拒绝忙 Session 换目录；公开 chat.abort 取消工作后，公开 sessions.create 允许空闲变更。相同 Session 自动跟随新目录，新 taskId、需求版本 1、预算 0；旧项目 BAD、新项目 NEW_B_ONLY；无旧反馈，旧基线未提交。手动 RC 绑定被禁用。 |
| E4-L/N：实际网关重启 | 通过 | 旧版 A/B、新版 A/B/真实 Worktree 的原 Session、项目来源、taskId、基线和预算恢复；既有历史按原记录身份/内容保留；查询未启动模型，原记录未重派。 |
| E4-L-completed-stop：非零预算恢复 | 通过 | 对 E1-L 已完成的实际修复状态再做关闭/启动/重启：A 的预算仍 1，B 仍 0；已完成 ADMITTED/OBSERVED/PASS 回执未重派，没有模型调用；首轮不一致 checkpoint 也原样保留，没有篡改。 |

Stop 对照夹具是标准库 Python CLI，唯一缺口为默认输出 BROKEN，正式要求 READY 加换行；首轮只读是操作顺序，原用户消息已经授权收到 RC 反馈后修复。`.runtime-corrector/config.yaml`、`spec/requirements.md` 和 AGENTS 先冻结哈希。A/B 使用相同 Reviewer 配置：面板 1、无 adjudicator、角色 240 秒、Stop 窗口 720 秒、hook 600 秒、k=2。没有变更核心格式修复或基础设施预算。

切换重跑根据已验证的业务触发路径调整：新版写回原样 BAD，在需求提取运行时取消；旧版用宿主 exec 执行只读 Python 检查，在正式 Stop Reviewer 运行时改绑。观察者没有制造 Hook 事件。

## 已复现的缺陷

### 新版后台 Stop 失去宿主调用生命周期（P1）

Worktree 项目基线已成功建立，首轮交付结束后，`ground-truth-extractor` 的私有 run 记录瞬间 SETTLED，宿主没有对应的模型 start；任务 journal 记录 `Gateway is temporarily unavailable. Please try again shortly.`。这不是此次 GLM 限流。

源码与日志共同指向：`native-stop-review.mjs` 在 reply hook 返回后异步运行；v2026.10.3 的 Gateway subordinate-work 保护检查继承 root 是否已经 released，拒绝后续 plugin execution。当前公开 Session work admission 只保留 Session 工作身份，没有延长这一 Gateway root。目录解析、SQLite Reviewer 身份登记成功并不能证明交付后的工作仍可执行。

需要在宿主兼容模块处理合法的后台工作生命周期或采用经过核验的终审入口，同时保留宿主取消/重启保护；不能靠私有导出或关闭宿主保护绕过。

### 基础设施重试重复上一轮内存结果（P1，2026-10-15 更正根因）

上述失败后，人工停止隔离试验之前 A 任务记录 **43,796 条** `NATIVE_STOP_REVIEW_RETRY`，B 任务记录 **15,418 条**，共 **59,214 条**；两方 `failureAttempt` 始终为 1。它们是调度循环记录，不是 59,214 次模型调用。每个任务只有一条真正进入核心的基础设施失败记录。

2026-10-15 逐层定位后撤回此前“外层 assessmentId 缓存重复”的推断：finalize 事件没有 toolName，`withState` 直接调用 callback，绕过那个外层缓存。真正路径是下一轮 `runWithWorkAdmission` 在 callback 前抛异常，`publicHandlers.finalize` 包装吞掉异常并返回 undefined，没有更新 `state.nativeAssessment`；调度循环忽略本轮返回值，继续读取上一轮 UNVERIFIED/block，重复写 retry。它从未重新进入核心，所以失败计数停在 1。

无模型确定性对照已经复现：首轮失败后 admission 拒绝，30 次请求只进入核心 1 次、产生 29 条调度重试；admission 始终允许时，同样的永久 Reviewer 故障严格执行 3 次后停止，`stop:infra-1/2` 正常生效，业务预算不变。修复应在适配调度层传递本轮结果/准入异常并有限处理；不需要改幂等缓存或扩大预算。循环仍有原 720 秒 deadline，并非数学上无限。本实验未更改生产代码。

### 首轮 checkpoint 与正式评估不一致（P2）

旧版初轮 task assessment 明确是 DEVIATION，随后原生反馈被宿主接收和模型读取；模型实际修改，最终 task verification 和反馈复验都是 PASS。然而初轮 `native-stop-reviews` checkpoint 为 UNVERIFIED。

源码与时间顺序指向：提交续作后，新的宿主 run 可能已经重置共享 `state.nativeAssessment`，旧 checkpoint 再从该可变状态读取结果。2026-10-15 用未改动的生产函数做确定性对照，已确认在 admission await 内启动新 run 会重现 DEVIATION → UNVERIFIED/null 的回执错误。真实现场没有记录内存 reset 时刻，该现场具体竞态顺序仍是强证据支持的推断。需要在派发前固定旧 run 已完成的评估，而保留新 run 的正常状态重置。业务闭环成功不能抵消审计记录的错误。

后续精确定位、最小重现与公开修复候选见 [2026-10-15 原因分析](session-projects-diagnosis-20261015.md)。首次宿主拒绝缺少原始 stack，分析区分了确定机制与首次抛错位置推断。

## 失败历史与复现

所有失败和无效试验保留，未覆盖为 PASS：首轮旧版 GLM HTTP 429 / code 1302；新版生命周期故障；旧版切换纯读取未触发所需阶段；旧版写回 BAD 后宿主报告 incomplete turn，日志为 `stopReason=toolUse, payloads=0, replaySafe=no`；重启观察器首版错误地比较整份会话历史，因查询本身新增历史而报失败，修正后重跑，原始审计也保留。

脚本位于 `scripts/diagnostics/`：`session-project-stop-live.mjs`、`session-project-switch-live.mjs`、`session-project-restart-live.mjs`，共用 `lib/isolated-openclaw.mjs`。参数为宿主包目录、测试 provider 描述、新隔离输出目录、空闲端口；凭据只从 `RC_TEST_MODEL_KEY` 读取，不写入仓库或报告。重启脚本仅接受成功的隔离项目探针，或 `--completed-stop` 指定的已独立验证完成的 Stop 试验状态。

关键原始证据：

- 旧版修复与并发：`/tmp/rc-session-extended-legacy-20261014-r2/inspection-only-results.json`、A/B 项目 task/journal/native records、`A-first-terminal.py`、`wire.jsonl`。
- 新版失败：`/tmp/rc-session-extended-native-20261014/summary.json`、`manifest.json`、真实 Worktree 下的 task/journal/native records。
- 新版切换子实验：`/tmp/rc-session-switch-native-20261014-r2/summary.json`、旧/新项目实际文件与运行记录、`history-final.json`。
- 旧版真实 Stop 中切换：`/tmp/rc-session-switch-legacy-20261014-r3/summary.json`、旧 Stop CANCELLED 回执、`history-final.json` 和新项目任务。
- 重启：两版原始真实项目探针的 `restart-audit.json`，以及旧版修复状态的 `restart-audit.json`。

可提交的脱敏摘要见 [结构化证据](session-projects-extended-20261014.json)。这是一组确定故障与隔离生命周期实验，不代表自然缺陷率、大项目质量或任意宿主版本兼容性。

补充回归：Session 项目、私有 Reviewer 身份、原生反馈与 Stop 预算相关的 38 项测试均通过；日志 `/tmp/rc-session-extended-targeted-tests.log`。这些单元测试没有覆盖此次宿主 Gateway root 生命周期与续作派发竞态，不能用来覆盖真实失败结论。
