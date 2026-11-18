# 维护与验证

源码在 `lib/`；`scripts/` 保留 CLI、宿主事件入口、构建及 MA 配置工具。`config/`、`knowledge/`、`specs/`、`templates/`、`skills/`、`commands/` 及 `packaging/` 包含运行资源，修改后需同步检查产物。

开发环境使用 Node 24.16 或兼容的更高版本；Claude/CodeAgent 的基础兼容性仍在 Node 18 验证。原生 reviewer 的独立开发依赖通过 `npm ci --prefix lib/review-task --ignore-scripts` 安装，保留精确版本及锁文件。

```sh
npm run build:plugins
npm run test:artifacts
npm test
```

测试入口只发现 `test/*.test.mjs`，最多并行运行四个独立文件。每个文件默认最多运行 90 秒，超时终止所属进程树、记录失败并继续其他文件；断言失败和中断均返回非零退出码。需要调整单次验证上限时使用 `npm test -- --file-timeout-ms 120000`，不得把超时当成跳过或通过。CI 另有 15 分钟作业上限。

测试使用本地脚本和受控 reviewer，不调用真实模型。安装宿主契约测试可通过 `RC_OPENCLAW_HOST_ROOT`、`RC_MA_HOST_ROOT`、`RC_MA_ROOT` 指向已安装包；未提供时相关测试跳过。宿主包只读，禁止为通过测试改写安装目录。

命令式宿主的 SessionEnd 只为尚未结束的标准输入保留 100ms 等待；收到 EOF 后先关闭输入看门狗，再加载解析器并写入生命周期日志。它不约束已收到完整输入后的解析和日志写入，也不保证任意资源争抢下的 shell/Node 启动耗时。进程回归保留原有 1200ms 壁钟断言；OpenClaw 原生会话结束直接调用宿主进程内的处理函数，不经过此启动脚本。

库模块必须逐文件列入 `packaging/runtime-modules.json` 的 common 或对应宿主列表；目录位置和 `.mjs` 扩展名不构成准入。新增被入口引用的模块时，更新清单并验证本地依赖闭包；新增未引用的诊断脚本应留在开发工具范围，不能加入运行清单。其他资源使用 `lib/plugin-builder.mjs` 的固定清单。宿主 manifest、active-host、命令和 skills 在构建时生成。

产物检查覆盖各宿主入口、静态本地依赖、资源、锁文件、禁止目录，以及直接放入各运行库目录的未列入清单 `.mjs`。运行模块和资源的清单变化必须与相关产物断言一起审查。

CI 在 Windows、Linux、macOS 验证基础 Hook 兼容与完整套件，并在标签发布时生成三种宿主压缩包。运行记录、实验、依赖安装和 `dist/` 属于本地产物，不应跟踪；关键故障应固化为小型行为回归。

真实模型准确性、完整桌面长时续作、进程重启恢复和分组性能仍需单独验收，不能由离线测试推导。版本兼容、产品限制与迁移规则直接维护在正式宿主和配置文档中。

## SWE-ArkTS-Bench 验证

[SWE-ArkTS-Bench](https://github.com/SELab-Leibniz/swe-arkts-bench) 的 13 个任务组成固定评测范围。正式整任务比较使用两组全新运行，A 组使用固定版本的 OpenClaw 和同一 OpenSpec 流程，B 组在完全相同的配置上打开候选 RC。固定任务字节、起始文件树、宿主及 OpenSpec 版本、主模型、工具、公共验证条件和总预算；记录 RC 使用的评审模型和额外请求。建议每题每组预先固定三轮，并交替执行组顺序。中断、缺失和恢复尝试保留原身份；历史 39 轮可作诊断参考。

1. **离线准备。** 用 `scripts/bench/arkts-dataset.mjs` 校验固定任务、测试 ID 和补丁摘要。求解器与 reviewer 接收公开任务字段、起始项目和两组共有的公共验证工具。黄金补丁、隐藏测试、历史候选及评分轨迹留在独立评估环境。按任务校准原始版本与黄金版本，保留完整测试输出和分母。
2. **运行与评分。** 使用下方配对入口记录 OpenSpec 完成状态、OpenClaw 真实终态、RC 检测及实际修复回执。两组使用同一个 OpenSpec(solo) 规划和 Apply 流程，在归档前封存候选。候选组的默认 ArkTS 配置在 Stop 重跑任务起始时的公共测试，为退化和复验提供证据。只有新鲜的 OpenSpec status、严格校验和 Apply 进度支持交付，才计为流程完成。冻结业务补丁后交给同一个独立评分器运行 `FAIL_TO_PASS` 和 `PASS_TO_PASS`。能取得首个纠偏前候选时，为它和最终候选分别保存摘要并离线评分。隐藏评分结果仅用于运行结束后的诊断。
3. **判断效果。** 以计划的 13 题及全部轮次报告整题通过率、F2P/P2P、真实完成及评分覆盖、未验证和基础设施失败。逐题列出改善与退化；汇报纠偏前后分数、误干预、漏检、额外 token 与墙钟。先核对正式配对与证据，再判断整题通过率是否改善，且已保留行为有无新增回归。分别报告 RC 内部判决、宿主完成和独立评分。专项回放只评估检测与定位能力。

```sh
node scripts/run-arkts-paired-campaign.mjs --plan --dataset=<evaluator-dataset> --output=<new-campaign-directory>
node scripts/run-arkts-paired-campaign.mjs --check-environment --tool-root=<Huawei CLT> --java-home=<JBR> --openclaw-profile=<profile>
node scripts/calibrate-arkts-batch.mjs --help
node scripts/run-arkts-paired-campaign.mjs --help
```

`--plan` 生成任务和公开输入的哈希以及交替顺序，默认 13 题 × 3 轮 × 2 组。先运行 `calibrate-arkts-batch.mjs --pin-toolchain`，串行校准各题的基础版本与黄金版本并预备精确版本的 Git 缓存。固定工具链文件的实测摘要进入评估凭据。将批量校准的输出目录传入 `--calibrations`，每题需有 `results.json`、`base-coverage.log`、`gold-coverage.log`。在候选包 `release.json` 所指的干净源码提交上以 `--preflight` 核对校准、固定宿主、流程和工具链，然后使用同一组输入运行 `--live`。候选评分前会核对实测摘要。启动一对试验前须为两组各预留完整的求解和评分窗口。

校准前可运行 `--check-environment` 检查本机工具链和模型配置。该命令检查所选模型和端点格式，以只读方式核对 OpenClaw 凭据数据库的表结构和主记录是否存在，且只查询元数据。数据库无法读取或结构不完整时，模型状态为 `AUTH_STORE_INVALID`。结构检查通过后，正式运行仍须验证凭据和连接。校准只依赖工具链。

- macOS arm64 使用原生 Huawei Command Line Tools、API26 SDK 和 DevEco JBR。该平台的评测使用独立校准。两组及评分器绑定同一套实测工具，记录 CLT、SDK 和 Hvigor 的实际版本。校准前验证 Previewer 和其动态链接扩展的代码签名。可用 `--openspec-cli` 指向官方 OpenSpec 1.4.1 的 `bin/openspec.js`，并将历史归档中与原摘要一致的 `cli/workflow.source.yaml` 复制为 `--workflow-root` 下的 `workflow.yaml`。仍使用相同阶段提示和严格检查。该入口以 `official-openspec` 记录来源。
- Windows x64 支持原 Huawei Command Line Tools 6.1.1.280、SDK API24 / 6.1.1.125 和 Hvigor 6.24.2。供应原 MatrixAssistant 配套目录时，工作流来源记录为 `matrixassistant`。

可以在 macOS 上运行 OpenClaw、OpenSpec、依赖准备和构建，把 Local Test 或 Instrument Test 交给独立的公测 worker 和隐藏评分 worker。两个 worker 使用相同的测试后端和工具链指纹，分别从受信任的控制端读取自己的交换目录。三端使用相同的冻结源码提交并保持系统时钟同步。公测 worker 不挂载隐藏评分的目录；隐藏评分 worker 无需模型凭据。将工作树和完整评分产物放在交换目录之外。

```sh
node scripts/run-arkts-public-test-worker.mjs --help
node scripts/run-arkts-grading-worker.mjs --help
node scripts/run-arkts-public-worker-smoke.mjs --help
```

使用 `run-arkts-public-worker-smoke.mjs` 从冻结计划和公开 Git 缓存准备起始源码。`--prepare-only` 核对每题的源码树和公开快照摘要。提供公测交换目录和在 worker 上独立测得的工具链摘要后，同一命令会通过该 worker 配置的后端执行测试，并在新输出目录保存快照摘要、可解析用例的统计和原始公开运行报告。可用 `--cases=security_tool_4` 先检查一题，省略 `--cases` 时覆盖计划全部任务。公开用例失败可与运行成功同时报告。这项检查无需模型配置或私有评分文件，正式配对仍按独立评分计算。

接入新的原生 worker 时，可在该命令加 `--public-acceptance` 实测已注册探针，也可用 `--probe-manifest` 和 `--probe-manifest-sha256` 加载固定公开计划下的候选探针。两者可用于同一次运行，单题只接受一份定义。命令先运行原始公测，再在单独快照运行探针，保存各自的快照摘要和报告。候选探针的逐项结果须符合清单中固定的初始版本预期；结果缺失、不完整或不匹配会使此次检查未完成。初始版本匹配后，仍需在已审查的修复版本验证相同探针，再考虑注册到正式评测。

HappyWord 13 可用独立源码重放核对实际发出的请求。以 `manifest` 检查预览清单，以 `pack` 检查手动下载。输入是原始公开任务文件、已审查的公开源码目录，以及核验者事先记录的源码摘要。摘要文件是由文件名映射到 SHA-256 的 JSON 对象。预览清单需要 `RemoteWordPackConfig.ets` 和 `PreviewManifestService.ets`。下载需要 `RemoteWordPackConfig.ets`、`BackendEnv.ets`、`BackendHeaders.ets`、`RemoteWordPackService.ets`、`WordPackCache.ets` 和 `WordPackSyncService.ets`。

```sh
node scripts/evaluate-happyword-request-routes.mjs \
  --project "$snapshot" --tool-root "$tools" --public-input "$public_task" \
  --route manifest --source-manifest "$reviewed_source_hashes"
```

重放使用安装的 Huawei TypeScript 编译器和记录请求的 HTTP 替身，输出六种配置的实际请求与预期结果。退出码 0 表示通过，1 表示请求目标不符合预期，2 表示源码或执行待核验。结果作为开发诊断记录。正式配对使用各自固定的原生公测和独立评分条件。

以 `--positive-manifest` 和 `--positive-manifest-sha256` 指定已审查的公开修复对照。清单的 `kind` 为 `arkts-public-positive-controls-v1`，`planSha256` 为同一公开计划摘要，`controls` 以任务 ID 为键，每项给出相对清单的 `file`、原始 `baseCommit` 和 `patchSha256`。补丁只可修改 `entry/src/main/` 中常规文件的内容，故原始测试和探针均由协调端按同一固定输入准备。修复补丁在独立的临时 Git 库中应用，并使用与正式模型运行分开的公测交换目录。初始版本至少有一个探针用例失败，修复版本的同一探针全部通过，且两个运行快照不同，该对照才标为 `BASE_AND_POSITIVE_MATCHED`。回归结果和正式评分仍以独立校验为准。

先在可信环境用 `--plan` 创建评测目录并记录输出的 `planSha256`。只把该目录的 `plan.json` 和 `public/` 交给控制端。在评分机上运行上述批量校准，然后启动两个 worker。在控制端的 `--preflight` 和 `--live` 中，用 `--plan-sha256`、`--public-test-exchange` 和 `--grading-exchange` 代替 `--dataset`、`--calibrations` 和 `--grade-workspace-root`。控制端仍提供本机构建使用的 `--tool-root` 和 `--java-home`。预检验证 13 题的原始校准和 worker 指纹。公开的起始测试、`bench_check(test)` 和 Stop 复验使用同一个公测入口。隐藏评分收取哈希绑定的冻结业务补丁，仅返回聚合结果。每个已领取的请求最多执行一次；评分 worker 重启后需要重新预检。评测结束后可清理交换目录，完整隐藏日志仍保留在评分机上。

macOS arm64 可使用 HarmonyOS Instrument Test。本机运行时，在校准和评测入口同时传入 `--instrument-config`。分离运行时，在评分端校准命令和两个 worker 的启动命令传入各自本地的 `--instrument-config`，并为公测 worker 额外提供 `--json5-package`。评分 worker 已要求该参数。配置文件放在交换目录之外，控制端仍使用上述分离运行参数。预检核对两个 worker 的测试后端和工具链指纹。

可在 `--preflight` 省略 `--openclaw-profile`，先核对计划、工作流、工具链和评分校准。输出的模型状态为 `PROFILE_MISSING`。正式运行 `--live` 时需配置模型。

该 JSON 含绝对 `hdc` 路径、回环 `server`，以及 `cases` 中逐题固定的回环 `target` 和 `appBuildMode`（`test` 或 `debug`）。使用专用 API24 模拟器，并按应用与测试清单声明的设备类型选择实例。运行器在临时副本中加载原始 Local Test 测试入口。每题均须验证 base/gold 的完整汇总、测试 ID、套件文件摘要和设备身份。两组公开测试和隐藏评分绑定相同的准备方式与设备。本机可用 `--plan --pilot-cases=<IDs> --repetitions=1` 先做 30 分钟等预算演练，正式计划仍默认覆盖 13 题。

十个 PC 任务的 Instrument Test 路由需要 API24 的 `2in1` 目标。华为的 Windows x86 和 macOS arm64 模拟器在中国大陆提供该设备类型。缺少适用目标时，可用独立的 Windows x64 Local Test worker 校准并执行这十题。原版和黄金版的原生运行回执用于确认该路由。[华为模拟器支持的设备](https://developer.huawei.com/consumer/en/doc/harmonyos-guides/ide-emulator-devicetype)

在 `--preflight` 和 `--live` 同时加上 `--public-acceptance` 可启用已注册的公开需求探针。两组都可调用 `bench_check` 的 `acceptance`，RC 开启组的 Stop 也读取同一探针凭据。评测记录锁定公开题面、探针字节和用例 ID。原始公开回归结果、需求探针和独立隐藏评分各自保留。探针失败时，只有能绑定原始需求和当前实现的具体偏差才能派发修正。

候选探针先用同一发行版、计划和原生公测工具链运行 `run-arkts-public-worker-smoke.mjs`。提供候选探针清单和正向对照清单及其摘要，保留 `report.json` 和每题的编译、测试日志。每个候选探针须在起始版本复现清单中预期的失败，并在仅修改应用生产源码的正向对照上全部通过。

在配对命令的 `--preflight`、`--live` 和 `--resume` 中，使用同一组参数加入已验证的候选探针。两个试验组收到同一题的探针字节和精确用例 ID。试验目录的 `public-acceptance/` 存有当次探针和描述文件，供合并报告重新核对。正向对照补丁和私有评分材料保留在各自的验证入口。

候选探针条目可包含 `requirementBindings`，每项使用探针内的 `testId` 和题面的原文 `quote`。将经审查的绑定写入清单，再用固定的清单摘要进行原生验证。启用绑定时，失败回执只能支持匹配的原文义务，并须有当前生产源码确认同一偏差。未绑定的失败用于诊断。两个试验组的身份摘要包含同一组绑定。

```sh
--public-acceptance \
--qualification-report="$qualification/report.json" --qualification-report-sha256="$qualification_hash" \
--probe-manifest="$public_probe_manifest" --probe-manifest-sha256="$public_probe_hash" \
--positive-manifest="$public_positive_manifest" --positive-manifest-sha256="$public_positive_hash"
```

Stop 确认任务完成后，若有固定探针且本次审查无适用的既有行为回归项，ArkTS 组合运行器只执行需求探针。结果将回归项记录为 `NOT_APPLICABLE`。探针字节、工作区摘要、运行器路由、用例和退出码均需匹配，完整结果才可复用。回归项适用时仍执行原始套件与需求探针。

两个检查均适用时，先在独立进程运行固定探针，最多使用当时剩余验证窗口的一半。原始回归套件使用同一个截止时间下的剩余时间。回归报告必须完整读完，并包含唯一且完整的失败清单。单项超时或没有完整报告时，已完成且身份可核对的另一项仍可用于审查。工作区或运行器路由在验证过程中变化会使结果不可用，部分结果不进入合并缓存。

两组都按同一规则推进 OpenSpec。计划文件齐全、实施任务均未勾选且严格校验报告明确错误时，可在原时间预算内修正计划一次。重新通过严格校验且任务清单和业务补丁保持一致后才进入实施。原始检查与修正回合均保留在结果中。

两组的 Apply 均可在原时间预算内恢复一次已证实的模型连接中断。控制器核对原业务回合的终态、活跃会话的错误记录及工具收据、模型调用与传输的跟踪摘要，并验证当前 OpenSpec 计划、任务文字和策略。恢复沿用同一个会话及工作区。评分仍要求新终态、严格验证和 Apply 进度齐全。原回合和恢复回合均保留，恢复不会计入 Stop 纠偏。

RC 开启组在 Proposal 通过后固定任务清单。Apply 和原生 Stop 都结算后，如果核实任务清单被改写且其余工作流文件及策略保持一致，控制器在原会话中发送一次内部 Apply 续修。续修按原清单逐项核实并标记进度。最终评分仍要求严格验证、保留原清单和工作流范围，并完成 Apply。续修单独记录在业务结果的 `openSpec.applyChecklistCorrection`，请求计入 Apply。

两组都在进入 Apply 前保留已批准的工作流检查点，并在 Apply 和原生 Stop 结算后核对同一会话的最终检查点。核验覆盖提案、设计、规范、工作流文件和评审策略。任务清单仅允许 OpenSpec 实际识别的复选框进度更新。已证实的变化记为 `OPENSPEC_APPLY_WORKFLOW_CHANGED`，缺少可核对的检查点记为 `OPENSPEC_APPLY_WORKFLOW_UNVERIFIED`。两类结果均保留流程状态，暂缓独立评分。

若只有部分任务需要独立 worker，可在 `--plan` 使用 `--cases=<逗号分隔的任务 ID>`，并在评分端用相同的任务 ID 校准。两组仍使用正式运行的相同时间窗口。结果标记为 `BENCHMARK_SUBSET` 并记录实际任务列表。默认计划仍覆盖 13 题，设备演练仍使用 `--pilot-cases`。

macOS 配对运行会识别原始 `AGENTS.md` 明确要求的 HAP 构建后 CodeLinter 检查。两组都可用 `bench_check` 的 `lint` 操作，并在结束时对当前源码验证该检查。运行器记录新生成的 HAP、固定配置和同一源码快照的 lint 结果。`--fix` 只在临时副本运行，若产生修改，需修正正式源码后重新检查。CLI 报告与底层扫描证据不符时，结果为未验证。

正式运行可加 `--max-pairs=1`，让本次调用至多完成一个完整配对，保留原计划、两组时限与评分口径。若达到上限且仍有未启动的配对，结果为 `PAIR_LIMIT_REACHED`。上限记录在本次 `invocations/<编号>/start.json` 中，续跑可以指定新的上限。

当 `summary.json` 显示 `PAIR_LIMIT_REACHED`、`INSUFFICIENT_PAIR_WINDOW`，或显示 `CANCELLED` 且已启动的配对全部结算、仍有未启动的配对时，使用原评测目录和相同的冻结输入，传入新的 `--deadline-at` 及 `--resume` 继续下一对。每次调用在 `invocations/` 中保留独立结果。续跑会核对已有试验收据和输入摘要。异常退出或存在未结算的试验时，先核查宿主、工具和收据状态。

重启远程评分 worker 时可沿用原私有 `--output-root`，从中读取已协商的逐题校准摘要。评分前仍要重新核对数据集、工具链及校准产物。若改用其他输出目录，先通过预检重新协商校准。

两组求解只读取哈希绑定的公开任务文件，关闭组不加载 RC。`--workspace-root` 和 `--grade-workspace-root` 分别指向不同的短路径，并将校准的 `--workspace-root` 设置为评估工作树路径。`workspace.patch` 保留 OpenSpec 变更，独立 grader 封存并核对排除工作流文件的 `candidate.patch` 的哈希后评分。不同准备树、工具链、工作流或提供器身份的结果单列；缺失评分和未尝试序号保留在计划分母内。

`arms.*.workflow` 记录工作流完成、未完成和已知原因。`comparison` 记录计划对数、缺失评分或身份不一致的对数，以及身份一致且两边均评分的对。通过率转移和 `matchedUsage` 使用身份一致的已评分配对。`workflow` 对所有两组均已尝试的配对报告已结算的工作流完成情况，超时、基础设施失败或收据不全的配对记为 `unavailable`。`attemptedUsage` 包括两组都有实测数据的配对，即使某组未获得评分。耗时和模型请求数分别报告覆盖对数。

`arms.*.observedUsage` 汇总每组已尝试试验中的请求数、耗时、分阶段请求数和 token 用量。即使另一组缺少收据，本组可核实的用量仍计入。`measuredTrials` 和 `missingTrials` 以该组已尝试试验为分母。`sum` 只汇总实测值。没有实测值时为 `null`，实测总和为零时记录为 `0`。

合并报告从封存的业务收据核对请求数、耗时、阶段用量及结束原因。旧记录缺少原始字段时，不用逐槽摘要推算该项。`comparison.tokenUsage` 对文档审查、Stop 审查、业务阶段和总用量分别报告覆盖配对数。只有两组在相应阶段的请求都有完整用量凭据时，该阶段才纳入统计；总用量要求所有阶段齐全。

`scoreChanges` 按任务和轮次报告匹配配对的 F2P、P2P 通过数变化和相同分母。两组均未解决任务时仍可观察到分数变动。通过总数相同的配对也可能同时有新通过和新失败的用例。

分片完成后，或在至少一个完整配对已结算且状态为 `PAIR_LIMIT_REACHED` 或 `INSUFFICIENT_PAIR_WINDOW` 时，可在私有评分端读取已封存的分片归档并汇总逐用例变化。报告记录分片状态，以及全分片和逐题的计划配对数、已结算配对数、匹配评分配对数及已核对逐用例变化的配对数。已结算但 Apply 未完成的配对仍计入结算数。远程评分时须指定该分片评分 worker 的私有 `--output-root`。命令核对评分报告、测试输出和候选补丁的摘要，只输出通过和失败之间的变化数量。请求数、时间和 token 用量只按两组均有实测数据的配对汇总。隐藏用例名称留在评分端，找不到对应原始评分的配对记为未验证。

```sh
node scripts/report-arkts-grade-transitions.mjs \
  --directory=<settled-shard-directory> --plan-sha256=<digest> \
  --release=<release.json> --grader-output=<private-worker-output-root>
```

`bothResolvedUsage` 汇总两组均通过独立评分的配对开销。`requestBreakdown` 在同样的配对范围内列出文档评审、Stop 评审和其余请求。只有两组的分类数量均与各自的请求总数一致时，该配对才计入分类统计。

The request attribution report reads a settled shard’s public business receipts and passive provider timing. It can include an attempted arm that never reached independent grading.

```sh
node scripts/report-arkts-review-requests.mjs \
  --directory=<settled-shard-directory> --plan-sha256=<digest> --release=<release.json>
```

Keep `business/result.json` and `business/native-host/provider-fetch-timing.jsonl` for each attempted arm. The report verifies the plan, release, and durable business receipt and records a hash of the local timing file. It matches wire requests to trusted OpenClaw calls and reports the request owner and observed workflow stage. Several wire attempts can belong to one model call. Missing or ambiguous trace evidence increments the unknown count. The report uses provider request counts and leaves independent grades, tokens, and billing to their own receipts.

PC 与手机分片结束后，用原始全量计划合并两边的标准配对记录。两边须使用同一发行包、OpenClaw 与 OpenSpec 工作流、业务模型、评审模型和 RC 策略。设备、构建、测试校准和各题验收探针沿用各分片的固定身份。保留 `execution.json`、`invocations/`、`observations/`、`summary.json` 和每个已评分试验的 `business/result.json` 与 `business/freeze/candidate.patch`。每个新评分试验还在试验目录保留 `grading-evidence.json`，其哈希写入逐槽结果，并将聚合分数绑定到所选评分尝试和冻结候选。

```sh
node scripts/summarize-arkts-paired-cohort.mjs \
  --master=<full-plan-directory> --master-plan-sha256=<digest> \
  --pc=<pc-campaign-directory> --pc-plan-sha256=<digest> \
  --phones=<phone-campaign-directory> --phones-plan-sha256=<digest> \
  --release=<release.json>
```

合并器只读取计划和已结算记录。它核对终结摘要、逐槽收据及业务补丁，按全量计划顺序重新计算统计。本机评分还核对所选评分目录 `grading/` 或 `grading-retry/` 中归档的 `results.json`、`candidate-coverage.log` 与 `candidate.patch`。独立 worker 模式使用归档中的脱敏回执，核对聚合分数与 worker 提供的评分产物摘要。合并时仅需分片归档，原交换目录可以清理，隐藏测试细节留在评分端。校验范围限于归档回执的一致性。

未启动、未封存和已封存但未评分的试验分别保留。缺少评分证据回执的旧评分记录标记为 `LEGACY_UNSEALED_GRADE`，保留供诊断，排除在正式配对计数之外。所有计划配对均有匹配的独立评分后才公布整项 pass@1。

分片全部试验结束后，可对有独立原生续修运行及其启动回执、且最终补丁已独立评分的试验补评首个续修前的补丁。命令核对运行、准备版本和补丁哈希，通过私有评分 worker 查询同一校准及工具链，在单独的时间窗内评分。结果写入新的诊断目录。

```sh
node scripts/grade-arkts-correction-checkpoints.mjs \
  --directory=<completed-shard> --plan-sha256=<shard-hash> \
  --release=<release.json> --exchange=<private-grading-exchange> \
  --output=<new-diagnostic-directory> --deadline-at=<absolute-unix-milliseconds>
```

诊断报告包含首个实际续修前后的独立 F2P、P2P 和整题评分，以及证据缺失的原因。前后补丁哈希相同的试验使用同一份已验证独立评分。即使通过总数相同，也可在私有评分端用下方 `--compare-grades` 核对具体用例的变化。

独立评分核对校准的原始提交、数据文件和测试补丁哈希。私有评分的 `testInventory` 保留实际测试集合的哈希、额外测试数和额外失败数，便于核对不同原生运行器的测试覆盖。公布的 F2P 和 P2P 仍使用数据集指定的用例。

RC 开启组的 `correctionEvidence` 仅在原始代码回合、已实际开始的续修和最终回合均可关联时标记为 `eligible`。`before` 固定首轮 Stop 续修前的业务补丁，`corrections[*].finalizedCheckpoint` 固定各续修结束时的业务补丁，`after` 固定最终交付。检查点缺失或身份不符时保留无结论状态。使用该试验的校准目录，把相应检查点的 `file` 和 `sha256` 传给 `calibrate-arkts-bench.mjs --candidate` 和 `--candidate-sha256`，同时传入 `--pin-toolchain`。在独立输出目录完成评分。续修结束时的评分可用于观察该阶段的变化；最终交付评分还反映后续工作区状态。

在私有评分端比较已保存的两个 `results.json`。使用 `correctionEvidence` 中固定的补丁摘要。命令输出每组测试由未通过转为通过、由通过转为未通过和通过状态未变的数量，隐藏用例 ID 留在评分端。两份评分须记录相同的任务、用例、校准目录和固定环境。校准目录引用无法验证历史校准文件的内容。

```sh
node scripts/calibrate-arkts-bench.mjs --compare-grades \
  --before-grade=<before-results.json> --before-patch-sha256=<before-sha256> \
  --after-grade=<after-results.json> --after-patch-sha256=<after-sha256>
```

若续修回合全部结算、证据链完整，但工作流最终未完成，`correctionEvidence` 以 `diagnostic` 保存。此时按原样保留试验的未评分状态。

补丁生成和校验只在独立临时目录内执行 Git，并清除继承的仓库、索引、配置与属性环境；即使 TEMP/TMP 在其他仓库内，也不能借用父仓库或用户换行配置。路径白名单、真实目标核对、原始内容匹配与 `git apply --check` 继续保留。

隔离实验的脚本、观察器、专用验证脚本、报告和原始运行记录只保留在本地，不纳入源码提交或插件运行清单。活动日志以共享读取加观察器目录写入的方式归档，禁止 `cp/copyFile` 复制正在追加的源文件；不复制宿主锁文件或目录链接。Stop 回执须递归读取，并同时确认任务终态、全部本会话回执已结算、私有请求已关闭，原始回复结束或已有一次评估均不足以关闭 Gateway。已保存的原始实验失败不回写为通过。

观察器为每个文件保存尝试次数、失败历史、最终字节数和校验值。EBUSY 等临时失败有限重试，运行结束后重新补采；已经观察过但最终消失的文件也必须登记，不能以旧副本冒充最终版本。最终检查包括 JSONL 格式、工具调用与结果配对、必需会话和每条私有运行记录的原始轨迹。旧元数据缺少路径时，只能按精确宿主会话头恢复归属。无法恢复的文件和私有会话明确标记 `EVIDENCE_INCOMPLETE`。

私有审查的临时请求目录在清理前归档到 `openclaw/review-traces`，记录源与归档校验值及缺失项；复制失败时保留原目录。公开历史观察只是导航信息，不作为宿主工具调用原始回执。审查结论、执行回执和轨迹完整性分别核对，文件复制成功不能代替审查完成。
