# 全指标 Review 与完整 Stop 验证

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

第三阶段首轮在 `8506ff9` 代码上发现路由覆盖遗漏，已保存证据并正规取消；修复后的第二轮尚待执行，第四阶段尚未启动。入口与输入保护见 [隔离宿主计划](../../experiments/review-metrics-20261024/e2e-plan/plan.md)。实际测试使用新端口、独立state/home和原生worktree；原业务项目、原session及18789宿主保持只读。原厨房合同、Skill和21场景verifier保持原字节，不扩大产品预算。

完整Stop以实际非空population、正式终态、原生续作receipt及独立业务验收判定。启用配置不等于角色已触发，空指标分母不计通过。厨房从空代码开发阶段由真实业务模型写实现，观察器不复制或修补业务代码。

第三阶段前置流程已暴露一项真实误报：原归档App在Windows的verifier隔离子进程中因默认cp1252输出Unicode失败；模型首次显式UTF-8修复其实有效，但原生产物评审把子进程编码错误推成父进程也以cp1252解码，建议撤销该修复改成ASCII-safe。独立离线副本使用原字节verifier及相同父环境，复现原版失败、首修21/21通过，并经另一协作者核对输入来源与产物；这是一次复现实测加独立产物审计，不是两次执行。其后模型先撤销有效修复，中间快照真实回到失败实现，又触发一次有据反馈，不能把两条反馈都称误报。首轮主任务约18分48秒后进入真实Stop，该耗时不是单项Review时间。原始轨迹在 `experiments/live-kitchen-stop-20261024-01/`，反例及源码指纹在 `.runtime-correction/all-metrics-lab-20261024/encoding-audit/report.json`。

首次完整Stop形成92个指标对象，另有1个独立文件质量任务。自然GT的34条声明均用`main-task`表示当前主任务，使78个对象回退native；13个Skill对象为`CURRENT_TASK`，另1个为`if verification fails`，后者仍需原生适用性判断。此时没有形成新SDK worker，不能用这轮宣称新路径通过。原生首项120秒超时保留UNVERIFIED，后续已完成PASS仍落盘；不是整个Stop崩溃。

最小修复仅在eligibility识别明确的`MAIN_TASK`/`CURRENT_TASK`等价拼写，保留原缺省兼容，不改写原始GT、对象或分母。条件、未来、未知及异常类型继续原路径。新增跨15指标路由和原字节GT不变回归，定向59/59通过；连同factory与兼容层再验75/75通过。重测将使用新task及本轮最终真实21项成功对应的冻结源码`02c4bfc9f2f35c15406f7aeb27be3b3966972adffa48ecd6e68f5657e21e2716`，避免旧native缓存混作新worker证据；观察窗口跟随产品原有Stop截止，而非让实验自身的30分钟观察窗提前终止健康流程。产品70分钟组合上限不变。

首轮采用仅本隔离会话的公开`sessions.reset`触发`before_reset`，Stop正式结算`SETTLED/CANCELLED/RC_STOP_CANCELLED`，自己的56081端口已关闭；原session、完整runtime、collection及源码先行冻结，3个已完成单项保留。它是因新执行器覆盖不足而由实验控制器主动中止，不能算产品自然超时或通过。取消前原生项另有一次120秒超时、一次64工具调用上限及两次累计读取上限；它们与整体取消原因分别记录。源中`runtime-corrector.control`在本native入口未注册，实际请求unknown method未写状态，未旁路手写task/session。短结算见 `experiments/live-kitchen-stop-20261024-01/stage3-cancelled-summary.json`。

## 交付边界

插件版本为 `1.9.1-openclaw.11-session-projects.12`。整个顶层experiments目录不进入安装包，避免夹带实验宿主认证状态、原始会话及外置oracle。原始模型轨迹保留在忽略目录，冻结输入与精简审计单独保留。

本文件在后续阶段完成后更新真实结果。当前不是“全流程已通过”的报告。
