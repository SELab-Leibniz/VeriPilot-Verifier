# security_tool_2 当前 RC 适配（2026-11-24）

实验程序基于 `codex/experiment-mvp-20261117` 的 `aa67a2f`；当前工作区覆盖文件由交接包的 `BUNDLE.json` 列出。只改实验程序、样本配置和文档，MA 与 RC 业务源码保持只读。

- RC 来源：`codex/rc-general-efficiency-bench`，`e6a42841f2b3135729371e7fdfeec348788ed01f`。
- 本次构建 TGZ：SHA256 `47b121716da4b7808c49cd4b23595cc8c1e52e790911c9edfecacbaba72203dc`，329 个文件条目。
- 配置来源：`SEWeekly/鸿蒙kit开发的长程任务/202611/dae36f7/config/config - artifacts off.yaml`。
- 配置原始与实际生效字节的 SHA256 均为 `e793216aa155a541994089e2d460981cb84c8590a8d4354ac5b6a3758dd9cfc2`。requirementFrame 开启、artifacts 为空、回归检查关闭；不执行配置中已关闭的旧命令。
- 原始公开项目仍是 `d72abe27c935b878363f4e849bd370b017abf3ea`，未注入错误或预先修复业务代码；单次实验总上限两小时。

## 适配内容

插件包可以带同名 `.source.json`，用内容哈希关联 RC 提交；来源文件内容不匹配时拒绝启动。没有来源文件的旧包保持兼容。包版本同为 1.11.0 时也能区别来源。

当前 RC 可以返回 `INTERRUPTED` 终态。实验程序仅在阶段为 CLOSED/ENDED、状态已刷新且健康、原生运行确已终止、队列及私有任务已全部清空时允许收尾；异常阶段、失联、等待 Agent 槽位或尚未结束的审查继续占用实验槽位。实验完成与 RC 的语义结论分开保存。

实跑又定位并修复了两处兼容问题：

- RC 状态锁占用或查询超时：在样本的 `uncertainTimeoutMs` 窗口内重试，不再仅因三次短时失败退出观察。持续失败仍有限返回；原实验硬截止不延长，身份错误等其他失败仍保留原来的处理。
- `dispatch.get.requirements.pending` 是需求基线游标，不是用户任务队列。只有冻结配置与当前项目配置完全一致、且 `dynamicGroundTruth.enabled` 和 `skillCorrection.enabled` 都明确为 false 时，才不把它当作未完成的提取工作。真实用户队列、私有工作、修复准入及精确宿主终态的检查全部保留；配置缺失、变更或提取开启时仍阻止收尾。

## 验证

最终 Windows 原生测试：79/79 通过，无跳过。包含新 RC 终态边界、状态锁暂时/持续占用、原截止时间、基线游标与真实任务队列的区分、私有任务等待、来源哈希、中文/空格路径、观察恢复和 Windows Job 硬截止机制。最终便携包为 77 项通过、两项依赖 Git 历史的打包测试按设计跳过；包内插件也完成了真实 Gateway 准备验证，未调用模型且清理确认。

实际隔离 Gateway 准备成功，RC 已启用，未提交模型任务；准备结束后活动进程为 0。准备尝试：`st2-demo-20261124T004444490Z-a6e9a995`。实际配置与指定文件逐字节相同，插件来源为上述提交。

原始项目在本机当前隔离环境下：doctor/install/test/build/docs 均退出 0；公开 Hypium 测试 747/747，报告为本次新生成；unsigned HAP 构建通过。这是运行前环境资格检查，不是模型交付或独立评分。

## 本次完整模型实跑

运行标识：`st2-demo-20261124T004802717Z-81f43001`。北京时间 2026-11-24 08:48:02 开始，09:18:19 归档，总计 30 分 16 秒。使用本机已配置的业务模型 `custom/deepseek-v4-flash` 和 RC 模型 `custom/deepseek-v4.1-flash`，未更换模型或重跑样本。

- 实验最终状态 `COMPLETED`，原生结果 `ARCHIVED`，业务原生运行 `ok`。
- 需求框架 `ready`，选择覆盖完整、可发布；生成耗时约 9 分 16 秒。
- 公开测试最终 **749/749**，unsigned HAP 构建和文档检查均通过。共记录五次 test 调用：741/749、无有效报告（退出 -1）、747/749、747/749、749/749。所有失败回执和轨迹保留；模型在同一次业务运行中修正，未生成有效报告的调用没有记作通过。
- 业务模型曾遇到一次上下文长度超限，宿主压缩上下文后继续原请求。未把内部错误记录删除或当成一次新实验。
- RC 终审 `NO_DEVIATION_FOUND`，8 个私有原生任务均已结算；本轮没有派发 RC 自动修复后续轮。模型依据公开测试自行修正不计作 RC 自动纠偏。
- 旧观察器先后因状态锁超时、把基线游标当作待办而返回 `NEEDS_ATTENTION`。修复实验程序后接回原运行完成归档；原 Session、原始运行 ID 和两小时绝对截止时间均未改变。未修改 RC 状态、结论或配置来放行。
- 收尾后 `activeProcesses: 0`，观察器和截止守护均为 `STOPPED`，`canScheduleNext: true`。AGENTS.md、requirements.md、demo-checks.ps1 的最终哈希与输入相同。

精选结果放在交接包的 `example-result/`：`summary.json`、`public-check-history.json`、`adaptation-verification.json` 分别保留最终结果、公开检查过程和适配/同会话恢复证据。原始配置、私有轨迹及全部失败记录留在本机私有运行目录，不放入交接包。

未调用独立评测器，未提供隐藏测试评分。上述结果属于本次指定插件和配置的真实流程及公开检查，不沿用 2026-11-17 旧插件、关闭 requirementFrame 的历史结果。
