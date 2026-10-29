# 两案例原生 F2P/P2P 对照（2026-10-29）

## 运行前固定协议

- 用户要求：跑完 1 个方案选择案例、1 个留出案例，对比 F2P/P2P。
- 方案选择：`security_tool_3`；留出：`security_tool_2`，均遵循既有开发/选择/留出划分。
- 候选冻结：`7cbd6989681d70d396d8236f67ea419db3849502`；原版：`c33bae6`。不根据本轮选择结果修改候选后再测试留出。
- 冻结候选产物：`.runtime-correction/system-optimization/candidates/7cbd698/runtime-corrector-openclaw`，6 个公开 Skill 通过实际宿主 YAML 解析。新增修复预检 22/22 通过。
- 实际宿主：只读 MatrixAssistant 内置 OpenClaw `2026.7.1-2`；业务及私有模型均为现有配置 `glm-5.3-flash`。业务工具、原始公开输入、预算、原生工具链、隐藏评分与公共导航两组相同。
- 用户明确允许使用 `C:\Program Files\Huawei\command-line-tools` 且不打开 DevEco Studio IDE。本轮通过该 CLT 的 ohpm/hvigorw 完成准备与原生本地测试；不启动 IDE。DevEco CLI 已核对无 Local Test 子命令。
- 公共导航继续冻结 `candidates/0b72285/runtime-corrector-openclaw`，避免将业务工具变化当作 RC 候选收益。模型仅见公开问题、提示和 base 源码；黄金及隐藏测试只进入独立评分 worktree。
- 实验目录：`.runtime-correction/system-optimization/paired-two-case-7cbd698-001`。无模型计划：`paired-two-case-7cbd698-plan-001`。
- `security_tool_3` 的已完成 c33 运行从 `paired-blank-selection-001/results.json` 复用；比较入口逐字节验证公共协议、模型、产物、提供方端点，且原生隐藏评分已执行。此前中断的 bacea56 候选不复用、不计有效成绩。旧 c33 业务运行的提供方 18 次请求只有 17 条正 usage，用量总数未知；不得从中推断省 token 或同等完成度效率。
- 顺序：选择原版（已完成且资格核对通过）→ 选择候选 → 留出候选 → 留出原版。所有业务项目检查和隐藏原生评分串行，避免 Windows Previewer 端口竞争。无自动重试，保留失败和中断。
- 本轮只验证这两个案例的观察成绩，不代表全部 13 例或统计显著提升；编译、回归测试和模型声明不能代替逐项原生测试结果。

## 压缩恢复

先读实验目录的 `progress.json` 和 `manifest.json`，核对 owner PID 与实际命令再观察原运行，不重复启动。协调 owner PID `22268`，启动终端句柄 `73605`；首个候选 owner PID `19652`。原始日志 `paired-two-case-7cbd698-001.log`。运行期间不得更改公共协议文件或冻结产物；不并发执行全量工程回归或其他 Previewer 测试。原始输入、补丁、成绩和用量由已有比较入口保存。

当前进度：四组实际产物均已完成独立隐藏原生评分，结果固定于 [去敏结果](rc-two-case-validation-20261029.results.json)。两条留出运行的宿主终态核对异常保留，完整配对工作流未正常完成；不把提交评分冒充端到端正常验收。

已复核的原版选择案例：F2P 1/1、P2P 595/595。该例原版已达上限，当前版即使全过也只能证明这一观察不退化；不能声称严格提升。原版业务因预算未正常完成、未进入 RC 审查，隐藏评分通过和流程完成度必须分别呈现。

选择案例当前版：业务正常结束，基线提取器和停止审查器均 SETTLED；RC 终态为 UNVERIFIED，不是 PASS。最终原生隐藏评分仍完整通过 1/1 F2P、595/595 P2P。严格区分“测试补丁通过”与“RC 已完成验证”。

## 留出当前版的运行异常与续行规则

- 留出当前版 owner `23784` 在 10 分钟业务预算到期后由原控制端实际 `chat.abort`，宿主真实轨迹记录原 run 的 `session.ended` / `aborted=true`。没有成功 write/edit，实际 `candidate.patch` 为 0 字节。
- 公开 `agent.wait` 终态核对未及时结算，post-run 保持 FINALIZING；原 16 分钟评测窗口结束，记录 `infrastructureComplete=false`。原协调器 `22268` 随后停止为 NEEDS_ATTENTION。两者均已实际退出；不伪造终态、修改产物或把这条运行算成正常闭环。
- 为完成用户要求的代码 F2P/P2P 对比，保留原始 `results.json` / `progress.json`，另建 `post-failure-continuation.mjs` 和 `continuation-plan.json`：对固定预算后的真实空补丁执行独立原生评分，再只启动尚未开始的留出原版。原版若也未正常结算，采用相同规则计分并单列运行失败。
- 这是原流程异常后的**补充提交评分**，不是完整运行成功的证据；该规则在原版结果出现前固定。模型不重试，输入、业务与审查预算、原版/候选、公共工具协议及隐藏测试分母均不变。续行入口逐字节核对冻结协议和两份产物，并验证旧 owner 已退出及真实宿主中止记录。
- 续行终端句柄 `97990`，状态 `continuation-progress.json`，结果 `continuation-results.json`；原始协调器的 NEEDS_ATTENTION 原样保留。恢复时观察续行状态，切勿重新启动原比较或重复模型。
- 14:29 补充原生评分完成：留出当前版真实空补丁 F2P 0/2、P2P 746/746，所有预期测试均执行。续行 owner `13236` 随后只启动原版，原版 owner `36164`，真实业务开始于 14:30:38；14:40 达到同一 10 分钟业务预算并中止，仍在等待原 16 分钟评测窗口结算。不得把未结算的原版推断成通过或把当前版空补丁评分称为正常运行成功。

## 最终观察结果（14:48）

- **方案选择 `security_tool_3`**：原版 c33bae6 与当前版 7cbd698 均为 F2P **1/1（100%）**、P2P **595/595（100%）**。原版业务未正常完成且没有 RC 审查；当前版业务正常完成，但提取与审查共用预算耗尽，RC 原因码 `STOP_ASSESSMENT_STOP_REVIEW_DEADLINE`，最终为 UNVERIFIED。
- **留出 `security_tool_2`**：两版均达到 10 分钟业务实现上限，均未成功 write/edit，实际补丁均为 0 字节；取消后的公开终态核对未在原 16 分钟评测窗口内结算。对两份实际空补丁分别执行独立原生测试，均为 F2P **0/2（0%）**、P2P **746/746（100%）**。这是失败尝试的真实产物成绩，不是正常完成的任务。
- 按任务累计，两版 F2P 均为 **1/3（33.33%）**，P2P 均为 **1341/1341（100%）**。按任务宏平均 F2P 均为 50%；P2P 存在跨任务重叠，累计计数不代表 1341 个独立观察。
- 两例观察准确率相同，没有严格提升的证据。没有重跑失败模型、改候选、删失败或缩小测试分母。它不代表其余 11 例、统计显著性或某项改动的因果收益。
- 所有四组的提供方 usage 覆盖均不完整，且审查完成度不同，因此 **不具备 token/耗时改善结论的资格**。已报告用量是下界，缺失请求不得记作零消耗。
- 原始 `results.json` / `progress.json` 保留原协调器的 NEEDS_ATTENTION；续行 `continuation-results.json` / `continuation-progress.json` 为 SETTLED_WITH_RUNTIME_FAILURES。`observed-report.json`、本仓库去敏结果和 `summary.json` 分别保留逐例成绩及聚合，明确 `codeScoringComplete=true`、`normalPairedWorkflowComplete=false`。
- 离线报告核对实际提交与评分保存的补丁 SHA256、原始评分与协调器快照、逐例相同测试分母、无缺失预期测试；原始输入、用量、运行错误、日志和模型补丁均保留。使用用户指定 Huawei CLT，未打开 DevEco Studio IDE。

下一步应先复现并解决“长时间检索未产出修改”和“取消后公开终态未结算”的问题，再以新的固定协议验证；这两个已观察案例不能再作为未经观察的留出。完整 13 例的准确率和效率目标仍未达成。
