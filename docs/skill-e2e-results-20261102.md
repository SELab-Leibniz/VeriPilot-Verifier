# Skill 最小闭环交付记录

一小时目标未达到；额外收尾后，已取得正常案与受控故障案的真实运行证据及通过的回执复核。工作全部在独立 worktree、新分支 `codex/rc-skill-e2e-hour` 内完成。

支持范围：OpenClaw 2026.7.1-2、GLM Coding `glm-5.3-flash`、独立 Skill 与终审 M08。全局基线、文档纠偏、其他终审指标明确关闭，不宣称整个 RC 或正式 benchmark 已验收。

## 实际结果

| 案例 | 观察结果 | 当前验收 |
| --- | --- | --- |
| 正常成功 | 自动读 Skill、生成规则图、真实审阅、验证退出 0、无多余 Skill 反馈、原生终态正常 | PASS |
| 受控故障 | 真实验证退出 3；只注入一次错误完成声明；Skill 报出 2 项偏差；反馈通过同图 M08 原生准入进入业务模型；业务 Agent 修改 app.mjs；新验证退出 0；Skill 最新复查 0 项偏差；原生终态正常 | 回执复核 PASS |

故障注入保留了原始模型响应、替换后的完成声明、两份摘要和完整实际用量。它不生成工具结果、Skill 判决或业务修复；不用于自然错误率或模型提分统计。

原始故障评测器只识别 `constraint/<ID>`，漏认了合法的 `<ID> (SKILL.md L6)` 引用，因此原始报告为 `INCOMPLETE`、评测进程退出 1。该记录没有覆盖。识别器修复后，对同一份原始证据作只读复核：实际 Skill 偏差、同一规则图节点、已消耗的原生准入、成功返回的业务模型请求均相互匹配，其余全部原始门槛保持，复核通过。原生业务、纠偏与宿主结算均已正常闭合；此处未再启动付费重跑。

## 修改内容

- 关闭全局基线后，选中的 Skill 仍能从完整原文建立自己的规则图；保留来源变化、所有权和证据不足检查。
- 修正独立 Skill 在终审准备阶段丢失任务上下文的问题。
- 原文允许修复时，区分已承认、已修复且有新验证支持的历史错误与当前待修问题。旧历史和评估保留；不豁免不可逆约束或缺失证据。
- 审阅、终审、业务、整轮及看护轮次均可配置，原始业务不再被入口固定十分钟限制截断。专项样例接受宿主可选执行参数的默认值。
- 识别同一 Skill 图、真实偏差及实际准入共同支持的 M08 统一反馈通道；普通终审文本和其他 Skill 不算送达证明。

## 文件与复现

- 使用说明：[skill-e2e.md](skill-e2e.md)。当前两个案例使用 `--check-interval-turns 50 --max-watch-turns 50 --wall-ms 900000`；审阅 600000ms，终审 900000ms，业务预算 1200000ms，全部受整轮截止时间约束。
- 可运行包：`dist/skill-e2e-openclaw-recovery/runtime-corrector-openclaw`。
- 配置：`dist/skill-e2e-openclaw-recovery/skill-only.config.yaml`。
- 运行源码身份：`12b0078`；后续变更仅为反馈引用格式识别与交付记录。
- 最终包的 247 个文件与两案实际加载的包逐字节相同；摘要见同目录 `runtime-manifest.json`。
- 证据总表：`.runtime-correction/skill-e2e-hour/delivery.json`。
- 正常案：`.runtime-correction/skill-e2e-hour/glm-success-recovery-002/result-reviewed.json`。
- 故障案：`.runtime-correction/skill-e2e-hour/glm-fault-recovery-002/result-reviewed.json`，同目录保留 `result.json` 原始误判记录。

专项检查共 83 项：82 通过、1 跳过、0 失败。日志为 `.runtime-correction/skill-e2e-hour/skill-regression-final-verified.log`。此前更宽的基线依赖夹具检查存在宿主路径错误，原始失败日志保留；本交付没有全量插件回归通过的声明。
