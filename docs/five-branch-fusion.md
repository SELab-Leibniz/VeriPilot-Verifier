# 五分支融合工作记录

## 固定起点与边界

- 共同基点：`b1297e0ac882d7f412412961d4a2ad08259f7c28`。
- Stop 起点：`codex/fuse-until-pass-workspace-review` / `d4e866f`，保留运行后 until_pass、单会话原工作区审查、跨轮需求及逐对象证据校验。
- Skill：`codex/skill-care-efficiency` / `f736004`，有界按需原文、内容缓存、源变更失效、持久笔记、重复未完成事件去重。
- 文档：`codex/document-corrector-efficiency` / `fbfe00b`，项目会话互斥与生命周期、范围工具、原文哈希、有效笔记和重复事件缓存。
- 控制台：`codex/rc-console-observability` / `fd1103f`，响应快照、反馈回执层次、指标/基线投影、检索筛选分页及异常提示。
- 基线：`codex/optimize-baseline-extraction` / `7a7374f`，项目提取 agent、完整来源分段决策与归属、分页搜索和恢复笔记。
- 新分支：`codex/fuse-care-observability-baseline`。新外部 Git worktree 共享原仓库 Git 对象。原有五工作树开始时均干净；不改动 MatrixAssistant 及其内置 OpenClaw，不复制业务代码仓。

## 方案与验收（实验前固定）

1. 先运行各原分支的相关专项测试，保存提交、命令、完整输出、耗时与失败；原始结果不可覆盖。
2. 按 Skill → 文档 → 基线 → 控制台融合。重叠文件逐处审查：Stop 保留单会话路径；所有看护维持源当前性、取消、预算和未验证边界；三个私有工具各自绑定有效执行器；打包采用并集。
3. 融合后运行完全相同的专项测试和机制实验，新增跨模块回归，最后完整回归、三宿主构建、浏览器检查。
4. 使用原分支已有真实模型实验作为历史证据，明确小样本和协议差异；新鲜配对实验比较指定 Stop 起点与融合，以及各专项分支与融合的相同场景。不把字节当 token、不把程序化结论当模型准确率、不删掉失败或超时。
5. 准确性优先：原义务/条件/禁止项保留，过期证据和缺失执行证据不可 PASS；同项目会话复用且无交叉并发；重复输入节约调用，来源变化强制重新核验。
6. 体验：阶段通过进度通道展示，宿主文本无阶段噪声；响应记录区分触发、验证、反馈产生与实际送达；全局搜索后分页、折叠及窄屏有效。
7. 最终结论分别描述机制改善、真实模型小样本及未验证边界。不能承诺每个场景、每项延迟均优于每个独立分支。

## 进度与下一步

- [x] 核对共同基点、五分支与干净工作树，创建共享仓库的新分支。
- [x] 阅读各专项的实现和历史实验说明；历史 Skill 实验虽输入更少但墙钟更慢，须保留这一反例。
- [x] 固定原分支专项与机制实测：164 通过、1 条件跳过；融合后同组结果一致。
- [x] 解决融合冲突并记录关键取舍：保留生产单会话，私有工具与发行资源并集，Skill/基线 UI label 分离。
- [x] 第一轮全量回归、打包与界面检查：152 文件，1774 通过、22 条件跳过、0 失败；控制台 7 项浏览器检查通过，三宿主构建通过。
- [ ] 补跨模块回归及真实模型暴露的误判边界，再作最终回归。
- [ ] 新鲜模型配对实验和结果报告。
- [ ] 提交最终实现和可复现实验资料。

所有运行日志存于忽略目录 `.runtime-correction/five-branch-fusion/`；可审阅的方案、脚本和去敏汇总随 Git 提交。每阶段更新本节，失败日志保留，压缩后从本文件和结果 JSON 恢复。

## 初次实验观察（不是最终结论）

- 新 worktree 最初缺少锁定的 typebox 测试依赖，两文件无法加载；`npm ci --prefix lib/review-task --ignore-scripts` 后同组全部通过。`after-initial` 与 `after-dependencies` 都保留。
- Skill 合成 80 辅助文件：入口取证披露 708066 → 10833 字节，热扫描 7 次内容读取均为 0；这是字节与 I/O，不是计费 token。
- 基线 50000 行、125 区间的恢复结果完全相同，本次区间算法约 88.49 → 0.25 ms；240 来源全部分页发现；12 次提取复用 1 个身份。
- 第一次真实 Skill 披露实验 7/8 命中：baseline 的进行中判断正确，optimized 将 completeRecords=true 误解为任务完成，尽管 phase=implementing。这是必须保留的负面观察；旧笔记不能证明 PASS 的案例仍正确。生产协议优化与复测须区分日志完整性和完成条件。
- 新鲜 Stop 配对正在运行，完整运行固定 runtime 源码摘要；完成前不改运行模块，以防中途源码漂移。

## 压缩恢复入口

当前工作区是 `C:/Users/user/.codex/worktrees/rc-five-branch-fusion/runtime-corrector-toy`。四次 merge commit 已完成，HEAD `4e8654e`。只在此树改代码。`.runtime-correction/five-branch-fusion/stop-live/results.json` 持续保存每个配对样本；`document-live/report.json`、`baseline-live-*.log`、`skill-care-live-experiment.json`（上一层目录）保存模型记录。最终提交前更新本段并将去敏汇总加入 docs；不可把初测错误或跳过计作全通过。
