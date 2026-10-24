# 阶段2生产工厂/collector隔离入口

准备版本，未调用真实模型，未启动Gateway。复用既有 `scripts/diagnostics/stop-task-integration.mjs` 的正式工厂、collector、GT、引用核验及反馈通路；没有注入fake worker。

运行入口：`node .runtime-correction/all-metrics-lab-20261024/integration-plan/run.mjs --out=preflight-01`。每次需新的`--out`名称。完成阶段1选择且正式路由接入后，root才可加`--live`，例如`--out=live-01 --live`。可用`--cases=A201,P08-pass`有限复测；M09指定代表会同时生成Stop与implementation角色两例。

首次预检 [preflight-01/report.json](preflight-01/report.json)：13例、12个新指标，M09额外implementation角色1例。全部输入哈希、完整基线、目标保护检查通过。当前生产基线只支持原先M01/M05/M12，所以13例路由均明确为false，状态是`PREFLIGHT_READY_PENDING_PRODUCTION_ROUTE`，没有假装集成成功。live在路由不合格时直接拒绝，不允许回落native绕过新模块。

## 冻结材料与隔离

从 `../fixtures` 和 `../freeze.json` 校验原workspace fingerprint、task及oracle哈希。只将task.targetFiles内的project/*和process/*复制为候选文件。basis/*完整写入GT公共约束claim，含原始UTF-8字节，不复制进业务候选。oracle始终在模型project外。完整过程record与原entries均保留：record在候选process目录，entries进入evidence.snapshot。它们明确是合成证据，只证明adapter/证据归属通路，不代表真实业务执行。

保留原project/...逻辑路径。worker会再加一层project/包装；指令中明确这种包装不是不同的项目或版本。没有新增reviewTargets API。

每例只有一个冻结对象，GT由生产API生成并冻结，population从生产buildMetricPopulation计算后按assigned source选一个对象。类别映射沿用METRIC_CATALOG。不会扩大任务为其他原义务，也不删公共条件。

## M08

使用原fixture `project/SKILL.md` 的S06原段落，不创建同sourceId的普通GTclaim：

1. 原字节放入本例 task/skills/build-offline-kitchen/source/SKILL.md。
2. 生产scanSkillDirectory建立source快照/digest，保存同目录skill-source.json及原候选来源路径/hash。
3. 生产persistSkillGroundTruth写skill-ground-truth.json、markdown/history，MUST/STEP/S06、CURRENT_TASK、sourceRef=project/SKILL.md#L2，保留完整失败重试与完成闸门原句。
4. buildMetricPopulation({skillDocuments:[document]})生成真实 `M08:build-offline-kitchen:S06` 对象。request提供skillGroundTruthPath/skillSourcePath，evidence提供skillGroundTruth/skillSource，供正式adapter读取。

这是从受控冻结fixture逐字导入的约束，不是声称真实模型GT提取器已运行。

## 输出

每例独立project/GT/Skill/collection/worker结果，立即写report及progress；记录未完成原因、原worker结果位置、短feedback字节上限、引用原文/哈希/行范围、代码与原材料保护。Live使用原授权provider/model，配置与凭据仅内存；不输出原始key，结束扫描实验文件是否含凭据值。

判断与oracle一致仍需要后续独立语义核对。这个入口不代替阶段3完整真实Stop或阶段4真实从空厨房开发。预算为既有单项120秒，无上调。
