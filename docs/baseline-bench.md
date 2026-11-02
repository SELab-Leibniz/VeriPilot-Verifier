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
提取/审查角色窗口和单轮验收均为 30 分钟，业务纠偏窗口为 15 分钟，格式修复最多 20 次。所有步骤继续受原始总时限约束。
提交前的结构校验修复使用这份共享次数预算；独立覆盖审查保留最多一次语义修复和两次审查，不会因前面的输出路径错误失去语义修复机会。
宿主 `diagnostics.stuckSessionAbortMs` 和模型网络窗口随总任务时限配置，避免默认无进展恢复中断仍在输出的推理流。GLM 5.3 强制思考，宿主的 `off` 映射到提供方支持的 `low`；未发送禁用思考参数（[官方说明](https://docs.z.ai/guides/capabilities/thinking)）。
前 3 次开发运行把整体业务窗口从原任务的 30 分钟放宽到 60 分钟；后续放宽到 90 分钟。原始输入、性能阈值和官方评分器保持不变。
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
- `manifest-001.json` 至 `manifest-006.json`：逐轮冻结的输入和配置。
- `bootstrap/result.json`：容器内实际宿主的无模型启动结果。
- `run-001/`：首轮失败原始记录。宿主无进展恢复中断原业务；当时尚无候选产物、基线或故障注入，第 6 次请求用量未知，完整保留其预留额度。
- `run-002/`：10 分钟基线审查耗尽预算，候选未发布。反馈已区分多义务映射数量错误与实际归属错误；保留第 29 次用量未知的完整预留额度。
- `run-003/`：原文单元与义务引用不一致多次无法定位，操作员停止本轮以应用精确定位反馈；未完成，官方评分不可用，第 41 次请求用量未知并保留预留额度。
- `run-004/`：发现提交前校验耗尽唯一语义修复机会，启动后在任何模型请求前停止；实际请求数为 0。
- `run-005/`：业务产出两份计划，基线审查仍未确定；第 40 次请求收到上游 401，终审未完成。原评分器下载依赖失败，不能把 reward=0 解释为有效性能评分。
- `verifier-preflight-006/`：使用第 5 次既有候选、原始镜像及未改动评分器的独立环境预检。5 个测试通过、1 个性能测试失败；不覆盖原试验记录。
- `run-006/on/external-controller/`：修正配置后的全部模型请求、统一计量和原始响应。
- `run-006/on/jobs/`：官方任务运行、原生业务轨迹和官方评分输出。
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
  --manifest "$bench_root/manifest-006.json" \
  --output "$bench_root/run-$(date +%Y%m%dT%H%M%S)"
unset RC_HARBOR_UPSTREAM_CREDENTIAL
```

入口使用本机现有 Docker、固定版本 Harbor 和冻结的 OpenClaw 安装缓存。所有业务、提取、覆盖审查、Stop 和修复请求共用外部控制器的原始时限与计量。需要调整预算时创建新的冻结清单；已运行的源码、产物、任务和清单不原地修改。
