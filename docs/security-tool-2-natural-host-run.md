# security_tool_2：宿主自然完成、RC 阶段 30 分钟

## 用户最新要求

“宿主运行不设置完成任务的时间限制，让宿主自然的跑完”。这覆盖此前“业务也设 30 分钟”的实验设置。RC 提取、语义审查及单次 Stop 总评估窗口仍为 1800000ms（Stop 含 30000ms 反馈预留）。

## 已落地的独立时限

- 宿主原始业务通过已核验 OpenClaw 2026.7.1-2 的 `chat.send.timeoutMs: 0` 使用原生无任务截止语义；宿主默认业务时限也使用该版本同一最大安全计时哨兵，覆盖自动业务修复。评测入口没有业务截止及全流程截止，外层子进程 `timeoutMs: null`。
- 新增插件配置 `businessRunTimeoutMs: 0`，移除可信业务修复开始后的 RC 执行截止；准入等待、RC 评审、手动取消和作用域失效控制继续生效。省略该字段保持旧行为。
- 原版 c33bae6 不支持该配置，因此本次先续接当前版，不静默用旧限制启动原版。原配对目标保留待后续匹配协议；本次续接结果不能混入旧 10 分钟/30 分钟配对作为同协议效率结论。
- 宿主不设完成时限不代表真实 SDK/模型错误会变成成功；按外层正式终态与 RC 实际结算记录。中间嵌入尝试的错误或上下文自动压缩不作为整体任务结束依据。

## 当前交付进展（2026-10-29 22:15）

**第四次恢复已完整通过。** 冻结版 `bc9fb9b3f55ebd618525ed4721490fc2db37d55b` 的真实业务运行 `2d890c9e-4e42-4b83-b567-7ef9e7eebd7c` 获得公开 `agent.wait: ok`，原任务 `oc-scope-d2f85228-38e3-46e6-a608-54e191c49c8b` 于 22:13:32 结算为 `COMPLETED / PASS`。基线提取和最终审查两项私有运行均为 `SETTLED`，没有迁移错误、业务预算中止或运行时错误。此次宿主及 RC 流程约 399683ms（6 分 40 秒）；不是从头实现整个案例的耗时。

随后独立原生评分完成：**F2P 2/2、P2P 746/746**，完整执行、修复通过、缺失和错误均为 0。补丁与上一轮一致（58248 字节），宿主只读检查后由正常最终审查完成验收，没有制造文件修改。原始账本逐字节恢复，SHA 与源一致，已用次数保留为 0，不重置预算。公开终态、私有运行和评分汇总在 `.runtime-correction/system-optimization/security2-natural-host-004/completion-proof.json`；原始记录、评分、用量及恢复回执均保留在同目录。

本结果证明真实续接可以在宿主无完成时限、RC 阶段 30 分钟下完成端到端流程。它继承了前轮真实进度，不能当作全新输入的公平对照或据此声称整体提速。后续仍使用 security_tool_3 / security_tool_2 两例、交替顺序、双方相同无截止配置验证；security_tool_2 已用于排障，不再称未见样本。项目模板中的 Stop 总评估设置也统一为 1800000ms，其他已有阶段设置保持 30 分钟。

第三次恢复使用冻结版 `fb897bb83c7c09531d38596ac57ab49c01214cce`，真实业务运行 `235b7f3d-d6b1-43d6-aaf8-a5c497b62a47` 于 21:08–21:17 自然完成。公开 `agent.wait` 回执为 `ok`，基础执行完整；没有业务或全流程截止。宿主原生构建及 749 项本地测试通过，独立评分为 **F2P 2/2、P2P 746/746**。但 RC 最终验收为 `UNVERIFIED / STOP_SESSION_MIGRATION_REQUIRED`，私有审查尚未开始，仍不能称完整 RC 端到端成功。

原因是隔离续接只恢复了真实会话记录，未带入原生任务绑定与会话级纠偏账本。新增恢复工具沿明确的恢复祖先链寻找真实账本，校验项目、任务和准备版本，逐字节复制，并保留已使用次数；不合成零计数、不覆盖不同账本，未释放的准入必须先协调。原始真实账本 SHA 为 `0feab19baca1a3e8edae67854eb88efc64a4324485502c86d54c5f6e9c470948`，已用次数为 0。原生任务标识、会话启停选择也从上次真实业务状态保留，不迁移活跃工作队列。

对迁移阻挡的未验证任务，真实后续只读回复可以继续正常最终审查；使用已有任务基线，不要求为触发审查而制造文件修改。已经通过的任务不会因此重复审查。原生生命周期、账本恢复、任务绑定、业务身份及运行配置共 **56/56** 项测试通过。第四次恢复将使用 `--verify-pending-rc`，在模型准入前校验上一轮正式业务成功、未完成验收和真实账本/任务绑定；不传入独立评分、隐藏测试或实现答案。

当前工作目录为 `C:/Users/user/.codex/worktrees/rc-natural-host-delivery/runtime-corrector-toy`，分支 `codex/rc-host-natural-completion`。最新持久入口为 `security2-natural-host-004/experiment.json` 与 `completion-proof.json`，控制端已退出。旧记录均保留，勿按下方历史入口重复启动旧运行。

## 初始版本和验证记录

- 当前工作区仍为外部 `rc-five-branch-fusion/runtime-corrector-toy`，为避免再次与主目录占用同一分支，本次独立分支为 `codex/rc-host-natural-completion`。
- 实现冻结 `cadd53e20bb7c91ded87a134626d75f7c853d81a`；产物 `candidates/cadd53e/runtime-corrector-openclaw`，6 个公开 Skill 经实际宿主 YAML 验证。
- 相关测试 **93/93** 通过，覆盖无截止修复自然结束后进入有界复验、重复开始事件不改执行策略、手动取消、未知终态恢复及其他会话隔离。真实宿主无模型预检确认 `businessRunTimeoutMs=0`、Reviewer 1800000ms，外部模型调用 0。
- MatrixAssistant/OpenClaw 源码、全局配置和现有会话不修改；CLT 使用用户指定路径，不打开 IDE。

## 会话恢复与证据

- 持久索引：`.runtime-correction/system-optimization/security2-natural-host-001/`，`experiment.json` 记录全部实际路径；`resume-source.json` 记录源运行和 prepared HEAD。
- 沿用系统临时项目 `C:/Users/user/AppData/Local/Temp/rc-s2-30m-DzngAd/w/.runtime-correction/b/biz-326126d382ff`，不重建源码或删除既有进度。原始对象仍复用 Git 缓存。
- 原会话 `3f43a25f-8ee5-4320-a848-1f3129b5896a` 的 **212 条真实记录**按原字节复制到新隔离宿主的会话文件，并通过公开 Session API 登记。没有合成助手回复、假完成事件或预期答案；`resume-evidence.json` 保存原始 SHA 和恢复路径。
- 新控制端只发送通用继续指令：沿用既有读取与压缩笔记，完成原始任务实现和实际检查；宿主取消任务时限，RC 阶段仍 30 分钟。不加入本例实现答案或隐藏测试提示。
- 旧 30 分钟当前版实际上于上下文恢复错误结束（未完成），不是被 30 分钟时限中止。旧原版调度因用户修改配置而停止；原始日志与协议已复制到 `security2-30m-001/evidence-superseded` / `protocol-30m`，不计有效原版新成绩。

## 压缩恢复入口

当前终端句柄 **25331**，运行入口 `security2-natural-host-001/run.mjs`。先读持久目录 `owner.json`、`progress.json` 与 `experiment.json`，再读取其输出目录的 `progress.json`；核对 owner PID 和实际命令后继续观察，禁止重复启动。

实际输出目录为 `C:/Users/user/AppData/Local/Temp/rc-s2-30m-DzngAd/natural-host-candidate`；原始主日志在持久目录 `run.log`，阶段日志也在同目录。控制端结束后将输出复制为 `evidence/`，独立原生评分复制为 `grade-evidence/`，不复制业务 Git 工作树。新会话若仍出现上下文/SDK 明确错误，应保存并诊断，不当作自然完成。

本轮于 2026-10-29 17:46 自行结束，持续 **5157334ms（约 86 分钟）**。没有业务或整体截止，也没有发出业务预算中止。独立原生评分完成：**F2P 2/2、P2P 746/746**，评分运行完整且无运行时错误。代码修复已通过固定测试，但 SDK 最后报上下文压缩失败，RC 仍未结算；不得把测试全过等同于宿主和 RC 已完成端到端交付。

原始 `result.json` 的 `businessCompleted=true` 有误：旧运行器只看内部诊断 `session.ended(success)`，未采信外层 `agent.wait`，最终助手记录实际为 `stopReason=error`。保留原始文件；`completion-audit.json` 记录纠正依据，明确它是控制流程审计而非伪造的 Gateway 回执。新运行器保存 `official-business-terminal.json`，以匹配实际业务 runId 的公开终态为完成依据，包含后续业务修复，未知状态不能当成功。配对报告的业务完成与效率资格也使用该依据，相关 13 项测试通过。下一步继续真实会话与文件进度完成宿主及 RC 收尾。

## 运行中发现的压缩取消误报

本次冻结版记录 `terminalRelease.reason=RC_HOOK_UNAVAILABLE`，宿主继续运行，RC 私有评审尚未启动。不能把本次状态称为完整 RC 成功。

已用实际运行时入口复现：`agentEnd` 报告一次内部尝试失败，RC 将本次 reviewer controller 取消为 `RC_NATIVE_ATTEMPT_ENDED`；宿主随后自动压缩，原生 work admission 拒绝已取消的 reviewer signal，外层包装误将同一取消原因归为钩子故障。复现日志 `host-compaction-regression-before.log` 明确记录错误释放原因。

工作区修复只忽略**当前 reviewer controller 的同一个取消原因对象**且其 code 为 `RC_NATIVE_ATTEMPT_ENDED` 的拒绝；不重开宿主信号，也不吞掉独立错误。两项回归确认正常压缩/重试恢复和独立准入故障上报，日志 `host-compaction-regression-after.log` 为 2/2 通过。测试显式 reset 并等待收尾，避免 Windows 清理与后台记录写入竞争。

真实宿主公共 Session API 的无模型探针也确认：已取消信号拒绝执行，并返回**同一个原因对象**（`native-admission-cancel-probe.json`，`modelCalls=0`）。探针使用独立临时项目和宿主配置，不接触正在运行的业务会话。

冻结的 cadd53e 产物和正在运行的业务会话不修改。该修复需通过完整相关回归后另行冻结；本次已有未验证记录保留，不追溯改写。

完整回归首轮完成 165 个文件，155 个文件通过，10 个文件失败或超过测试文件期限，其中包含诊断期间加入的压缩取消回归红测。原始失败日志 `host-no-deadline-full-tests.log` 保留。修复后将这 10 个文件串行复核，结果 **261 通过、1 跳过、0 失败**，各文件均成功完成（`host-no-deadline-rechecks.json`）；测试文件上限为 180 秒，与宿主业务完成策略无关。不是一次全量并行全绿的记录。

## 续跑用量与后续公平对照

原有 `summarize-arkts-run.mjs` 汇总主会话全部消息，在复制真实历史的续跑中会包含旧用量。保留原统计，另用 `scripts/summarize-arkts-continuation.mjs --run=<captured-run>` 生成 `continuation-usage.json`：核验恢复源 SHA 和复制前缀的完整字节，再区分恢复的历史与本次新增记录。不得按相同消息内容去重（真正的新调用可能内容相同），也不按推测时间边界扣减。4 项测试通过；实际运行中的历史前缀也已核验为 212 条原始记录。

此增量统计仅含业务消息中已报告的用量，压缩及 RC 私有调用可能不在其中；零记录、缺失字段和未报告用量不能证明零消耗。不据宿主价格字段 0 推算金额。运行结束前的观察文件明确为 `partial`，不称最终总耗。

共享无截止协议已准备完成：原版 c33bae6 派生为 **f77cf9397bb3ad13f73e89e2a59e19569ed078a1**，只改原生运行时、post-run 调度器、插件配置 schema 三个文件，补入相同无业务截止及压缩取消处理；两份运行时文件与修复版 32531a4 完全一致。使用原仓共享 Git 对象的临时 worktree，不复制仓库。两版真实宿主无模型预检均通过（宿主无完成时限、RC 1800000ms）。

索引 `shared-natural-host-protocol/protocol-baseline.json` 保存来源、完整差异、预检和新配对计划。计划为全新独立输入下的 security_tool_3 / security_tool_2、交替运行顺序；当前仅 `PLAN_NO_MODEL`，尚未启动。续跑不能与从头运行混作公平配对，也不能把派生对照称为未经修改的 c33。先等本次宿主自然结束及独立评分；任务完成后优先执行公平配对验证修复版，任务未完成则先继续真实进度，避免重复无效工作。

原配对计划的运行器哈希在公开终态判定修复后已过期，启动前须重新生成共同协议，不得绕过校验。当前先续接未完成的宿主收尾。模型耗时还受提供商行为影响：GLM-5.3-FLASH 强制思考，不能通过 off 关闭；官方支持 low/high/max 推理强度，默认 max。当前案例保持原配置；未来若调节强度，须核验实际发出参数并对两版应用相同协议。[提供商说明](https://docs.z.ai/guides/capabilities/thinking)

## 独立工作目录与续接

2026-10-29 检测到旧 `rc-five-branch-fusion` 工作目录被另一项工作切换到 `codex/rc-expected-files-targeted-repair`，并有不属于本次任务的源码修改。保留全部文件和该分支；本次改用独立 worktree `C:/Users/user/.codex/worktrees/rc-natural-host-delivery/runtime-corrector-toy`，分支 `codex/rc-host-natural-completion`，仍共享原仓 Git 对象。

第一轮完整原始记录仍在旧目录的 `security2-natural-host-001/`；新工作目录的 `security2-natural-host-002/experiment.json` 和 `source-boundary.json` 保存绝对恢复入口。业务仍沿用原临时项目，原始会话字节及文件进度继续保留，RC 使用冻结修复版 32531a4；不向宿主传递独立评分结果或隐藏测试信息。新运行器分别展示真实业务终态和 RC 结算状态，进度标识不再把未结算统一写成 SETTLED。

## 离线预检提速实验（尚未接入当前运行）

现有预检为 176 个模块分别启动 Git，再读取各产物文件。辅助工具 `scripts/bench/frozen-artifact-verification.mjs` 固定解析 commit 后，通过批量 blob 协议取回原文；实际产物仍逐文件重读、规范化换行并比较，不缓存放行。Git 进程从 177 次变为 3 次。UTF-8、空格路径、CRLF 等价、篡改后再次校验和缺失输入的 3 项测试通过。

离线复用本轮已有预检证据，176 项文件及 SHA 全部一致；原运行预检文件标识间隔约 139858ms，批量调用观察为 5934ms。冷热缓存与当时负载不同，这仅是一次阶段观察，不外推为整任务提速比例。原检查没有重复执行。记录在 `frozen-artifact-verification-experiment.json`；复现入口 `scripts/benchmark-frozen-artifact-verification.mjs --run=<prepared-native-run> --output=<result.json>`。当前模型运行继续使用冻结的原预检代码，待本次结算后再接入后续共同协议。

## 第二次恢复的维护任务识别纠偏

`security2-natural-host-002` 未产生新的有效业务评分。真实原生轨迹表明，宿主先执行 `trigger=memory` 的内部维护，原业务 runId 为 `64f00f92-ddc7-47c4-850d-2eeb3f4a6ba3`，维护 runId 为 `1155e67c-f1e5-4a26-9841-3954a56cc252`。旧运行器以同会话最新模型 runId 判断业务，将维护错误当作业务错误；RC 同时把维护回调当成业务回调。控制端随后以 `actualBusinessStart=false` 拒绝计分。原始记录保留，`maintenance-audit.json` 记录原因，不伪造业务完成。

修复只信任原业务 ID 与 RC 持久化的可信修复 ID；进度明确展示业务是否真正启动。RC 根据宿主可信 `ctx.trigger=memory` 及精确运行/会话绑定忽略维护回调，后续缺少 trigger 的同一维护回调也不会替换业务。不同会话、不同 Agent 和普通业务不受该标记影响，私有 Reviewer 工具授权继续执行。真实宿主源码的 Hook 上下文构造与原生轨迹均确认了 trigger 字段。

维护替换业务的回归先失败、修复后通过；原生生命周期整文件 37/37 通过，包含失败尝试后等待真实外层终态再审查、同会话维护不替换业务、私有工具限制保留。其他相关文件已完成复核；原串行 150 项中的唯一失败来自把内部失败尝试立刻伪装为外层成功的测试夹具，已改为终态门控后在这 37 项中验证。身份/继承范围等 11 项也通过。

隔离评测明确设置 `agents.defaults.compaction.memoryFlush.enabled=false`，跳过前置记忆维护模型任务，保留普通上下文压缩与完整真实历史；MatrixAssistant 全局配置不修改。该共同设置将同等用于后续两版对照。批量源码校验在第二次恢复已结束后接入新运行器。

继续恢复时不丢弃维护记录和笔记。产物范围沿显式恢复祖先链找到上一次真正启动的业务，只继承其成功写入范围，再加入新业务的真实写入；维护启动失败的写入不算产品变更。实际审计从 5 个候选路径中排除 1 个维护笔记路径，保留原业务 4 个路径，全部工作区记录仍保留。这项处理通过跨任务、循环祖先和控制文件拒绝测试，不按目录名称猜测业务需求。
