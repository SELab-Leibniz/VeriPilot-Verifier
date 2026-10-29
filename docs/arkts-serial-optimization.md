# ArkTS 逐例调优记录（2026-10-30）

当前有效口径更正：原 serial-20261030 是显式 M16-only 诊断，不能代表默认指标评测。用户提供参考配置后，已确认默认开启 M08/M09/M12/M13/M15/M16；在跑第七例按原配置结算，后续转入 serial-default-metrics-20261030，从第一例起按六项默认指标重新补齐全部十三例。原始数据保留，两个口径不混合汇总。

本轮按用户要求逐个执行 13 个样本：真实业务运行 → 独立原生隐藏评分 → 阅读轨迹和源码 → 通用 harness 修复及回归 → 进入下例。目标是全量 F2P、P2P 尽可能达到 95%。所有样本均用于迭代开发，本轮不能宣称未见留出集泛化成绩。

工作分支为 `codex/rc-general-efficiency-bench`。MatrixAssistant、其 OpenClaw、数据集和 Huawei 工具安装只读。实验索引为 `.runtime-correction/system-optimization/serial-20261030/`。按编号 1–13 推进；每次尝试和独立评分各用新目录，保留失败及原始消耗。

## 初始修复与运行协议

- 已合入 `codex/rc-host-natural-completion` 的既有修复：公开业务终态校验、宿主维护运行身份隔离、压缩取消原因识别、真实历史/纠偏额度恢复、批量安装产物核验。
- 相关分组回归 74/74 通过。第一例在拉取 GitHub 源码时出现网络失败，尚无业务模型调用；原始日志保留在 `security_tool_1/calibration/`。
- 发现此前同仓 worktree 的完整 13 例原生校准证据。模型运行通过显式 `--cache` 复用共享源码对象；评分仍核验原始数据摘要及 base/gold 的原生覆盖日志，不重复下载。
- 当前第一轮使用 `glm-5.3-flash` 和冻结候选 `artifacts/round-001/runtime-corrector-openclaw`；业务宿主自然结束、RC 阶段 1800000ms、纠偏额度一次、仅启用 M16。后续如改变协议必须记录，不能混称固定配对比较。
- `scripts/summarize-arkts-iterations.mjs --suite=.runtime-correction/system-optimization/serial-20261030` 汇总全量 45 F2P / 7547 按任务累计 P2P。分别展示首轮和最新轮，不择优；未评分任务保留在全量分母，部分日志不计有效得分，业务/RC 接受数与测试解决数分列。
- 同时展示按测试数加权的通过率、每例等权的宏平均和整例解决/接受率。全量未评分完时，总分母中的比例只是已知通过的下界；已观测通过率另列。95% 判断要求两种口径均达标，不能让大测试集掩盖小样本失败；全部样本完成仍单独检查 `allCasesResolved` / `allCasesAccepted`。

## 恢复

先读实验 `next-step.json`、`summary.json` 与各例 `attempt-*/progress.json`，核对 PID、命令、会话和冻结产物，再续接仍活跃的同一运行。不得因观察超时重新启动。下文已结算样本的 PID/终端仅作为历史身份记录，不能据此重新启动。

每例结束后保存 `attempt-NNN-review.json`，记录原生评分、轨迹问题、源码定位、修复及其回归、下一步。隐藏测试与黄金补丁仅属于独立评分器，不能写入业务输入或下一样本提示。

## security_tool_1

首轮真实结果：F2P 1/1、P2P 611/611，原生评分完整、无解析错误；业务公开终态成功、RC PASS、两个私有角色全部结算。总时长 951327ms；提供方记录 1801034 tokens（含缓存），51 次请求均有正用量记录。该例完成，不代表全量已达 95%。

轨迹发现两项日志存储失败引起与问题无关的源码调查和三次本地测试。新增 `--baseline-local-tests` 在模型启动前执行原始本地测试，保存原始报告；`bench_check` 返回失败 ID、已有失败、新增回归和不再观察到的原始用例。原有失败仍保留为失败，不改变隐藏评分。原生无模型探针验证原始源码为 452 PASS / 2 FAIL；最终业务为 454 PASS / 2 FAIL，新增两项测试通过、无回归、无消失的原始用例，恰是同样两项既有日志失败。

新增用量/总体分母与本地诊断的专项测试通过；合并宿主修复后的完整工程回归为 174 文件 / 1888 用例，1865 pass、23 skip、0 fail。后续仅修改了实验 harness，包含诊断生成工具的相关 21 项测试通过。新增本地诊断测试文件未包含在那次全量计数中。

## security_tool_2（已完成）

原始本地基线 747/747 通过。`attempt-001` 以 `ed8e083` harness 启动，复用 round-001 插件，已实际使用基线功能；owner PID 18436、终端句柄 98858、项目 `.runtime-correction/b/biz-461830b02601`、会话 `b4b07782-5688-4a03-9d8e-5f53f08dd043`。完整输出在实验根 `security_tool_2-attempt-001.log`。

出现一次宿主原生 `Context overflow: estimated context size exceeds safe threshold during tool loop.`；宿主随后自动压缩并继续相同业务 run。`FINALIZING` 此时仍可能有实际模型调用，不得误报整次运行已结束，也不要重启。错误后仍在读取源码，需观察真实外层终态及最终补丁。

轨迹中 20 次原生 read 已返回约 193529 字符，单次最大约 31966 字符，包含大型源码/测试的广泛与重复读取。后续新增可选 `--paged-reads`：用 `bench_read` 替代业务原生 read，默认 120 行、最大 250 行，明确建议先定位符号再读相关范围。使用原有 UTF-8 原文分页，下一游标保留全部源码可达性、路径约束和私有角色隔离。633 行中文文件逐页完整比对、超大请求及目录逃逸的真实生成工具回归通过。当前运行不热改工具；下一次新运行/真实恢复才启用，保留协议差异和此前消耗。

独立阅读公开原始测试还发现 `viewmodel.test.ets` 的 `should keep policy state while refreshing application list` 固化了问题报告要求修改的旧行为。通用提示因此改为保护“无关的”通过行为；允许把直接固化所报缺陷的旧测试改成新需求并解释理由，明确禁止弱化/绕过断言以求通过。原始测试基线是观察证据，不是高于问题报告的规范；正式隐藏评分不变。

该例还暴露了单次流式模型响应持续数分钟时只有响应头/结束记录、无法观察中途活动的问题。被动观察器新增默认 15 秒的字节进度事件，只在收到新数据时记录字节、分块数和耗时，不缓存正文、思考或凭据、不改变请求。真实本地流式响应及已安装宿主传输的无模型测试 7/7 通过；已完成业务的计量规则不变。当前在途运行仍使用它启动时的旧观察器。

首轮在两次上下文溢出、半小时以上调查仍无源码修改后，为应用已验证的 harness 修复而中断。已核验专属 PID 18436 及完整命令、无子进程，再只停止该实验进程；保留全部转录，不伪造宿主成功终态。`capture-arkts-interruption.mjs` 仅允许已死亡 owner，拒绝覆盖既有结果，按真实成功写入回执导出候选和部分用量。原生评分空补丁为 F2P 0/2、P2P 746/746；46 条正用量响应、49 个提供方请求，完整消耗未知。对应封存/归属/不伪造完成的三项回归通过。

新一轮 `attempt-002` 使用 `--baseline-local-tests --paged-reads`，PID 17116、终端 75179、会话 `e87335e1-0da9-4349-a30b-872fa8cf4ada`，从独立原始基准运行。原始本地 747/747 通过，实际业务已使用 `bench_read`；它仍沿用启动时 128000 的容量声明。第一轮结果保留，不能与新一轮混称固定协议公平配对。

继续调查发现隔离宿主为自定义模型统一硬编码了 128000 上下文。[当前 GLM-5.3-Flash 官方文档](https://docs.z.ai/guides/vlm/glm-5.3-flash)标注 1M 上下文与 128K 最大输出。新增显式 `--context-window-tokens`，保留默认值，校验有限整数和边界；新参数进入运行清单和配对协议，不允许跨容量复用基线。后续可用 `--context-window-tokens=1000000` 验证当前实际通道；文档容量不等于已证明代理通道能力，当前运行不热改。输出预算继续 32768，未放宽源码权限、隐藏评分或纠偏额度。

真实宿主的无模型预检 `capacity-million-preflight-001/proof.json` 已确认 Gateway 正常加载插件，公开 `models.list` 返回当前模型 `contextWindow=1000000`，实际模型启动和提供方请求均为 0。这只证明宿主正确接收并使用声明，实际代理处理大上下文的能力仍待真实运行验证。

新增封存与容量改动后的完整工程回归：177 文件 / 1898 用例，1875 pass、23 skip、0 fail、0 timeout，见 `full-regression-iteration2.log`。第二轮轨迹反复把 `A|B` 交给字面量 grep；后续生成工具对这类空结果返回明确的字面检索提示，不把它冒充正则、不推断各替代词不存在。真实生成工具验证字面管道仍正常匹配，目录边界及完整分页不变。

第二轮在第 34 次调用附近仍触发 128000 的上下文保护，尚无源码修改；经验证专属 PID 17116 和无子进程后封存。原生评分仍为 F2P 0/2、P2P 746/746，部分用量和错误原样保留。准备以 1M 沿真实历史续接。

`attempt-003` 在新业务请求之前由严格的原生任务绑定校验拒绝：宿主已分配 scope.taskId，但尚未创建任务状态，封存结果没有 taskId。原转录复制品逐字节一致，没有发出新业务请求。修复保留原 result.json，不覆盖失败证据；单独捕获宿主绑定的 SHA、原结果 SHA、精确身份和项目，恢复时逐一核验。缺少证明、任一原文或身份变化均拒绝；原有目标冲突和 inactive 防护不变。相关身份、额度、继承范围和封存回归 12/12 通过。

`attempt-004` 成功恢复了同一真实会话及工作目录，原始 97 条转录未变，原 Stop 额度账本 used=0 按原字节复制（budgetReset=false），原生任务绑定也按原字节恢复。实际配置容量 1000000；历史 PID 31316、终端 97367、会话为 `e87335e1-0da9-4349-a30b-872fa8cf4ada`。该运行已结算，保留这些身份供审计，不重新启动。

`attempt-004` 已正常结算：业务公开终态成功、RC PASS、三次私有运行全部 SETTLED。原始问题的完整功能要求保留在 M16 审查清单中，包含服务器快照应用/记录更新、保留已加载 3D 详情、选中应用只读其权限资料。模型先改模块文档，再改 Service/ViewModel 和测试。首次构建抓到模型引入的重复方法，模型据真实诊断删除重复后重建通过；原始失败日志保留。实际本地 748/748 通过；独立隐藏评分 **F2P 2/2、P2P 746/746**，无解析错误。本例完整完成，进入第三例。

续跑全程 2588948ms。原始全会话汇总包含复制的 36 条正用量历史，不能直接和本轮 54 个提供方请求比较。新增按精确前缀和原生注册私有会话进行归属的本轮统计：54 请求 / 54 正用量记录，本轮报告 2583170 tokens（含缓存）；已排除原始 1276133 历史 tokens。早期中断请求的完整消耗仍未知，未把它们抹掉或计作零。旧私有会话缺乏前缀边界时继续报告未知；对应当前/历史隔离、篡改/归属拒绝、未报告请求的回归通过。

## security_tool_3（已完成）

`attempt-001` 从独立原始基准开始，使用 `9ee6d72` harness、原始本地基线、分页读取和 1M 容量。原始本地测试 595/595 通过。历史 PID 3516、终端 61872、会话 `a10ea841-3f2f-4152-817b-aad4a6e664ec`，项目 `.runtime-correction/b/biz-92789807355b`。该运行已结算：公开业务成功、RC PASS、两个私有运行 SETTLED，耗时 1170922ms。独立原生隐藏评分 **F2P 1/1、P2P 595/595**，无运行或解析错误。

源码根因是 ViewModel 在 finally 中无条件锁定 initialized，页面随后不检查初始化结果便激活与刷新。模型改为根据快照初始化结果更新状态，并在页面初始化失败时立即返回；已存在的 ApplicationRuntimeManager 失败保护因此能够再次触发真实初始化。新增两项测试验证失败时零 count/snapshot 读取，以及存储恢复后成功重试、快照读取一次。本地最终 597/597 通过，原始 595 项无回归或消失。

轨迹使用 29 次导航、23 次分页读取、3 次编辑和 2 次检查，没有上下文溢出或业务重启。原始完整问题保留为一条 USER_EXPLICIT 实现要求，审查为 TASK_COMPLETE。需求提取工具提交有效 finish 收据后主动取消已完成的宿主运行，宿主却记录 generic aborted/timeout；核对 `CANDIDATE_COMPLETE`、finish 和 task-session 的 `Task receipts committed` 关闭逻辑后确认是预期结算，不是提取失败或重试。本例未发现需要新增修复的功能性 harness 缺陷，不为适配单个任务任意改协议。

用量报告为 1827658 tokens（含缓存），57 次请求对应 57 条正用量记录；一次取消终态的零用量记录不被拿来证明请求免费。复盘为 `security_tool_3/attempt-001-review.json`。目前最新结果完成 3/13，F2P 4/4、P2P 1952/1952；其余十例仍在全量分母中，不能宣称整体达标。

本轮等待期间，补跑近期全部 harness 改动的完整回归，包含恢复绑定、宏平均/全量分母和当前续跑用量归属：177 文件、1903 用例，1880 pass、23 skip、0 fail、0 timeout，记录为 `full-regression-iteration3.log`。

## security_tool_4（已完成，修复候选导出遗漏）

`attempt-001` 使用 `edcea57` harness 和相同公共协议。历史 PID 5596、终端 76190、会话 `c79d1287-2561-40b0-8425-7feb6a256a0c`，项目 `.runtime-correction/b/biz-9df5fd2b01ca`。实际业务已正常结算，RC PASS、两个私有运行 SETTLED，耗时 259379ms。公开问题要求浅色主题的危险按钮文字使用 AppColors.DANGER，深色仍保持白色。模型只修改一条生产返回值及一条固化旧错误的原始断言；构建通过，本地最终 593 PASS / 3 FAIL 与原始基线完全一致。三项 PeripheralDevicePolicyRepository 失败未被误作新增回归，没有无关改动、用例丢失或弱化断言。

独立评分首次发现实际 harness 缺陷：宿主提供原生 `apply_patch`，成功回执已列明两个文件，但 `businessMutationPaths` 只识别 write/edit，导致 candidate.patch 导出为 0 字节，评分实际测了未修改源码。另外一次原生 GC 日志交错把类名损坏为 `SecureStorageService.Performance2:`，严格解析报告 CONFLICTING_CLASS。原始评分 `executed=false`，全部保留，部分通过不能计作有效分数。

修复使业务写入归属支持匹配的成功 apply_patch 结构化回执，记录 added/modified/deleted 文件（包括移动两端），缺少结构化回执、失败调用、错配身份及控制目录仍拒绝。业务工具清单显式记录 apply_patch。新增 `reexport-arkts-candidate.mjs --run=<原运行> --output=<新目录>`，只允许已结束 owner，从封存的 workspace.patch 和成功回执用独立 Git index 重建候选；不读取后来工作目录差异、不覆盖原始结果或原候选，不发起模型调用。新文件未被原始差异封存时明确拒绝恢复，不能取后来内容补造证据。

本例重导出 `attempt-001/candidate-exports/export-001/candidate.patch` 为 1481 字节，与实际两文件修改一致。proof.json 绑定原清单、结果、完整差异、原候选、继承范围和转录的 SHA。重导出候选的全新原生评分位于该目录的 `grade/`，**F2P 1/1、P2P 595/595**，完整执行且没有解析错误；严格解析器未放宽。汇总保留原始和修复后的所有 gradingRevisions，按时间使用最新修订，不择优、不把重导出称为新模型尝试；首轮/最新轮仍指真实业务尝试。

归属、封存重建、二进制/增删文件、原 index/原证据不变、活跃 owner/身份/HEAD 拒绝、缺失封存文件拒绝、评分修订哈希/时间顺序及原生工具/评分器的 24 项回归通过，见 `candidate-capture-regression.log`。业务用量 17 请求 / 17 正用量记录、289043 tokens（含缓存）；离线修复增加模型调用为 0。完整复盘为 `security_tool_4/attempt-001-review.json`。目前最新结果完成 4/13，F2P 5/5、P2P 2547/2547，其余九例仍未完成。

另外回查已完成四例的成功写入归属，`completed-mutation-scope-audit.json` 确认前三例无相同遗漏，第四例的修复范围与真实回执完全一致。

捕获修复后的完整工程回归也已通过：178 文件、1908 用例，1885 pass、23 skip、0 fail、0 timeout，记录为 `full-regression-iteration4.log`。这轮包含新增原生 patch 回执、冻结候选重建和评分修订的测试，不与修复前的 iteration3 计数混用。

## security_tool_5（已完成）

`attempt-001` 使用 `bf47c1c` harness，包含原生 apply_patch 回执归属修复。历史 PID 29872、终端 61295、会话 `0a6219d7-e61c-4715-aa01-405ddcd15957`，项目 `.runtime-correction/b/biz-99f0cddd99fc`。已正常结算：业务公开终态成功、RC PASS、两个私有运行 SETTLED，耗时 561575ms。独立原生隐藏评分 **F2P 1/1、P2P 610/610**，完整执行且没有运行或解析错误。

公开问题是无效防火墙更新在验证之前删除旧系统规则。模型在 updateRule 的既有规则检查之后，先复用完整 validateRuleIntentInput，再进入删除/新建路径；空名称返回真实的 `rule name is required`，不触发删除或保存。新增回归同时检查返回错误、零系统删除、零意图保存，原有创建及合法更新路径保持不变。原始本地 610/610、最终 611/611 通过，没有回归或消失用例。

轨迹为 6 次导航、8 次分页读取、2 次 edit、2 次检查，没有业务错误或上下文溢出。正式导出包含两个真实业务文件、3137 字节，与原生写入范围一致；本例没有使用 apply_patch，不能把它冒称为新的 apply_patch 端到端证明，相关真实恢复证据在第四例。原始完整问题保留为一条 USER_EXPLICIT 实现要求，审查沿生产调用方及实际存储/系统写入路径确认 TASK_COMPLETE，无新增 harness 功能缺陷。

用量报告为 1003396 tokens（含缓存），40 请求 / 40 正用量记录；需求提取约 130.9s、审查约 269.9s，原始计量全部保留。复盘为 `security_tool_5/attempt-001-review.json`。目前最新结果完成 5/13，F2P 6/6、P2P 3157/3157；其余八例仍未完成，全量目标保持 active。

## security_tool_6（已结算，保留一项 P2P 失败）

`attempt-001` 使用 `5f3307d` harness 和相同公共协议。PID 12544、终端 31430、会话 `c593642c-9b35-4213-ac21-afb2d232c538`，项目 `.runtime-correction/b/biz-c9ab31566370`；原始本地 615/615 通过，已观察到实际业务模型启动。公开问题要求蓝牙/USB 首次接入自动拒绝、成功后才保存匹配本地策略，失败仍允许并记录原因；USB 显式 deny 的种类/优先级和不支持类型/策略的早期拒绝也必须覆盖。接续此运行，真正结算后用 calibration-heldout-001/security_tool_6 独立评分，再进入第七例。

核对 owner PID 的精确命令和原终端，均仍活跃。模型已更新模块设计文档、成功/失败提示常量及两类消费者；自行发现一次编辑误删 USB 存储分支起始判断，已重构修复并回读。自动拒绝辅助服务实际已作为新文件写入，当前正在调整 USB 等消费者测试。测试/构建、RC 及隐藏评分尚未完成，中间状态不计作成功。根会话按原公开问题保存 `security_tool_6/requirements-audit.json`，分别覆盖七条成功/失败/优先级/输入拒绝路径，全部仍为 PENDING，不把总体 PASS 当作逐条证据。

观测发现只看 git diff --stat 会漏掉新辅助服务，导致初次进度判断不完整。新增只读 `scripts/inspect-arkts-progress.mjs --run=<目录>`，按成功原生写入回执和真实继承范围同时列出修改路径与未跟踪新文件，排除无归属的宿主 bootstrap 文件；不暂存或导出候选。PID presence 与精确命令/原终端校验分开报告，半行追加明确标识，完整前缀损坏及 owner 错配拒绝，续跑读取真实恢复边界。对应 9 项定向回归通过，见 `progress-observer-regression.log`；前述 iteration4 的完整工程回归早于此观察器，不能冒充已包含新增测试。

业务首次构建通过，本地测试 612 PASS / 5 FAIL。两项原先通过的 dispatch 输入拒绝用例出现回归，另三项是新增/调整的自动拒绝用例。模型已据真实报告诊断跨套件 Hamock 静态 mock 泄漏，继续修复。原始 615 中三项旧行为用例已按新需求改名；是否属于合理替换，仍须结合最终断言及独立评分审查。首轮原生覆盖报告与匹配的真实工具回执已封存在 `attempt-001/observed-reports/test-001.coverage.log` 和 `test-001-evidence.json`，不是新测试或新业务运行。

本轮发现测试工具只直接返回失败 ID，关键断言要另读长日志；同时生成目录的覆盖报告会被后一次测试替换。后续新运行的 `bench_check test` 增加最多 16 条、每条最多 800 字符的原始断言诊断与报告行号，并在命令日志旁用新文件保存每次新鲜覆盖报告，`reportPath` 指向该副本。陈旧报告不返回诊断，诊断不推断类身份或改变严格计分，所有失败 ID/数量仍完整保留。相关 14 项回归通过，见 `local-diagnostic-regression.log`；真实首轮报告重解析仍为 612/5，准确提取五条断言。当前第六例继续使用启动时已加载的旧工具，不能把后续工具改动冒称为本次已应用或已做原生归档验证；下一例需核对新副本的真实生成。

上述观察器与诊断/归档改动完成后的完整工程回归已通过：179 文件、1915 用例，1892 pass、23 skip、0 fail、0 timeout，见 `full-regression-iteration5.log` / `.json`。对应代码为 `fccbe18` 与 `3c9caae`；下一例使用最新已提交 harness，继续保留 round-001 冻结运行插件。第六例当前仍为原 PID/会话、业务 RUNNING；模型持续生成静态 mock 隔离修复方案，尚未成功复测，不启动第七例。

较长响应期间提供方观察器持续记录新字节，未出现上下文溢出或进程终态。等待模型真实完成，不从观察超时推断停止。最新运行快照与提供方进度保存在 `next-step.json`，恢复时必须再次核对实时进程与同一终端；不要启动重复的第六例，也不要拿尚未结算的工作目录代替正式候选导出。

### 第六例的本地修复与终态缓存缺陷

最后真实构建通过，本地测试 617/617，原先两个 dispatch 回归已消失。Hamock 的 clearAll 只清 stub，不还原静态方法；模型改用可重置的派发执行器测试注入，移除泄漏 mock。RC 三个私有运行均 SETTLED，任务 COMPLETED / PASS。

原控制器只在 RC 全部结束后才查询公开 agent.wait，遇到长审查超过宿主约 10 分钟终态缓存。安装宿主源码只读核对，隔离零模型复现 terminal-cache-proof/proof.json 记录先 ok、推进 11 分钟后 timeout/queue；原运行真实查询也返回 timeout/queue，而非正式成功。不得从 RC PASS 反推公开终态。原 owner PID 12544 的精确命令、无子进程及三项私有结算状态复核后，仅停止空等控制器，封存 attempt-001 为 INCOMPLETE。七个真实业务文件、44102 字节候选、原始报告、独立私有会话快照和 terminal-loss.json 均保存，保留原任务身份与原 ledger。原候选先独立评分，生命周期缺失与功能分数分开。

修复在业务离开 RUNNING 时及时读取并留存真实公开终态，审查结束使用同一回执；纠偏换 run 或同一 run 新模型调用使旧回执失效，查询期间开始的新调用和早于该调用的结束时间均拒绝。超时、不可用、错配身份不转换为成功，真实查询日志单独保留。终态及相关协议/写入归属 15 项定向回归通过（terminal-retention-regression.log）；iteration5 全量回归早于此修复。下一步沿真实会话和工作目录续接 attempt-002，验证终态留存后再进入第七例，不把原缺失证据覆盖掉。

独立评分 attempt-001-grade 完整执行，无运行/解析错误，F2P 7/7、P2P 616/617，resolved=false。唯一失败为原 U-USB-008 空事件用例（device_deny 对 default_allow）；原始评分原样保存，不放宽计分，不向业务会话提供隐藏评分内容。该候选仍缺少原公开终态，不计作正式接受。

attempt-002 沿原会话恢复后，宿主默认凌晨 4 点 daily reset 按 sessionStartedAt 判断过期（仅改 updatedAt 无效），归档恢复的转录并启动不同 sessionId。原生作用域/ledger 恢复本身已严格通过，但重置后绑定失效，不能冒认续跑成功。发现身份变化后核对专属 PID 42720 和无子进程并停止，保存 session-drift.json 与 INCOMPLETE 结果；模型只调用读取/导航及启用工具，七文件业务候选逐字节未变。误绑定请求报告 376069 tokens（含缓存），中断未报告消耗仍未知。

隔离实验改用宿主正式支持的 reset.mode=idle 且省略 idleMinutes（原生解析为 0，即无每日/空闲重置），不改历史时间戳，所有新样本使用同一策略。循环检查真实 SessionEntry 与业务诊断中的 sessionId；任一变化写入失败证明、请求停止精确 run，拒绝接纳新历史。13 项定向回归通过，包含安装宿主原生 freshness 函数验证；session-continuity-preflight-001/proof.json 由真实 Gateway 严格加载配置，原转录 SHA 保持一致，跨 4 点仍 fresh，模型和提供方调用均 0。接下来 attempt-003 仍从 attempt-001 的原始历史、作用域与 ledger 恢复。

完整回归 iteration6：179 文件 / 1920 用例，1897 pass、23 skip、0 fail、0 timeout。其运行期间开发了会话修复，初始文件清单未包含新测试，故不冒称最终完整覆盖，稍后以已提交版本重跑。

### 第六例正式续跑结算与复评

attempt-003 使用 444da1f，沿 attempt-001 原会话 c593642c-9b35-4213-ac21-afb2d232c538 恢复 198 条真实记录，原 ledger used=0 且 budgetReset=false，原 task scope 恢复通过。真实业务 5 次模型调用，公开终态在 FINALIZING 立即保存为 agent.wait:ok，154760ms 后正常 SETTLED。完成的原任务返回 STOP_NOT_REQUIRED，没有新增私有审查；原实施 RC PASS 在候选逐字节不变的前提下继承，不能称为新 RC 审查。

真实续跑构建通过、本地 617/617；原三个固化旧行为的测试合理更新断言，其他通过用例未被删减。新鲜报告副本 2610105 字节，与原报告逐字节一致，诊断/归档能力已获得端到端验证。当前业务增量 541188 tokens（含缓存）/5 条正用量；标准工具保守地不推断历史私有会话增量，原首轮 110 请求/110 正用量、6568234 tokens 保存在 terminal-loss.json 与私有快照。

正式候选 44102 字节，SHA de378e811716c339374199d4f3b85afbe570a64041172c6ae3cc0da4d1ff17f9；独立复评仍为 **F2P 7/7、P2P 616/617、resolved=false**，无解析/执行错误。U-USB-008 的空事件在评分的派发测试设置下被记录为 device_deny，而原期望 default_allow；新增本地派发执行器对 USB_OTHER 返回失败，因此本地全过不能替代这项失败。按原规则保留分数，不修改评分器或向业务泄漏隐藏内容。完成本例轨迹/源码复盘及两项通用 harness 修复后，进入第七例，保留这一未全通过项。完整复盘见 security_tool_6/attempt-003-review.json。

以提交 444da1f 固定源码完成的 iteration7 全量回归：180 文件 / 1922 用例，1899 pass、23 skip、0 fail、0 timeout。本轮包含终态留存和跨日会话防护，未在测试期间修改代码。

## security_tool_7（运行中）

采用 bf004ba harness，PID 27144、终端 19613、会话 3277d70c-0cf6-4fee-84e0-84bed7075f23，项目 .runtime-correction/b/biz-9ed20ea2fcb2。原始本地 674/674 通过，已确认真实业务模型启动。公开问题要求模式切换部分失败/抛错时回滚规则、还原前模式/映射并重载服务确认状态；模式切换与保护开关互斥，重叠调用返回 in progress。八项公开要求清单位于 security_tool_7/requirements-audit.json。源码原本只分别检查自身 busy 标志；规则失败无事务恢复，抛错时跳过 UI 重载。原服务已仅在 failedItems 为空时保存目标模式，不能把问题叙述当成当前源码逐字事实。完成真实结算、独立评分和复盘后再进入第八例。

### 第七例等待期间：声明 off 不等于提供方已禁用思考

第七例持续出现长响应但正常返回数据，尚未形成候选。对安装宿主及其请求构造代码只读核对，发现自定义模型声明 reasoning=false 时，thinking=off 只得到内部 thinkingEnabled=false，外层 capability guard 仍会省略请求的 thinking 字段。不能把内部 off 声称为提供方已禁用思考。thinking-policy-proof-002/proof.json 使用实际安装宿主的 transport、仅本地假 SSE 响应验证：reasoning=false/off 时字段缺失，reasoning=true/off 时发出 disabled，两次本地请求、远程请求与模型调用均 0；自然退出成功。首个诊断脚本在写完证明后强制退出，触发 Windows 句柄关闭断言，原日志保留，不冒称干净退出；移除强制退出的第二份证明与独立测试均正常完成。

provider-fetch-timing.test.mjs 的真实安装宿主测试加入这两种明确请求设置断言，7/7 通过、0 skip，见 thinking-contract-regression.log。业务原转录的计数快照也确实观察到 thinking 块，保存前缀长度和 SHA，仅记录数量/长度，不保存新的思考文本。该证据证明 off 未有效阻止可见思考块，不推断远程隐藏计算，也不声称解释所有耗时。

后续清单补记 modelThinkingPolicy：业务请求 off，自定义 capability=false，提供方禁用未验证。当前及后续实际模型、capability、请求设置、质量/努力程度均保持原协议；不通过修改宿主或请求来强制关思考。此项修复是如实记录实验设置，不能算作性能提升。当前第七例仍使用启动时已加载的 bf004ba harness，原 manifest 与请求不热改；iteration7 完整回归早于这项清单/传输测试更新，新增部分由上述 7 项原生传输测试覆盖。

### 用户确认优化范围

用户明确要求：“这例结束可以停下优化外围框架了。我目前只想优化RC 插件本体。” 第七例维持当前真实运行，完成评分与复盘。此后停止开发外围运行/评测框架，仅使用既有流程执行、评分及保存证据；逐例优化对象限定 RC 插件本体的需求提取、审查与纠偏逻辑。发现插件问题后在 runtime-corrector-toy 修改、验证并冻结新插件，再进入下一例，不热换在跑版本，不为制造迭代而修改无证据的问题。全部十三例及 F2P/P2P 95% 目标保持不变；MatrixAssistant/OpenClaw 继续只读。

### RC 插件本体：条件性失败保证的证据约束

回查第六例原 RC 审查发现一项具体的理由过度保证：M16 的派发失败项 PASS 理由还声称 repository save failure 没有 partial state，而被引用的 PeripheralDevicePolicyRepository.set 在 saveRecords 之前已修改 records，catch 仅返回 false，没有回滚。原要求限定系统派发失败；该要求本身仍可能正确 PASS，不能据额外错误说明直接翻转整个原判定。原审查结果 SHA、源码 SHA、精确分支与条件区别保存为 rc-plugin-failure-effects-evidence.json，不向业务提供评分内容。

插件工作区审查提示与共享 productionTrace.producerValue 描述补充：保留准确失败操作/条件，区分内存、持久化和外部系统状态，按顺序检查失败前写入与补偿，别名快照必须独立，理由也不能扩大保证。原 version1 见证结构、判定与证据来源规则保持兼容。新增四个独立 RC 审查语义样本（失败前已写内存、正确补偿、别名假补偿、仅派发失败要求），直接运行源码对 false/throw 路径校准其预期结果；它们不是 ArkTS 隐藏测试，也不是外围跑测能力开发。校准、M16 协议及工作区审查 24 项回归通过，接下来用现有显式 native workspace 审查入口运行语义验证，再冻结新插件用于后续样本。当前第七例冻结 round001 未变。

RC 本体改动 3d76dd2 的四项真实 native production workspace 审查均匹配预期：失败前已写内存 DEVIATION（65.2s）、正确补偿 PASS（80.7s）、别名假补偿 DEVIATION（74.8s）、仅限定派发失败 PASS（62.0s）。最后一例理由明确允许成功派发后持久化失败仍保留追加值，没有额外要求原任务未声明的持久化原子性。四项总计 20 次提供方请求、4 个审查启动且全部结算、业务续作启动为 0。原始回执/理由/来源保留在 rc-failure-effects-live-results.json。该结果只验证这四例，不宣称任意语义已形式证明，也没有固定配对的 benchmark 提升结论。

相同提交完整回归 iteration8：181 文件、1924 用例，1916 pass、8 skip、0 fail、0 timeout。此次启用安装宿主原生契约测试，skip 数与之前默认环境不同，不能把全部新增通过数视作新修复。冻结 artifacts/round-002/runtime-corrector-openclaw，并按 Git 提交逐模块核验，兼容 Skill 验证通过。与 round001 比较仅两个 runtime 模块变化：stop-workspace-review.mjs 和 production-trace.mjs；见 round-002/verification.json 与 changed-runtime-modules.json。当前第七例仍运行 round001；后续第八例使用新插件，公共业务导航继续固定 round001，外围不新增功能、模型/努力程度不变。

### 用户纠正：恢复默认指标范围

参考文件 C:/Users/user/Documents/防作弊将历史文件临时移出/261026纠偏配置/.runtime-corrector/config.yaml 没有显式 metrics 开关，按当前 RC/冻结 round002 默认解析，应开启 M08（Skill step compliance）、M09（Development standard compliance）、M12（Requirement execution rate）、M13（Acceptance closure rate）、M15（Critical journey pass rate）、M16（Production implementation coverage）；其他十项关闭，独立 fileQualityReviewEnabled=false。之前 runner 显式把 M01-M15 全设 false，是评测范围收窄，不是插件默认。按用户明确要求，删除这一覆盖，使新启动样本继承 RC 默认指标；没有复制参考文件的其他路径或参数，没有更改模型、额度、时间窗口。

新增实际生成 YAML 的默认继承断言先复现错误，删除覆盖后与 metric policy 的 18 项回归全过。用冻结 round002 的真实 loadConfig 解析新生成配置，与用户参考的有效指标逐项一致；全局 Stop enabled=true，零模型调用，并核对在跑第七例的归档/项目配置逐字节仍一致。证明位于 default-metrics-policy-preflight/proof.json，参考文件保持只读。

原六例分数仍保留为 M16-only 诊断，不作为六默认指标下的 >=95% 证据。当前第七例完成真实纠偏/复审与独立评分后，进入新目录 serial-default-metrics-20261030，按原顺序从第一例重新评测全部十三例，继续只优化 RC 插件本体。各指标开启不代表必有适用对象，后续按实际基线、范围与回执报告，不把空对象或 M16 PASS 当作其他指标通过。

### 第七例结算：异常分支刷新漏判

旧 M16-only 第七例实际 SETTLED，业务结束与基础设施完成均 true，最终纠偏 run 的真实 agent.wait=ok，四个私有运行均 SETTLED。原审查发现回滚重建系统规则后仍保存旧 systemRuleId，真实自动纠偏消耗一次额度，改为使用返回的新 ID，并按 localRuleId 分组恢复多用户映射。最终 RC PASS，三次实际本地测试均 679/679；独立评分实际执行完整、无编译或全局运行错误，F2P 4/5、P2P 673/673，resolved=false。失败项为切换抛错后重新加载已确认模式，保存原始 test ERROR，不能因本地全过或 RC PASS 改写。

最终 ViewModel 的刷新在 await switchMode 之后，finally 只清除忙标志；调用拒绝时刷新被跳过。原需求明确含 operation throws 与 confirmed mode reloaded，但最终审查把普通返回路径上的刷新当成了该复合条目全部通过的证据。审查全文、源码 SHA、原终态、六次 build/test 回执及用量 8,787,474（含缓存）存于 security_tool_7/attempt-001-review.json，需求核对表关闭为存在一项异常路径缺口。rc-plugin-exception-paths-evidence.json 固定公开需求、最终来源和漏判理由；隐藏结果不发送给业务。

RC 本体继续只改工作区审查提示和共享 productionTrace 描述：多效果条目逐项追踪适用结果，返回失败与异常拒绝分别检查，finally 只证明自身操作，不能用回滚或忙标志清理替代另一个必需效果；依赖下层吞掉异常时需要相关边界的完整契约。version1 结构及判定协议不变。新增三个通用 RC 语义夹具，分别为异常跳过必需刷新、finally 正确刷新、原要求明确排除异常刷新；直接执行代码独立校准三种结果，防止扩大义务。相关回归 25/25 通过，真实 native production 审查另行保存。此迭代不是外围框架功能开发。

f67ab07 的三项真实 native production 审查均匹配：遗漏异常刷新 DEVIATION（68.4s）、finally 正确刷新 PASS（72.3s）、原要求排除异常刷新 PASS（75.6s），三个私有运行全部结算、业务启动为 0；结果在 rc-exception-paths-live-results.json。它们只验证 M16 审查语义，不代替六指标 benchmark。round003 对 Git 的 176 个 runtime 模块和 6 个 Skill 验证通过，较 round002 仍只改两个审查模块。冻结插件实际解析新评测配置与参考文件的十六个指标开关逐项一致，证明在新套件 policy-preflight/proof.json。新套件已从 security_tool_1 重新启动，公共导航仍固定 round001；原七例诊断与失败留存，按新套件独立统计全部十三例。

### 六指标第一例：规范分类与 RC 搜索预算

新第一例确认实际项目配置开启全部六默认指标。本地构建成功，测试 453 pass/2 fail，与原 452 pass/2 fail 对比无新增回归或原用例缺失。冻结原审查依据中，提取器将项目 hvigor 工具查找与 UTF-8 规范保存为 PROCESS constraints，而非 developmentStandards；其后投影到关闭的 M11，M09 因分类错误无对象。另有仅含“### 构建”的 PROCESS requirements。实际选择只有 5 个 M12 和 1 个 M16。原依据 SHA、原条目和用同一配置在独立证据目录重算的路由结果保存在新套件 taxonomy-audit/evidence.json；这不是规范均不适用，也不能为了填充指标而任意改类别。

下一版 RC 内置 baseline-extraction Skill 明确类别与证据归属独立：编码、测试、构建/工具等项目开发规范归 developmentStandards，并保留原条件与权威；普通边界、任务步骤、验收条件和端到端路径分别按原义分类，不从开关反推类别，不制造或重复对象。标题/示例不是独立执行义务。

同一轮审查的真实 source_grep 以整个 program_workspace 为根搜索 PASSWORD_LENGTH_OPTIONS，长时间无返回，宿主记录 blocked_tool_call。新 RC 工作区提示/工具描述首先指向 task.workspace，并给递归导航增加条目/字节预算及明确的未完成状态；绝对路径、父目录和直接读取继续可用。原调用参数在新工具组件上实测 756ms 后返回 scanIncomplete=true（1090 条目、16767973 bytes、0 命中），证明在 taxonomy-audit/navigation-budget-proof.json；没有给原运行热换工具，没有把零命中当不存在，也不以组件耗时宣称端到端提升。相关 172 用例为 171 pass/1 skip/0 fail，见 rc-taxonomy-navigation-regression.log。原轮仍按冻结 round003 继续，下一版需真实提取器验证后才用于下一样本。

原第一例随后真实 SETTLED：业务结束和基础设施完成均 true，RC=UNVERIFIED / STOP_REVIEW_INCOMPLETE。私有审查 completed=false、OPENCLAW_DIRECT_ABORT，无逐项语义判断；搜索调用时间为 22:51:06.904 UTC，原助手 aborted 为 22:57:26.502 UTC。这里只记录搜索期间实际中止，不推断中止的精确原因。独立评分完整执行，F2P 1/1、P2P 611/611，resolved=true；RC accepted 仍为 false，不能用功能通过替代审查。原候选、用量 683030（含缓存）、审查和分类缺口保存在新套件 security_tool_1/attempt-001-review.json。

e8fba6f 完整回归 181 文件、1927 用例，1918 pass、9 skip、0 fail、0 timeout；执行期间源码不修改。实际 native 提取组件 after001 使用旧第一例的字节核验原来源、初始空基线，100.2s 真实结算、1 个私有运行、业务启动为 0。它把工具查找和 UTF-8 两项正确归到 developmentStandards，却额外将 Test Framework Baseline 标题下的可用测试/安装/冒烟命令表保存成 CURRENT_TASK HARD PROCESS 规范；该结果是部分修复，不能视为验证通过。原始输出和 audit 保留在 taxonomy-component-after-001 与 taxonomy-audit/component-after-001-audit.json。继续收紧 RC 内置提取规则：PROCESS 规范必须在原文有指令/禁止及触发条件，目录标题和可用命令不能补出执行授权；同一操作的明确任务动作与环境条件保持一起，避免把动作藏入普通约束。后续仍须新的真实组件验证，保留每次结果。

24f04d0 的 after002 在组件实验固定 180 秒窗口内仍持续生成，实际结算 completed=false/REVIEWER_DEADLINE，没有候选或语义结论，部分提供方用量不能算零。after003 在独立证据目录保留同一原始驱动，仅将组件 reviewer 窗口改为与业务评测相同的 1800000ms，主仓 runner/grader 未修改，模型与 effort 不变；sourceInputId 与前两次完全相同。该次真实 native 提取 118.3s 完成，九条开发规范保留原 CONDITIONAL 条件，其中工具查找和 UTF-8 正确归 M09；无测试命令目录义务、无裸标题执行项，明确项目检查动作仍在 requirements PROCESS 中。原结果与核对位于 taxonomy-component-after-003 和 taxonomy-audit/component-after-003-audit.json；小样本不证明普遍分类准确率。

冻结 round005：176 runtime 模块逐文件与 Git 24f04d0 对照，较完整回归的 round004 模块全部相同，仅内置提取 Skill 规则细化并核对 Git 内容 SHA、六份 Skill 兼容性。该细化相关回归 53 pass/1 skip/0 fail。第一例 attempt002 现使用 round005 重新运行，实际项目配置再次核验六项默认指标开启；第一次的独立功能满分与 RC UNVERIFIED 保留在首轮统计，不用重跑覆盖原事实。
