# ArkTS 逐例调优记录（2026-10-30）

本轮按用户要求逐个执行 13 个样本：真实业务运行 → 独立原生隐藏评分 → 阅读轨迹和源码 → 通用 harness 修复及回归 → 进入下例。目标是全量 F2P、P2P 尽可能达到 95%。所有样本均用于迭代开发，本轮不能宣称未见留出集泛化成绩。

工作分支为 `codex/rc-general-efficiency-bench`。MatrixAssistant、其 OpenClaw、数据集和 Huawei 工具安装只读。实验索引为 `.runtime-correction/system-optimization/serial-20261030/`。按编号 1–13 推进；每次尝试和独立评分各用新目录，保留失败及原始消耗。

## 初始修复与运行协议

- 已合入 `codex/rc-host-natural-completion` 的既有修复：公开业务终态校验、宿主维护运行身份隔离、压缩取消原因识别、真实历史/纠偏额度恢复、批量安装产物核验。
- 相关分组回归 74/74 通过。第一例在拉取 GitHub 源码时出现网络失败，尚无业务模型调用；原始日志保留在 `security_tool_1/calibration/`。
- 发现此前同仓 worktree 的完整 13 例原生校准证据。模型运行通过显式 `--cache` 复用共享源码对象；评分仍核验原始数据摘要及 base/gold 的原生覆盖日志，不重复下载。
- 当前第一轮使用 `glm-5.3-flash` 和冻结候选 `artifacts/round-001/runtime-corrector-openclaw`；业务宿主自然结束、RC 阶段 1800000ms、纠偏额度一次、仅启用 M16。后续如改变协议必须记录，不能混称固定配对比较。
- `scripts/summarize-arkts-iterations.mjs --suite=.runtime-correction/system-optimization/serial-20261030` 汇总全量 45 F2P / 7547 按任务累计 P2P。分别展示首轮和最新轮，不择优；未评分任务保留在全量分母，部分日志不计有效得分，业务/RC 接受数与测试解决数分列。

## 恢复

先读实验 `summary.json` 与各例 `attempt-*/progress.json`，核对 PID、命令、会话和冻结产物，再续接仍活跃的同一运行。不得因观察超时重新启动。当前第一例 `security_tool_1/attempt-001` 的初始 owner PID 为 21512，原生终端句柄为 63859。

每例结束后保存 `attempt-NNN-review.json`，记录原生评分、轨迹问题、源码定位、修复及其回归、下一步。隐藏测试与黄金补丁仅属于独立评分器，不能写入业务输入或下一样本提示。

## security_tool_1

首轮真实结果：F2P 1/1、P2P 611/611，原生评分完整、无解析错误；业务公开终态成功、RC PASS、两个私有角色全部结算。总时长 951327ms；提供方记录 1801034 tokens（含缓存），51 次请求均有正用量记录。该例完成，不代表全量已达 95%。

轨迹发现两项日志存储失败引起与问题无关的源码调查和三次本地测试。新增 `--baseline-local-tests` 在模型启动前执行原始本地测试，保存原始报告；`bench_check` 返回失败 ID、已有失败、新增回归和不再观察到的原始用例。原有失败仍保留为失败，不改变隐藏评分。原生无模型探针验证原始源码为 452 PASS / 2 FAIL；最终业务为 454 PASS / 2 FAIL，新增两项测试通过、无回归、无消失的原始用例，恰是同样两项既有日志失败。

新增用量/总体分母与本地诊断的专项测试通过；合并宿主修复后的完整工程回归为 174 文件 / 1888 用例，1865 pass、23 skip、0 fail。后续仅修改了实验 harness，包含诊断生成工具的相关 21 项测试通过。新增本地诊断测试文件未包含在那次全量计数中。

## security_tool_2（运行中）

原始本地基线 747/747 通过。`attempt-001` 以 `ed8e083` harness 启动，复用 round-001 插件，已实际使用基线功能；owner PID 18436、终端句柄 98858、项目 `.runtime-correction/b/biz-461830b02601`、会话 `b4b07782-5688-4a03-9d8e-5f53f08dd043`。完整输出在实验根 `security_tool_2-attempt-001.log`。

出现一次宿主原生 `Context overflow: estimated context size exceeds safe threshold during tool loop.`；宿主随后自动压缩并继续相同业务 run。`FINALIZING` 此时仍可能有实际模型调用，不得误报整次运行已结束，也不要重启。错误后仍在读取源码，需观察真实外层终态及最终补丁。

轨迹中 20 次原生 read 已返回约 193529 字符，单次最大约 31966 字符，包含大型源码/测试的广泛与重复读取。后续新增可选 `--paged-reads`：用 `bench_read` 替代业务原生 read，默认 120 行、最大 250 行，明确建议先定位符号再读相关范围。使用原有 UTF-8 原文分页，下一游标保留全部源码可达性、路径约束和私有角色隔离。633 行中文文件逐页完整比对、超大请求及目录逃逸的真实生成工具回归通过。当前运行不热改工具；下一次新运行/真实恢复才启用，保留协议差异和此前消耗。

独立阅读公开原始测试还发现 `viewmodel.test.ets` 的 `should keep policy state while refreshing application list` 固化了问题报告要求修改的旧行为。通用提示因此改为保护“无关的”通过行为；允许把直接固化所报缺陷的旧测试改成新需求并解释理由，明确禁止弱化/绕过断言以求通过。原始测试基线是观察证据，不是高于问题报告的规范；正式隐藏评分不变。
