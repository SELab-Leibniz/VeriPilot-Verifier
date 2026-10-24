# 全指标 Review 与完整 Stop 验证

**最新状态：完整长跑已按用户要求暂停。** 第04轮完成两次 CHECKER_ERROR 评估后宿主进程丢失，没有正式取消回执、自然超时或完整报告，不计通过。已合并全路径和已知失败审查，转为集中修复和逐层验证，见 [审查与验证门禁](stop-path-audit-20261024.md)。以下各阶段记录保留历史含义，不能将“待完成”理解成当前仍在运行；第4阶段从空代码开发尚未开始。

分支：`codex/all-metric-review-validation`。本轮按“隔离提示选择 → 生产工厂/收集器 → 完整 Stop → 空代码厨房开发”的顺序验证。阶段1检查点为 `c509619`；开始点为 `c64969a`。

## 隔离实验1：提示与角色

43个冻结案例覆盖本轮新增的12个指标。M01/M05/M12沿用上轮提示；其余指标有明确职责，复用同一只读执行器。开发集及留出集暴露的错误和第二版闭合提示的选择过程见 [实验说明](../../experiments/review-metrics-20261024/README.md) 与 [机器汇总](../../experiments/review-metrics-20261024/phase1-summary.json)。

固定输入汇总中，baseline为36/43，selected为43/43。共执行87个worker任务，另有8个同输入、同提示结果复用；任务数不是HTTP请求数。这是定向合成案例的结果，不能估计生产准确率。用于修正第二版提示的旧留出失败例已经成为开发回归。

## 隔离实验2：当前生产路径

支持单个CURRENT_TASK对象的TASK_COMPLETE评审。M01–M15按对象职责分流；M09/M12实现审查保留源码范围。STAGE_COMPLETE、分类、未知适用性及findings-only仍使用原生路径。没有宣称所有阶段都替换为新执行器。

M08保留原Skill及正式Skill Ground Truth绑定；过程/闭合角色读取所属原始事件，源码角色不接收整个过程。单项结果立即保存，失败不覆盖已完成结果。整体文件质量另由原生评审执行一次，不追加一个读取全部单项结果的总评Agent。文件质量补充仍不是逐文件隔离，且没有PASS缓存。

真实生产工厂与collector的新增13例全部完成，标签、诊断、职责及引用通过独立审计：12个新增指标及M09的第二角色，7 PASS、6 DEVIATION，最大反馈1442字节。没有在这13例中生产采样UNVERIFIED；过程记录是合成材料，不能当真实业务执行。轨迹位于 `experiments/review-metrics-20261024/integration-plan/live-01/`；独立审计位于 `.runtime-correction/all-metrics-lab-20261024/phase2-semantic-audit.json`。

旧7例回归全部完成收集，6例符合基准；F08把永久emoji误作所需图片加载占位而给PASS。该项已读全必读材料，源码引用有效，实际使用正确提示；这是模型语义漏检，不是输入丢失或overflow。K09缺少业务执行证据，由程序直接保留UNVERIFIED；因此该轮为6个模型worker任务加1个程序结算，不能写成7个模型任务。失败原样保留在 `.runtime-correction/stop-integration-allmetrics-regression-01/`，独立审计为 `.runtime-correction/all-metrics-lab-20261024/legacy-regression-semantic-audit.json`。

随后只做一个M12源码候选、严格5次worker任务的有界探针：旧v2与新v3在同一F08输入都判对，另三个v3正负对照也正确。v3未展示相对提升，单次F08还更慢、累计输入更多，因此不接入，生产继续v2。原误PASS不被复测成功覆盖。结果及计量边界见 [探针摘要](../../experiments/review-metrics-20261024/m12-stability-summary.json)。

全仓回归：1248项，1239通过、9跳过、0失败，242.2秒。日志为 `.runtime-correction/all-metrics-lab-20261024/full-regression-01.log`。完整回归证明机制兼容，不消除上述真实模型漏检。

## 完整 Stop 与空代码开发

第三阶段前两轮发现路由覆盖遗漏，第三轮已进入真实新执行器但暴露候选身份误判；三轮均保存证据后正规取消，均不算完整Stop通过。正在用冻结失败输入做候选身份小实验，第四阶段尚未启动。入口与输入保护见 [隔离宿主计划](../../experiments/review-metrics-20261024/e2e-plan/plan.md)。实际测试使用新端口、独立state/home和原生worktree；原业务项目、原session及18789宿主保持只读。原厨房合同、Skill和21场景verifier保持原字节，不扩大产品预算。

完整Stop以实际非空population、正式终态、原生续作receipt及独立业务验收判定。启用配置不等于角色已触发，空指标分母不计通过。厨房从空代码开发阶段由真实业务模型写实现，观察器不复制或修补业务代码。

第三阶段前置流程已暴露一项真实误报：原归档App在Windows的verifier隔离子进程中因默认cp1252输出Unicode失败；模型首次显式UTF-8修复其实有效，但原生产物评审把子进程编码错误推成父进程也以cp1252解码，建议撤销该修复改成ASCII-safe。独立离线副本使用原字节verifier及相同父环境，复现原版失败、首修21/21通过，并经另一协作者核对输入来源与产物；这是一次复现实测加独立产物审计，不是两次执行。其后模型先撤销有效修复，中间快照真实回到失败实现，又触发一次有据反馈，不能把两条反馈都称误报。首轮主任务约18分48秒后进入真实Stop，该耗时不是单项Review时间。原始轨迹在 `experiments/live-kitchen-stop-20261024-01/`，反例及源码指纹在 `.runtime-correction/all-metrics-lab-20261024/encoding-audit/report.json`。

首次完整Stop形成92个指标对象，另有1个独立文件质量任务。自然GT的34条声明均用`main-task`表示当前主任务，使78个对象回退native；13个Skill对象为`CURRENT_TASK`，另1个为`if verification fails`，后者仍需原生适用性判断。此时没有形成新SDK worker，不能用这轮宣称新路径通过。原生首项120秒超时保留UNVERIFIED，后续已完成PASS仍落盘；不是整个Stop崩溃。

最小修复仅在eligibility识别明确的`MAIN_TASK`/`CURRENT_TASK`等价拼写，保留原缺省兼容，不改写原始GT、对象或分母。条件、未来、未知及异常类型继续原路径。新增跨15指标路由和原字节GT不变回归，定向59/59通过；连同factory与兼容层再验75/75通过。重测将使用新task及本轮最终真实21项成功对应的冻结源码`02c4bfc9f2f35c15406f7aeb27be3b3966972adffa48ecd6e68f5657e21e2716`，避免旧native缓存混作新worker证据；观察窗口跟随产品原有Stop截止，而非让实验自身的30分钟观察窗提前终止健康流程。产品70分钟组合上限不变。

首轮采用仅本隔离会话的公开`sessions.reset`触发`before_reset`，Stop正式结算`SETTLED/CANCELLED/RC_STOP_CANCELLED`，自己的56081端口已关闭；原session、完整runtime、collection及源码先行冻结，3个已完成单项保留。它是因新执行器覆盖不足而由实验控制器主动中止，不能算产品自然超时或通过。取消前原生项另有一次120秒超时、一次64工具调用上限及两次累计读取上限；它们与整体取消原因分别记录。源中`runtime-corrector.control`在本native入口未注册，实际请求unknown method未写状态，未旁路手写task/session。短结算见 `experiments/live-kitchen-stop-20261024-01/stage3-cancelled-summary.json`。

第二轮在`9bdf238`上用相同冻结02c4源码、合同及政策重测，真实业务模型再次跑原verifier退出0、21项PASS，但自然GT使用24种自由范围标签，例如`file modifications`、`pantry set command`。形成105个对象加1个质量项；全部不匹配旧别名白名单，实际只启动的两个native项均触及累计读取上限，新SDK任务仍为0。观察器按产品原70分钟截止运行，没有人为30分钟截断；为修复协议再次通过仅本隔离会话的reset正规取消，1206端口已关闭。没有为通过而删除条件或调整预算。短结算见 `experiments/live-kitchen-stop-20261024-02/stage3-cancelled-summary.json`。

别名补丁未能解决自由文本控制路由的根因。新方案保留原范围字段，另加固定枚举`applicabilityKind`。例如第二轮c30正文仅“R02: Retain zero-amount entries.”，其`applicability="pantry set command"`是有效的命令限定，不能直接覆写为CURRENT_TASK或依赖模型重新搬入正文。新枚举只选择执行器，原义务、条件、范围及来源仍完整传入；未知/未来/条件型保守走原路径。严格要求只用于新模型生成，旧持久化文档继续兼容；没有额外分类Agent或新工作流。

协议补丁的7模块定向回归161/161通过；补强真实生成入口后的CLI、OpenClaw模块分别16/16通过。另一协作者只读复核schema→ledger→population→adapter完整传播、两种宿主initial/followUp严格校验、旧文档兼容及cache v3，未发现阻断。新字段不能证明条件成立、指标适用或义务满足；原数据缺字段不被自动迁移，新legacy更新也不继承失效旧标签。真实worker路由仍需03轮验证。

全仓第一次使用仓库内`.tmp`作为TEMP，触发打包测试递归复制自身，属于实验临时目录设置错误；失败日志保留为`full-regression-typed-protocol.log`。改用系统临时目录及允许本地测试子进程后重跑，没有为此修改产品或断言。该轮1289项：1279通过、9跳过、1失败，208.7秒；唯一失败是已有hook测试的新生成Skill替身缺少kind/condition，触发额外一次格式修复。仅补齐该替身的新输出字段后，所属模块3/3通过，生产、断言及旧持久化fixture不变。日志为`full-regression-typed-protocol-system-temp.log`及`typed-applicability-runtime-hook.log`；没有将全仓失败日志覆盖成全绿。协议提交为`9dc428c`，真实03来源及准入检查冻结于`8c18fde`。

03轮自然GT为37条有效声明（36 CURRENT_TASK、1 CONDITIONAL），形成84对象加1质量项；83对象保留CURRENT_TASK、1条件项保守回退。独立只读重建population摘要与正式collector一致；实际新SDK执行证明kind经过schema、ledger和population传播，修复了前两轮的路由遗漏。真实业务模型再次运行原verifier，退出0/21项通过，源码仍为02c4。

但新执行器暴露了另一个实际错误。首M01在120秒截止前未提交：14轮、约89,949工具字节，无无效工具或字面重复行，最终观测上下文估计64,870，未见overflow；已经读完所需basis后仍寻找未经鉴定的需求拆分候选，并无必要整读约30KB原GT。后续worker `0de81f5e`把RC config当候选而给PASS，`2cc7314b`又因该config缺少read/write/edit约束而给DEVIATION。独立审计确认两者引用字节真实、候选角色错误：原任务要求保留配置，从未要求它承担需求拆分。不能据此要求改配置或新建被禁止的文档。

根因是adapter把任意`permittedTargets[0]`作为非空目标种子，实际为`project/.runtime-corrector/config.yaml`；模型将导航提示误认成候选身份，又在候选缺失时扩大搜索。现有检索工具已经足够，先用冻结失败输入及真实候选正反对照验证最小提示修复，不增加大索引、总结Agent、验收条件删减或预算。03先完整保存运行态、全部worker/collection、原会话与源码后，仅经本隔离22656会话的公开reset正规结束，Stop为`SETTLED/CANCELLED/RC_STOP_CANCELLED`。这属于因错误评审前提主动取消，不是产品自然耗尽预算；首项超时及取消前已提交的错判均保留，不能算完整Stop或语义通过。短结算由03目录保存，独立审计为`.runtime-correction/all-metrics-lab-20261024/stage3-03-independent-audit.json`。

## 候选身份的最小迭代

M01小实验共5个worker：v1修正了真实错D及K01/K02正反对照；同一首项超时输入在v1完成U，但诊断附带一句被原spec反驳的全局否定。v2仅约束U诊断不编造全局缺失，同一输入完成U、主诊断与引用通过独立复核，但耗时59.531秒、工具114722字节，均高于v1的30.137秒、25709字节，不能宣称效率提升。v2未重跑正反对照。M02/M05各P/D/U共6个有效样本均符合基准；此前6个sandbox传输失败任务无有效回复，保留在分开目录，不计语义通过。最终仅采用这三个已审计提示，未改其它角色。精简来源见 [候选身份汇总](../../experiments/review-metrics-20261024/candidate-identity-summary.json)。

去掉错误首文件种子后的真实工厂K01/K04能找到真实候选并PASS，但同一03首项、同33个文件、只将targetFiles置空的独立探针仍在119.957秒未提交。完整basis约2.9秒已读完，后来继续搜索候选；峰值上下文估计55174/200000，没有overflow或compact。该探针没有读完整GT或过程索引，不能继续把失败统称“大索引”。结论是提示与自由发现仍不能封闭缺候选路径；两例真实候选P不能覆盖这个失败。

因此增加一处程序输入前提：父Stop按已有artifact.metrics明确声明及精确路径归属，一次建立带文件SHA与声明身份的候选表。产物证明未绑定时，由程序给原对象U并继续其它项，不再让每个模型独立搜索整个项目；有绑定仍进行真实审查并要求候选引用。metricCheckpoint或源码配置不推断为需求/验收候选。没有删指标、改适用条件或整体改为PASS；旧caller没有声明也会保留U，历史对话候选尚无新绑定协议。声明配置与所有候选即便未被引用，也进入缓存和发布失效检查。新机制必须再经小实验和完整Stop验证，不能用上述提示小实验代替。

候选桥接定向producer/caller52、adapter90、collector/cache84项各自0失败；这些集合有重叠，不能相加作独立样本数。外部配置只作为程序哈希依赖，既不进入模型源码，也不因业务根路径校验而漏掉失效检查。绑定比较列表在当前collection冻结；下一Stop重收集会发现新增匹配文件，本轮没有增加每项重新glob的目录实时监视。

原03首项在同33冻结文件、同原GT及对象上的正式adapter离线重放，23ms程序U、0worker、分母1/分子0，所有输入字节不变；没有宣称模型完成了原超时任务。离线共调用adapter两次：首回同样U，但后验断言误用captureFiles元数据而未写完报告，修正实验断言后第二次验证成功；生产未改。真实工厂/collector另跑9个明确绑定案例，7P/2D全部独立审计正确，完整basis全读、12段引用字节核验、0native回退，每例一个worker。K02确缺missing短缺对象，K05确缺成功cook扣减/持久化路径；其余五类产物职责没有被要求执行业务。最大反馈1340字节。它们采用fixture已有候选manifest声明，不包含oracle，不代替配置producer到完整Gateway的04验证。

候选绑定全仓首轮1346项：1332通过、5失败、9跳过，195.4秒。一个旧路由协议测试缺少显式候选，正确被新前提挡在worker前；仅补齐fixture候选，保留原字节传播及worker断言。其余四项涉及原短时限，仍待复测，不据并行负载推定原因。原日志为`full-regression-candidate-binding-01.log`，没有覆盖成全绿。

补齐fixture、结束小模型并行后第二次全仓1346项：1336通过、1失败、9跳过，154.8秒；原四项短时限中三项通过，剩余SessionEnd“stdin不结束”看门狗在1301.8ms被测试的1200ms外部截止杀死。其独立模块随后7/7通过，该case约1010.9ms；SessionEnd脚本及原时限断言均未修改。这说明单独运行可完成，仍保留全仓并发时限失败这一事实，不把第二轮报告写成全绿。日志分别为`full-regression-candidate-binding-02.log`、`session-end-process-isolated.log`。Stop变更和真实9例均已通过对应门禁，后续按冻结来源进入04，既有并发SessionEnd时限边界不通过修改其它插件环节绕过。

## 交付边界

插件版本为 `1.9.1-openclaw.11-session-projects.12`。整个顶层experiments目录不进入安装包，避免夹带实验宿主认证状态、原始会话及外置oracle。原始模型轨迹保留在忽略目录，冻结输入与精简审计单独保留。

本文件在后续阶段完成后更新真实结果。当前不是“全流程已通过”的报告。
