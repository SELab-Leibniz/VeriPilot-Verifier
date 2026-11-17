# MatrixAssistant 适配与验证记录

基线为 `371253e`（`codex/rc-general-efficiency-bench`），目标为 MatrixAssistant 内置 OpenClaw `2026.7.1-2`。实现、构建和临时实验均在 RC 范围内；未向真实 MA 安装产物，MA、内置 OpenClaw、已安装扩展与个人配置保持只读。实际执行环境为 **Windows**；POSIX 路径大小写、符号链接及启动兼容按代码与夹具设计保留，未在 POSIX 实机运行本次回归。

此前默认全量中的既有 `ma-host-config` 测试曾以显式临时配置启动 `configure-ma-host` CLI，没有写真实 MA 配置；后续 `af3d002` 已将其替换为纯配置函数临时夹具，9/9 通过。因此不宣称整个开发过程从未启动过该 CLI。完整真实模型、MA 桌面长时行为及安装后的恢复由用户验收。

## 已确认的四项决策

| 项目 | 实际策略 |
| --- | --- |
| B4 | 仅能严格证明由 RC 自身错误提示引发的边界拒绝免扣共享修复额度；其他拒绝、轮次和截止时间沿用原规则。 |
| T3 | 同一会话 autopilot 可核实为 RUNNING 时，RC Stop 排队让路并保留完整审查预算；IDLE 正常审查；活动状态 UNKNOWN 只提示，不推断宿主结束。旧宿主终态 UNKNOWN 仍保留所有权，不能重发或抢占；真实旧终态确认后恢复精确新候选，用户取消/安全解除不会被重启复活。 |
| X2 | 安装插件及显式调用 `/rc-setup` 时只初始化 RC 和主 Agent 工具授权，不向 `matrix-context-controller.config.bypassSessionPatterns` 注入 `agent:*:runtime-corrector:**`，已有规则和 deny 保留，重复调用幂等。开发验证仅使用临时配置。 |
| T1 | UNKNOWN 最多重试 12 次或 60 秒后升级，仍保持 UNKNOWN。安全解除需同一操作者、运行与修订绑定的短期令牌二次确认；解除只停止该 RC 调度身份，不证明宿主已取消或业务已结束。 |

## 地基：E1、E2、X1

原工作区已设置仓库级 `core.longpaths=true` 并执行 `git add --renormalize .`。`4e09317` 通过 `.gitattributes` 固定测试/夹具 LF，保留二进制和原始问题陈述的逐字节内容（当时遗漏 `examples/`，见审查后补修）；`lib/path-utils.mjs` 新增 `isSameFile` 与逐级 lstat 的 `hasLinkedPath`，后续各分支替换自己的调用点。Windows 文件别名与真实链接分别判断，不能用相同 stat 身份放行符号链接/Junction。

`scripts/test.mjs` 在缺少源码测试依赖 TypeBox 时显示准确安装命令并保留失败，README 补充 `npm ci --prefix lib/review-task --ignore-scripts`。新增 `test/path-utils.test.mjs` 3 项及 `test/test-dependencies.test.mjs` 1 项，均通过；Windows 使用目录 Junction，POSIX 夹具保留文件符号链接分支。三端构建与产物 17/17 通过。

## 六分支交付

以下列出主要实现文件与新增测试；同名文件在不同分支有局部交集，最终保留相应来源/覆盖/所有权守卫。各专项选集重叠且会随补修改变，计数不相加。六分支均完成三宿主构建、产物 17/17 和 diff 检查，仍须以主分支全量门禁为准。

### host-coexist：X2、X3、X4、T3

- **实现与文件**：工具前钩子优先级为 5，位于 autopilot/audit 之后、RTK 改写之前；热钩子最多 10 秒，模型任务另用自身预算并按 controller 串行、取消、隔离迟到结果。`lib/openclaw/{runtime,tools,entry,hook-timeout,host-setup,post-run-host,reviewer,sources,material-basis,console-observations}.mjs`、`ui/observations.mjs`；原始 MATERIAL provider 接入 `lib/runtime-v2/{onboarding,orchestrator,baseline-task,baseline-shared-basis,skill-source}.mjs`。更新 `packaging/runtime-modules.json`、OpenClaw manifest、`docs/openclaw.md`、`docs/interfaces.md`。
- **新增测试与结果**：新增 `ma-host-coexist.test.mjs`、`ma-material-basis.test.mjs`，覆盖精确会话活动、原始材料瞬时替换/恢复、限额、取消、重启及迟到发布。初轮扩展专项 173/173、材料 15/15、末端边界 8/8；来源组 35/37，两个既有 Windows 文件链接因 EPERM 失败，未改为跳过。第一工具/别名、清理及配置故障补修后，完整 host/native/session/集成组 117/117，首工具 12/12，材料/OpenClaw/热预算 54/54。
- **补修与边界**：来源 `99f4436`，首工具补修原 `75ce4ab` 变基为 `d82f906`。第一工具无 prompt/task 时仍先捕获原始 MATERIAL，支持限定工具别名；夹具等待 dispose/drain，配置读取失败保持 UNKNOWN。超限或无法稳定取得原始材料时保持 UNVERIFIED，恢复当前哈希不能替代最初原文权威。

### skill：S1、S2、S3、N2、X1

- **实现与文件**：补齐宿主根和优先级、分组嵌套、按条目解析插件 Junction、Windows `skill.md` 大小写别名（原实现只在选择环节接受，磁盘上实际为小写的文件到身份解析即失败，见审查后补修）。实际读取文件的真实路径和原始字节摘要一路绑定到选择、watcher、规则图、共享基线、M08 和工作区 Stop，拒绝同名替换。涉及 `lib/hosts/openclaw.mjs`、`lib/openclaw/{tools,runtime}.mjs`、`lib/runtime-v2/{skill-source,orchestrator,baseline-shared-basis,metrics,stop-workspace-review}.mjs`。
- **新增测试与结果**：新增 `openclaw-skill-sources.test.mjs`，并扩展 OpenClaw 与 workspace Stop 测试。初轮 123 项中 108 通过、15 项既有 macOS 宿主可用性跳过；文件名补修 7/7，最新来源与工作区 Stop 41/41。来源提交 `5020705 → 5fbcc96 → 883e6d0`。
- **风险边界**：每根最多 2000 个目录、6 层；实际原文读取失败、摘要变化或图身份不一致拒绝发布。只读安装目录识别与实际 MA 模型运行是不同验证层次，见后文。

### document：D1、D2、D3

- **实现与文件**：真实链接拒绝、Windows 大小写别名、CRLF 展示与原始字节哈希分离；exec/PowerShell 仅对声明文档作有界执行前后快照，失败命令的部分写入也复核。涉及 `lib/document-tools.mjs`、`lib/openclaw/{tools,runtime,console-observations}.mjs`、`ui/observations.mjs`、`lib/runtime-v2/orchestrator.mjs`。
- **新增测试与结果**：新增 `ma-document-adaptation.test.mjs`，原 13 场景加 5 个所有权回归；更新 `document-open-budget`。文档/观测 46/46；相关原生/文档 59 通过、1 个 CLI 启动时序断言失败，停止并发工作后该文件独跑 6/6，未改其实现/断言。变基专项 26/26；纯配置函数夹具 9/9、实际 dispatch 事件测试 1/1。来源 `666fd92 → e2e4356`，变基 `73e2d1d/c84c038`；测试补修 `af3d002/093d98b`。
- **风险边界**：首个无 owner 调用只在已准入 callback 绑定 controller 一次；重复钩子保留原始快照及空值，外来 run/旧 controller 不得消费。快照最多 128 文件、单文件 4 MiB、合计 16 MiB、1 秒；通配/模板未解析范围、缺少前快照或超限保持 UNVERIFIED，阻断旧 PASS 缓存；Stop 仍照常审查，但结论最高为 UNVERIFIED（见审查后补修）。后台 writer 只有匹配已绑定 process poll 的真实结构化终态后，才可经完整声明文档复核解除；无关稳定命令不能证明它结束。

### baseline-onboard：B3、N3、N6、E3

- **实现与文件**：写入前采用同等 expectedFiles/来源校验，沿原会话和预算修复。不合格原义务逐条持久化 UNVERIFIED，有效兄弟义务照常入账，部分基线不得冻结。跨重试/重启保留原待处理操作，省略或弱化不能解除；只有同一原义务的有效元数据修复并入账后清除；待定期间 Stop 照常审查，待定义务单列 UNVERIFIED，整体不得为 PASS（见审查后补修）。统一相对 `/` 路径和字符码排序。涉及 `lib/runtime-v2/{onboarding,orchestrator,production-stop}.mjs`、`lib/openclaw/{reviewer,console-observations}.mjs`、`ui/observations.mjs`。
- **新增测试与结果**：新增 `onboarding-adaptation.test.mjs`（最终 12 项），更新 native source、观测、生产 Stop、baseline 测试；5 项补修专测遗漏/重启、入账幂等、回执前中断、元数据删除/语义弱化及来源修复。初轮 80/80，后续不同选集 75/75，变基 44/44。来源 `0298fd8 → 7cf9d5b`，变基 `9a7529c/b576945`。
- **风险边界**：缺少 `RC_OPENCLAW_HOST_ROOT` 的 E3 关键路径明确跳过；提供实际宿主校验器时，既有 `Unknown source unit S1L2` 仍单独保留，没有绕过或记为通过。

### baseline-extract：B1、B2、B4、N1、C1、X1

- **实现与文件**：复用会话固定首个 native cwd，无真实 assistant 消息的会话退休；完整 LF 行分片，超长 UTF-8 行安全回退、endLine 明确、支持跨片选取。草稿提示带 proposalId/父摘要与 correct 用法；免扣仅限有证据的 RC 错误提示同批次拒绝。保存并展示脱敏原始码、原因链、阶段及 run/task 关联。涉及 `lib/openclaw/{baseline-agent,task-session}.mjs`、`ui/observations.mjs`、`lib/review-task/{baseline-selection,baseline-task,task-evidence}.mjs`、`lib/runtime-v2/{baseline-task,baseline-shared-basis,baseline-coverage-audit}.mjs`。
- **新增测试与结果**：新增 `ma-baseline-extract.test.mjs` 10 场景，更新私有会话、观测、baseline 测试。专项 32/32；只读宿主校验器相关组 225 项中 224 通过、1 失败（既有 S1L2）；变基专项 19/19。来源 `6a92cde`，变基 `14ee506`。
- **风险边界**：同一 C1 test 75 改名不代表失败增减；实际默认运行仍在到达 fixture transport 前遇到同一 ENOENT，详见计数说明。普通拒绝继续计额度，免扣不重置轮次或截止时间。

### stop：T1、T2、T3、N4、N5、E4、X1

- **实现与文件**：有界 UNKNOWN 核对、鉴权控制及审计、同身份二次确认、安全回收已持久结算记录；缺少注入 runTask 明确报错，OpenClaw 不打包退役 Stop 说明。涉及 `lib/openclaw/{post-run-dispatch,post-run-controls,native-stop-review}.mjs`、`ui/post-run.{html,mjs}`、`lib/runtime-v2/{production-stop,stop-protocol-task,stop-task-review,stop-task-group}.mjs`、`lib/plugin-builder.mjs`、`lib/review-task/README.md`。
- **新增测试与结果**：新增 `ma-stop-recovery.test.mjs`，初轮共新增 13 个命名测试，专项 306/306；后续新增 `ma-stop-successor.test.mjs`，最终调度专项 90/90。来源 `ad7ae6f`；变基 `0bef57d`，迟到候选实现 `07078da`，最终补修原 `abf3ebd` 变基 `d6c44ac`。
- **补修与边界**：真实旧终态 ok/error 后，以 owner/version CAS 原子保存新 run、完整候选、FINALIZING 和 provenance；安全 IDLE 的 lastTerminal 也可接续，包括空业务队列和重载。UNKNOWN 后核对获得终态的证据必须持久保留，纠偏终态不得被父 run 替代。用户取消/安全解除持久抑制复活；取消后同 owner 迟到 PASS、旧 timer 均不得改变新结果。解除保留未派发任务及审计，不推断宿主已结束。

只有 host-coexist 新增运行时模块 `material-basis.mjs`，已登记打包 allowlist；其余新增文件为测试或复用既有模块。

## 主分支迟到候选接线与组合验收

`185bdea` 在既有 runtime 中接入严格候选 bridge：完整检查点校验原 24hex 文本摘要及独立 64hex 不可变字段摘要；接受 ACTIVE 或严格关联同候选 run/reason 的 STOPPED_UNVERIFIED，拒绝取消、新需求、错误身份或截断。WeakMap 按 state 跟踪并发 producer 与失败污点；待写入或失败时不读旧文本复活。beforeReview 直接查询 autopilot，锁内只做同步内存 guard，不自改调度 version。

仅明确由 postState 重建的旧运行可按当前持久 promotion 跟随新运行，真实业务 controller 不被改写。运行恢复与任务 ACK 分开，稳定 adoptedVersion 支持重启幂等消费；ACK 只标 ADOPTED 和审计，不修改 verification 或清除其他 UNVERIFIED。旧终态未知不推进；新候选仍走自身的 gateway terminal 和 Stop 审查，不发送业务重放。

主分支实际取得 **组合 7/7、迟到候选原生专项 13/13**，无失败/跳过，日志为 `.runtime-correction/fix-baseline/{combination-final,native-final}.log`。覆盖同会话基线/实际脚本文档修改/真实 Skill 原文和 M08/Stop，T3 两模式 × done/UNKNOWN、重启/FIFO、取消/迟到结果。此前 scratch 的 145/145、13/13、7/7、构建和产物是接口早验，不与主分支数量相加。

## 安装源只读核对

`skill-installed-probe.json` 记录实际目录识别：`%USERPROFILE%\.openclaw\plugin-skills` **16/16**，MA `resources/openclaw/skills` **2/2**，均匹配实际来源身份；没有启动 MA 进程。来源优先级、实际低优先级同名 Skill 到最终 Stop 的一致性另由临时夹具验证。

实际 `resources/app.asar` 的只读源码证明：`@matrix/gateway/dist/paths.js:90–101` 指向 `process.resourcesPath/openclaw/openclaw.mjs`；`manager.js:1759–1986` 使用该入口作为脚本参数、以 openclawDir 为 cwd、shell=false，并设置 `ELECTRON_RUN_AS_NODE=1`、`OPENCLAW_NO_RESPAWN=1`。实际 OpenClaw `package.json` 为 `2026.7.1-2`；`openclaw.mjs:244/271` 的编译缓存重启保留该脚本参数，`:784–786` 导入 dist 入口而不替换 argv[1]。

因此该已核对 packaged launcher 下，RC 的 argv 包根上溯能到达内置 package.json/skills，不依赖指向 RC 插件的 api.rootDir。此为源码契约与文件识别证据，不是运行中的 MA 进程观测，也不是完整桌面或模型验收。

## 全量回归口径与真实失败

证据位于本地忽略目录 `.runtime-correction/fix-baseline/` 的 `checks-* / regression-* / comparison-*` 和对应日志。“无新增”是逐文件、失败标题及明确别名的比较通过，不代表全量通过。

原始 `371253e` 默认为 **2136 项：1893 通过、185 失败、58 跳过**。185 分为参考失败 63 与缺少宿主校验路径 122；其中 34 文件还只报告 TypeBox 加载失败。在隔离原始代码补同一依赖、补跑这 34 文件得到 637/495/142 后，校准全集为 **2739/2388/293/58**。原始宿主口径 expanded 为 **2731/2656/38/37**；首次该口径的 baseline 文件 90 秒超时仍保留，单文件 180 秒补充仅用于补全原始失败，不替换首次记录。

| 默认阶段 | 实际 head | 总 / 通过 / 失败 / 跳过 | 相对校准基线新增 | 构建 / 产物 | 文件超时 |
| --- | --- | --- | --- | --- | --- |
| foundation | `4e09317` | 2735 / 2397 / 280 / 58 | 0 | 三端 / 17⁄17 | 0 |
| host 首次 | `1ffecbe` | 2771 / 2430 / 283 / 58 | 3，未过门禁 | 三端 / 17⁄17 | 0 |
| host-final | `e46aa51` | 2785 / 2447 / 280 / 58 | 0 | 三端 / 17⁄17 | 0 |
| skill | `9d73493` | 2793 / 2455 / 280 / 58 | 0 | 三端 / 17⁄17 | 0 |
| document 首次 | `7a82fdf` | 2811 / 2472 / 281 / 58 | 1，未过门禁 | 三端 / 17⁄17 | 0 |
| document-final | `091165d` | 2811 / 2473 / 280 / 58 | 0 | 三端 / 17⁄17 | 0 |
| baseline-onboard | `2481899` | 2825 / 2487 / 279 / 59 | 0 | 三端 / 17⁄17 | 0 |
| baseline-extract | `11282eb` | 2835 / 2497 / 279 / 59 | 0，C1 精确标题归一后 | 三端 / 17⁄17 | 0 |
| stop | `c4987ce` | 2876 / 2538 / 279 / 59 | 0 | 三端 / 17⁄17 | 0 |
| final-default 首次 | `185bdea` | 2817 / 2479 / 279 / 59 | 新增一个文件超时，未过门禁 | 三端 / 17⁄17 | **1** |
| final-default-complete | `2ebe3fa` | 2865 / 2527 / 279 / 59 | 原生分组通过；宿主集成等待挂起，未过门禁 | 三端 / 17⁄17 | **1** |

失败减少不能混算：校准 293 到 stop 279 的 14 项，分别为 12 项开发依赖完整性恢复（task-runtime、proof-boundary、stop-task-compat 各 4）、1 项未改实现的 CLI 启动时序观察差异，以及 1 项 E3 缺宿主路径的显式 SKIP。后两项不能记为问题修复。E3 提供宿主后既有 `Unknown source unit S1L2` 仍单列；Windows 文件链接 EPERM、原有 macOS 探测跳过也保留。

C1 同一 test 75 新标题 “baseline native transport preserves sanitized host failure cause and identity” 精确映射回旧标题 “baseline native transport still redacts unrelated host failures”；两边缺宿主时同为 ENOENT，未达到预期 HOST_FIXTURE_FAILURE，不是新增或消除失败。未归一化的 before-title-alias JSON 与正式 titleNormalizations 均保留，不作泛化忽略。

host 首次 3 项为两个未排空后台运行的 ENOTEMPTY 清理失败和一个配置读取异常逃逸，已修并完整复验。document 首次是约两秒派发轮询不足；改为等待实际 dispatch 事件并保留审查预算内的失败期限，而非接受未派发。上述首次失败记录都没有删除。

`185bdea` 原生文件的 90000 ms TIMEOUT 必须保留：当时已输出 51 个顶层测试，顶层 duration 合计 **89396.2851 ms**，未完成文件汇总，不能补记 PASS。随后 `2ebe3fa` **只拆测试**：52 个顶层守恒为原生文件 47 + 新 `openclaw-late-candidate.test.mjs` 5，共享 `support/openclaw-native-stop-fixture.mjs`，全部 76 项及断言保持。使用真实 runner、原 **90 秒/并发 2** 验证，分别 **63/63、61.23 秒**与 **13/13、28.74 秒**；无失败/跳过/超时，没有修改生产源码或提高看门狗。该专项不能替代拆分后的全量。

`2ebe3fa` 的两个原生分组及组合测试均在完整回归中通过，但 `stop-host-integration` 第二项停在审查开始信号。遗留夹具的持久 warning 明确记录 `transcript.jsonl` 原子替换收到 EPERM，调度记录已诚实结束为 `IDLE / UNVERIFIED / RC_HOOK_UNAVAILABLE`；测试仍裸等一个不会发生的开始信号。证据副本保存在 `transcript-eperm/{warning,post-run}.json`。单独复现该项通过，完整文件 28/28、四并发重复前两项 16/16，也均保留原始日志，不用重跑成功覆盖失败。

`b6c6d5e` 将 `lib/openclaw/transcript.mjs` 的替换接入已有 `renameWithRetry`：最多 8 次，合计退避 810 ms，保留原子替换及最终临时文件清理；持续拒绝仍抛错并保留旧快照。新增两个临时/永久 EPERM 回归，宿主夹具按 dispose→后台排空→删除目录清理，并要求真实审查开始，若先结算则直接输出诊断失败。两个相关文件 **66/66** 通过；未改热钩子预算或文件看门狗，也未将提前 UNVERIFIED 当作测试通过。

默认门禁之后，`0832dc8` 更正一处 UNKNOWN 交接冲突提示：只陈述旧 RC 所有者尚未安全解除，不再硬编码 autopilot 正在运行。新增原生回归实际经过已确认终态的 COEXIST_WAIT、未知活动状态和交接 CONFLICT，要求状态、旧所有者、完整候选及截止时间保持不变；主分支专项 **1/1** 通过。后续宿主全量包含此提交，两个口径按各自真实 head 记录。

首次最终宿主全量 `0832dc8` 为 **2896 / 2829 / 30 / 37**，无文件超时，构建及产物通过，但相对宿主基线新增 1 个共享基线测试失败，门禁未通过。B1 固定复用会话 cwd 后，该夹具仍从 cwd 检查候选和 finish，误读初次请求的已完成文件，导致当前分类修复步骤未执行。`1feca20` 仅修改两个测试文件：通过 native `onPrepared` 的真实 requestDirectory 与当前 prompt requestId 绑定本轮产物，使用当前 generation 检查文件；增加请求身份和复用 cwd 不等断言，保留全部分类拒绝、字节、预算及正式发布断言。宿主专项为 **18 项、16 通过、2 项原有失败**；不改生产分类校验，不用专项结果冒充全量通过。

| 最终主分支门禁 | 实际 head / 日志 | 总 / 通过 / 失败 / 跳过 / 超时及相对新增 |
| --- | --- | --- |
| 最终默认全量 `final-default-verified` | `b6c6d5e`，`regression-final-default-verified.log` | **2895 / 2557 / 279 / 59 / 0；新增失败 0**；三端构建与产物 17/17 通过 |
| 宿主首次 `final-host` | `0832dc8`，`regression-final-host.log` | **2896 / 2829 / 30 / 37 / 0；新增失败 1，未过门禁**；三端构建与产物 17/17 通过 |
| 宿主最终 `final-host-verified` | `1feca20`，`regression-final-host-verified.log` | **2896 / 2830 / 29 / 37 / 0；新增失败 0**；三端构建与产物 17/17 通过 |

## 失败减少及保留项的逐项索引

证据简称：

- **A**：原全量日志 (`.runtime-correction/fix-baseline/regression-before-host.log`)。
- **B**：原 Stop 延长复跑 (`.runtime-correction/fix-baseline/regression-before-host-stop-longer.log`)。原 Stop 文件 131 项、121 通过、10 失败；原全量该文件曾达 90 秒 watchdog。对照用 B 补齐原全量结果。
- **F**：最终 verified 日志 (`.runtime-correction/fix-baseline/regression-final-host-verified.log`)、检查元数据 (`.runtime-correction/fix-baseline/checks-final-host-verified.json`)、机器对照 (`.runtime-correction/fix-baseline/comparison-final-host-verified.json`)。表内 `A/B/F:行号` 均为日志行号。
- **R**：上一轮 0832dc8 raw (`.runtime-correction/fix-baseline/regression-final-host.log`)，仅保留新增夹具问题的历史证据，不作最终统计。
- **Q**：当前 request 夹具修正的 focused 日志 (`.runtime-correction/fix-baseline/host-shared-basis-current-request.log`)，对应后续 test-only 提交 `1feca20ffa6f397ca159017700aa680eef62ba03`。

### 当前能确认的数值

| 指标 | 原对照（补齐 B） | F：1feca20 verified |
| --- | ---: | ---: |
| tests | 2731 | 2896 |
| pass | 2656 | 2830 |
| fail | 38 | 29 |
| cancelled / skipped | 0 / 37 | 0 / 37 |
| 本轮完成文件 / 超时文件 | 不以初轮超时作最终对照 | 276 / 0 |

最终机器差异为 **9 个原失败消失、0 个新增失败**，即 `38 − 9 = 29`。F 的二十九条失败全部与原基线同名，其中包括一条父级聚合失败，不能写成二十九个独立叶子缺陷。276 个文件全部完成、0 个超时；regression exit 1（仍有原有失败），comparison exit 0（没有新增失败）。三种插件构建及 17 项打包测试均通过。上一轮新增的一项共享基线夹具问题已在本轮实际全量消除，见后表。

### 原 Stop 基线中已消失的 9 项

文件均为 `test/stop-baseline-task.test.mjs`。F 此文件为 **131 项、130 通过、1 失败**；剩下的一项是原有 S1L2，见后表。

| 完整测试名 | 原错误分类 | 当前证据 | 原因与归因边界 |
| --- | --- | --- | --- |
| span batches copy exact originals, share explicit metadata and preserve ordinary ledger publication | ENOENT：`mkdtemp ...empty-workspace-XXXXXX` | B:255 → F:1802 `ok 43` | B1 原生基线会话/工作区生命周期修复后通过。 |
| span supersession preserves exact claim identity and unrelated project obligations | 同类明确 mkdtemp ENOENT | B:308 → F:1844 `ok 50` | 同上，归入 B1。 |
| one unchanged mixed source clause supports separately scoped full-mode obligations through publication and metric projection | 同类明确 mkdtemp ENOENT | B:391 → F:1916 `ok 62` | 同上，归入 B1。 |
| completed baseline publication uses the parent deadline after the extractor closes | 同类明确 mkdtemp ENOENT | B:426 → F:1940 `ok 66` | 同上，归入 B1；保留父级发布截止断言。 |
| baseline publication failure keeps its typed cause and never commits a current cursor | 同类明确 mkdtemp ENOENT，先于预期发布失败场景 | B:451 → F:1952 `ok 68` | 同上，归入 B1；发布失败类型与游标保护仍被测试。 |
| mixed-source authority feedback names actual inherited defaults and preserves explicit overrides | `Native task execution failed` 外包装；内层 deepEqual 仅材料 `ref` 的 `/` 与 `\\` 分隔符不同 | B:518、536 → F:2006 `ok 77` | **仅测试兼容修正**：expected 改为 `f.material.replaceAll('\\', '/')`，对齐既有规范化 ref；不是新增权限或放宽来源规则。 |
| formal delta, commit receipt and source cursor publish once, including a lost application reply | 同类明确 mkdtemp ENOENT | B:791 → F:2265 `ok 118` | 归入 B1；仍验证单次发布与应答丢失保护。 |
| cancellation after transaction log write but before head publication applies neither delta nor cursor | ERR_ASSERTION 包装的明确 mkdtemp ENOENT，未到达预期取消路径 | B:838、853 → F:2301 `ok 124` | 归入 B1；仍验证取消不应用 delta/cursor。 |
| existing requirements orchestrator repairs a rejected claimId, commits once and advances its source cursor | ENOENT + `Requirement baseline extraction failed; requirement remains pending.`；底层缺失路径未保留 | B:882 → F:2319 `ok 127` | 现已通过；**不把底层路径不明的 ENOENT 强行单独归因 B1、缺输入 fixture 或其他原因**。 |

归因合计：7 个日志明确的内部工作区 mkdtemp ENOENT → B1；1 个仅 expected 路径规范化的测试修正；1 个底层路径不明、现通过但不独立归因。B1 对应 `14ee506` 的原生基线会话及工作区稳定性实现；其中 pooled workspace 稳定、无 assistant 的原生日志不继续复用等是生产行为修复。不能把这九项一概写成“仅改断言”，也不能把七个明确路径错误扩展成“所有 ENOENT 都已修复”。

### F 中与原基线同名的 29 条失败

#### Windows 符号链接创建 EPERM：10 条

下列错误均在 fixture 创建链接时发生，短错误为 `EPERM: operation not permitted, symlink`。可确认是当前 Windows 环境的链接创建失败；不是链接逃逸防护断言已被证明失效。文件或目录链接都包含在内。

| 文件 | 完整失败测试名 | F / 原证据 |
| --- | --- | --- |
| `test/benchmark-fault-fixture.test.mjs` | fault cannot escape the isolated benchmark through traversal or a symlink | F:58 / A:58 |
| `test/native-integrated-module-contract.test.mjs` | native business fence rejects symlink deliverables and never grants unbound private reads | F:375 / A:277 |
| `test/native-stop-evaluation-preflight.test.mjs` | native fixture fence permits generated basis and the exact external contract; denies parent/profile and links before read | F:274 / A:322 |
| `test/openclaw-supervised.test.mjs` | public validator loader rejects public-entry symlinks escaping the selected AI package | F:815 / A:806 |
| `test/plugin-root.test.mjs` | resolves an in-root entry and rejects lexical and symlink escapes | F:892 / A:881 |
| `test/session-end-process.test.mjs` | declared Node launch preserves a plugin root containing spaces | F:1205 / A:1194 |
| `test/source-root-alias.test.mjs` | root alias support cannot expand the frozen inventory or follow a replaced child outside | F:1414 / A:1403 |
| `test/source-context-population.test.mjs` | actual bounded intake still rejects project-private, traversal, linked and external observer-private sources before native dispatch | F:1494 / A:1483 |
| `test/synthetic-provider-preflight.test.mjs` | synthetic frozen tool rejects external, undeclared and linked paths before disclosing content | F:2415 / A:2519 |
| `test/synthetic-provider-preflight.test.mjs` | synthetic snapshot rejects changed bytes and internal links too | F:2430 / A:2534 |

#### 原有 S1L2：1 条

| 文件 | 完整失败测试名 | 短错误 / 分类 | F / 原证据 |
| --- | --- | --- | --- |
| `test/stop-baseline-task.test.mjs` | critical-path MATERIAL revision replays original live006 arguments and publishes guarded ledger and certificate | `BASELINE_SCOPE_INVALID`，`Unknown source unit S1L2`；原文单元范围不符，原基线已有。未修复，不能计为本轮新失败或通过。 | F:2325 / B:898、914；A:2435、2451 |

#### 其他原有具体错误：18 条（含 1 条聚合）

这些条目没有符号链接 EPERM。以下按日志能确认的现象分类；对象/产物为什么缺失、证书 ref 为什么不匹配等，不额外猜测。

| 文件 | 完整失败测试名 | 当前短错误 / 分类 | F / 原证据 |
| --- | --- | --- | --- |
| `test/failed-skill-selection-recovery.test.mjs` | failed selected read survives document alignment and Stop runs the same Skill independent checker | TypeError：读取 undefined 的 `sources`；对象缺失根因未知，不直接归为缺输入 fixture。 | F:140 / A:146 |
| 同上 | a genuine later read of changed original recovers the pending identity without resetting its window | 期望 ACTIVE，实际 UNVERIFIED；`BASELINE_AUDIT_INCOMPLETE / SKILL_WATCH_NOT_ESTABLISHED`。原因未确认。 | F:191 / A:197 |
| `test/native-integrated-entry.test.mjs` | actual integrated CLI retains its provider boundary when startup loses an unclosed host handle | ENOENT：生成的 `trace.jsonl` 不存在；启动/生成原因未知，非直接的输入 fixture 缺失证据。 | F:243 / A:236 |
| `test/openclaw-document-e2e.test.mjs` | real benchmark source is pinned and candidate faults leave the complete original available | `Benchmark original source identity changed`，实际/期望 SHA-256 不同；哈希差异与旧日志相同。后经核实为 CRLF：`examples/` 未纳入 LF 规则，Windows `core.autocrlf=true` 检出的 12 个 `requirements.md` 均为 CRLF，转 LF 后摘要全部吻合。已在审查后补修中修正。 | F:456 / A:448 |
| 同上 | all benchmark document samples preserve their original sources and only the declared candidate changes | 同类固定源 SHA-256 断言不符，另一原样本；原因同上。 | F:487 / A:479 |
| `test/runtime-v2-shared-basis-publication-guards.test.mjs` | hit material | ENOENT：缺少生成的 `skills/demo/skill-ground-truth.json`；生成失败原因未知。 | F:1002 / A:992 |
| 同上 | hit user | 同上。 | F:1012 / A:1002 |
| 同上 | hit cancel | 同上。 | F:1022 / A:1012 |
| 同上 | hit deadline | 同上。 | F:1032 / A:1022 |
| 同上 | hit baseline | 同上。 | F:1042 / A:1032 |
| 同上 | hit revision | 同上。 | F:1052 / A:1042 |
| 同上 | miss and cache-hit publication preserve source, cancellation, deadline, baseline and revision guards | `6 subtests failed`，是上述六个 hit 子测试的**父级聚合**，不是第七个独立根因。 | F:1062 / A:1052 |
| `test/runtime-v2-shared-basis-publication.test.mjs` | legacy already-PASS Skill adoption is recovered before the first shared certificate | `certificate.sources.some(source => source.ref === f.skillFile)` 为假；证书包含断言不符，是否路径规范化/旧断言/缺图未知。 | F:1098 / A:1087 |
| 同上 | new real user identity, material bytes, PROJECT_FILE appearance and adopted Skill changes cause real bounded misses | `cert.sources` 未含严格等于 `f.skillFile` 的 ref；原因未确认。 | F:1126 / A:1115 |
| `test/runtime-v2-shared-basis.test.mjs` | legitimate new USER plus MATERIAL NEW_TASK publishes both sources and their matching formal certificate | `BASELINE_SCHEMA_INVALID`：`exclude.units` / `sourceFrom.unitId` 不符合 `S…L…` 格式；字段协议/测试数据不符，具体生成原因未知。 | F:1250 / A:1239 |
| 同上 | new formal source certificate survives rolling close and retains the whole original without covering new Skill material | 严格相等断言 `0 !== 1`；仅凭日志不能定为旧断言错误。 | F:1362 / A:1351 |
| `test/synthetic-key-recovery.test.mjs` | offline host double verifies fresh limits, no old-deadline reuse, env-only auth and redacted output | `manifest.sourceHashes[runner.replace(process.cwd() + path.sep, '')]` 为假；清单键/路径断言不符，根因未确认。 | F:2382 / A:2482 |
| `test/swebench-lite-workspace.test.mjs` | actual exported patch applies staged/unstaged/new/binary/doc changes, excludes RC metadata and preserves original index | ENOENT：读取含换行的 `new file⏎with newline.py`；该 fixture 路径文件缺失现象明确，创建/平台原因未确认。 | F:2505 / A:2603 |

计数：10 Windows symlink + 1 S1L2 + 18 其他（含聚合 1）= **29 条原同名失败 / 28 个原同名叶子失败**。不能用“非本次新增”代替对未解决缺陷的如实列示。

### 上一轮新增 1 条：test-only 修正已获最终全量确认

| 文件 | 完整测试名 | 上一轮 R 的事实 | 修正与最终确认 |
| --- | --- | --- | --- |
| `test/runtime-v2-shared-basis.test.mjs` | closed live006 Mixed NEW_TASK repairs its field before formal publication without consuming an empty delta | R:1243，期望实际原候选进入 formal admission 的数量 2，实际 0；紧邻诊断 `Missing expected rejection`。上一轮 comparison 将其列为唯一新增失败。 | B1 复用原生会话后 cwd 保持首任务；旧夹具却用 `params.cwd/../candidates-0` 读取当前候选。`1feca20` **只改测试夹具**：用 onPrepared 的当前 requestId 映射绑定 requestDirectory/sourceRoot，再按当前 generation 检查候选/finish；仍断言 reused cwd 与当前 sourceRoot 不同、requestId 一致，未回滚生产复用行为。Q 为 18 项中 16 通过、仅两个原有失败；F 的本用例也实际通过，最终 comparison `added: []`，新增失败确认消除。 |

## 审查后补修

对 `1d19d9b` 的审查确认了两项实际缺陷，另有两项 UNVERIFIED 行为按用户决定调整。这些改动都不涉及 MA、OpenClaw 安装目录或个人配置。

- **Windows 小写 `skill.md`**：原实现只有 `selectedSkillRead` 接受这个别名。磁盘上实际为小写的文件，在 `resolveSkillDirectory` 校验身份时就因文件名不等于 `SKILL.md` 返回 null，之后又被扫描阶段要求精确 `SKILL.md` 的检查拒绝。结果是该 Skill 读取事件得到 `SKILL_SOURCE_UNRESOLVED`，原文无法进入 watcher 和 Stop。现在由 `skill-source.mjs` 的 `isSkillFileName` 统一判断文件名（win32 不区分大小写，POSIX 仍要求精确 `SKILL.md`），扫描结果把根目录下的别名记为规范名 `SKILL.md`，因此规则图、M08 和工作区 Stop 按原名引用即可。`sourceIdentity.path` 仍保存磁盘上的真实路径，内容变化依旧报 `SKILL_SOURCE_STALE`。目录中同时存在精确名和别名时，优先采用精确名。新增 `openclaw-skill-sources` 用例，覆盖识别、身份解析、带身份扫描和图绑定；POSIX 上只做文件名判断，其余部分跳过并注明原因。
- **E2 遗漏 `examples/`**：`.gitattributes` 新增 `examples/** text eol=lf`，并保留 5 个原始问题陈述的 `-text` 逐字节规则。重新规范化后，索引内容不变，工作区重新检出为 LF。`openclaw-document-e2e` 从 7/9 恢复为 9/9。
- **D2 文档覆盖 UNVERIFIED**：Stop 不再提前短路，审查照常执行。结束后若覆盖仍为 UNVERIFIED，PASS 会被撤销为 UNVERIFIED（`DOCUMENT_EXECUTION_UNVERIFIED`，并写入 `STOP_VERIFICATION_INVALIDATED` 审计）；其他结论保持原状，另附一条 UNVERIFIED 说明。`production-stop` 的整次评估复用仍要求覆盖已核实；本次被降级的 PASS 记录的复用依据为空，以后也无法被复用。逐项 PASS 缓存本来就绑定审查员读取文件的内容指纹，脚本改过的文件不会命中。
- **Onboarding 待定义务**：Stop 不再在准备阶段抛出 `ONBOARDING_OPERATIONS_UNVERIFIED`，审查照常执行。结果中的 `unverifiedObligations` 完整列出待定原义务，反馈中最多逐条展示 20 条；整体结论不得为 PASS，PASS 按 D2 同样方式撤销。两项同时存在时，`unverifiedBasis` 会同时列出。
- **测试调整**：`stop-production-entry` 新增两项，用脚本化审查员实际产出 PASS，验证审查仍运行、PASS 被封顶、旧 PASS 不复用。`ma-document-adaptation` 中关闭 Stop 审查的用例，改为断言不得出现 PASS 并附带单列说明。`onboarding-adaptation` 的两项改为断言 Stop 进入审查准备并逐条列出待定义务；该夹具没有 OpenClaw 宿主，原生审查员会在宿主定位处失败，因此仍为 UNVERIFIED。

| 补修验证（工作区未提交改动，基于 `1d19d9b`） | 日志 | 总 / 通过 / 失败 / 跳过 / 超时及相对新增 |
| --- | --- | --- |
| 默认全量 | `regression-review-fix-default-en.log` | **2899 / 2563 / 277 / 59 / 0；相对 `final-default-verified` 新增 0，消失 2** |
| 宿主全量 | `regression-review-fix-host.log` | **2899 / 2835 / 27 / 37 / 0；相对 `final-host-verified` 新增 0，消失 2** |

消失的两项都是 `openclaw-document-e2e` 的原始来源 SHA-256 断言。两次全量都设置了 `LANG=en_US.UTF-8`，与原门禁的语言环境一致。宿主全量的 `RC_OPENCLAW_HOST_ROOT` 指向 MA 内置的 `resources/openclaw`，运行前后其文件数和最新修改时间不变。三端构建和产物测试 17/17 通过。

不设置 `LANG`、`LC_ALL`、`LC_MESSAGES` 时，RC 默认输出中文提示。此时 `shadow-fail-open` 的 1 项和 `stop-gate-escape` 的 2 项会因为按英文匹配而失败，HEAD 代码也同样失败，与本次补修无关。这次运行结果保留在 `regression-review-fix-default.log`（2899 / 2560 / 280 / 59）。

## 覆盖与用户验收边界

原始 MATERIAL 默认最多 16 根、100 文件、1000 目录项、合计 4 MiB/2 秒，并受热钩子剩余时间约束；声明文档限额见各分支。这两类范围超限、缺失、未知进程或原始权威失效保持可见 UNVERIFIED。Skill 发现也有目录/层数边界，超限条目不作为已识别原文，不能据此宣称完整清单覆盖。部分来源或恢复后的哈希不能当成全局 PASS。新模块均已列入 allowlist，三端产物测试不能替代真实 MA 使用验收。

完整分支命令在六 worktree 的 `.runtime-correction/ma-branch-report.md`；本次摘要的输入为主忽略目录 `.runtime-correction/ma-combination/{branch-report-draft,integration-report-draft,late-runtime-report,late-runtime-test-split-report}.md`、`skill-installed-probe.json`。最终公开结论须与主分支实际 head 和日志一致；日志本身不作为运行时安装文件。

## 由用户执行的安装、验收与回滚

1. 完全退出 MA 及其 OpenClaw gateway，备份当前 RC 扩展整个目录、实际生效的 `openclaw.json` 和项目 RC 配置，记录真实注册路径。默认扩展位置可能为 `%USERPROFILE%\.openclaw\extensions\runtime-corrector`，以当前注册为准。
2. 在 RC 仓库使用目标宿主支持的 Node 运行 `npm run build:plugins`、`npm run test:artifacts`。将 `dist/runtime-corrector-openclaw/` 的完整内容手动替换到已备份的现有 RC 扩展位置，不增加额外 dist 层，不覆盖 MA 自带 OpenClaw 或其他插件，也不在 MA 目录安装开发依赖。
3. 重启 MA 并确认 RC 加载，保留已有注册配置。需要初始化 RC 的模型、超时、Hook 权限和主 Agent 工具授权时，在可信管理员会话显式发送 `/rc-setup`；该流程不修改 MCC 的 `bypassSessionPatterns`。核对初始化结果及 warnings，按其重载提示操作。不要执行 `scripts/configure-ma-host.mjs`。
4. 在新的小项目会话串联原始基线、声明文档脚本写入、实际 Skill 读取和 Stop；核对来源身份、文档覆盖、待处理义务和最终结论。再验 autopilot 排队、UNKNOWN 警告、重启、取消与安全解除；任何未验证依据和未知宿主终态都应保留，不得显示已完成。

回滚前先在控制页暂停或禁用本次 RC 会话的自动调度，并备份运行状态，避免旧版本恢复待办后自行续作。未知宿主终态先核对，不重发。随后完全退出 MA/gateway，恢复备份的 RC 扩展整个目录和实际配置；调用过 setup 的同时核对其原始备份。重启确认旧版本加载，再用新测试会话验证。保留审计与排队历史，不通过删状态回滚；产物/配置回滚不会撤销已发生的业务文件修改。
