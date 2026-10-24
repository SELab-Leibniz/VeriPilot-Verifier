# 指标 Review Prompt 对照结果

实际去重评审 46 次：开发 32、原复核 8、扩展 6；已提交 46 次。未改写原报告的 pending 状态；独立语义结论仅合并到 summary.json。

## 开发与选择

- baseline 开发：标签正确 11/12；诊断支持 11/12；grounded 正确 11/12。回合 46，输入 token 含缓存/不含缓存 422,738/210,002，输出 31,364，总 token 含缓存/不含缓存 454,102/241,366；submitErrors 0，最大反馈 606 byte。
- rubric-v1 开发：标签正确 10/12；诊断支持 10/12；grounded 正确 10/12。回合 43，输入 token 含缓存/不含缓存 380,620/199,116，输出 29,672，总 token 含缓存/不含缓存 410,292/228,788；submitErrors 0，最大反馈 545 byte。
- rubric-v2 开发（仅 M05/M12，8 例）：标签正确 8/8；诊断支持 7/8；grounded 正确 7/8。回合 29，输入 token 含缓存/不含缓存 262,490/140,378，输出 22,793，总 token 含缓存/不含缓存 285,283/163,171；submitErrors 1，最大反馈 614 byte。
- selected 开发事后组合：标签正确 12/12；诊断支持 12/12；grounded 正确 12/12。回合 44，输入 token 含缓存/不含缓存 375,365/204,101，输出 30,686，总 token 含缓存/不含缓存 406,051/234,787；submitErrors 0，最大反馈 606 byte。

selected 开发 12 例由 M01=v1、M05=baseline、M12=v2 的既有结果组合；新增调用为 0，不能当作新的 12 次验证。选择依据是开发集，未把复核结果用于该轮调优。

## 原始复核

- baseline 原复核：标签正确 6/6；诊断支持 6/6；grounded 正确 6/6。回合 21，输入 token 含缓存/不含缓存 203,420/112,796，输出 19,101，总 token 含缓存/不含缓存 222,521/131,897；submitErrors 0，最大反馈 593 byte。
- selected 原复核视图：标签正确 6/6；诊断支持 6/6；grounded 正确 6/6。回合 21，输入 token 含缓存/不含缓存 203,869/106,845，输出 18,794，总 token 含缓存/不含缓存 222,663/125,639；submitErrors 0，最大反馈 593 byte。

selected 的 K03/F03 使用 selected-holdout 新运行；K06/K09/F06/F09 复用 baseline-holdout。脚本核验相同冻结 task/workspace、实际原六段提示的 1894 byte 与 SHA，以及 selected 对应 append 为空；详细证据在 reuse-ledger.json。

## 前瞻扩展

- baseline 扩展：标签正确 2/3；诊断支持 2/3；grounded 正确 2/3。回合 11，输入 token 含缓存/不含缓存 138,034/60,210，输出 9,291，总 token 含缓存/不含缓存 147,325/69,501；submitErrors 0，最大反馈 596 byte。
- selected 扩展：标签正确 2/3；诊断支持 2/3；grounded 正确 2/3。回合 13，输入 token 含缓存/不含缓存 152,586/74,506，输出 8,616，总 token 含缓存/不含缓存 161,202/83,122；submitErrors 0，最大反馈 604 byte。

K10/F10/F11 另列为 3 个开发选择后冻结的风险探针，不加入原复核 6 例分母。F10 的初始 PASS oracle 在任何该扩展模型复核前被独立反例纠正为 DEVIATION，初始文件及修订保留。该集合不是独立随机样本。

## 提交、资源与保护

- 全部 46 次实际执行（只计一次）：标签正确 41/46；诊断支持 40/46；grounded 正确 40/46。回合 169，输入 token 含缓存/不含缓存 1,608,288/822,880，输出 125,048，总 token 含缓存/不含缓存 1,733,336/947,928；submitErrors 1，最大反馈 614 byte。
- 基础设施失败 0；overflow 事件 0；provider 错误事件 0；compaction 失败 0；unsafe 请求预防 0。
- 内联诊断上限 600 UTF-8 byte；最大完整反馈 614 byte，按本批路径计算的反馈封套上界 840 byte（含任务、状态、Details 路径及换行）。
- 各 run 的输入、仓库、宿主配置与 profile 保护检查全部为 true；业务执行和原项目/session 写入标志保留原报告值，未由汇总脚本推断替代。

## 标签与理由分开判断

- baseline-dev-01/F08：PASS（预期 DEVIATION），label=false，diagnosis=false，scope=true，grounded=false；证据与审计说明见 A2/F08。
- rubric-v1-dev-01/F05：PASS（预期 DEVIATION），label=false，diagnosis=false，scope=false，grounded=false；证据与审计说明见 B2/F05。
- rubric-v1-dev-01/F08：PASS（预期 DEVIATION），label=false，diagnosis=false，scope=true，grounded=false；证据与审计说明见 B2/F08。
- rubric-v2-dev-01/K05：DEVIATION（预期 DEVIATION），label=true，diagnosis=false，scope=true，grounded=false；证据与审计说明见 C1/K05。
- baseline-extension-01/F10：PASS（预期 DEVIATION），label=false，diagnosis=false，scope=true，grounded=false；证据与审计说明见 G2/F10。
- selected-extension-01/F10：PASS（预期 DEVIATION），label=false，diagnosis=false，scope=true，grounded=false；证据与审计说明见 H2/F10。

## 解释范围

- 只评冻结单对象的 Review 阶段，不代表整个 M01/M05/M12 分母、完整 15 指标或项目验收。
- 开发集用于选择提示，selected 开发 12 例是已有调用的事后组合，不能作为新增独立验证或新的 12 次调用。
- 原复核 selected 6 例仅 2 例新运行、4 例经 task/workspace 与实际原提示及空 append 核验后复用；不重复计费或计数。
- 扩展 K10/F10/F11 在开发选择后预先设定，是前瞻风险探针，但并非独立随机样本，不并入原 6 例复核分母。
- F10 初始 PASS oracle 在任何该扩展模型复核前被独立反例否决并改为 DEVIATION；原 oracle 与修订证据保留。
- 小样本、每条件一次运行；观察到的回合/token 差异不是因果效率估计，不可估计生产稳定率或普遍准确率。
- 状态标签、诊断机制支持、范围、引用字节完整性分别记录；有正确标签仍可能因理由不支持而 grounded 错误。
- UNVERIFIED 只有完成提交且缺少正确类型证明才计准确；不是业务 PASS。基础设施未提交另列。
- token 是现有报告记录的评审模型用量；不包含主会话、独立语义审计或其他工具成本。累计输入含逐回合历史，不是唯一文本量。
- 四类 reviewer 是配置与共享 review engine 的实验路由，尚未集成生产流程。
