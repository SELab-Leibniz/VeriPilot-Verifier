# 文档纠偏：项目会话与按需证据

## 动态基线与真实 benchmark 需求文档

同一入口增加 `--dynamic-baseline`，启用生产动态需求抽取和文档 Ground Truth 评审。复制类样例从原始用户任务及项目约束抽取并发布正式基线，记录复制契约和作者操作要求；`dynamicGroundTruth.materialRoots: []` 避免把大段示例代码重复提炼为运行义务。完整 `requirements.md` 仍作为已声明的文档 Ground Truth，由原生文档审查直接读取，并由 `review.copyFrom` 比较全部字符。文档自动 Hook 的各轮评审均须绑定已发布的基线版本。这只调整此复制类实验入口，不改变普通方案设计任务的材料配置。只启用基线和文档，Skill、实现检查、Stop、额外指标和 onboarding 小组全部关闭。

固定案例位于 `examples/document-e2e/terminal-bench-batching/`，采用 Terminal-Bench 2.1 的 `llm-inference-batching-scheduler` 原始完整需求（78 行、4365 字节）。来源仓库固定到 `7131e4375048a0e408a8fb404b5f499d726b695b`；`case.json` 保存来源 URL、原始文件哈希和独立检查点，原始 Apache 2.0 许可证随文件保留。`requirements.md` 保持 benchmark 原字节；独立 `draft.md` 仅在对齐粒度、形状预算、性能表和输入保护四处设置受控偏差。期望结果和偏差清单不会写进模型工作区。

```sh
node scripts/evaluate-openclaw-document-e2e.mjs --live --dynamic-baseline \
  --benchmark-case examples/document-e2e/terminal-bench-batching \
  --host-root /opt/homebrew/lib/node_modules/openclaw \
  --config examples/document-e2e/dynamic-benchmark-options.json \
  --output-root .runtime-correction/openclaw-dynamic-benchmark-new
```

`baselineTimeoutMs` / `--baseline-timeout-ms` 独立设置需求抽取的时限，默认 1200000 毫秒。示例配置为基线 20 分钟、文档评审 20 分钟、Hook 30 分钟、主运行 30 分钟、整轮 40 分钟，均可调整到 60 分钟；较短的外层截止仍会先结束调用。输出额外保存 `dynamic-baseline.json`，报告中包含正式基线、原生抽取记录、两轮 artifact evaluation 及其绑定版本。

这项测试评价真实 benchmark 原始需求在文档中的保真和纠偏效果。原始任务的实现和执行指令作为方案内容保留，本次不执行调度器、不生成 benchmark 运行产物，也不报告官方 benchmark 得分。

### 更多完整需求样例

以下样例沿用相同的生产动态基线和文档自动 Hook 入口，每个保留原始 benchmark 需求、许可证、来源提交和哈希。独立草稿各设置四处受控偏差，期望清单留在模型工作区之外。

| 样例目录（位于 `examples/document-e2e/`） | 原始需求 | 偏差类型 |
|---|---:|---|
| `terminal-bench-batching` | 78 行 / 4365 字节 | 对齐粒度、跨桶上限、阈值、输入保护 |
| `terminal-bench-multi-source-data-merger` | 62 行 / 1912 字节 | 来源优先级、字段类型、日期格式、统计口径 |
| `terminal-bench-constraints-scheduling` | 30 行 / 2415 字节 | 硬时间边界、缓冲方向、UTC 格式、偏好作用 |
| `terminal-bench-nginx-request-logging` | 24 行 / 1882 字节 | 端口、日志引号、限流参数、验证顺序 |
| `terminal-bench-fix-code-vulnerability` | 52 行 / 3873 字节 | 输出路径、字段类型、错误处理、修改权限 |
| `terminal-bench-financial-document-processor` | 13 行 / 1055 字节 | 缺省值、特殊分支、列顺序、聚合口径 |

通过替换 `--benchmark-case` 选择样例，并为每次运行指定新的输出目录：

```sh
node scripts/evaluate-openclaw-document-e2e.mjs --live --dynamic-baseline \
  --benchmark-case examples/document-e2e/terminal-bench-constraints-scheduling \
  --host-root /opt/homebrew/lib/node_modules/openclaw \
  --config examples/document-e2e/dynamic-benchmark-options.json \
  --output-root .runtime-correction/document-scheduling-new
```

每例的验收都要求实际模型写入、自动反馈、实际模型修复、当前文档复审、正式动态基线绑定和宿主完成回执。原始需求文件保持所有字节不变，业务文档保留完整需求内容；脚本不会代替模型修改业务文档。

复制比较只允许非围栏代码块的行尾空格或制表符不同；正文、行首缩进、行内空白、换行数量、末尾换行及围栏代码块仍保持一致。比较规则只作用于本次文档样例验收，不会改写文件。初始评审哈希必须精确匹配主 Agent 实际写入的字节，最终评审哈希必须精确匹配当前文件；原始 benchmark 来源哈希仍逐字节核对。报告中的 `initialCopy` / `finalCopy` 分别保存等价比较、逐字一致性和双方实际哈希。

任务提示将文档内容要求与作者执行指令分开：以 `requirements.md` 为依据是作者的工作规则，不要求在文档中另写“权威声明”、测试范围说明或执行免责声明。文档评审协议同样区分这两类义务；原始任务明确要求输出某段声明时，仍保留该内容要求。固定样例的最终文档还会与完整原文比较，因此额外添加的前言或声明不能因模型返回 PASS 而被接受。

2026-11-02 修复后，上述六个样例均通过全新的真实 OpenClaw 动态基线与自动 Hook 回归，单例耗时 64–121 秒。24 处受控偏差全部恢复，首轮无额外诊断，最终均为零诊断，宿主完成回执均为 `ok`。漏洞样例再次出现了限定范围内的行尾空白差异，初始和最终文档都按上述等价规则通过，其余五例逐字一致；每例的实际评审哈希、完整来源哈希、已结算私有运行和打包源码哈希均已核对。相关自动检查 66 项通过，超时配置沿用现有示例。详见 仓库记录 `docs/document-copy-scope-regression-results.json`；此前仓库记录 `docs/document-multicase-results.json` 的失败与额外诊断保持原样。这些结果只评价文档纠偏，不代表官方 benchmark 得分或通用准确率。

### 新增长文本需求样例

六个 `swe-bench-*` 样例来自 SWE-bench Verified 的完整 `problem_statement`，数据集版本固定为 `c104f840cc67f8b6eec6f759ebc8b2693d585d4a`。保留原始 UTF-8 字段为 `source-problem-statement.txt`，导入的 `requirements.md` 只统一 CRLF 为 LF；两者字节数和哈希、数据集行标识、上游仓库及 base commit 均记录在 `case.json`，来源说明保存在 `NOTICE.md`。不读取或向模型提供 hints、修复补丁或测试补丁。草稿仍仅设置四处受控偏差，运行入口和超时配置不变。

| 样例目录（位于 `examples/document-e2e/`） | 完整输入 | 偏差范围 |
|---|---:|---|
| `swe-bench-pylint-dev__pylint-7080` | 260 行 / 24513 字节 | 递归行为、忽略路径、命令参数、预期行为 |
| `swe-bench-pytest-dev__pytest-7490` | 378 行 / 22403 字节 | 版本行为对比、动态 marker、断言、预期失败记录 |
| `swe-bench-matplotlib__matplotlib-22719` | 208 行 / 9971 字节 | 警告类别、复现输入、预期结果、空数据边界 |
| `swe-bench-pydata__xarray-6721` | 237 行 / 9067 字节 | 内存行为、后端、元数据访问、环境版本 |
| `swe-bench-django__django-11087` | 90 行 / 9262 字节 | 查询字段范围、升级版本、预期结果、字段必要性 |
| `swe-bench-scikit-learn__scikit-learn-11578` | 176 行 / 7216 字节 | 默认分类策略、参数传递、继承规则、参数类型 |

```sh
node scripts/evaluate-openclaw-document-e2e.mjs --live --dynamic-baseline \
  --benchmark-case examples/document-e2e/swe-bench-pylint-dev__pylint-7080 \
  --host-root /opt/homebrew/lib/node_modules/openclaw \
  --config examples/document-e2e/dynamic-benchmark-options.json \
  --output-root .runtime-correction/document-large-pylint-new
```

这些样例重点覆盖长文本、大段复现代码、日志和版本列表中的文档保真与偏差定位，不执行问题对应的软件修复，也不作为官方 SWE-bench 得分。

2026-11-02 首轮真实运行结果为 **2 例通过、4 例失败**，单例耗时 110–217 秒，24 处预置偏差均被定位并恢复，但不能据此把所有闭环标为通过。动态基线均正式发布，所有私有运行已结算；没有超时，也未再出现额外权威声明要求。相关自动检查 44 项通过。生产运行器、评审规则和超时配置保持上一轮状态，失败证据未被覆盖。

| 样例 | 严格结果 | 主要证据 |
|---|---|---|
| Pylint 7080 | 通过 | 两轮自动评审，初稿及最终全文逐字一致 |
| pytest 7490 | 失败 | 修复用了原生 `apply_patch`，运行器只统计 write/edit；独立全文核对另发现代码块内空格变化及末尾换行缺失，模型却返回 PASS |
| Matplotlib 22719 | 失败 | 复审 PASS 后又调用无效补丁，宿主回执 error；最终代码块缩进和末尾换行也与原文不同 |
| xarray 6721 | 失败 | 最终全文已逐字恢复并复审 PASS，初次复制少一个末尾换行，未通过既有初稿检查 |
| Django 11087 | 通过 | 首轮附带候选补丁校验失败诊断，随后业务模型完成修复，最终全文逐字一致且零诊断 |
| scikit-learn 11578 | 失败 | 最终全文逐字一致，仍被原文已有的第 149 行标题跨级 warning 阻止通过；初次复制另少一个末尾换行 |

完整初稿/终稿差异、首轮额外诊断、模型复审结果、宿主回执及严格失败原因保存在 仓库记录 `docs/document-large-requirement-results.json`。其中额外诊断包含模型复制时新引入的问题和候选补丁校验错误，不应全部视为误报。Matplotlib 的主运行在早期断言失败前未导出统一会话文件，汇总直接读取保留的原生会话日志和私有运行账本，原始失败报告保持原样。

### 长需求闭环修复

复制样例显式配置 `review.copyFrom: original-requirements`。生产文档评审基于当前已声明、已读取的来源和目标返回逐字符差异，保留实际字节哈希，不由运行器改写业务文件。JSON 转义后的行和末尾后缀可供主 Agent 用原生 edit/write/apply_patch 修复；代码块缩进、行内空格和 EOF 换行差异不能再被模型的 PASS 覆盖。普通需求到方案的语义评审不启用此选项。

运行器按真实成功工具回执统计 write/edit/apply_patch 的目标文件修改，失败、空补丁、未确认调用和其他文件均不计入。初稿必须保留全部预置偏差，初次评审哈希仍须精确对应实际写入；初次复制附带的格式偏差记录于 `initialCopy`，允许在同一自动反馈闭环内修复。最终全文等价检查、零诊断复审和宿主正常回执仍是必需条件。

`rules.enabled: false` 现在关闭默认 Markdown 风格规则，保留来源自身的标题层级。业务任务明确要求在自动反馈通过后结束，不发送空补丁；复制评审只返回诊断，不要求生成候选补丁。运行记录在断言宿主回执前保存，便于失败追查。

隔离文档自动 Hook 样例在主 Agent 的宿主工具授权中禁用 `runtime_corrector` 手工检查入口，防止模型在自动评审通过后额外复查。该约束仅写入当前隔离 Gateway 的配置，不修改宿主全局配置或插件通用手工命令。

插件异常边界会取消插件自己的评审，不取消宿主业务信号；后台清理失败被捕获，导航 checkpoint 失败不会传播到宿主压缩流程。故障注入检查覆盖评审入口抛出异常、日志/清理不可用和导航记录不可用，检查宿主调用继续返回、宿主取消信号未被触发。超时配置与之前相同，仍分别控制基线、评审、Hook、主运行和整轮预算。

2026-11-02 修复后的首轮真实回归为 5 例通过、1 例未通过：六例最终文档均逐字恢复，24 处受控偏差全部修复；xarray 在自动通过后又调用手工检查，因此仍保留 FAILED。收紧隔离工具授权后，实际安装的宿主工具过滤流程已验证手工入口被排除，文档读写和补丁工具仍保留。本地相关检查共 143 项通过。

随后，统一工具配置的回归曾在文档评审前被原提供方 `AccountQuotaExceeded` 拒绝，三个隔离 Gateway 保存记录并正常关闭。当时的阻塞和待验证项保留在仓库文件 `docs/document-large-fix-progress-results.json`；这份历史记录不代表下述 GLM 回归的当前结果。

### GLM 完整回归结果（2026-11-02）

使用用户提供的 `glm-5.3-flash` 和智谱官方 Anthropic 兼容入口，在全新目录运行相同六个大需求样例，最终 **6/6 通过**。生产插件、动态基线、自动 Hook、完整来源和可配置超时沿用上述修复；仅在进程环境中提供凭据，不修改全局宿主配置。

| 样例 | 真实耗时 | 自动评审轮数 | 最终结果 |
|---|---:|---:|---|
| Pylint 7080 | 303 秒 | 2 | 通过，逐字一致 |
| pytest 7490 | 322 秒 | 3 | 通过，逐字一致 |
| Matplotlib 22719 | 248 秒 | 2 | 通过，逐字一致 |
| xarray 6721 | 268 秒 | 2 | 通过，逐字一致 |
| Django 11087 | 340 秒 | 2 | 通过，仅非围栏行尾空白不同 |
| scikit-learn 11578 | 279 秒 | 2 | 通过，逐字一致 |

24 处预置偏差全部定位并恢复；所有最终复审均为零诊断，宿主完成回执均为 `ok`，私有运行均结算。来源原字节哈希和实际初稿/终稿评审哈希逐一核对，最终全文遵守既有比较策略。初稿复制新增的错误由实际主 Agent 在自动反馈闭环中修复，程序未改写业务文件。没有通过后额外补丁调用或手工纠偏调用。七次隔离尝试的进程均已退出，未观察到宿主崩溃；扫描 2761 个隔离产物文件及结果报告，未发现所提供的凭据。

Django 首次复制多出一行，评审正确报在实际第 86 行，验收却比较原草稿第 85 行，故保留该次 FAILED。运行器已改为从实际首稿定位预置偏差，仍要求原始偏差文本存在，且不移动任何评审诊断。其他五例已按新定位逻辑复核，生产模块与打包模块哈希完全一致；Django 在新目录中重跑通过。相关本地检查共 144 项通过。完整版本、当前行号、原生调用及历史失败记录见仓库文件 `docs/document-large-glm-results.json`。这些结果只评价文档纠偏，不是官方 SWE-bench 得分。

## OpenClaw 自动 Hook 文档闭环

`scripts/evaluate-openclaw-document-e2e.mjs` 在独立目录内启动已安装的 OpenClaw 2026.7.1-2 Gateway，加载当前源码构建的插件，通过真实 `sessions.create` / `chat.send` 发起主 Agent 任务。主 Agent 将虚构草稿写入 `design.md` 后，生产工具结果中间件自动触发文档评审，把诊断附回这次写入结果；主 Agent 根据实际收到的反馈进行修改，修改后再次自动评审。运行器不会手动调用评审、注入 Hook 事件或替换修订稿。

```sh
node scripts/evaluate-openclaw-document-e2e.mjs --live \
  --host-root /opt/homebrew/lib/node_modules/openclaw \
  --config examples/document-e2e/openclaw-options.json \
  --output-root .runtime-correction/openclaw-document-new
```

输出目录必须全新。可提供完整的 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`（或 `ANTHROPIC_API_KEY`）和模型环境配置；没有提供器环境时，读取本机 `.claude/settings.json` 中已配置的同一提供器信息。`--claude-settings` 可以指定该配置文件。认证仅通过进程内普通提供器环境传入。Gateway 配置、会话和插件构建都保存在新输出目录内。

| 独立预算 | JSON 字段 | 命令行覆盖 | 默认值 |
|---|---|---|---:|
| 每次私有评审 | `reviewTimeoutMs` | `--review-timeout-ms` | 600000 |
| 每次自动 Hook | `hookTimeoutMs` | `--hook-timeout-ms` | 1200000 |
| 主 Agent 运行 | `businessTimeoutMs` | `--business-timeout-ms` | 1800000 |
| 整轮验收 | `totalTimeoutMs` | `--total-timeout-ms` | 1800000 |

单位为毫秒，可配置到 3600000，使用整秒；Hook 最少 2000，其余最少 1000。各层截止时间共同约束运行，放宽私有评审时应同时给 Hook 和主 Agent 留足时间。原生定位格式修复共享同一评审截止时间，不重新计时。超出总时限会请求宿主取消当前运行，并记录失败。

验收要求首轮真实发现第 2 行的遥测偏差、主会话真实消费对应工具反馈、主 Agent 至少两次写入/编辑、最新文档的原生评审返回 `passed` 且零诊断、私有评审均结算，以及需求文件保持原字节。评审输入哈希必须对应初始草稿和最终修改稿。保存的 `report.json` 包含实际生效的超时、评审记录和反馈回执；`business-session.json` 保留原生工具调用与工具结果。文档模式直接使用声明的原始需求，不依赖动态基线账本；动态基线、Skill 和 Stop 仍独立验收。

## 最小真实模型闭环（2026-11-02）

独立入口 `scripts/evaluate-document-e2e.mjs` 会生成一个包含遥测偏差的虚构文档项目，构建 Claude 插件，并使用生产 `checkArtifact`、`runSemanticReview`、`finalizeArtifactCheck` 和真实 `rc_document` MCP 工具完成评审。原始需求文件直接作为声明的依据，不依赖动态基线抽取。

首轮必须发现设计第 2 行的实际偏差。程序将本轮生产反馈交给业务 Agent，要求它读取原始需求、当前设计和反馈，并真实调用 Edit/Write 修改设计。随后重新读取当前文件进行第二轮评审；只有当前文档通过、存在成功编辑回执、原始需求保持原字节，整轮才返回 `PASSED` 和退出码 0。不会由测试程序替换修订稿。该入口是显式 CLI 协调的文档闭环；OpenClaw/Gateway 自动 Hook、动态基线、Skill 和 Stop 属于其他接入范围。

使用本机已配置且可正常调用的 Claude Code：

```sh
node scripts/evaluate-document-e2e.mjs --live \
  --config examples/document-e2e/options.json \
  --output-root .runtime-correction/document-e2e-live-new
```

输出目录必须全新。`--live` 会调用真实模型并产生相应费用。`RC_DOCUMENT_CLAUDE` 可指定 Claude 可执行文件；默认使用宿主的 Claude 路径解析，不修改全局模型或认证配置。

时间阈值可以通过 JSON 或以下参数调整（毫秒），命令行参数优先：

```sh
node scripts/evaluate-document-e2e.mjs --live \
  --output-root .runtime-correction/document-e2e-live-wide \
  --review-timeout-ms 1200000 \
  --repair-timeout-ms 1200000 \
  --total-timeout-ms 3600000
```

| 配置 | 默认值 | 用途 |
|---|---:|---|
| `reviewTimeoutMs` | 600000 | 每轮评审，包含模型启动、工具读取和定位错误修复 |
| `repairTimeoutMs` | 600000 | 每轮业务 Agent 编辑 |
| `totalTimeoutMs` | 1800000 | 所有评审和编辑共享的总时限 |
| `maxRepairRounds` | 2 | 最多允许的业务修复轮数 |
| `locationRepairAttempts` | 2 | 每轮允许修复定位错误的次数 |
| `killGraceMs` | 1500 | 超时后终止整个调用进程组前的宽限 |

三个时间预算接受 1000–3600000 毫秒。重试不会重置本轮或总截止时间；超时记录失败并返回非零，不能当作 PASS。输出保留 `options.json`、构建后的插件、原始及当前文档、每轮反馈、完整 CLI 工具调用/回执流和 `report.json`。模型用量及费用按 CLI 的报告值保存。

定位校验覆盖当前声明文件的物理行号和逐字引用，支持 `path:line: 'quote'`、双引号和行范围。定位错误要求模型重新读取并提交，程序不会悄悄挪动发现。修订后的检查必须使用当前哈希对应的完整文档，不能复用之前的 PASS。

## 目标与范围

本方案优化 MatrixAssistant / OpenClaw 的 artifacts、bundle、workflow 节点和入边文档评审。实现放在 runtime-corrector 插件中，不修改宿主。开发使用从当前分支建立的外部 Git worktree，共享原仓库对象；运行时直接读取项目原文件，不克隆或复制代码仓。

Stop 的任务评审引擎和 CLI 宿主的默认会话策略保持原协议。文档工具也提供独立 CLI / MCP 适配器，便于实验和其他宿主显式接入；不能把这个适配器描述为已自动改变 Claude / CodeAgent 的生命周期。

## 实现规划与落地

1. **项目级执行槽。** `document-session.mjs` 用项目真实路径和磁盘互斥锁串行接收文档轮次。每轮新建请求、运行编号、预算和工具绑定，但复用私有 agent 的原生身份和会话。不同项目独立执行；相同项目并发排队，等待仍受原截止时间和取消信号控制。
2. **拉起、复用、释放。** 首轮按需拉起。轮次结束后释放执行器、工具、监听器、内部租约及请求资源，保留可恢复的会话。空闲 30 分钟或达到 32 轮后释放/轮换；模型、权限、认证或协议变化也轮换。失败、取消不复用不确定会话。重置、关闭纠偏和插件退出清理空闲资源；不合作的在途运行仍须结算后才放开执行槽，防止两轮重叠。进程崩溃后的死锁按持有进程存活情况回收，开启新身份，保留笔记供重新核对。
3. **按声明读取。** `document-tools.mjs` 的 `rc_document` 仅接受本轮已声明的目标、前序文档和 ready Ground Truth 文件。`open` 一次返回清单、有效笔记和带原行号的当前文档页；剩余内容用 `read` / `search` 获取。所有原文件在结果接受前重新核对哈希；链接、越界、非文本和不稳定证据会被拒绝。一般文档页最多 8 KiB；长行明确返回 `requiresHostRead`，不会静默当成完整内容。
4. **精简 skill。** `skills/document-corrector/SKILL.md` 由文档执行器按需提供。它要求读完当前目标及适用依据、保留缺失前提的 pending 状态、只给当前偏离和最小候选编辑。完整语义评审协议继续负责具体节点、入边、Ground Truth 和指标约束。
5. **压缩后的笔记。** `remember` 只写项目私有笔记，只接受本轮读取过的文件引用；按键覆盖，最多 24 条，每条正文 1000 字节。`recall` 的正文预算为 4 KiB，明确标注省略条数。每条笔记绑定本轮完整文档范围的哈希、规则、基线及任务身份；任意依据变化后仅返回 stale 键。压缩前后自动保存私有 checkpoint；`open` 同时给出当前请求路径，便于重新加载。笔记和 checkpoint 只用于导航，不承认先前 PASS 或引述为当前证据。
6. **合理触发与看护。** 继续使用原有配置匹配、写入触发、节点/边开关和宿主取消协议。完整输入与证据完全相同的重复事件可复用已验证结果，模型调用为零；文件、规则、基线、转录证据或模型策略变化都会重新评审。额外读取声明范围之外的源文件、调用外部检索，或结果含临时私有路径时，不进入去重缓存。候选 diff 的可编辑范围和 exact-expect 校验继续由原程序执行。
7. **界面阶段标识。** 原生工具进度通道显示 `文档·评审`。阶段状态不追加到宿主模型消息或助手正文；真实诊断仍按原反馈协议送达。状态侧录在项目私有 `status.json`，不把定时状态当成真实模型活动，也不延长原截止时间。

## 生命周期与存储

`待命 → 排队 → 评审/取证 → 哈希及输出校验 → 本轮结束 → 待命或释放`。

私有文件位于项目 `.runtime-correction/document-agent/`：

- `active.lock/`：跨进程执行槽的独立排队凭据，含进程号、随机令牌和次序号；只回收死进程的独立凭据，不删除其他进程新建的共享锁。
- `status.json`：本轮阶段与会话身份。
- `notes.json`、`checkpoint.json`：有界笔记和压缩恢复导航。
- `<session-id>/session.jsonl`：支持文件转录的原生会话；使用 SQLite 的宿主继续由公开原生 session API 管理转录。

每轮请求、进展证据及审计记录各自使用独立编号，不能因会话复用覆盖上轮结果。文件转录按本轮新增区间归档，避免反复归档全部历史。此目录应保持项目原有的忽略规则。进程崩溃后的历史目录保留供诊断；重新启动不冒认旧原生身份。

## 验证

确定性测试覆盖同项目串行和复用、跨进程互斥与崩溃恢复、取消和截止时间、空闲/失败/策略变化后的释放、当前工具绑定、重复事件零模型调用、文件变化后的拒绝、笔记失效、压缩 Hook checkpoint、MCP 真实 stdio 往返、范围和链接约束。原有文档 workflow、diff、权限、宿主进度、插件打包和注册契约继续复验。

全量初测执行 144 个文件，出现机器负载相关的截止时间/性能阈值失败及新资源清单断言失败。补齐新工具与 skill 的打包断言后，13 个相关或失败文件改为串行复验，404 项全部通过；没有放宽既有时间与业务断言。最终文档专项和宿主/打包契约另行复验。历史初测失败与复验结果均保留在工作树的 `.runtime-correction/` 验证记录中。

真实模型实验使用本机已配置的 Claude Code 模型及真实 MCP 工具，生成一个小型文档夹具，不复制仓库：连续检查“云端导入偏离 → 离线导入正确 → 遥测网络调用再次偏离”。冷启动组每轮新会话、分步导航读取；优化组一个会话、批量 `open`。两组均 3/3 判断正确。

- 冷启动：3 个会话；输入 token 16,885（含缓存），输出 836；模型报告总耗时 80,187 ms。
- 优化：1 个会话；输入 token 12,524（含缓存），输出 439；模型报告总耗时 37,785 ms。
- 本次输入量减少 25.8%，耗时减少 52.9%。非缓存输入从 4,149 降到 2,348。

另做了仅复用会话、仍分步取证的对照：虽减少非缓存输入，总上下文输入却增加。因此批量取证与有界笔记是必要优化，不能用“复用”本身承诺 token 节省。结构化观测见 [实验记录](document-correction-experiment.json)。

实验只有每组 3 轮，结果受缓存和服务延迟影响，不代表所有项目的固定收益。压缩恢复验证包含真实 Hook 调用、工具状态重建和笔记恢复，没有强制对生产 MatrixAssistant 会话执行压缩。已只读验证本机宿主注册契约，尚未在运行中的 MatrixAssistant 界面发布或进行人工视觉验收。

## 复现

在仓库根目录执行：

```powershell
node --test test/document-agent.test.mjs test/document-agent-lifecycle.test.mjs
node scripts/experiment-document-agent.mjs .runtime-correction/document-experiment
node scripts/experiment-document-agent.mjs .runtime-correction/document-experiment-live --live --batched
```

第三条会使用本机 Claude Code 的已配置模型产生真实用量。可通过 `RC_DOCUMENT_CLAUDE` 指定原生可执行文件。MCP 适配器采用 [官方 stdio 协议](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)，可用 `node scripts/document-tools.mjs <semantic-request.json> --stdio` 启动；这是单轮工具进程，私有笔记持久化在项目中。
