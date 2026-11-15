# 轨迹、RC 产物与标准答案复核（2026-11-15）

## 结论及本次决策

本轮证据不支持“三项机制已经让四题都做对”。初版四个新样本中，独立评分完整通过的是 st2 和数独；st9 有一个新需求失败，st6 有一个原公共回归失败。数独虽然独立测试全部通过，离线复核又确认了一个标准答案修复、生成代码遗漏的 Worker 配置入口。

优先优化方向确定为：**逐项保存并交付已完成的简报内容；复核场景前提的依据；沿实际公共入口核查配置是否真正生效。** 延长到 15 分钟保留，但继续增加等待时间或增加形式上的完整性门槛，不能解决已经观察到的问题。

这是分析和方向决策，不把尚未实现的“部分简报”当成产品能力。当前运行时代码仍是 `ed0f5dc`，仍存在整份筛选未完成就不发送简报的行为。本报告没有把标准答案写入产品提示或正在运行的业务会话。

## 样本、隔离与证据口径

- 原仓库基点：`c286bc5e545cbbd61e6f16d4c2a1eb14150460c3`。
- 独立 worktree：`C:/Users/user/workspace/program_workspace/rc-wt/post-proposal-contract-review-20261115`。
- 分支：`codex/post-proposal-contract-review-20261115`。
- 初版运行时：`a41c4f6f393981b453339c78bd2a820f88b14e3c`，四项均已自然收尾。
- 通用修正版：`ed0f5dc46eeea415facf52541954dee9d7a60e88`。修复了同一行为仅因 contractCell 分类不同而被拒绝覆盖的问题，明确了原成功依赖替身仍须验证。修正版在读取标准答案之前冻结。
- 初版产物根目录：`C:/Users/user/workspace/program_workspace/Experiments/rc-post-proposal-contract-review-20261115`，下文称 O。
- 修正版产物根目录：`C:/Users/user/workspace/program_workspace/Experiments/rc-post-proposal-contract-review-15m-20261115`，下文称 N。用户要求先分析后，保留已启动的 st2 至完成，后续三项未启动。确认 st2 最终评分已保存、保活请求已释放、下一项尚在派发入口等待且无业务子进程后，已结束待派发队列。未向业务会话追加本报告发现。
- 分析目录：O 下的 `trajectory-analysis`，下文称 A。
- 使用原生 MA CLI、实际隔离 OpenClaw、冻结安装包、原业务模型和 RC 模型、原公共测试及独立评分器。MA 和内置 OpenClaw 保持只读。没有推送或全局安装本分支。

“独立测试完整通过”“RC 检查完成”“自然结束”分别报告。`NO_DEVIATION_FOUND` 加 `verificationIncomplete=true` 不等于契约全部验证。初版 st2 的外层摘要误选了修正前的 DEVIATION；派生结果通过原生结算载体、同一 session/current task/evaluation、持久化评估及业务退出前时间绑定，确认最终修正后的结算。原始摘要和评分不改写。

标准答案来自本地数据集各题 JSON 的 `patch` 字段；只用作离线语义比较，未读取隐藏测试体来优化产品。st9 标准补丁包含与任务无关的文档、签名和端到端资源，不能把整份补丁的每个改动都当作用户要求；st2 标准补丁也包含更广的持久化调整。比较以可观察契约为准，不以文件或行数相等为准。

## 四项初版结果

- **st2**：独立新需求 2/2，原回归 746/746，完整执行。RC 发现并保存一个真实偏差，自动修正一次；最终 14/14 frame 项已检查，实际最终结算无偏差且验证完整。自然结束，用时约 31.9 分钟。
- **st9**：第一次评分执行不完整，新需求 6/7，原回归 669/670，缺一项原回归。保持同一生成补丁与评分器复测后，完整执行结果为 6/7、670/670。RC 的 14/14 frame 项均标为已检查，但仍有两项原回归证据不足；最终无已证明偏差，验证不完整。未自动修正，自然结束约 20.8 分钟。
- **st6**：独立完整执行，新需求 7/7，原回归 616/617。准备阶段 41 个有效候选，10 分钟到时未交出整份筛选结果，没有简报。最终 RC 的未验证项是准备流程失败，没有识别出缺失 USB 身份的代码错误。未自动修正，自然结束约 36.3 分钟。
- **数独**：独立完整执行，新需求 10/10，原回归 288/288。35 个提议、32 个有效候选；两次筛选均未通过账本检查，没有简报。失败发生在约 8 分 51 秒，属于 `SELECTION_INCOMPLETE`，不是 15 分钟不够。最终 RC 保留准备失败的未验证项，未自动修正，自然结束约 20.2 分钟。

这些是每题一次初版业务运行，st9 多了一次同补丁的评分重跑。不能由此推断稳定提升、成功率或因果增益。

补充样本单独报告：ed0f5dc 的 st2 在 15 分钟配置下完整通过新需求 2/2、原回归 746/746；37 个候选全部有效，修复一次筛选账本后交付 15 项，实际最终 15/15 已检查、0 项未验证。再次证明并修正同类 3D 策略保留问题，自动修正一次，业务自然结束约 34.1 分钟。frame 准备实际为 8 分 7 秒，未触及原 10 分钟上限，不能据此证明延长时限有效。终审提交仍有 5 次格式/绑定信息拒绝。

补充样本的外层摘要同样误选修正前的 DEVIATION，原 `qualifiedPass=false`、`workflowComplete=false` 均原样保留。实际最终载体由 `nativeStopRequired` 指定，并通过 `nativeStopVerification`、原生 SETTLED 记录、同一 session/current task/evaluation 的持久化结果和业务退出前时间验证，结算为 NO_DEVIATION_FOUND、verificationIncomplete=false。派生结果明确标出 `captureSelectionMismatch=true`，不是把原始 UNVERIFIED 改成通过。证据在 A 的 `supplemental-st2-evidence.json` 与 N 的 `results.json`、`pending-dispatch-retirement.json`；此采集问题不应与业务修复或 RC 语义能力混在一起。

## 简报处在业务流程的什么位置

当前反例复核是在 **RC 自己的独立提议之后**执行：只读取冻结的任务开始源码、用户消息和 RC 候选，不读取宿主后来生成的 OpenSpec 方案或实时实现。因此它不能被描述为“已经针对宿主实际方案做过反例审查”。真实生成产物与代码仍要在后续终审核对。

从原始轨迹看，简报也不总在业务开始写代码之前完成（以下为 UTC）：

- st2：反例 01:40:35 完成，frame 01:43:46 完成，业务 01:44:40 进入 codeing，01:44:43 在 run_start 收到简报。
- st9：反例 02:12:11 完成，业务 02:12:37 进入 codeing，frame 02:15:42 才完成，02:15:56 作为工具结果附加送达。延迟约为进入代码阶段后的 3 分 18 秒。
- st6：业务 02:34:48 进入 codeing，反例 02:35:12 完成，02:38:35 到时，没有交付。
- 数独：反例 03:10:56 完成，业务 03:11:01 进入 codeing，03:14:31 筛选最终失败，没有交付。

`deliveries.jsonl` 的 `productionChangesBefore` 实际按 `owner === 'STOP'` 计数（st2 为 1，st9 为 6），并非逐个确认生产源文件，不能据此断言已经修改了多少个生产代码文件。时间与接收通道已足够证明 st9 的建议是代码阶段中的异步提示；没有证据断言它单独导致了生成方案。部分交付的价值也包括尽早提供已确认信息，而不仅是最终超时兜底。

## st2：既有 Stop 机制确实完成了一次有效纠偏

用户要求刷新应用列表时获取策略、保留已有 3D 相关数据，选择应用时减少重复加载。生成代码主要调整 PermissionService 和 PermissionViewModel；标准答案使用加载账户策略快照来充实列表，选择时只加载权限配置，并包含更广的本地仓库修改。

RC 的反例与终审发现：虽然保留了 `threeDGroups`，但传入非空、只含本地子集的 `threeDPolicies` 时，列表合并会覆盖之前已加载的完整策略。RC 按原入口、已有状态和保留行为保存偏差，触发修正；最终代码保留完整的已加载策略列表。最终独立评分和实际结算均闭合。

这说明反例加逐项终审有用，也说明应保留现有有效纠偏机制。它不证明新增的全部字段约束都必要，更不证明其他题已正确。

## st9：账本完整，语义前提仍可选错

失败项是 `PeripheralPolicyViewModel::should reject bluetooth device policies without saving local policy`。原公共测试的 `beforeEach` 将 dispatch 替换为成功返回。生成代码主要依靠下层 dispatch 拒绝蓝牙；调用者 `setDevicePolicy` 自己没有排除蓝牙。在原成功依赖前提下，调用者仍可写入本地蓝牙策略。生成测试把依赖改成失败，局部通过不能证明原契约。

RC 产物明确记录了错误方向：

- G6 认为成功替身代表真实 owner 已不可能产生的成功，因此认可更新受影响测试。
- S4 的前提明确要求 dispatch **不替换**，只验证真实下层返回拒绝的路径。
- S6 把旧的 normalization-first 错误优先级认定为必须保留，并要求新拒绝落在下层 dispatch。旧控制流本身不足以授权这样的实现位置约束。

标准答案在 `PeripheralPolicyViewModel.setDevicePolicy` 自己先检查 USB 类型，蓝牙请求在调用者入口被拒绝；`shouldDispatchBeforeSave` 也只覆盖 USB。因此原成功依赖不再能造成蓝牙落库。关键是调用者自己保证无副作用；不能据此要求所有实现必须逐行采用标准答案的 guard 顺序。若要保留另一输入错误的优先级，应另有仍适用的依据。

RC 完整地检查了自己选择的 14 个项目，但选定前提已经放过了原契约。这不是“再检查一遍 ID 是否齐全”能够发现的问题。程序检查只能保证前提字段没有被后续偷偷替换，不能证明起初选定的前提正确。

另外两项原回归在 RC 中仍为 UNVERIFIED：不支持的策略应在接触管理器前拒绝，不支持的设备类型应在派发前拒绝。观察到的成功结果与源代码预期不符，原因未证实。独立评分原回归 670/670 不能解释这两处证据冲突；没有证据把它归因为已确认的 mock 泄漏。

证据：O 的 `st9-original-dependency-observation.json`、`st9-original-public-dependency-setup.txt`；A 的 `analysis-evidence.json`；业务目录 `Experiments/sc-b/biz-b57d6ac10c6c` 的 frame G6/S4/S6、生成补丁和原生 Stop 记录；A 的 `security_tool_9-standard.patch`（仅比较生产代码）。

## st6：已完成的关键反例被整份提交门槛吞掉

独立失败为原公共回归 `U-USB-008 should stay stable for missing or empty raw payloads`。生成 consumer 把格式化的 deviceId、类型和名称交给新 AutoDeny helper，却没有在第一个副作用前验证原始 vendorId/productId。缺失数字身份时 `resolveUsbEventInfo` 会产生 `UNKNOWN-USB-<occurAt>`，这是展示占位符，不能用作持久化拒绝策略的身份。

标准答案在首次接入拒绝逻辑里、dispatch 和 repository.set 之前检查两个数字身份均为有限数值，不满足则跳过自动拒绝。仅检查设备类别也不足够：缺失身份的输入仍可推断为 USB_STORAGE。

超时前 RC 已完成的反例包括：

- P2-S6：空参数解析为 UNKNOWN-USB/USB_OTHER；继续返回 default_allow，不能保存策略。
- P4-S2：类别是可派发的 USB_STORAGE、vendor/product 缺失，dispatch 保持原成功替身；必须零派发、零落库。它区分了“拒绝不支持类别”与“验证真实身份”，与标准修复的关键边界一致。

41 个有效候选和反例已保存，但 selector 在超时前没有提交完整账本，于是上述内容没有送给宿主。这里支持“有用内容应能部分交付”的方向；但不能声称若送达宿主就必然修好，尚无这条对照实验。

现有 Stop 仅因 `FRAME_PREPARATION: TIMEOUT` 保留验证不完整；这不是它检测到了 UNKNOWN-USB 的真实代码偏差。增加时限可能给 selector 更多机会，但无法保证下一次全部完成。

证据：O 的 `st6-frame-timeout-original.json`、`st6-frame-timeout-candidates.json`；A 的 `security_tool_6-standard.patch`；生成业务目录 `Experiments/sc-b/biz-fc776f77fcc5`。

## 数独：独立测试全过，配置入口仍有可复现遗漏

生成代码把 `Common.isValidPlacement` 改为使用活动 PEERS，又增加 HAS_DIAGONALS 和额外出题后置检查；没有修改 `PuzzleWorker`。标准答案主要修复 Common 和 Worker：无论是否提供可选 gridSize，都应按 diagonal 变种启用对角线拓扑。

生成 Worker 将 `applyTopology(createDiagonalConfig())` 放在 `if (gridSize !== undefined)` 内。RC 终审看到文件中存在该调用，就认为 Worker 会在 generatePuzzle 前激活对角线，遗漏了条件分支。更严格的场景身份字段也不能自动证明这一分支已经走到。

离线验证使用实际 Worker `onmessage`、实际 GameConstants/VariantConfig/VariantTopology/Topology/Common，两个版本共用同一个生成器观察替身：

- 输入 `{type:'generate', difficulty:1, variantType:'diagonal'}`，不传 gridSize：生成版进入生成器时有 27 个普通单元，实际 Common 允许 (0,0) 与 (8,8) 重复；只应用标准 Worker 修复后有 29 个单元，Common 拒绝该重复。
- 控制输入增加 `gridSize:9`：两个版本都是 29 个单元并拒绝重复。
- 控制输入 `variantType:'standard'`、不传 gridSize：两个版本都是 27 个单元并允许只在对角线上重复。

这是入口和活动规则的复现，未运行完整出题算法或 Harmony Worker 线程，不能替代整机验收。它也不改写原独立评分 10/10、288/288，说明该评分没有覆盖这个入口条件。

简报未交付还有两个不同原因：P3-S1 与 P1-S3 是相同 `generateFullBoard` 行为，却因分类标签不同误拦截，已在 ed0f5dc 修复；P3-S5 想用另一个主入口 `generatePuzzle` 覆盖 full-board 入口，属于真实绑定冲突，不能直接删除门槛。这种局部错误也不应把其他已正确复核的项目一起丢掉。

证据：A 的 `prepare-worker-probe.py`、`probe-sudoku-worker.mjs`、`sudoku-worker-probe-source.json`、`sudoku-worker-probe-results.json`、`soduku-harmony_11-standard.patch`。探针保存了全部被运行源码的 SHA-256，标准 Worker 由校验全部上下文的补丁应用产生。

## 现有 RC 已有的可复用部分能力

运行时 `stop-review-store.mjs` 逐项保存带 ownership、revision、basis 和依赖的结构化结果。`stop-review-round.mjs` 在组失败或超时时结束本轮，已经保存的有效回执仍保留；未完成项维持未验证。`review-collector.mjs` 的 `partialReport` 只保留归属正确、唯一、结构有效且有证据的有效兄弟项。

frame 路径相反：`submitInSession` 要求一次提交整个 selector reviews 数组；一次修复仍失败或到时后，整份 guidance/scenarios 不发送。st6 甚至尚无 selector 提交可挽救；只会解析最后一个完整 JSON 的方案无法解决它，需要逐项或分批提交的检查点。不能从截断的模型输出里猜测它已经完成了哪些结论。

## 后续实现边界与验收

1. **逐项完成、部分发送。** selector 可分批提交结构化处置，程序逐项核对来源、当前任务/源码、身份和覆盖关系，保存已接受回执。坏项不污染有效兄弟项。所有候选在内部均有已选择、已拒绝、已覆盖、待处理或延期的明确状态；partial 不能冒充完整覆盖。达到 15 分钟时用已接受的内容组成简报，不能把原始候选直接等同于已完成复核。
2. **宿主只看有用内容与一句提醒。** 推荐提醒为“本次梳理可能仍有遗漏，请结合用户原文与实际代码，自主补全检查并作出决策。”不列未完成项目、编号或内部失败清单。内部仍保留完整账本供审计。没有任何已接受内容时不能编造实质简报。稳定编号、发送去重和过期回执拒绝沿用现有机制；后续是否增量发送要有单独明确规则。
3. **场景前提有授权依据。** 分开记录旧源码事实、旧测试依赖设置、用户授权改变的断言和有依据的保留行为。真实下层现在拒绝不能豁免原成功替身下的调用者无副作用契约。另一方面，旧代码中的错误优先级也不能自动升级为必须保留的需求。ed0f5dc 的无条件“preserve existing input-validation precedence”提示仍过强，应在后续实现中改为按来源判断。开始快照的建议与后来宿主实际方案分开处理，终审核查实际产物，不能将前者冒充后者的审查记录。
4. **终审追到活动配置与第一个副作用。** 对公共入口按受支持的可选参数有/无、状态空/已有、依赖原返回进行检查；确认配置写入分支实际到达、共享规则实际消费该配置、拒绝发生在派发/落库之前。看到目标函数名存在不能代替这条追踪。此规则通用于 Worker、事件 consumer 和 ViewModel，不硬编码四题。
5. **区分建议覆盖与交付契约证据。** 准备失败是内部流程状态，不能单凭它宣称发现了代码错误，也不应必然把所有已充分验证的交付契约降为未验证。真正证据不足的交付项继续 UNVERIFIED；有来源证明不适用的建议允许 NOT_APPLICABLE，并保留理由。st9 两处原回归的证据冲突不能随部分简报优化而抹掉。

复用逐项机制时，原入口、原前提与源码版本可由程序保存并绑定；审查者按项 ID 提交结论、适用性依据及当前代码追踪，无需反复抄写整段身份字段，且不能在提交时改变前提。初版 st2 有 5 次 finish 因缺理由或契约信息不一致被拒绝，这是协议成本，不是 5 个新业务缺陷。不能为了减少重试而省略真实来源追踪，也不宜继续增加抄录字段来代替证据。

有意义的验证应覆盖：完整账本；到时前已有若干已接受项；到时前一个也未接受；局部覆盖冲突；配额延期；过期提交；重复发送；跨入口误覆盖；宿主提醒不泄露内部待处理清单。再冻结一个通用版本，使用新会话验证四题，保留原样本和独立评分；不把标准答案或本报告的题目专用反例作为产品输入。

已经分析标准答案后的四题复测属于定向开发验证，不能宣称为未见任务的盲测或泛化证据。

## 已有实现的验证及限制

初版精确全量：319 文件、3354 测试，3301 通过、4 失败、49 跳过。三处版本断言期望 1.10.0、实际既有版本 1.11.0，在原基点 c286bc5 同样复现；另一项 host-contract 超时后单独重跑 2/2 通过。包相关检查 33/33。

ed0f5dc 精确全量：319 文件、3355 测试，3295 通过、11 失败、49 跳过。三项为上述原有版本断言；另外八个失败文件在相同源码下逐个串行重跑全部通过（合计 99 项通过、1 项跳过）。保留初次失败日志，不能把它描述为全量全绿。聚焦检查 122/122；独立 frame-selection 模块 5/5；安装前只读预检通过，模型启动数为 0。

日志分别保存在 O/N 根目录；N 的 `failed-files-isolated-rerun.json` 保存逐文件退出状态和原始输出。源码/安装包身份、宿主只读及实际终审绑定由 `audit-source.py`、`audit-mechanism.mjs`、`rc_closure.py` 检查。新分析没有修改生产代码，因此不为文档重复运行整套模型或全量回归。

当前样本不足以证明部分交付提高业务正确率；本轮已经证明的是整份提交会丢弃已完成的有用内容、前提选错会让完整账本放过真实错误、活动配置的入口条件可能超出独立评分覆盖。
