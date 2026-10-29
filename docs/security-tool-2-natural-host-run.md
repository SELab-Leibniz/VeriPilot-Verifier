# security_tool_2：宿主自然完成、RC 阶段 30 分钟

## 用户最新要求

“宿主运行不设置完成任务的时间限制，让宿主自然的跑完”。这覆盖此前“业务也设 30 分钟”的实验设置。RC 提取、语义审查及单次 Stop 总评估窗口仍为 1800000ms（Stop 含 30000ms 反馈预留）。

## 已落地的独立时限

- 宿主原始业务通过已核验 OpenClaw 2026.7.1-2 的 `chat.send.timeoutMs: 0` 使用原生无任务截止语义；宿主默认业务时限也使用该版本同一最大安全计时哨兵，覆盖自动业务修复。评测入口没有业务截止及全流程截止，外层子进程 `timeoutMs: null`。
- 新增插件配置 `businessRunTimeoutMs: 0`，移除可信业务修复开始后的 RC 执行截止；准入等待、RC 评审、手动取消和作用域失效控制继续生效。省略该字段保持旧行为。
- 原版 c33bae6 不支持该配置，因此本次先续接当前版，不静默用旧限制启动原版。原配对目标保留待后续匹配协议；本次续接结果不能混入旧 10 分钟/30 分钟配对作为同协议效率结论。
- 宿主不设完成时限不代表真实 SDK/模型错误会变成成功；按外层正式终态与 RC 实际结算记录。中间嵌入尝试的错误或上下文自动压缩不作为整体任务结束依据。

## 版本和验证

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

**当前在运行，尚无新成绩。** 后续应等待宿主自然结束、RC 实际结算，再报告真实 F2P/P2P；不可因等候时间自行停止或把未验证记作通过。

## 运行中发现的压缩取消误报

本次冻结版记录 `terminalRelease.reason=RC_HOOK_UNAVAILABLE`，宿主继续运行，RC 私有评审尚未启动。不能把本次状态称为完整 RC 成功。

已用实际运行时入口复现：`agentEnd` 报告一次内部尝试失败，RC 将本次 reviewer controller 取消为 `RC_NATIVE_ATTEMPT_ENDED`；宿主随后自动压缩，原生 work admission 拒绝已取消的 reviewer signal，外层包装误将同一取消原因归为钩子故障。复现日志 `host-compaction-regression-before.log` 明确记录错误释放原因。

工作区修复只忽略**当前 reviewer controller 的同一个取消原因对象**且其 code 为 `RC_NATIVE_ATTEMPT_ENDED` 的拒绝；不重开宿主信号，也不吞掉独立错误。两项回归确认正常压缩/重试恢复和独立准入故障上报，日志 `host-compaction-regression-after.log` 为 2/2 通过。测试显式 reset 并等待收尾，避免 Windows 清理与后台记录写入竞争。

真实宿主公共 Session API 的无模型探针也确认：已取消信号拒绝执行，并返回**同一个原因对象**（`native-admission-cancel-probe.json`，`modelCalls=0`）。探针使用独立临时项目和宿主配置，不接触正在运行的业务会话。

冻结的 cadd53e 产物和正在运行的业务会话不修改。该修复需通过完整相关回归后另行冻结；本次已有未验证记录保留，不追溯改写。

完整回归首轮完成 165 个文件，155 个文件通过，10 个文件失败或超过测试文件期限，其中包含诊断期间加入的压缩取消回归红测。原始失败日志 `host-no-deadline-full-tests.log` 保留。修复后将这 10 个文件串行复核，结果 **261 通过、1 跳过、0 失败**，各文件均成功完成（`host-no-deadline-rechecks.json`）；测试文件上限为 180 秒，与宿主业务完成策略无关。不是一次全量并行全绿的记录。
