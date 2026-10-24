# 指标 Review Prompt 实验

基准检查点为 73390e0。本目录是隔离的 Review 阶段实验，不接入生产 Stop，也不运行 App、业务 verifier 或原 session。

## 四种职责，一个执行引擎

- 需求分解审查（M01）：原始义务是否被候选分解按语义完整覆盖，包括条件、例外和公共约束。使用 rubric-v1。
- 验收覆盖审查（M05）：正式候选验收单元是否覆盖指定义务；不评实现、实际执行或 M06 的准则质量。保留 baseline。
- 源码实现审查（M12 / SOURCE_IMPLEMENTATION）：沿数据和控制路径证明每个适用行为；声明、输出形状和永久替代物不能代替所要求的行为。使用 rubric-v2。
- 运行证据审查（M12 / RUNTIME_ACCEPTANCE）：需要与对象及版本相符的实际运行证明，源码与自报不能代替；保留 baseline 的系统提示与独立 task。

这些是按 metricId 和 scope 确定的配置，每项建立独立会话，共用 runReviewTask。不是让一个模型先读全量材料再决定派工，也没有新建四套工作流。程序不更改原始义务；输入映射把 Ground Truth、候选文档、源码、自报和可信运行记录的角色分开。

select-profile.mjs 是本轮开发对照的单次选择记录工具，含明确的实验来源及人工判断理由，不是通用的自动 Prompt 搜索器。

完整公共系统提示保存在 long/review-task.mjs；每次实际组合提示保存在运行目录的 review/prompt.txt，任务和模型窗口在 review/input.json，指标增补位于 profiles/*.json。程序仅按固定映射选择增补，不把 oracle 发给模型。没有新增总评模型，结果汇总由 summarize.mjs 完成。

M05 本轮特定政策：正式声明为候选验收/场景单元的等价表达均可；已声明为需求正文的普通 SHALL 不能自动升格为验收单元。这项输入角色约定同时提供给基准和候选，不是整个行业的唯一指标定义。

## 复现

从仓库根目录运行，先按上级 README 安装锁定依赖并运行离线机制检查。以下默认不调用模型：

    node .runtime-correction/review-module-lab-20261024-02/experiments/review-task/prompt-accuracy/run-review.mjs replay-preflight --variant=selected --split=all --extensions

输出目录必须是本实验内尚不存在的新目录。真实 Review 需显式追加 --live，使用宿主已授权的服务配置；不会保存密钥或修改宿主配置。可以用 --cases=K01,F01 只跑选定对象。默认并发2，固定工具、每回复8192、maxAttempts=2、maxTurns=100；所有版本均未设累计 token 或时间预算。未改变基准模型窗口来帮助候选版本。

fixture-paths.mjs 按 domain/caseId 将历史绝对描述安全重定位到当前 checkout，不修改旧描述或冻结哈希。离线包装检查命令：

    node --test .runtime-correction/review-module-lab-20261024-02/experiments/review-task/prompt-accuracy/packaging-checks.mjs

最后一次核验：原执行器62/62；包装检查4通过、1跳过（环境不允许创建junction测试副本）；21个输入全通过离线预检。另用两个案例验证跨目录重定位，未调用模型。检查记录和未覆盖的边界见packaging-audit.json。评审未完成时CLI退出非0；合法提交的UNVERIFIED仍是正常完成，不能混为执行失败。

模型只看到 fixtures 下该 case 的 workspace 和 task；oracle、provenance 在 workspace 外。保留完整原合同。输入哈希与冻结清单不匹配时拒绝运行。评审读取的是只读副本；不能修改项目文件、运行命令、恢复原 session。

先用 prepare-audit.mjs RUN_DIRECTORY OPAQUE_TAG DOMAIN 生成去掉版本身份和耗时的审计输入，再独立逐项检查状态、诊断和范围。审计员仍是模型，且是同一协作环境中的复核，不能当成形式化证明或严格双盲研究。引用的位置、范围、哈希和字节由程序另行校验。

## 数据与限制

初始18例（12开发+6复核）先冻结；两个候选版本只在开发集迭代。selected.json 在读取复核结果前冻结，此后未调参。相同完整提示与输入的4个原始复核项复用基准结果，账本另存，不把复用算新调用。

K10/F10/F11 是开发结束后、模型评审前冻结的3个额外风险探针，应单列，不能伪称初始独立随机测试集。F10 初拟 PASS 标准答案被独立源码审查否决，在任何该例模型调用之前纠正；初稿、修订记录和审计均保留。F11 是隔离副本内最小修复的配对正例。

results.md 与 summary.json 区分 verdict 相符和诊断有据，也保留失败候选。每项短反馈和证据位置独立保存，不要求宿主读取大 JSON 或全部轨迹。当前实验记录原始 pending-semantic 状态保持不变；完成的语义检查在 semantic-audits 和 summary.json 中合并呈现。

原始 provider session、每次冗余 frozen-source 和大轨迹保留在本机 ignored 实验目录，未提交。提交的是规范 fixtures、精简运行报告、实际提示、输入清单、短反馈和独立审计；因此可以核对输入与结论、重新实验，不能只靠 Git 重建已运行模型的完整逐 token 轨迹。模型有随机性，结果不保证逐字复现。

这些案例只覆盖指定对象和三个指标的局部子问题。它们不能证明整个指标、全部15指标、复杂项目 Stop 或任何业务整体通过。长上下文压缩机制沿用之前独立长阶段实验；本轮准确度样例没有触发压缩，不提供新的长任务稳定率估计。
