# 基线接回 RC 的真实任务闭环

此流程在真实 benchmark 环境中调用原生业务 Agent，再由现有 RC 执行基线提取、独立覆盖审查、终审反馈、业务修复与当前验收。
当前只开发基线接入所需的部分；独立 Skill 和文档纠偏关闭，Stop 中适用的检查沿用原实现。

## 固定样例

- Benchmark：Terminal-Bench。
- 任务：`llm-inference-batching-scheduler`。
- 原始任务仓库提交：`7131e4375048a0e408a8fb404b5f499d726b695b`。
- 原始需求：4365 字节；SHA256 `0817374767533fbf51bb93345ee1bba266263c216c6cc55c096e71b4a1d37dfc`。
- 原始镜像：`alexgshaw/llm-inference-batching-scheduler:20251031`，镜像 ID `sha256:19e79aa49be4e55dccca1dde966515ebe6852314b6010bcb9230afb48b996774`。
- 模型：`glm-5.3-flash`，显式 `reasoning_effort: low`；宿主：OpenClaw `2026.7.1-2`。

样例包含两组请求、逐请求唯一性、批次形状一致性、64 对齐、固定 heads/hidden 维度、跨两组的 8 种形状上限、8 个性能阈值和输入保持不变等要求。
原文中的背景、参考程序和较差基线成绩不能被新增为交付要求，也不能替代目标阈值。

## 配置与实验边界

`config/baseline-bench.yaml` 保留动态需求基线、实现纠偏和 Stop，关闭独立 Skill/文档纠偏与多次 onboarding 抽取。
第 7 次使用组件已有的 `baselineWireMode: full`，从完整语义提交候选；完整原文读取、原文绑定、独立覆盖审查、修复预算和正式发布检查均保留。默认工作流的编码选择不变。
当前大预算配置位于 `config/baseline-bench-limits.json`，通过冻结清单 `agentKwargs.rc_baseline_limits` 传给插件的 `baselineLimits`：提取与覆盖审查共用 `timeoutMs: 86400000`（24 小时）、`maxSteps: 2000`；`maxRepairs`、`maxAuditCalls`、`maxExternalRepairs` 均为 2000。steps 是共享模型步数，所有审查和修复仍需从同一份原始预算扣除，不因新一轮审查重新计时。
可信配置可以调大这些有限值。普通工作流未配置时仍沿用原有默认；该配置只扩展基线任务。有效但不确定的 UNRESOLVED 报告原样保留，在原始预算内重新发起独立、先读原文的审查。模型正常返回但尚未提交有效 finish 的尝试，必须先确认其原生进程已准确结算，才能在原额度内重试；传输错误、预算到期、证明不完整及已接受提交缺少持久化证明均继续失败。不确定或未完成不等于 PASS。
原文引用反馈会定位具体单元、引用 ID 和实际路径，明确区分原文与导航目录引用；反馈不产生新引用，也不改变语义归属。
当前 profile 另将 `auditUnitBytes` 配为 `16384`，避免把这份 4364 字节的宿主原文及其阈值表切成三个小块。该选项仅调整有界原文传输单元，纳入审查身份；普通默认仍为 2048 字节，UTF-8/CRLF、完整原文读取、全部义务及多归属检查不变。较大要求仍分成多个有界单元，不截断内容。
漏读反馈列出准确文件与行范围；缩短的 inventoryDigest 会得到完整的已封存身份值供核对，程序不代填报告。宿主把明确拒绝的工具返回记为 `isError:false` 时，仅凭完全一致的原生调用、拒绝内容和私有负面记录认可这条失败记录；它不能产生引用或读取覆盖，额外内容及引用仍拒绝。
审查可用 `CANDIDATE`、`owner: CONTEXT`、空 `obligationIds` 指出有实际 claimId 的多余候选条目，仅能给出 REPAIR。该意见不计入任何原始义务的覆盖，不自动删除条目；提取器明确修订后，新的独立审查仍须覆盖全部原始义务和保留的有效条目。
单轮 Stop 验收为 25 小时，业务纠偏窗口为 15 分钟；普通角色单次窗口为 30 分钟。提交前的结构修复和语义反馈修复共享原始修复预算与步数。
宿主 `diagnostics.stuckSessionAbortMs` 和模型网络窗口随总任务时限配置，避免默认无进展恢复中断仍在输出的推理流。GLM 5.3 强制思考，宿主的 `off` 映射到提供方支持的 `low`；未发送禁用思考参数（[官方说明](https://docs.z.ai/guides/capabilities/thinking)）。
当前试验显式配置宿主 `hookTimeoutMs: 86460000`，为基线窗口预留返回时间；真实任务总窗口为 30 小时，启动器外层为 31 小时。审查中越界翻页作为带原生调用身份的失败回执保留，不产生引用或读取证明；后续有效读取仍必须完整完成。
前 3 次开发运行把整体业务窗口从原任务的 30 分钟放宽到 60 分钟，第 4–7 次为 90 分钟；第 8 次起采用上述可配置大预算。原始输入、性能阈值和官方评分器保持不变。
结果属于放宽时间预算的开发验收，不用于排行榜或 OFF/ON 收益比较。

第 6 次起直接观察真实任务自然产生的偏差，不再加入故障注入插件。前面的尝试没有得到实际注入回执，也没有宣称完成反馈修复。
第 5 次的候选已产出两份计划，公开成本模型显示两组的 sequential timecost 超过原始阈值；原始评分器的独立环境预检也确认性能检查失败。
这些既有候选和评分器报告不进入新业务 Agent 的提示；新一轮继续只提交原始任务全文。

评分器原本在下载 uv 时网络失败，未能执行测试。可选 `rc_verifier_uv_archive` 预置其同版本上游 uv 0.9.5 二进制，仅作为环境依赖；原始评分器脚本、测试、输入和阈值不修改。
归属提示明确：交付产物的内容/结果属于 ARTIFACT，写出产物这一附带动作本身不新增 PROCESS 义务；原文独立要求的执行/验证、主体、顺序和证据仍保留 PROCESS。

## 运行与证据

沿用现有入口 `scripts/bench/run-harbor-gateway-pilot.mjs`，冻结清单使用 `baselineExperiment.kind: baseline-e2e-v1` 和单独的 `on` 运行。
原始任务、冻结源码、插件产物、镜像、环境缓存及配置在启动前确定。实际运行使用一次性输出目录。
上游密钥只通过 `RC_HARBOR_UPSTREAM_CREDENTIAL` 临时进入外部控制进程，Docker 内只有可撤销的代理凭据。

本次目录为 `.runtime-correction/baseline-bench/scheduler/`：

- `public-source.json`：原始任务身份及开发时间预算调整。
- `manifest-001.json` 至 `manifest-011.json`：逐轮冻结的输入和配置。
- `bootstrap/result.json`：容器内实际宿主的无模型启动结果。
- `run-001/`：首轮失败原始记录。宿主无进展恢复中断原业务；当时尚无候选产物、基线或故障注入，第 6 次请求用量未知，完整保留其预留额度。
- `run-002/`：10 分钟基线审查耗尽预算，候选未发布。反馈已区分多义务映射数量错误与实际归属错误；保留第 29 次用量未知的完整预留额度。
- `run-003/`：原文单元与义务引用不一致多次无法定位，操作员停止本轮以应用精确定位反馈；未完成，官方评分不可用，第 41 次请求用量未知并保留预留额度。
- `run-004/`：发现提交前校验耗尽唯一语义修复机会，启动后在任何模型请求前停止；实际请求数为 0。
- `run-005/`：业务产出两份计划，基线审查仍未确定；第 40 次请求收到上游 401，终审未完成。原评分器下载依赖失败，不能把 reward=0 解释为有效性能评分。
- `verifier-preflight-006/`：使用第 5 次既有候选、原始镜像及未改动评分器的独立环境预检。5 个测试通过、1 个性能测试失败；不覆盖原试验记录。
- `run-006/`：独立审查有效提交 REPAIR，但一次越界翻页未被登记为失败回执，复验以 `Source disclosure lacks its exact owned gate transaction` 拒绝；操作员停止旧版本并修复此程序问题。
- `run-007/`：有效独立审查多次要求修复，旧版一次语义修复/两次审查限制不足，基线未发布；为应用新配置中止，保留未知请求的预留额度。
- `run-008/`：大预算版本首个模型请求收到 HTTP 429 / 1302，业务未开始，未知用量预留额度保留。
- `run-009/`：真实预算已跨过旧版两次审查上限。第三次审查把导航目录引用加入原文引用，重复校验后正常返回但未提交有效 finish；为补齐具体错误定位与未完成审查恢复而中止。
- `run-010/`：长审查重复漏读候选末尾文件，并缩短清单身份值；固定版本只有通用反馈，最终仍未发布。中止后保留原生记录，并增加具体缺失范围、身份核对和多余条目修复支持；业务未产出计划文件。
- `bootstrap-011/result.json`：当前版本在实际容器/OpenClaw 中的无模型启动结果。
- `run-011/on/external-controller/`：24 小时 / 2000 steps 配置下的全部模型请求、统一计量和原始响应。
- `run-011/on/jobs/`：官方任务运行、原生业务轨迹和官方评分输出；启动不代表已经通过。
- Agent 日志中的 `rc-runtime/host-run/baseline-summary.json`：发布后的基线、当前验收和证据目录。
- 基线未发布时，收集器也返回明确 `UNPUBLISHED`、版本 0 和当前验收状态，保留任务记录；不会以缺少 current.json 的普通文件错误掩盖未完成原因。

验收应分别核对基线覆盖、实际反馈与修复、当前 RC 验收、原生进程结算及官方任务评分。
运行结束、模型声明完成或 RC 的 PASS，均不能单独替代这些结果。


## 在本机重跑

先等同一份安装缓存的现有运行完全退出，再指定新的输出目录。冻结清单和任务目录已保存在上述实验目录中；不要覆盖旧运行。

```zsh
bench_root="$PWD/.runtime-correction/baseline-bench/scheduler"
read -s 'RC_HARBOR_UPSTREAM_CREDENTIAL?GLM key: '
export RC_HARBOR_UPSTREAM_CREDENTIAL
node scripts/bench/run-harbor-gateway-pilot.mjs --live \
  --manifest "$bench_root/manifest-011.json" \
  --output "$bench_root/run-$(date +%Y%m%dT%H%M%S)"
unset RC_HARBOR_UPSTREAM_CREDENTIAL
```

入口使用本机现有 Docker、固定版本 Harbor 和冻结的 OpenClaw 安装缓存。所有业务、提取、覆盖审查、Stop 和修复请求共用外部控制器的原始时限与计量。需要调整预算时创建新的冻结清单；已运行的源码、产物、任务和清单不原地修改。
