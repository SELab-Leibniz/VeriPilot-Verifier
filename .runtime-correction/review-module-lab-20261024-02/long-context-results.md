# 长任务 Review：实现与单阶段验证

2026-10-24。结论：**隔离长任务阶段通过，独立语义复核通过**。生产仍是干净的 `20ec5b5`，本轮没有接入 Stop，也没有运行、修改或恢复原项目与原 session。

最终模块在 `experiments/review-task/long/`，真实成功实验对应准确冻结版本 `source-snapshot-05-long/manifest.json`。首轮失败对应 `source-snapshot-04-long/` 和 `long-stage-live-01/`，完整保留。

## 最小职责与实际实现

主审循环、摘要生成、压缩和原始 session 格式均复用锁定的 Pi 1.4.0。新增逻辑集中于原 worker 的健康保护，以及独立的 `history-memory.mjs`。没有新建规划模型、总结总评模型、向量库或第二套 agent 循环。

1. **提前压缩**：模型配置窗口保持204800；原生压缩余量设为61440，估算超过143360即触发原生 threshold compact，近期保留不超过20000 token。不是等待 provider 已经 overflow 后才处理。
2. **旧轨迹可找回**：原生 append-only session 保留旧原文；程序保存仅含元数据的 `history-index.json`，不把整个索引加入模型输入。一个只读 `review_history` 工具提供 search/read/state，整次返回上限8KiB，按 UTF-8 字节分页；不索引自身返回或 thinking。
3. **程序状态不依赖摘要记忆**：compact 前后及失败/关闭时，先同步 session，再原子保存 checkpoint，记录任务与输入版本、session/leaf、成功读回执和 cite 账本。可独立核验加载。摘要只作导航，不授予基线已读状态，也不能制造来源引用。
4. **请求前检查**：保留原生自动压缩，再检查当前投影与输出空间。新 provider usage 可作锚点；压缩后 usage 尚未知时不复用旧 usage。额外使用保守 UTF-8 字节余量，避免仅靠 chars/4 低估中文。压缩失败或检查不放行时保存 checkpoint，返回明确的 UNVERIFIED。
5. **短输出仍保持**：每个主审回复的生成上限8192与检查器预留一致；不是累计 token 或时间预算。原生 summary 使用独立 routing，保留其原设置。最终只提交 taskId、verdict、短原因与 citeIds；原文由程序取，反馈超长只给独立文件位置。

执行顺序是：原始历史保存 → 阈值检查 → checkpoint → 原生 compact → 摘要及近期上下文 → 按需检索旧原文 → 重核当前冻结基线/源码 → 小提交 → 证据与结果持久化。summary 不取代冻结 Ground Truth。

复用依据是本地锁定 SDK 原码与 [Pi 1.4.0 原生压缩说明](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/compaction.md)。压缩与外部笔记、按需检索的职责分离，也与 [Anthropic 的上下文工程实践](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents) 一致；本轮没有把原则另造为复杂工作流。

## 直接构造待测阶段

使用既有冻结捕获的805条公开过程记录（1,367,269字节），在新隔离 session 中重放446条脱敏公开观察，共541,079字节。不是重复填充，也没有伪造历史 provider usage。去除 thinking、图片/base64、宿主配置和凭据字段观察；原文件不改。

原生消息估算149738，超过提前阈值143360。204800是当前**配置的模型窗口**，不是本轮独立测得的供应商物理上限。摘要请求会按原生规则截短长工具正文，因此它的真实 usage 与未压缩主请求的估算不是同一量。

保留同一 f1 源码证明问题、全部79条公共条件和例外、原始需求与79份输入文件。阶段问题明确给出一个旧需求的 sourceId/关键词，要求在它被移出当前投影后实际 search/read 找回，再检查冻结源码。这是有已知检索定位线索的受控阶段实验，不是无提示检索质量或完整业务长任务的泛化测评。没有端到端重跑厨房或复杂 App。

## 首轮失败及修复

`long-stage-live-01` 的真实 summary 成功：原生估算149738→21608；摘要输入80305、输出6740。之后保护器把压缩余量61440当成单次回复空间，用171809+61440判超窗，误拒主审请求。0次主审取证，正确保存为 UNVERIFIED；这不是 provider overflow，也不是业务缺陷。

修复只区分两种余量：压缩触发余量仍61440；公开 streamFunction 对主审实际传8192生成上限，保护器取同一值。summary 的原生选项不受影响。新增真实 SDK＋脚本 provider 回归检查实际收到的选项，不能仅修改日志数字。

## 修复后真实结果

`long-stage-live-02`：一次阶段尝试、一次真实 threshold compact、6个有效主审回复，131.113秒完成持久判断。

- 压缩：149738→21645（均为 SDK 估算）；真实摘要74.347秒。
- 被移出的关键旧记录 `29d128f3:615:0:0` 在压缩后实际检索；read 返回3468字节，独立逐字节等于旧原文，完整文本 SHA 相同。
- 全部基线重新披露；79输入与冻结/基准副本哈希一致；f1＋79公共条件共80个 claim 与原 GT 对应对象逐项相同。
- 最终 DEVIATION 有源码依据：首页卡片 `Index.ets:257–279` 使用色块与 emoji，没有商品图片及其加载占位。页面级数据 loading 不能替代图片 loading。详情页另有 Image，结论应限定首页商品卡片，不能扩写为全项目没有 Image。
- 一次合法 submit，参数441字节，宿主反馈442字节；原文和详细证据留在独立文件，不要求模型复制引文。
- 成功 checkpoint 可在不传内存 session 的情况下独立加载：79文件、6个成功读区间、6个 cite 均经持久回执核验。
- 仓库601个跟踪文件指纹、HEAD、冻结捕获及宿主配置前后相同。原项目与原 session 未访问或写入。

用量分开记录：摘要输入80305、输出6967；主审非缓存输入120461、缓存读取205824、输出4672。成功阶段累计418229 token，含缓存读取；主审峰值实际输入66428。累计输入不是同时占用的上下文，也不是美元账单。摘要输出中的 reasoning 已包含在 output，不能再加一遍。

两次真实执行合计计量505274 token、worker时间200.252秒，包含首轮失败，未挑选性排除。没有拿无长历史的旧37秒案例作同条件省时/省 token 比较。

日志有7次主 stream 选项边界，其中最后一次发生在结果保存后，随即 closed_after_save；只有6个有效模型回复，最后取消项无新增已报告 usage。边界调用数不能当作成功 HTTP 调用数，也没有记录最终 HTTP 原包。

## 机制与独立核验

最终冻结05完整机制回归 **59/59**，根 agent 独立复跑同样通过。重复执行不相加为118个不同测试。使用正式 SDK 与脚本 provider；它们验证恢复、工具与保存机制，不冒充59个真实模型质量案例。

覆盖提前压缩、压缩后检索被摘要遗漏的原件、摘要失败阻止主请求、旧 usage 失效、CJK估计偏差拦截、不可分批次仍过大、历史分页/不泄漏 thinking/不自索引、checkpoint身份与成功回执、引用准确性、取消及混批保护。

真实模型这次成功案例由独立 agent 复核源码语义和字节完整性；结论为 `PASS_CONTROLLED_LONG_STAGE`。这是审查过程通过，业务 verdict 仍是 DEVIATION。原生产四指标0/4记录不变，不能把单个 f1 源码反例扩充为完整项目或运行验收。

## 明确边界

当前原生压缩按 SDK 估计触发，最终额外保护按更保守的估计检查。中文或不可分工具批次仍可能被保守拒绝；这个分支会保全进度后 UNVERIFIED，尚无基于该保护再自动 compact 的二次调度。故不能声称所有长任务都会继续完成。

checkpoint 已可独立核验加载，但没有实现进程崩溃后的自动 worker 重启续跑。原始记录留存不等于已验证任意掉电时刻的完整恢复。真正超过窗口的不可分输入、摘要服务持续失败仍需要明确未验证，不能用删条件、无限重试或提高窗口掩盖。

## 复核入口

- 最终代码与版本：`experiments/review-task/long/{review-task.mjs,history-memory.mjs}`；`source-snapshot-05-long/manifest.json`。
- 最终回归：`verification-long-final-02.tap`。
- 原始真实记录：`long-stage-live-01/`、`long-stage-live-02/review/{events.jsonl,sessions/,prompt.txt,evidence.json,decision.json,review-checkpoint.json,history-index.json}`。
- 机器汇总：`long-context-results.json`。
- 独立计量与逐字节核对：`long-stage-live-02-independent-measurement.json`。
- 独立语义、输入与来源核对：`long-stage-live-02-semantic-review.json`。
- 原始 run/report.json 保持当时的 pending-semantic 状态不改；最终语义通过以独立报告与本汇总为准。
