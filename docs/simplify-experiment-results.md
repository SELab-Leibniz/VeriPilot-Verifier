# RC Stop 简化对照实验结果


## 推荐与边界

加入 security_tool_2 后，按计划的证据不足规则保留 **A**，并保留基线代码。B12 仍在 security_tool_1 上完成全部审查及修复。

- 第一轮四臂各检出 9/9，误报均为 0。B2 和 B12 分别完成 21/21，A 和 B1 各完成 15/21。B2 与 B12 按计划入围，B1 通过主指标但未进入前两名。B1 有样例用量覆盖不足，未用 token 破同分。

- security_tool_1 的第二轮中，B12 四次全部在预算内完成。正确首稿两次均无误报，缺陷变体两次首次 Stop 均命中缺失的 20 位选项和策略映射，每次只续修一次。两次最终 FAIL_TO_PASS 均为 1/1，PASS_TO_PASS 均为 611/611。A 和 B2 各四次到审查截止，缺陷变体的最终 FAIL_TO_PASS 均为 0/1，PASS_TO_PASS 均为 611/611。

- 合并后，A 的需求基线提取与审计占观测 RC 耗时 96.8%。整体 token 占比未能判定。

## 旧包故障与替换验证

原文清单工具有实现，旧包的任务工具清单和插件清单漏登记，宿主从工具集过滤了它。B1 和 B12 的 42 条旧包记录均遇到范围选择被拒，27 条实际调用工具并收到找不到工具的返回。旧包 B12 在三个隐藏依赖样例中分别约 13.5、11.7 和 20.6 秒读到缺陷文件。增加时间无法补齐工具声明。

| 旧包臂 | 保留序号 | 完成 | 失败 | 超时 | 工具找不到的运行 |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 21 | 15 | 6 | 0 | — |
| B1 | 21 | 0 | 0 | 21 | 14 |
| B2 | 21 | 21 | 0 | 0 | — |
| B12 | 21 | 0 | 0 | 21 | 13 |

旧包第一轮不计分。暂停时旧包第二轮有四条完整观测、两条隐藏评分阶段中断记录，全部不计分。JSON 报告保留了这些记录和路径。

新包验证只用 210 秒预算。B1 的外部缺陷和正确实现分别在 42.294 秒和 28.452 秒结束，各成功提交一次清单。前者发出反馈，后者无反馈，均未发现新工具缺失。无需运行 600 秒补验。

## 包、冻结输入与复核

- 旧包源提交 **b6700c1**，SHA256 **ec358bfbd52df682ca921a185195293682ee470630f1be011c147e11a480fa9a**。
- 替换包源提交 **0bbf9e3**，SHA256 **a678d55b6f58ede1ff686afc02c6438a6ba943158d6e642d38cfe4806a53b059**。正式替换只打包一次，之后哈希核对一致。
- 两包各 195 个 lib 文件字节完全一致。改变的是 openclaw.plugin.json 和 config/openclaw-tool-contracts.json。C 中 Stop 关闭，新增工具没有审查会话绑定。C 压缩与注入的运行代码相同，沿用旧包记录。
- 主计划 SHA256 **4e822f278b1b26a95270982d9b283c4646f979e018c320e689b4f3d4cb9b7a65**。security_tool_1 第二轮输入 SHA256 **61b9c3d8fdecca2d741169949125b3338db086ee3dd78a8acabb56b90d30964f**。 [替换包重跑计划](simplify-experiment-replacement-plan.md) · [冻结输入](simplify-experiment-round-two-inputs.json)
- security_tool_1 S0 的工作区提交内容 SHA256 **51b7b5532d9a8894676a4084cafdbf97017394804bd12bee1bc7aad655f7d5aa**。工作区 Git 提交、会话和补丁摘要见第二轮表。正确首稿和注入变体沿用原冻结字节。

| 只读目录 | 文件数 | 内容 SHA256 | 比对 |
| --- | ---: | --- | --- |
| MatrixAssistant | 24246 | 643511b58e079d065f97e645bb3190d8c59042d892dc4703306d0e915158d90a | 一致 |
| OpenClaw | 22207 | a7593d93da114e76d95d1a6cb1228ecc5d2b7db1275f9eb20e8617a2d37c8bca | 一致 |
| swe-arkts-bench | 15 | d93ec97bfec5faa87a470e2c8418bae58e92b1fdbfc71563f6060941b7e78dea | 一致 |

## 并发与恢复

- 新包第一轮保留的 84 条中，19 条在四并发下完成运行，65 条为串行。切换发生在 22:03:55（北京时间）。同一 alias-bug 组的一条配置读取失败在 Gateway 前发生，重试单独留档。后来一个 Git 长路径失败也在 Gateway 前发生，修复后续跑原序号。
- security_tool_1 的新包第二轮 11 条在三并发组内测得，分属 4 组。B12 的缺陷变体第 1 次因运行器提前关闭 Gateway 而作废。修复等待条件后，只补跑这一条并保留原始失败证据。补跑为串行，耗时不与组内 A 或 B2 比较。三条在组边界中断的准备尝试均无模型请求。
- 全部工程检查与隐藏评分经全局 hvigor 互斥锁串行。等待时间单列。原批次未出现 429 或 Previewer 端口冲突。

## C 对照说明

6 个序号都已记录。仅 C 关第 2 次有可评分回答，为 6/10。C 开第 3 次在首个压缩之后约 2.790 秒注入一次，共 22335 字节。其余两次 C 开未观测到注入，三次都没有可评分回答。C 的组间效果未能判定。

## security_tool_2 补充对照

用户在首版报告后要求加入该样例。使用同一替换包、DeepSeek 路由、每阶段预算、续修上限和计分规则。原第一轮、C 和 security_tool_1 的逐次结果沿用。

- 隐藏校准通过。基准修复测试 0/2，黄金补丁 2/2，基准和黄金补丁的回归测试均为 746/746。
- S0 自然结束，提交、补丁和会话均已冻结。它将 PermissionService.loadApplications 改为 loadApplicationsWithPolicySnapshot。原测试仍引用旧方法，独立评分编译报错 8 处。修复测试和回归测试均未执行，通过数记为未能判定。
- 原样首稿作为自然缺陷对象。六次从相同冻结字节恢复，覆盖 A、B2、B12 各两次。首稿未达到生成正确对照与注入变体的条件。
- 隐藏测试保持原始测试与 test_patch。模型提交中对测试的改写仍留在业务工作区，评分时依原规则排除。盲评以原题和冻结补丁为准。

| 臂 | 预算内完成 | 首次命中 | 误报 | 最终 F2P（两次） | 最终 P2P（两次） |
| --- | ---: | ---: | ---: | --- | --- |
| A | 0/2 | 0/2 | 0 | 未能判定、未能判定 | 未能判定、未能判定 |
| B2 | 0/2 | 0/2 | 0 | 未能判定、未能判定 | 未能判定、未能判定 |
| B12 | 2/2 | 0/2 | 0 | 未能判定、未能判定 | 未能判定、未能判定 |

六次均未发出修复反馈，最终补丁的 SHA256 均与首稿相同。六次隐藏评分均因同一缺失接口在编译时失败。B12 两次判定无当前偏差。A 一次到达审查截止、一次触发审查输出上限。B2 两次到达审查截止。

本样例 A 的需求基线提取与审计占观测 RC 耗时 99.9%。整体 token 占比因用量缺项未能判定。

1 条在并发 1 下运行，5 条在并发 3 下运行。RC 耗时只在同一组比较，hvigor 锁等待单列。最终隐藏测试无法完整执行的记录保留在原序号，通过数记为未能判定。

跨两个样例的正式判定按预设规则保留 A。security_tool_2 的首稿没有可用的隐藏评分，无法建立修复前后的完整比较。security_tool_1 上 B12 的优势仍由其自身四次对照支持。

- 补充冻结输入 SHA256 **d99d3c8b0e38d29391d7b2c377e9ea442ed88619f116131fe2fa4deb8df1d843**。工作区提交内容 SHA256 **10915611e3f300974a9c9e4ddcf0e37a7f812ee44be77f676fd980350af92625**。 [补充冻结输入](simplify-experiment-security-tool-2-inputs.json)
- 补充墙钟 47.42 分钟，模型请求 197 次，观测 token 12905226，用量覆盖 193/197。

## 完成情况和运行边界

| 阶段 | 保留的运行数 | 计划数 | 完成 | 失败 | 超时 |
| --- | --- | --- | --- | --- | --- |
| 1 | 84 | 84 | 72 | 10 | 2 |
| C | 6 | 6 | 1 | 5 | 0 |
| 2 | 18 | 18 | 6 | 1 | 11 |

- 原接入失败记录保留，复验以一次模型请求通过。C 校准第 2 轮触发真实压缩。正式 C 六条原包记录沿用，未重新运行。
- 旧包第一轮 84 条、旧包第二轮 4 条完整观测及 2 条隐藏评分阶段中断记录单列归档，全部排除计分。
- 替换包通过 A/B1/B2/B12/F 的工作者工具登记测试、17 项产物测试及四臂离线准备。B1 两个 210 秒验证均通过，未触发 600 秒补验。
- 按用户批准的范围缩减，最初第二轮仅使用 security_tool_1。其源码和隐藏校准在 C 运行期间完成，S0 在 C 结束后串行生成。S0 的首次启动前配置失败保留，未产生模型请求。
- security_tool_1 使用原来冻结的首稿、会话和注入变体。替换包只改变工具注册清单，冻结输入和隐藏评分基准继续沿用。
- 用户随后要求补充 security_tool_2。其隐藏校准、独立首稿与新增对照使用原预算、模型和替换包。原样例、第一轮和 C 的计分记录沿用。
- 批次 round1-new 在北京时间 2026/11/4 22:03:55 切换串行，原因 EVALUATION_FAILED。
- 原来计划的 15 分钟诊断未启动。工具缺失已在旧包离线测试和轨迹中复现，并由新包 210 秒实测验证。
- 只读目录快照在各记录阶段前后相同。各阶段及最终报告扫描均为 0 命中。
- 补充对照于北京时间 2026/11/5 01:26:18 切换串行。第二组有一个序号在 Gateway 启动前读取模型配置失败，无模型请求。原序号单独补跑。

总墙钟 444.086 分钟，模型请求 2787 次，记录到 71489564 token，用量覆盖 2689/2787。

## 第一轮

| 臂 | 检出率 | 正确实现误报 | 缺运行证据误报 | 总误报 | 预算内完成率 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| A | 1 | 0 | 0 | 0 | 0.714 | control |
| B1 | 1 | 0 | 0 | 0 | 0.714 | eligible |
| B2 | 1 | 0 | 0 | 0 | 1 | eligible |
| B12 | 1 | 0 | 0 | 0 | 1 | eligible |

入围臂 B2、B12。
次指标缺少可比用量或观测 tokens。

## 第二轮

| 样例 | 首稿隐藏评分 F2P；P2P | 冻结工作区提交 | 会话 SHA256 | 补丁 SHA256 | 状态 |
| --- | --- | --- | --- | --- | --- |
| security_tool_1 | 1/1；611/611 | b22001f92964256ec569b24cf03cfdf39f5e3a17 | 9e48372a0929e4bb789948e91487e69fe68bd044c3029b37b082886b1d76f15f | 028deb4a62fcb13ea5de6d27e0d7e59cca5a75b2afc359502f85e8cd42ad924a | frozen-graded |
| security_tool_2 | — | 61816677f7ec107da7c20a4dbd72a08cc39c3f76 | 4ae8924bceb48ba8693d667e319fa6d691cd881b3e4c5101b4cf7f00b60f64df | 707acb885b4e724bbfacce613754575592e1526f84bc861f5837b148088546fb | candidate-compile-error |

| 审查对象 | 类别 | 初始隐藏评分 F2P；P2P | 变体撤回 |
| --- | --- | --- | --- |
| security_tool_1-correct | correct | 1/1；611/611 | — |
| security_tool_1-injected | defect | 0/1；611/611 | Remove only 20 from PASSWORD_LENGTH_OPTIONS in entry/src/main/ets/models/DataModels.ets. Keep 24 and all other S0 edits. |
| security_tool_2-natural | defect | — | — |

| 臂 | 首次 Stop 缺陷检出率 | 全部误报 | 正确首稿误报 | 主指标判定 |
| --- | --- | --- | --- | --- |
| A | 0 | 0 | 0 | control |
| B2 | 0 | 0 | 0 | unscored |
| B12 | 0.5 | 0 | 0 | unscored |

| 臂 | 缺陷对象 | F2P 两次均值 | P2P 两次均值 | P2P 无新增失败 |
| --- | --- | --- | --- | --- |
| A | security_tool_1-injected | 0 | 611 | 是 |
| A | security_tool_2-natural | — | — | — |
| B2 | security_tool_1-injected | 0 | 611 | 是 |
| B2 | security_tool_2-natural | — | — | — |
| B12 | security_tool_1-injected | 1 | 611 | 是 |
| B12 | security_tool_2-natural | — | — | — |

第二轮的 RC 耗时只在同一并发对内比较。token 使用各隔离会话的调用计数。

| 候选臂 | 对象 | 序号 | 对照组 ID | A RC ms | 候选 RC ms | 候选减 A ms |
| --- | --- | --- | --- | --- | --- | --- |
| B2 | security_tool_1-correct | 1 | b92a2383-f566-453c-b700-4a914954e188 | 569964 | 570002 | 38 |
| B2 | security_tool_1-correct | 2 | bde96c64-911a-4823-903c-ca7dd8c84c2b | 571887 | 569984 | -1903 |
| B2 | security_tool_1-injected | 1 | a8443723-7c20-4dbf-a4c0-4f4fc0d1e2fa | 569986 | 569858 | -128 |
| B2 | security_tool_1-injected | 2 | 5e7cf295-5bb1-4ccf-a20f-ee666afb77ac | 569948 | 569925 | -23 |
| B2 | security_tool_2-natural | 1 | 703040b7-bbdf-4590-aaf0-54eaeba93253 | 569911 | 571859 | 1948 |
| B2 | security_tool_2-natural | 2 | — | — | — | — |
| B12 | security_tool_1-correct | 1 | b92a2383-f566-453c-b700-4a914954e188 | 569964 | 52085 | -517879 |
| B12 | security_tool_1-correct | 2 | bde96c64-911a-4823-903c-ca7dd8c84c2b | 571887 | 71410 | -500477 |
| B12 | security_tool_1-injected | 1 | — | — | — | — |
| B12 | security_tool_1-injected | 2 | 5e7cf295-5bb1-4ccf-a20f-ee666afb77ac | 569948 | 119517 | -450431 |
| B12 | security_tool_2-natural | 1 | 703040b7-bbdf-4590-aaf0-54eaeba93253 | 569911 | 506221 | -63690 |
| B12 | security_tool_2-natural | 2 | 1d260acb-a0e3-4dc5-88de-d92959abfaec | 467037 | 162478 | -304559 |

| 运行 | 并发 | Gateway 端口 | 工具链锁等待 ms | 调用数 |
| --- | --- | --- | --- | --- |
| r2-security_tool_1-correct-1-a | 3 | 64959 | 39774 | 3 |
| r2-security_tool_1-correct-1-b2 | 3 | 63342 | 8 | 3 |
| r2-security_tool_1-correct-1-b12 | 3 | 64961 | 5106 | 3 |
| r2-security_tool_1-correct-2-b2 | 3 | 53524 | 7 | 3 |
| r2-security_tool_1-correct-2-b12 | 3 | 55271 | 4855 | 3 |
| r2-security_tool_1-correct-2-a | 3 | 55269 | 29986 | 3 |
| r2-security_tool_1-injected-1-a | 3 | 64570 | 38409 | 3 |
| r2-security_tool_1-injected-1-b2 | 3 | 49670 | 8 | 3 |
| r2-security_tool_1-injected-1-b12 | 1 | 62628 | 9 | 5 |
| r2-security_tool_1-injected-2-b2 | 3 | 53826 | 2218 | 3 |
| r2-security_tool_1-injected-2-b12 | 3 | 53825 | 9 | 5 |
| r2-security_tool_1-injected-2-a | 3 | 54979 | 31478 | 3 |
| r2-security_tool_2-natural-1-a | 3 | 55023 | 24836 | 3 |
| r2-security_tool_2-natural-1-b2 | 3 | 55022 | 2315 | 3 |
| r2-security_tool_2-natural-1-b12 | 3 | 55021 | 3 | 3 |
| r2-security_tool_2-natural-2-b2 | 1 | 53037 | 6 | 3 |
| r2-security_tool_2-natural-2-b12 | 3 | 58348 | 1850 | 3 |
| r2-security_tool_2-natural-2-a | 3 | 58343 | 5 | 3 |

## 次指标与噪声

| 轮次 | 臂 | 样例 | 指标 | A 均值 | 候选均值 | A 极差 | 候选减 A | 方向 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | B1 | internal-correct | completion | 1 | 1 | 0 | 0 | tied |
| 1 | B1 | six-functions | completion | 1 | 1 | 0 | 0 | tied |
| 1 | B1 | external-bug | completion | 1 | 1 | 0 | 0 | tied |
| 1 | B1 | hidden-dependency | completion | 1 | 1 | 0 | 0 | tied |
| 1 | B1 | alias-bug | completion | 1 | 1 | 0 | 0 | tied |
| 1 | B1 | missing-run | completion | 0 | 0 | 0 | 0 | tied |
| 1 | B1 | mixed-skill | completion | 0 | 0 | 0 | 0 | tied |
| 1 | B1 | internal-correct | elapsedMs | 24334 | 28475.667 | 5631 | 4141.667 | tied |
| 1 | B1 | six-functions | elapsedMs | 40644 | 61263.667 | 6107 | 20619.667 | regressed |
| 1 | B1 | external-bug | elapsedMs | 27867.667 | 39211.667 | 1805 | 11344 | regressed |
| 1 | B1 | hidden-dependency | elapsedMs | 36238.333 | 39729.333 | 1643 | 3491 | regressed |
| 1 | B1 | alias-bug | elapsedMs | 34814.667 | 41542.667 | 7100 | 6728 | tied |
| 1 | B1 | missing-run | elapsedMs | 26073.333 | 30034.667 | 4152 | 3961.333 | tied |
| 1 | B1 | mixed-skill | elapsedMs | 81476 | 155085.667 | 29387 | 73609.667 | regressed |
| 1 | B1 | internal-correct | tokens | 55240.667 | 74907.667 | 24095 | 19667 | tied |
| 1 | B1 | six-functions | tokens | 74033.333 | 133577.667 | 13239 | 59544.333 | regressed |
| 1 | B1 | external-bug | tokens | 63942 | 109451.667 | 3163 | 45509.667 | regressed |
| 1 | B1 | hidden-dependency | tokens | 88016.333 | 123707 | 16302 | 35690.667 | regressed |
| 1 | B1 | alias-bug | tokens | 63108.667 | 100924.667 | 2322 | 37816 | regressed |
| 1 | B1 | missing-run | tokens | 49676.667 | 65248 | 14695 | 15571.333 | regressed |
| 1 | B1 | mixed-skill | tokens | 170619 | — | 91313 | — | incomparable |
| 1 | B2 | internal-correct | completion | 1 | 1 | 0 | 0 | tied |
| 1 | B2 | six-functions | completion | 1 | 1 | 0 | 0 | tied |
| 1 | B2 | external-bug | completion | 1 | 1 | 0 | 0 | tied |
| 1 | B2 | hidden-dependency | completion | 1 | 1 | 0 | 0 | tied |
| 1 | B2 | alias-bug | completion | 1 | 1 | 0 | 0 | tied |
| 1 | B2 | missing-run | completion | 0 | 1 | 0 | 1 | improved |
| 1 | B2 | mixed-skill | completion | 0 | 1 | 0 | 1 | improved |
| 1 | B2 | internal-correct | elapsedMs | 24334 | 20849 | 5631 | -3485 | tied |
| 1 | B2 | six-functions | elapsedMs | 40644 | 21301.667 | 6107 | -19342.333 | improved |
| 1 | B2 | external-bug | elapsedMs | 27867.667 | 23900.333 | 1805 | -3967.333 | improved |
| 1 | B2 | hidden-dependency | elapsedMs | 36238.333 | 32686.667 | 1643 | -3551.667 | improved |
| 1 | B2 | alias-bug | elapsedMs | 34814.667 | 28779.667 | 7100 | -6035 | tied |
| 1 | B2 | missing-run | elapsedMs | 26073.333 | 27422.667 | 4152 | 1349.333 | tied |
| 1 | B2 | mixed-skill | elapsedMs | 81476 | 50144.667 | 29387 | -31331.333 | improved |
| 1 | B2 | internal-correct | tokens | 55240.667 | 43594.333 | 24095 | -11646.333 | tied |
| 1 | B2 | six-functions | tokens | 74033.333 | 46324.667 | 13239 | -27708.667 | improved |
| 1 | B2 | external-bug | tokens | 63942 | 54450.333 | 3163 | -9491.667 | improved |
| 1 | B2 | hidden-dependency | tokens | 88016.333 | 79940 | 16302 | -8076.333 | tied |
| 1 | B2 | alias-bug | tokens | 63108.667 | 67213.333 | 2322 | 4104.667 | regressed |
| 1 | B2 | missing-run | tokens | 49676.667 | 43135 | 14695 | -6541.667 | tied |
| 1 | B2 | mixed-skill | tokens | 170619 | 96344 | 91313 | -74275 | tied |
| 1 | B12 | internal-correct | completion | 1 | 1 | 0 | 0 | tied |
| 1 | B12 | six-functions | completion | 1 | 1 | 0 | 0 | tied |
| 1 | B12 | external-bug | completion | 1 | 1 | 0 | 0 | tied |
| 1 | B12 | hidden-dependency | completion | 1 | 1 | 0 | 0 | tied |
| 1 | B12 | alias-bug | completion | 1 | 1 | 0 | 0 | tied |
| 1 | B12 | missing-run | completion | 0 | 1 | 0 | 1 | improved |
| 1 | B12 | mixed-skill | completion | 0 | 1 | 0 | 1 | improved |
| 1 | B12 | internal-correct | elapsedMs | 24334 | 27917.667 | 5631 | 3583.667 | tied |
| 1 | B12 | six-functions | elapsedMs | 40644 | 30190 | 6107 | -10454 | improved |
| 1 | B12 | external-bug | elapsedMs | 27867.667 | 32123.333 | 1805 | 4255.667 | regressed |
| 1 | B12 | hidden-dependency | elapsedMs | 36238.333 | 41058.333 | 1643 | 4820 | regressed |
| 1 | B12 | alias-bug | elapsedMs | 34814.667 | 38286.333 | 7100 | 3471.667 | tied |
| 1 | B12 | missing-run | elapsedMs | 26073.333 | 36285.333 | 4152 | 10212 | regressed |
| 1 | B12 | mixed-skill | elapsedMs | 81476 | 77630 | 29387 | -3846 | tied |
| 1 | B12 | internal-correct | tokens | 55240.667 | 71601 | 24095 | 16360.333 | tied |
| 1 | B12 | six-functions | tokens | 74033.333 | 75430.667 | 13239 | 1397.333 | tied |
| 1 | B12 | external-bug | tokens | 63942 | 85197 | 3163 | 21255 | regressed |
| 1 | B12 | hidden-dependency | tokens | 88016.333 | 124957 | 16302 | 36940.667 | regressed |
| 1 | B12 | alias-bug | tokens | 63108.667 | 97963.667 | 2322 | 34855 | regressed |
| 1 | B12 | missing-run | tokens | 49676.667 | 76177 | 14695 | 26500.333 | regressed |
| 1 | B12 | mixed-skill | tokens | 170619 | 144970.333 | 91313 | -25648.667 | tied |
| 2 | B2 | security_tool_1-correct | completion | 0 | 0 | 0 | 0 | tied |
| 2 | B2 | security_tool_1-injected | completion | 0 | 0 | 0 | 0 | tied |
| 2 | B2 | security_tool_2-natural | completion | 0 | 0 | 0 | 0 | tied |
| 2 | B2 | security_tool_1-correct | elapsedMs | 570925.5 | 569993 | 1923 | -932.5 | tied |
| 2 | B2 | security_tool_1-injected | elapsedMs | 569967 | 569891.5 | 38 | -75.5 | improved |
| 2 | B2 | security_tool_2-natural | elapsedMs | — | — | — | — | incomparable |
| 2 | B2 | security_tool_1-correct | tokens | — | — | — | — | incomparable |
| 2 | B2 | security_tool_1-injected | tokens | — | — | — | — | incomparable |
| 2 | B2 | security_tool_2-natural | tokens | — | — | — | — | incomparable |
| 2 | B12 | security_tool_1-correct | completion | 0 | 1 | 0 | 1 | improved |
| 2 | B12 | security_tool_1-injected | completion | 0 | 1 | 0 | 1 | improved |
| 2 | B12 | security_tool_2-natural | completion | 0 | 1 | 0 | 1 | improved |
| 2 | B12 | security_tool_1-correct | elapsedMs | 570925.5 | 61747.5 | 1923 | -509178 | improved |
| 2 | B12 | security_tool_1-injected | elapsedMs | — | — | — | — | incomparable |
| 2 | B12 | security_tool_2-natural | elapsedMs | 518474 | 334349.5 | 102874 | -184124.5 | improved |
| 2 | B12 | security_tool_1-correct | tokens | — | 289161.5 | — | — | incomparable |
| 2 | B12 | security_tool_1-injected | tokens | — | 610176 | — | — | incomparable |
| 2 | B12 | security_tool_2-natural | tokens | — | 2421653 | — | — | incomparable |

## A 的基线提取与审计

第二轮整体可节省上限估计，耗时占比 0.968，token 占比 —。

| 样例 | 序号 | 基线 ms | 占 RC 耗时 | 基线 token | 占 RC token |
| --- | --- | --- | --- | --- | --- |
| security_tool_1-correct | 1 | 464748 | 0.815 | 1133417 | — |
| security_tool_1-correct | 2 | 571379 | 0.999 | — | — |
| security_tool_1-injected | 1 | 569582 | 0.999 | — | — |
| security_tool_1-injected | 2 | 569136 | 0.999 | — | — |
| security_tool_2-natural | 1 | 569479 | 0.999 | — | — |
| security_tool_2-natural | 2 | 466668 | 0.999 | 418830 | 1 |

## C 的检查得分

| 臂 | 三次得分 | 均值 | 极差 | 注入符合预期 |
| --- | --- | --- | --- | --- |
| C-off | — / 6 / — | — | — | 是 / 是 / — |
| C-on | — / — / — | — | — | 否 / 否 / 是 |

C 开减 C 关得分差 —，C 关极差 —，判定 inconclusive。

| 臂 | 序号 | 首次压缩时间 | 注入次数 | 注入长度 | 得分 |
| --- | --- | --- | --- | --- | --- |
| C-off | 1 | 1793796148268 | 0 |  | — |
| C-on | 1 | 1793796736169 | 0 |  | — |
| C-off | 2 | 1793797013926 | 0 |  | 6 |
| C-on | 2 | 1793797395108 | 0 |  | — |
| C-off | 3 | — | 0 |  | — |
| C-on | 3 | 1793797804322 | 1 | 22335 | — |

### c-off-2

> 基于我完整读过的需求文档（R01–R50 统一业务规则），以下是你要求的四类规则与数据库损坏处理方式。
>
> ## 一、菜谱编号（Recipe ID / 编号）
> - 编号由系统自动生成（自增主键），**不允许用户手动指定或修改**。
> - 每个菜谱拥有**唯一、稳定**的编号；删除后再新建不会复用被删编号（避免历史记录引用错乱）。
> - 编号只作内部标识与关联用途（食材、步骤、收藏、做菜记录、购物清单都挂在编号上），不向用户暴露为可编辑字段。
> - 删除菜谱时，其**关联记录保留该编号对应的名称/份数等快照**于历史中，即使编号本身不再可查。
>
> ## 二、食材单位与数量
> - **固定单位集，共 8 种**：克、千克、毫升、升、个、勺、杯、适量。不得新增/自定义单位。
> - **不做单位换算**：`1千克土豆` 与 `500克土豆` 视为两种不同记录，互不等价。
> - 「适量」为特殊单位：其数量**必须为空**（存 NULL）。
> - 其余 7 种单位，数量**必须为正数**，允许小数（如 0.5、300）；不允许 0 或负数。
> - 数量校验失败（非法单位、非法数值、适量却带数量）→ 该条食材非法，随事务整体拒绝并回滚。
> - 展示时去除无意义的尾零（300.0→"300"、0.5→"0.5"），「适量」显示为「适量」。
>
> ## 三、数据删除
> - **删除菜谱**：级联删除其食材、步骤、收藏、周计划条目；但**做菜记录与已有购物清单予以保留**（历史仍需可查）。
> - **购物清单**：同时只有**一张当前清单**；重新生成会**替换**旧清单，需先确认；清单中的**手工添加项不会被继承**（重新生成后消失）。
> - **示例数据**：首次初始化写入的 ≥6 条示例菜谱，用户删除后**不得再次自动出现**。
> - 任何删除操作都应可追溯、不静默；删除菜谱不删除关联的历史做菜记录。
>
> ## 四、导入 / 导出
> - **JSON 导出是“交换格式”，不是备份**；真正的备份是**一致性快照**（复制库内容而非直接拷贝正在使用的 DB 文件）。
> - **JSON 导入为“全有或全无”**：批次中任一条记录非法（如数量为负），**整个批次被拒绝**，并报告**出错位置**（哪条、哪个字段），不写入任何部分数据。
> - **CSV 导出**：使用 **UTF-8 带 BOM**，正确处理中文、逗号、引号、换行。
> - 导入、导出均只支持标准库格式（JSON/CSV），且完全离线，不联网、不上传。
>
> ## 五、数据库损坏时如何处理（重点）
> - **保留损坏的 DB，绝不自动重建 / 覆盖 / 伪装成首次启动**。
> - 检测到损坏时，应用应**报告失败原因与损坏文件位置**，而不是静默清库重来。
> - 提供**恢复路径**：用户可基于**此前的一致性备份快照**恢复数据；损坏文件本身保留以便排查。
> - 这是硬性验收场景（Scenario 6）：在测试目录放一个损坏的 DB 文件，应用必须报错并指明位置，不得覆盖或当成全新库。
>
> ---
> 需要我针对以上任意一条，说明当前代码/ACCEPTANCE 中的落实状态吗？（说明：本会话无执行工具，无法本机实跑，只能静态核对。）

| 规则 | 分数 | 依据 |
| --- | --- | --- |
| C01 | 1 | 明确每个菜谱有唯一且稳定的内部编号。 |
| C02 | 0 | 未说明菜谱可同名，也未说明名称不能代替编号。 |
| C03 | 1 | 八种固定单位全部正确。 |
| C04 | 0 | 说明正数和可用小数，但未明确拒绝自由文本数值。 |
| C05 | 1 | 规定适量只允许空值，并将携带数量判为非法，排除了用零替代。 |
| C06 | 1 | 明确不做单位换算。 |
| C07 | 1 | 删除四种关联并保留两种历史数据。 |
| C08 | 0 | 未列出菜谱 JSON 导出字段，也未说明排除做菜记录和保持源数据。 |
| C09 | 0 | 写了整批验证和不部分写入，缺新编号和不覆盖同名菜谱。 |
| C10 | 1 | 写明原因和位置，保留原文件并禁止自动覆盖和重建。 |

## 逐次记录

Stop 轮 token 为可归属的 RC 用量。C 的 token 和耗时来自整个隔离会话。覆盖不足的 token 是观测小计。

| 臂 | 样例 | 序号 | 状态 | 修复反馈 | 命中 | 误报 | 预算内 | 耗时 ms | RC ms | token | 用量覆盖 | 隐藏首稿 | 隐藏最终 | 盲评依据 | 证据 | 原因 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | internal-correct | 1 | completed | 否 | 否 | 否 | 是 | 36342 | 22919 | 47283 | 4/4 | — | — | 审查完成。正确的加一实现未收到修复反馈。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-internal-correct-1-a\evaluation\results.json | — |
| B1 | internal-correct | 1 | completed | 否 | 否 | 否 | 是 | 47788 | 33138 | 84858 | 6/6 | — | — | 审查完成。正确的加一实现未收到修复反馈。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-internal-correct-1-b1\evaluation\results.json | — |
| B2 | internal-correct | 1 | completed | 否 | 否 | 否 | 是 | 35290 | 21959 | 39615 | 4/4 | — | — | 审查完成。正确的加一实现未收到修复反馈。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-internal-correct-1-b2\evaluation\results.json | NO_DEVIATION_FOUND |
| B12 | internal-correct | 1 | completed | 否 | 否 | 否 | 是 | 41426 | 26844 | 61077 | 5/5 | — | — | 审查完成。正确的加一实现未收到修复反馈。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-internal-correct-1-b12\evaluation\results.json | NO_DEVIATION_FOUND |
| A | six-functions | 1 | completed | 否 | 否 | 否 | 是 | 54586 | 39583 | 69513 | 5/5 | — | — | 审查完成。六个正确实现均未收到修复反馈。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-six-functions-1-a\evaluation\results.json | — |
| B1 | six-functions | 1 | completed | 否 | 否 | 否 | 是 | 107331 | 92622 | 190871 | 10/10 | — | — | 审查完成。六个正确实现均未收到修复反馈。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-six-functions-1-b1\evaluation\results.json | — |
| B2 | six-functions | 1 | completed | 否 | 否 | 否 | 是 | 39479 | 24564 | 54229 | 5/5 | — | — | 审查完成。六个正确实现均未收到修复反馈。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-six-functions-1-b2\evaluation\results.json | NO_DEVIATION_FOUND |
| B12 | six-functions | 1 | completed | 否 | 否 | 否 | 是 | 41057 | 26084 | 64161 | 5/5 | — | — | 审查完成。六个正确实现均未收到修复反馈。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-six-functions-1-b12\evaluation\results.json | NO_DEVIATION_FOUND |
| A | external-bug | 1 | completed | 是 | 是 | 否 | 是 | 43175 | 29039 | 62542 | 5/5 | — | — | 定位合同原句和实现，并正确区分无状态条件。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-external-bug-1-a\evaluation\results.json | — |
| B1 | external-bug | 1 | completed | 是 | 是 | 否 | 是 | 46062 | 31789 | 91108 | 6/6 | — | — | 指出 accept 原样返回，未执行所要求的加一。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-external-bug-1-b1\evaluation\results.json | — |
| B2 | external-bug | 1 | completed | 是 | 是 | 否 | 是 | 37028 | 24012 | 54791 | 5/5 | — | — | 指出真实生产返回原值，与合同的加一要求直接矛盾。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-external-bug-1-b2\evaluation\results.json | — |
| B12 | external-bug | 1 | completed | 是 | 是 | 否 | 是 | 50019 | 35959 | 97909 | 7/7 | — | — | 对照外部合同，指出 app.mjs 恒等实现未实现加一。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-external-bug-1-b12\evaluation\results.json | — |
| A | hidden-dependency | 1 | completed | 是 | 是 | 否 | 是 | 52765 | 36909 | 77957 | 6/6 | — | — | 指出可达生产依赖 bump 是恒等函数，导致 accept 未加一。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-hidden-dependency-1-a\evaluation\results.json | — |
| B1 | hidden-dependency | 1 | completed | 是 | 是 | 否 | 是 | 52143 | 36385 | 119229 | 8/8 | — | — | 以 lib/calc.mjs 的 bump 定义确认恒等输出。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-hidden-dependency-1-b1\evaluation\results.json | — |
| B2 | hidden-dependency | 1 | completed | 是 | 是 | 否 | 是 | 47601 | 33192 | 67230 | 6/6 | — | — | 指出 bump 恒等返回导致实际生产路径不满足加一。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-hidden-dependency-1-b2\evaluation\results.json | — |
| B12 | hidden-dependency | 1 | completed | 是 | 是 | 否 | 是 | 62771 | 46918 | 134122 | 10/10 | — | — | 在 app.mjs 及 lib/calc.mjs 两处定位调用链和恒等行为。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-hidden-dependency-1-b12\evaluation\results.json | — |
| A | alias-bug | 1 | completed | 是 | 是 | 否 | 是 | 52786 | 38320 | 62338 | 5/5 | — | — | 指出别名时清空操作覆盖备份，重读丢失原始内容。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-alias-bug-1-a\evaluation\results.json | — |
| B1 | alias-bug | 1 | completed | 是 | 是 | 否 | 是 | 47991 | 33544 | 86133 | 6/6 | — | — | 指出别名路径在重读前已被清空，返回空串。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-alias-bug-1-b1\evaluation\results.json | — |
| B2 | alias-bug | 1 | completed | 是 | 是 | 否 | 是 | 47733 | 34381 | 80014 | 7/7 | — | — | 给出同一路径的执行顺序，说明应返回先前捕获的值。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-alias-bug-1-b2\evaluation\results.json | — |
| B12 | alias-bug | 1 | completed | 是 | 是 | 否 | 是 | 42707 | 33268 | 92448 | 7/7 | — | — | 追踪同路径的写入、清空与重读，指出返回值偏离。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-alias-bug-1-b12\evaluation\results.json | — |
| A | missing-run | 1 | failed | 否 | 否 | 否 | 否 | 32883 | 25182 | 44700 | 4/4 | — | — | 审查未完成。只有自述，缺少实际执行的证据。未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-missing-run-1-a\evaluation\results.json | STOP_REVIEW_INCOMPLETE |
| B1 | missing-run | 1 | failed | 否 | 否 | 否 | 否 | 30351 | 22805 | 51607 | 4/4 | — | — | 审查未完成。只有自述，缺少实际执行的证据。未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-missing-run-1-b1\evaluation\results.json | STOP_REVIEW_INCOMPLETE |
| B2 | missing-run | 1 | completed | 否 | 否 | 否 | 是 | 41762 | 34430 | 43086 | 4/4 | — | — | 审查完成。只有自述，缺少实际执行的证据。未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-missing-run-1-b2\evaluation\results.json | NO_DEVIATION_FOUND |
| B12 | missing-run | 1 | completed | 否 | 否 | 否 | 是 | 35613 | 28248 | 72217 | 6/6 | — | — | 审查完成。只有自述，缺少实际执行的证据。未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-missing-run-1-b12\evaluation\results.json | NO_DEVIATION_FOUND |
| A | mixed-skill | 1 | failed | 否 | 否 | 否 | 否 | 102616 | 94112 | 220868 | 11/11 | — | — | 审查未完成。数组 Skill 条件不适用，独立测试请求缺执行证据。未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-mixed-skill-1-a\evaluation\results.json | STOP_REVIEW_INCOMPLETE |
| B1 | mixed-skill | 1 | failed | 否 | 否 | 否 | 否 | 112561 | 104702 | 237752 | 11/11 | — | — | 审查未完成。数组 Skill 条件不适用，独立测试请求缺执行证据。未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-mixed-skill-1-b1\evaluation\results.json | STOP_REVIEW_INCOMPLETE |
| B2 | mixed-skill | 1 | completed | 否 | 否 | 否 | 是 | 57438 | 50070 | 91686 | 6/6 | — | — | 审查完成。数组 Skill 条件不适用，独立测试请求缺执行证据。未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-mixed-skill-1-b2\evaluation\results.json | NO_DEVIATION_FOUND |
| B12 | mixed-skill | 1 | completed | 否 | 否 | 否 | 是 | 97277 | 89802 | 177895 | 10/10 | — | — | 审查完成。数组 Skill 条件不适用，独立测试请求缺执行证据。未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-mixed-skill-1-b12\evaluation\results.json | NO_DEVIATION_FOUND |
| B1 | internal-correct | 2 | completed | 否 | 否 | 否 | 是 | 36663 | 28841 | 71004 | 5/5 | — | — | 审查完成。正确的加一实现未收到修复反馈。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-internal-correct-2-b1\evaluation\results.json | — |
| B2 | internal-correct | 2 | completed | 否 | 否 | 否 | 是 | 28462 | 20894 | 50628 | 5/5 | — | — | 审查完成。正确的加一实现未收到修复反馈。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-internal-correct-2-b2\evaluation\results.json | NO_DEVIATION_FOUND |
| B12 | internal-correct | 2 | completed | 否 | 否 | 否 | 是 | 42968 | 30330 | 91613 | 7/7 | — | — | 审查完成。正确的加一实现未收到修复反馈。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-internal-correct-2-b12\evaluation\results.json | NO_DEVIATION_FOUND |
| A | internal-correct | 2 | completed | 否 | 否 | 否 | 是 | 34375 | 22226 | 47172 | 4/4 | — | — | 审查完成。正确的加一实现未收到修复反馈。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-internal-correct-2-a\evaluation\results.json | — |
| B1 | six-functions | 2 | completed | 否 | 否 | 否 | 是 | 57787 | 44814 | 111630 | 7/7 | — | — | 审查完成。六个正确实现均未收到修复反馈。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-six-functions-2-b1\evaluation\results.json | — |
| B2 | six-functions | 2 | completed | 否 | 否 | 否 | 是 | 31230 | 19269 | 42061 | 4/4 | — | — | 审查完成。六个正确实现均未收到修复反馈。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-six-functions-2-b2\evaluation\results.json | NO_DEVIATION_FOUND |
| B12 | six-functions | 2 | completed | 否 | 否 | 否 | 是 | 50738 | 38791 | 111675 | 8/8 | — | — | 审查完成。六个正确实现均未收到修复反馈。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-six-functions-2-b12\evaluation\results.json | NO_DEVIATION_FOUND |
| A | six-functions | 2 | completed | 否 | 否 | 否 | 是 | 57625 | 44228 | 69835 | 5/5 | — | — | 审查完成。六个正确实现均未收到修复反馈。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-six-functions-2-a\evaluation\results.json | — |
| B1 | external-bug | 2 | completed | 是 | 是 | 否 | 是 | 58191 | 44725 | 126180 | 8/8 | — | — | 对照外部合同和 app.mjs 的恒等实现，指出实际返回值缺少加一。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-external-bug-2-b1\evaluation\results.json | — |
| B2 | external-bug | 2 | completed | 是 | 是 | 否 | 是 | 37131 | 24107 | 54916 | 5/5 | — | — | 对照外部合同和 app.mjs 的恒等实现，指出实际返回值缺少加一。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-external-bug-2-b2\evaluation\results.json | — |
| B12 | external-bug | 2 | completed | 是 | 是 | 否 | 是 | 44034 | 32095 | 80584 | 6/6 | — | — | 对照外部合同和 app.mjs 的恒等实现，指出实际返回值缺少加一。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-external-bug-2-b12\evaluation\results.json | — |
| A | external-bug | 2 | completed | 是 | 是 | 否 | 是 | 35989 | 27330 | 63579 | 5/5 | — | — | 对照外部合同和 app.mjs 的恒等实现，指出实际返回值缺少加一。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-external-bug-2-a\evaluation\results.json | — |
| B1 | hidden-dependency | 2 | completed | 是 | 是 | 否 | 是 | 51726 | 43920 | 150005 | 10/10 | — | — | 追踪 accept 到 calc.mjs 中的恒等 bump，指出依赖返回原值导致加一缺失。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-hidden-dependency-2-b1\evaluation\results.json | — |
| B2 | hidden-dependency | 2 | completed | 是 | 是 | 否 | 是 | 43622 | 35865 | 108246 | 9/9 | — | — | 追踪 accept 到 calc.mjs 中的恒等 bump，指出依赖返回原值导致加一缺失。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-hidden-dependency-2-b2\evaluation\results.json | — |
| B12 | hidden-dependency | 2 | completed | 是 | 是 | 否 | 是 | 41815 | 34715 | 106319 | 8/8 | — | — | 追踪 accept 到 calc.mjs 中的恒等 bump，指出依赖返回原值导致加一缺失。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-hidden-dependency-2-b12\evaluation\results.json | — |
| A | hidden-dependency | 2 | completed | 是 | 是 | 否 | 是 | 42856 | 35266 | 94259 | 7/7 | — | — | 追踪 accept 到 calc.mjs 中的恒等 bump，指出依赖返回原值导致加一缺失。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-hidden-dependency-2-a\evaluation\results.json | — |
| B1 | alias-bug | 2 | completed | 是 | 是 | 否 | 是 | 53113 | 45752 | 109955 | 7/7 | — | — | 指出相同路径在重读前被清空，导致返回空串而非已捕获的原内容。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-2-b1\evaluation\results.json | — |
| B2 | alias-bug | 2 | completed | 是 | 是 | 否 | 是 | 32662 | 25467 | 56217 | 5/5 | — | — | 指出相同路径在重读前被清空，导致返回空串而非已捕获的原内容。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-2-b2\evaluation\results.json | — |
| B12 | alias-bug | 2 | completed | 是 | 是 | 否 | 是 | 50887 | 43619 | 110501 | 8/8 | — | — | 指出相同路径在重读前被清空，导致返回空串而非已捕获的原内容。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-2-b12\evaluation\results.json | — |
| A | alias-bug | 2 | completed | 是 | 是 | 否 | 是 | 43122 | 34904 | 62333 | 5/5 | — | — | 指出相同路径在重读前被清空，导致返回空串而非已捕获的原内容。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-2-a\evaluation\results.json | — |
| B1 | missing-run | 2 | failed | 否 | 否 | 否 | 否 | 36578 | 28715 | 63437 | 5/5 | — | — | 审查未完成。只有自述，缺少实际执行的证据。未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-missing-run-2-b1\evaluation\results.json | STOP_REVIEW_INCOMPLETE |
| B2 | missing-run | 2 | completed | 否 | 否 | 否 | 是 | 29101 | 21883 | 42936 | 4/4 | — | — | 审查完成。只有自述，缺少实际执行的证据。未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-missing-run-2-b2\evaluation\results.json | NO_DEVIATION_FOUND |
| B12 | missing-run | 2 | completed | 否 | 否 | 否 | 是 | 36438 | 28807 | 60249 | 5/5 | — | — | 审查完成。只有自述，缺少实际执行的证据。未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-missing-run-2-b12\evaluation\results.json | NO_DEVIATION_FOUND |
| A | missing-run | 2 | failed | 否 | 否 | 否 | 否 | 31883 | 24443 | 44935 | 4/4 | — | — | 审查未完成。只有自述，缺少实际执行的证据。未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-missing-run-2-a\evaluation\results.json | STOP_REVIEW_INCOMPLETE |
| B1 | mixed-skill | 2 | timed-out | 否 | 否 | 否 | 否 | 188642 | 180288 | 369039 | 14/15 | — | — | 审查到时限。数组 Skill 条件不适用，独立测试请求缺执行证据。未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-mixed-skill-2-b1\evaluation\results.json | REVIEWER_DEADLINE |
| B2 | mixed-skill | 2 | completed | 否 | 否 | 否 | 是 | 65628 | 53341 | 111082 | 7/7 | — | — | 审查完成。数组 Skill 条件不适用，独立测试请求缺执行证据。未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-mixed-skill-2-b2\evaluation\results.json | NO_DEVIATION_FOUND |
| B12 | mixed-skill | 2 | completed | 否 | 否 | 否 | 是 | 100500 | 87489 | 164358 | 9/9 | — | — | 审查完成。数组 Skill 条件不适用，独立测试请求缺执行证据。未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-mixed-skill-2-b12\evaluation\results.json | NO_DEVIATION_FOUND |
| A | mixed-skill | 2 | failed | 否 | 否 | 否 | 否 | 96293 | 85591 | 161434 | 8/8 | — | — | 审查未完成。数组 Skill 条件不适用，独立测试请求缺执行证据。未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-mixed-skill-2-a\evaluation\results.json | STOP_REVIEW_INCOMPLETE |
| B2 | internal-correct | 3 | completed | 否 | 否 | 否 | 是 | 33234 | 19694 | 40540 | 4/4 | — | — | 审查完成。正确的加一实现未收到修复反馈。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-internal-correct-3-b2\evaluation\results.json | NO_DEVIATION_FOUND |
| B12 | internal-correct | 3 | completed | 否 | 否 | 否 | 是 | 39075 | 26579 | 62113 | 5/5 | — | — | 审查完成。正确的加一实现未收到修复反馈。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-internal-correct-3-b12\evaluation\results.json | NO_DEVIATION_FOUND |
| A | internal-correct | 3 | completed | 否 | 否 | 否 | 是 | 41139 | 27857 | 71267 | 6/6 | — | — | 审查完成。正确的加一实现未收到修复反馈。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-internal-correct-3-a\evaluation\results.json | — |
| B1 | internal-correct | 3 | completed | 否 | 否 | 否 | 是 | 36095 | 23448 | 68861 | 5/5 | — | — | 审查完成。正确的加一实现未收到修复反馈。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-internal-correct-3-b1\evaluation\results.json | — |
| B2 | six-functions | 3 | completed | 否 | 否 | 否 | 是 | 32970 | 20072 | 42684 | 4/4 | — | — | 审查完成。六个正确实现均未收到修复反馈。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-six-functions-3-b2\evaluation\results.json | NO_DEVIATION_FOUND |
| B12 | six-functions | 3 | completed | 否 | 否 | 否 | 是 | 37707 | 25695 | 50456 | 4/4 | — | — | 审查完成。六个正确实现均未收到修复反馈。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-six-functions-3-b12\evaluation\results.json | NO_DEVIATION_FOUND |
| A | six-functions | 3 | completed | 否 | 否 | 否 | 是 | 51308 | 38121 | 82752 | 6/6 | — | — | 审查完成。六个正确实现均未收到修复反馈。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-six-functions-3-a\evaluation\results.json | — |
| B1 | six-functions | 3 | completed | 否 | 否 | 否 | 是 | 58315 | 46355 | 98232 | 6/6 | — | — | 审查完成。六个正确实现均未收到修复反馈。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-six-functions-3-b1\evaluation\results.json | — |
| B2 | external-bug | 3 | completed | 是 | 是 | 否 | 是 | 36353 | 23582 | 53644 | 5/5 | — | — | 定位 app.mjs 原样返回，和外部合同要求加一直接矛盾。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-external-bug-3-b2\evaluation\results.json | — |
| B12 | external-bug | 3 | completed | 是 | 是 | 否 | 是 | 41420 | 28316 | 77098 | 6/6 | — | — | 定位 app.mjs 原样返回，和外部合同要求加一直接矛盾。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-external-bug-3-b12\evaluation\results.json | — |
| A | external-bug | 3 | completed | 是 | 是 | 否 | 是 | 40237 | 27234 | 65705 | 5/5 | — | — | 定位 app.mjs 原样返回，和外部合同要求加一直接矛盾。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-external-bug-3-a\evaluation\results.json | — |
| B1 | external-bug | 3 | completed | 是 | 是 | 否 | 是 | 53146 | 41121 | 111067 | 7/7 | — | — | 定位 app.mjs 原样返回，和外部合同要求加一直接矛盾。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-external-bug-3-b1\evaluation\results.json | — |
| B2 | hidden-dependency | 3 | completed | 是 | 是 | 否 | 是 | 41177 | 29003 | 64344 | 6/6 | — | — | 跟踪 app.mjs 的调用进入 lib/calc.mjs，指出 bump 原样返回使加一要求落空。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-hidden-dependency-3-b2\evaluation\results.json | — |
| B12 | hidden-dependency | 3 | completed | 是 | 是 | 否 | 是 | 54591 | 41542 | 134430 | 10/10 | — | — | 跟踪 app.mjs 的调用进入 lib/calc.mjs，指出 bump 原样返回使加一要求落空。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-hidden-dependency-3-b12\evaluation\results.json | — |
| A | hidden-dependency | 3 | completed | 是 | 是 | 否 | 是 | 44368 | 36540 | 91833 | 7/7 | — | — | 跟踪 app.mjs 的调用进入 lib/calc.mjs，指出 bump 原样返回使加一要求落空。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-hidden-dependency-3-a\evaluation\results.json | — |
| B1 | hidden-dependency | 3 | completed | 是 | 是 | 否 | 是 | 46897 | 38883 | 101887 | 7/7 | — | — | 跟踪 app.mjs 的调用进入 lib/calc.mjs，指出 bump 原样返回使加一要求落空。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-hidden-dependency-3-b1\evaluation\results.json | — |
| B2 | alias-bug | 3 | completed | 是 | 是 | 否 | 是 | 37594 | 26491 | 65409 | 6/6 | — | — | 指出别名路径清空后再次读取，返回空串，违反保留原始内容的要求。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-3-b2\evaluation\results.json | — |
| B12 | alias-bug | 3 | completed | 是 | 是 | 否 | 是 | 51601 | 37972 | 90942 | 7/7 | — | — | 指出别名路径清空后再次读取，返回空串，违反保留原始内容的要求。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-3-b12\evaluation\results.json | — |
| A | alias-bug | 3 | completed | 是 | 是 | 否 | 是 | 45781 | 31220 | 64655 | 5/5 | — | — | 指出别名路径清空后再次读取，返回空串，违反保留原始内容的要求。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-3-a\evaluation\results.json | — |
| B1 | alias-bug | 3 | completed | 是 | 是 | 否 | 是 | 58043 | 45332 | 106686 | 7/7 | — | — | 指出别名路径清空后再次读取，返回空串，违反保留原始内容的要求。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-3-b1\evaluation\results.json | — |
| B2 | missing-run | 3 | completed | 否 | 否 | 否 | 是 | 38646 | 25955 | 43383 | 4/4 | — | — | 审查完成。只有自述，缺少实际执行的证据。未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-missing-run-3-b2\evaluation\results.json | NO_DEVIATION_FOUND |
| B12 | missing-run | 3 | completed | 否 | 否 | 否 | 是 | 64135 | 51801 | 96065 | 7/7 | — | — | 审查完成。只有自述，缺少实际执行的证据。未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-missing-run-3-b12\evaluation\results.json | NO_DEVIATION_FOUND |
| A | missing-run | 3 | failed | 否 | 否 | 否 | 否 | 36155 | 28595 | 59395 | 5/5 | — | — | 审查未完成。只有自述，缺少实际执行的证据。未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-missing-run-3-a\evaluation\results.json | STOP_REVIEW_INCOMPLETE |
| B1 | missing-run | 3 | failed | 否 | 否 | 否 | 否 | 47780 | 38584 | 80700 | 6/6 | — | — | 审查未完成。只有自述，缺少实际执行的证据。未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-missing-run-3-b1\evaluation\results.json | STOP_REVIEW_INCOMPLETE |
| B2 | mixed-skill | 3 | completed | 否 | 否 | 否 | 是 | 55053 | 47023 | 86264 | 6/6 | — | — | 审查完成。数组 Skill 条件不适用，独立测试请求缺执行证据。未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-mixed-skill-3-b2\evaluation\results.json | NO_DEVIATION_FOUND |
| B12 | mixed-skill | 3 | completed | 否 | 否 | 否 | 是 | 68596 | 55599 | 92658 | 6/6 | — | — | 审查完成。数组 Skill 条件不适用，独立测试请求缺执行证据。未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-mixed-skill-3-b12\evaluation\results.json | NO_DEVIATION_FOUND |
| A | mixed-skill | 3 | failed | 否 | 否 | 否 | 否 | 77187 | 64725 | 129555 | 7/7 | — | — | 审查未完成。数组 Skill 条件不适用，独立测试请求缺执行证据。未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-mixed-skill-3-a\evaluation\results.json | STOP_REVIEW_INCOMPLETE |
| B1 | mixed-skill | 3 | timed-out | 否 | 否 | 否 | 否 | 192387 | 180267 | 385510 | 15/16 | — | — | 审查到时限。数组 Skill 条件不适用，独立测试请求缺执行证据。未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-mixed-skill-3-b1\evaluation\results.json | REVIEWER_DEADLINE |
| A | security_tool_1-correct | 1 | timed-out | 否 | 否 | 否 | 否 | 571716 | 569964 | 1771622 | 39/40 | 1/1；611/611 | 1/1；611/611 | 冻结首稿已通过隐藏评分，未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round2-new\r2-security_tool_1-correct-1-a\evaluation\result.json | STOP_REVIEW_DEADLINE |
| B2 | security_tool_1-correct | 1 | timed-out | 否 | 否 | 否 | 否 | 571410 | 570002 | 377026 | 13/14 | 1/1；611/611 | 1/1；611/611 | 冻结首稿已通过隐藏评分，未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round2-new\r2-security_tool_1-correct-1-b2\evaluation\result.json | STOP_REVIEW_DEADLINE |
| B12 | security_tool_1-correct | 1 | completed | 否 | 否 | 否 | 是 | 53585 | 52085 | 229349 | 10/10 | 1/1；611/611 | 1/1；611/611 | 冻结首稿已通过隐藏评分，未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round2-new\r2-security_tool_1-correct-1-b12\evaluation\result.json | NO_CURRENT_DEVIATION |
| B2 | security_tool_1-correct | 2 | timed-out | 否 | 否 | 否 | 否 | 571026 | 569984 | 1037584 | 22/23 | 1/1；611/611 | 1/1；611/611 | 冻结首稿已通过隐藏评分，未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round2-new\r2-security_tool_1-correct-2-b2\evaluation\result.json | STOP_REVIEW_DEADLINE |
| B12 | security_tool_1-correct | 2 | completed | 否 | 否 | 否 | 是 | 72749 | 71410 | 348974 | 13/13 | 1/1；611/611 | 1/1；611/611 | 冻结首稿已通过隐藏评分，未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round2-new\r2-security_tool_1-correct-2-b12\evaluation\result.json | NO_CURRENT_DEVIATION |
| A | security_tool_1-correct | 2 | timed-out | 否 | 否 | 否 | 否 | 573270 | 571887 | 1164969 | 24/25 | 1/1；611/611 | 1/1；611/611 | 冻结首稿已通过隐藏评分，未发修复反馈，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round2-new\r2-security_tool_1-correct-2-a\evaluation\result.json | STOP_REVIEW_DEADLINE |
| A | security_tool_1-injected | 1 | timed-out | 否 | 否 | 否 | 否 | 571530 | 569986 | 1288403 | 25/26 | 0/1；611/611 | 0/1；611/611 | 未发修复反馈，未检出冻结变体缺失 20 位选项及映射的真实缺陷。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round2-new\r2-security_tool_1-injected-1-a\evaluation\result.json | STOP_REVIEW_DEADLINE |
| B2 | security_tool_1-injected | 1 | timed-out | 否 | 否 | 否 | 否 | 571573 | 569858 | 1184318 | 27/28 | 0/1；611/611 | 0/1；611/611 | 未发修复反馈，未检出冻结变体缺失 20 位选项及映射的真实缺陷。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round2-new\r2-security_tool_1-injected-1-b2\evaluation\result.json | STOP_REVIEW_DEADLINE |
| B12 | security_tool_1-injected | 1 | completed | 是 | 是 | 否 | 是 | 316666 | 182783 | 706298 | 25/25 | 0/1；611/611 | 1/1；611/611 | 指出当前选项表缺 20，追到 indexOf(20) 返回 -1 并保留默认值，命中已验证的注入缺陷。两项反馈指向同一个缺陷的两条要求。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round2-new-resume\r2-security_tool_1-injected-1-b12\evaluation\result.json | ASSESSMENT_DELIVERED |
| B2 | security_tool_1-injected | 2 | timed-out | 否 | 否 | 否 | 否 | 571286 | 569925 | 1447034 | 29/30 | 0/1；611/611 | 0/1；611/611 | 未发修复反馈，未检出冻结变体缺失 20 位选项及映射的真实缺陷。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round2-new-resume\r2-security_tool_1-injected-2-b2\evaluation\result.json | STOP_REVIEW_DEADLINE |
| B12 | security_tool_1-injected | 2 | completed | 是 | 是 | 否 | 是 | 231557 | 119517 | 514054 | 18/18 | 0/1；611/611 | 1/1；611/611 | 引用当前 DataModels 与 applyConfig，说明 20 缺失且 24 的位置随之左移。20 位策略无法映射，命中注入缺陷。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round2-new-resume\r2-security_tool_1-injected-2-b12\evaluation\result.json | ASSESSMENT_DELIVERED |
| A | security_tool_1-injected | 2 | timed-out | 否 | 否 | 否 | 否 | 570922 | 569948 | 1631265 | 38/39 | 0/1；611/611 | 0/1；611/611 | 未发修复反馈，未检出冻结变体缺失 20 位选项及映射的真实缺陷。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round2-new-resume\r2-security_tool_1-injected-2-a\evaluation\result.json | STOP_REVIEW_DEADLINE |
| A | security_tool_2-natural | 1 | timed-out | 否 | 否 | 否 | 否 | 571869 | 569911 | 1711443 | 31/32 | — | — | 未向宿主发送修复反馈。未命中首稿删除 PermissionService.loadApplications 导致原测试无法编译的问题，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round2-st2\r2-security_tool_2-natural-1-a\evaluation\result.json | STOP_REVIEW_DEADLINE |
| B2 | security_tool_2-natural | 1 | timed-out | 否 | 否 | 否 | 否 | 573652 | 571859 | 1557060 | 26/27 | — | — | 未向宿主发送修复反馈。未命中首稿删除 PermissionService.loadApplications 导致原测试无法编译的问题，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round2-st2\r2-security_tool_2-natural-1-b2\evaluation\result.json | STOP_REVIEW_DEADLINE |
| B12 | security_tool_2-natural | 1 | completed | 否 | 否 | 否 | 是 | 508013 | 506221 | 3819753 | 46/46 | — | — | 未向宿主发送修复反馈。未命中首稿删除 PermissionService.loadApplications 导致原测试无法编译的问题，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round2-st2\r2-security_tool_2-natural-1-b12\evaluation\result.json | NO_CURRENT_DEVIATION |
| B2 | security_tool_2-natural | 2 | timed-out | 否 | 否 | 否 | 否 | 571133 | 569990 | 882576 | 22/23 | — | — | 未向宿主发送修复反馈。未命中首稿删除 PermissionService.loadApplications 导致原测试无法编译的问题，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round2-st2-resume\r2-security_tool_2-natural-2-b2\evaluation\result.json | STOP_REVIEW_DEADLINE |
| B12 | security_tool_2-natural | 2 | completed | 否 | 否 | 否 | 是 | 164197 | 162478 | 1023553 | 19/19 | — | — | 未向宿主发送修复反馈。未命中首稿删除 PermissionService.loadApplications 导致原测试无法编译的问题，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round2-st2\r2-security_tool_2-natural-2-b12\evaluation\result.json | NO_CURRENT_DEVIATION |
| A | security_tool_2-natural | 2 | failed | 否 | 否 | 否 | 否 | 468657 | 467037 | 418830 | 11/11 | — | — | 未向宿主发送修复反馈。未命中首稿删除 PermissionService.loadApplications 导致原测试无法编译的问题，无误报。 | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round2-st2\r2-security_tool_2-natural-2-a\evaluation\result.json | REVIEWER_OUTPUT_LIMIT |
| C-off | kitchen-compaction | 1 | failed | — | — | — | 否 | 261207 | — | 524424 | 24/27 | — | — | — | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\c-formal\c-off-1\evaluation\result.json | Compaction turn did not complete. |
| C-on | kitchen-compaction | 1 | failed | — | — | — | 否 | 290941 | — | 393370 | 19/22 | — | — | — | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\c-formal-resume\c-on-1\evaluation\result.json | Compaction turn did not complete. |
| C-off | kitchen-compaction | 2 | completed | — | — | — | 是 | 343188 | — | 321498 | 16/21 | — | — | — | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\c-formal-resume\c-off-2\evaluation\result.json | — |
| C-on | kitchen-compaction | 2 | failed | — | — | — | 否 | 311331 | — | 483283 | 16/19 | — | — | — | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\c-formal-resume\c-on-2\evaluation\result.json | Compaction turn did not complete. |
| C-off | kitchen-compaction | 3 | failed | — | — | — | 否 | 195609 | — | 11032 | 1/15 | — | — | — | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\c-formal-resume\c-off-3\evaluation\result.json | Compaction turn did not complete. |
| C-on | kitchen-compaction | 3 | failed | — | — | — | 否 | 221115 | — | 216314 | 11/14 | — | — | — | C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\c-formal-resume\c-on-3\evaluation\result.json | Compaction turn did not complete. |

### 实际修复反馈

#### r1-external-bug-1-a

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:R1, R1: The original contract requires accept(value) to return the input number plus one (original-contract.md line 1: "must return the input number plus one").
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-external-bug-1-a\evaluation\sample-15745f50-ef33-42b9-809c-ab2875a7c9d7\original-contract.md#L1-L2
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-external-bug-1-a\evaluation\sample-15745f50-ef33-42b9-809c-ab2875a7c9d7\project\app.mjs#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-external-bug-1-a\evaluation\sample-15745f50-ef33-42b9-809c-ab2875a7c9d7\project\.runtime-correction\tasks\task-20261104T140108493Z-d1b67e33\feedback-delivery\feedback-20261104T140150497Z-1e7904c5\index.json

#### r1-external-bug-1-b1

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:original-eefa8282af2f0f01927ac8da, original-eefa8282af2f0f01927ac8da: app.mjs exports accept as `value => value`, which returns the input unchanged instead of the required input number plus one, so the sole required production behavior is not implemented.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-external-bug-1-b1\evaluation\sample-64d6e8b8-3b12-42ed-a1b0-21c564b2dd81\project\app.mjs#L1-L2
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-external-bug-1-b1\evaluation\sample-64d6e8b8-3b12-42ed-a1b0-21c564b2dd81\original-contract.md#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-external-bug-1-b1\evaluation\sample-64d6e8b8-3b12-42ed-a1b0-21c564b2dd81\project\.runtime-correction\tasks\task-20261104T140108500Z-428e8c3b\feedback-delivery\feedback-20261104T140153320Z-77c79d0a\index.json

#### r1-external-bug-1-b2

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:R1, R1: The original contract requires the production accept(value) function to return the input number plus one (and not store state).
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-external-bug-1-b2\evaluation\sample-2fd1783c-9a3c-4714-9557-675852953c06\original-contract.md#L1-L2
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-external-bug-1-b2\evaluation\sample-2fd1783c-9a3c-4714-9557-675852953c06\project\app.mjs#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-external-bug-1-b2\evaluation\sample-2fd1783c-9a3c-4714-9557-675852953c06\project\.runtime-correction\tasks\task-20261104T140108493Z-730154bf\feedback-delivery\feedback-20261104T140144340Z-68cd2055\index.json

#### r1-external-bug-1-b12

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:original-1db9d8bed31db96e5d32eec5, original-1db9d8bed31db96e5d32eec5: The original contract requires accept(value) to return the input number plus one, but app.mjs implements `export const accept = value => value;`, returning the input unchanged.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-external-bug-1-b12\evaluation\sample-b94ad15d-345f-4cdd-ae41-5ed37a61d925\project\app.mjs#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-external-bug-1-b12\evaluation\sample-b94ad15d-345f-4cdd-ae41-5ed37a61d925\project\.runtime-correction\tasks\task-20261104T140108504Z-7e4aa823\feedback-delivery\feedback-20261104T140157225Z-6bf07691\index.json

#### r1-hidden-dependency-1-a

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:R1, R1: Required behavior is "returns the input number plus one".
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-hidden-dependency-1-a\evaluation\sample-0fda32ea-ccb1-46e1-99e3-e314a07740a1\project\app.mjs#L1-L3
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-hidden-dependency-1-a\evaluation\sample-0fda32ea-ccb1-46e1-99e3-e314a07740a1\project\lib\calc.mjs#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-hidden-dependency-1-a\evaluation\sample-0fda32ea-ccb1-46e1-99e3-e314a07740a1\project\.runtime-correction\tasks\task-20261104T140159285Z-3196d5b3\feedback-delivery\feedback-20261104T140250784Z-62a732da\index.json

#### r1-hidden-dependency-1-b1

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:original-057ecffeedf09bec35368fee, original-057ecffeedf09bec35368fee: accept(value) must return value+1.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-hidden-dependency-1-b1\evaluation\sample-d3251ac2-88cb-4c2f-95c3-47cac1b30431\project\app.mjs#L1-L3
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-hidden-dependency-1-b1\evaluation\sample-d3251ac2-88cb-4c2f-95c3-47cac1b30431\project\lib\calc.mjs#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-hidden-dependency-1-b1\evaluation\sample-d3251ac2-88cb-4c2f-95c3-47cac1b30431\project\.runtime-correction\tasks\task-20261104T140159306Z-9e627fb4\feedback-delivery\feedback-20261104T140250158Z-de236476\index.json

#### r1-hidden-dependency-1-b2

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:R1, R1: The requirement is that accept(value) in app.mjs returns the input number plus one.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-hidden-dependency-1-b2\evaluation\sample-7473370c-181d-4c6f-a435-849c75833050\project\app.mjs#L1-L3
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-hidden-dependency-1-b2\evaluation\sample-7473370c-181d-4c6f-a435-849c75833050\project\lib\calc.mjs#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-hidden-dependency-1-b2\evaluation\sample-7473370c-181d-4c6f-a435-849c75833050\project\.runtime-correction\tasks\task-20261104T140159307Z-39f94ca7\feedback-delivery\feedback-20261104T140245730Z-b3532f40\index.json

#### r1-hidden-dependency-1-b12

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:original-057ecffeedf09bec35368fee, original-057ecffeedf09bec35368fee: Requirement: accept(value) in app.mjs must return the input number plus one.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-hidden-dependency-1-b12\evaluation\sample-a858ca24-1f6a-4950-9679-bc1ef60e3ebb\project\app.mjs#L1-L3
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-hidden-dependency-1-b12\evaluation\sample-a858ca24-1f6a-4950-9679-bc1ef60e3ebb\project\lib\calc.mjs#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-hidden-dependency-1-b12\evaluation\sample-a858ca24-1f6a-4950-9679-bc1ef60e3ebb\project\.runtime-correction\tasks\task-20261104T140159306Z-8d14e170\feedback-delivery\feedback-20261104T140300747Z-f233bd76\index.json

#### r1-alias-bug-1-a

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:R1, R1: The implementation fails the explicitly allowed aliasing case sourcePath === backupPath.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-alias-bug-1-a\evaluation\sample-79aa175d-ad34-410b-8124-594a218bb85c\project\app.mjs#L1-L7
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-alias-bug-1-a\evaluation\sample-79aa175d-ad34-410b-8124-594a218bb85c\project\.runtime-correction\tasks\task-20261104T140302873Z-aba026d8\workspace-reviews\3c3209ce-bb3f-420d-abe4-a9eddfc4f8f3\basis\original-basis-0000.txt#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-alias-bug-1-a\evaluation\sample-79aa175d-ad34-410b-8124-594a218bb85c\project\.runtime-correction\tasks\task-20261104T140302873Z-aba026d8\feedback-delivery\feedback-20261104T140354235Z-2dd3b2d0\index.json

#### r1-alias-bug-1-b1

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:original-52420e5b53b17905f74b4f62, original-52420e5b53b17905f74b4f62: The requirement explicitly allows sourcePath === backupPath and requires the return value to still be the original contents in that case.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-alias-bug-1-b1\evaluation\sample-9b349272-405d-401f-a1aa-89b2914cc7f4\project\app.mjs#L1-L7
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-alias-bug-1-b1\evaluation\sample-9b349272-405d-401f-a1aa-89b2914cc7f4\project\.runtime-correction\tasks\task-20261104T140302873Z-8ddca2a7\feedback-delivery\feedback-20261104T140349434Z-e9369241\index.json

#### r1-alias-bug-1-b2

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:R1, R1: When sourcePath === backupPath (explicitly allowed), the sequence is: value = read(sourcePath); write(sourcePath, value); write(sourcePath, ''); return read(sourcePath).
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-alias-bug-1-b2\evaluation\sample-0c50726b-ef81-4be2-84c5-06ca2c3861bd\project\app.mjs#L1-L7
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new\r1-alias-bug-1-b2\evaluation\sample-0c50726b-ef81-4be2-84c5-06ca2c3861bd\project\.runtime-correction\tasks\task-20261104T140302874Z-f1d9df7d\feedback-delivery\feedback-20261104T140349310Z-4d70d0d6\index.json

#### r1-alias-bug-1-b12

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:original-1202282ea988646be5801522, original-1202282ea988646be5801522: snapshot returns io.read(backupPath) rather than the original contents captured in `value`.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-alias-bug-1-b12\evaluation\sample-8ec3642a-a21e-460a-a9d5-0ad25d5c2c86\project\app.mjs#L1-L7
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-alias-bug-1-b12\evaluation\sample-8ec3642a-a21e-460a-a9d5-0ad25d5c2c86\project\.runtime-correction\tasks\task-20261104T140448882Z-876a5789\feedback-delivery\feedback-20261104T140530896Z-7d5c8cdc\index.json

#### r1-external-bug-2-b1

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:original-f04719ff5455256abd8c7ecf, original-f04719ff5455256abd8c7ecf: The original contract requires accept(value) to return the input number plus one, but app.mjs line 1 defines `export const accept = value => value;`, which returns the input unchanged (identity) rather than adding 1.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-external-bug-2-b1\evaluation\sample-2a5117b5-a886-4112-b183-33c8638b4a3d\original-contract.md#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-external-bug-2-b1\evaluation\sample-2a5117b5-a886-4112-b183-33c8638b4a3d\project\.runtime-correction\tasks\task-20261104T141952649Z-d2b6958c\feedback-delivery\feedback-20261104T142049641Z-4076f645\index.json

#### r1-external-bug-2-b2

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:R1, R1: The frozen contract (original-contract.md) requires: "The production accept(value) function must return the input number plus one.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-external-bug-2-b2\evaluation\sample-062ea4f9-2d67-4b63-9a9f-7f341c11f3c4\original-contract.md#L1-L2
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-external-bug-2-b2\evaluation\sample-062ea4f9-2d67-4b63-9a9f-7f341c11f3c4\project\app.mjs#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-external-bug-2-b2\evaluation\sample-062ea4f9-2d67-4b63-9a9f-7f341c11f3c4\project\.runtime-correction\tasks\task-20261104T142051496Z-81e31941\feedback-delivery\feedback-20261104T142127358Z-1f914af7\index.json

#### r1-external-bug-2-b12

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:original-132db2c8fdb4dd67972a5021, original-132db2c8fdb4dd67972a5021: Contract requires accept(value) to return the input number plus one.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-external-bug-2-b12\evaluation\sample-fd541ddf-f2b3-43b9-8b2b-e1b981f8f2a3\original-contract.md#L1-L2
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-external-bug-2-b12\evaluation\sample-fd541ddf-f2b3-43b9-8b2b-e1b981f8f2a3\project\app.mjs#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-external-bug-2-b12\evaluation\sample-fd541ddf-f2b3-43b9-8b2b-e1b981f8f2a3\project\.runtime-correction\tasks\task-20261104T142129193Z-c1ff9c78\feedback-delivery\feedback-20261104T142211812Z-d15f2098\index.json

#### r1-external-bug-2-a

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:R1, R1: Contract (original-contract.md) requires the production accept(value) function to return the input number plus one.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-external-bug-2-a\evaluation\sample-6dc0a048-2c10-4188-8388-f51e54d21195\original-contract.md#L1-L2
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-external-bug-2-a\evaluation\sample-6dc0a048-2c10-4188-8388-f51e54d21195\project\app.mjs#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-external-bug-2-a\evaluation\sample-6dc0a048-2c10-4188-8388-f51e54d21195\project\.runtime-correction\tasks\task-20261104T142213858Z-a46bb2b6\feedback-delivery\feedback-20261104T142249275Z-a4deaf23\index.json

#### r1-hidden-dependency-2-b1

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:original-2aa01c9dbfca16508c389617, original-2aa01c9dbfca16508c389617: accept(value) delegates to bump(value) (app.mjs:2), and bump (lib/calc.mjs:1-2) returns value unchanged without adding one.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-hidden-dependency-2-b1\evaluation\sample-f952b3f8-a9c2-448f-aaa8-300ddd7a4386\project\app.mjs#L1-L3
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-hidden-dependency-2-b1\evaluation\sample-f952b3f8-a9c2-448f-aaa8-300ddd7a4386\project\lib\calc.mjs#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-hidden-dependency-2-b1\evaluation\sample-f952b3f8-a9c2-448f-aaa8-300ddd7a4386\project\.runtime-correction\tasks\task-20261104T142250434Z-341776cd\feedback-delivery\feedback-20261104T142341480Z-6fa8fe9c\index.json

#### r1-hidden-dependency-2-b2

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:R1, R1: app.mjs exports accept = value => bump(value), delegating to bump in lib/calc.mjs which is defined as value => value (identity).
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-hidden-dependency-2-b2\evaluation\sample-2b363555-1d90-43fe-bb58-4fb0ff77d61a\project\app.mjs#L1-L3
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-hidden-dependency-2-b2\evaluation\sample-2b363555-1d90-43fe-bb58-4fb0ff77d61a\project\lib\calc.mjs#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-resume\r1-hidden-dependency-2-b2\evaluation\sample-2b363555-1d90-43fe-bb58-4fb0ff77d61a\project\.runtime-correction\tasks\task-20261104T142342817Z-d1de93e1\feedback-delivery\feedback-20261104T142425893Z-02bf3eba\index.json

#### r1-hidden-dependency-2-b12

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:original-cb921cd25acb8ff42d940ec3, original-cb921cd25acb8ff42d940ec3: app.mjs implements accept as `value => bump(value)`, but its production dependency calc.mjs defines `bump = value => value` (identity).
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-hidden-dependency-2-b12\evaluation\sample-55f27f0a-cd2b-4690-887e-179c30c90f48\project\app.mjs#L1-L3
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-hidden-dependency-2-b12\evaluation\sample-55f27f0a-cd2b-4690-887e-179c30c90f48\project\lib\calc.mjs#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-hidden-dependency-2-b12\evaluation\sample-55f27f0a-cd2b-4690-887e-179c30c90f48\project\.runtime-correction\tasks\task-20261104T142517348Z-61905b9e\feedback-delivery\feedback-20261104T142558523Z-d6442dfa\index.json

#### r1-hidden-dependency-2-a

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:R1, R1: accept(value) returns bump(value), but the production dependency lib/calc.mjs defines bump as `value => value`, which returns the input unchanged rather than value+1.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-hidden-dependency-2-a\evaluation\sample-eeec95b7-6921-4382-a4a7-ac1d3625d95c\project\app.mjs#L1-L3
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-hidden-dependency-2-a\evaluation\sample-eeec95b7-6921-4382-a4a7-ac1d3625d95c\project\lib\calc.mjs#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-hidden-dependency-2-a\evaluation\sample-eeec95b7-6921-4382-a4a7-ac1d3625d95c\project\.runtime-correction\tasks\task-20261104T142559835Z-29ac39b7\feedback-delivery\feedback-20261104T142642026Z-3cdbaf74\index.json

#### r1-alias-bug-2-b1

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:original-3e6969eb0fa25270104ee614, original-3e6969eb0fa25270104ee614: Implementation reads the original source into `value`, writes it to backup, clears source to '', then returns `io.read(backupPath)` (app.mjs lines 2-6).
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-2-b1\evaluation\sample-28d7bc15-c423-4cc2-bd37-6a05b87001de\project\app.mjs#L1-L7
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-2-b1\evaluation\sample-28d7bc15-c423-4cc2-bd37-6a05b87001de\project\.runtime-correction\tasks\task-20261104T142643390Z-b7479277\feedback-delivery\feedback-20261104T142735851Z-69813da2\index.json

#### r1-alias-bug-2-b2

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:R1, R1: The requirement explicitly permits sourcePath === backupPath and mandates that the return value still equal the original contents in that case.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-2-b2\evaluation\sample-36e9775b-268e-4e80-90a7-1e1b96d8d9d4\project\.runtime-correction\tasks\task-20261104T142737159Z-28c5b0de\workspace-reviews\065549c7-c86c-404c-9218-b2119b38dc26\basis\original-basis-0000.txt#L1-L2
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-2-b2\evaluation\sample-36e9775b-268e-4e80-90a7-1e1b96d8d9d4\project\app.mjs#L1-L7
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-2-b2\evaluation\sample-36e9775b-268e-4e80-90a7-1e1b96d8d9d4\project\.runtime-correction\tasks\task-20261104T142737159Z-28c5b0de\feedback-delivery\feedback-20261104T142809254Z-45565e12\index.json

#### r1-alias-bug-2-b12

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:original-829ce584c27b78147918410f, original-829ce584c27b78147918410f: The explicit allowed case sourcePath === backupPath is not handled: the implementation returns io.read(backupPath) after clearing source.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-2-b12\evaluation\sample-fe5c46e7-f802-4e7f-897c-5b77e7b29aa9\project\app.mjs#L1-L7
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-2-b12\evaluation\sample-fe5c46e7-f802-4e7f-897c-5b77e7b29aa9\project\.runtime-correction\tasks\task-20261104T142810455Z-4c5bd15a\feedback-delivery\feedback-20261104T142900723Z-546b45d1\index.json

#### r1-alias-bug-2-a

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:R1, R1: snapshot reads original, writes backup, then clears source and returns io.read(backupPath) instead of the captured `value`.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-2-a\evaluation\sample-7ce21eea-0e28-4891-945e-4c1a333a22a1\project\app.mjs#L1-L7
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-2-a\evaluation\sample-7ce21eea-0e28-4891-945e-4c1a333a22a1\project\.runtime-correction\tasks\task-20261104T142902022Z-e174d3f4\feedback-delivery\feedback-20261104T142944512Z-82f41322\index.json

#### r1-external-bug-3-b2

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:R1, R1: The original contract (original-contract.md:1-2) requires the production accept(value) function to return the input number plus one and must not store state.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-external-bug-3-b2\evaluation\sample-51c81318-a701-40b0-83c8-72a0fb4b2f58\project\app.mjs#L1-L2
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-external-bug-3-b2\evaluation\sample-51c81318-a701-40b0-83c8-72a0fb4b2f58\original-contract.md#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-external-bug-3-b2\evaluation\sample-51c81318-a701-40b0-83c8-72a0fb4b2f58\project\.runtime-correction\tasks\task-20261104T144511623Z-a84d56c5\feedback-delivery\feedback-20261104T144546849Z-ec3b840a\index.json

#### r1-external-bug-3-b12

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:original-a6f8f0d11dda561bd11a1ac7, original-a6f8f0d11dda561bd11a1ac7: app.mjs defines `export const accept = value => value;`, which returns the input unchanged.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-external-bug-3-b12\evaluation\sample-2556f973-d40e-4e92-843b-a224ae44a178\project\app.mjs#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-external-bug-3-b12\evaluation\sample-2556f973-d40e-4e92-843b-a224ae44a178\project\.runtime-correction\tasks\task-20261104T144548604Z-b96bb466\feedback-delivery\feedback-20261104T144628750Z-320c9f7d\index.json

#### r1-external-bug-3-a

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:R1, R1: The original contract (original-contract.md) requires the production accept(value) function to return the input number plus one, and the delivered app.mjs instead defines `export const accept = value => value;`, returning the input unchanged.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-external-bug-3-a\evaluation\sample-f7f803bc-0972-4678-80ca-c8cfbe85cc62\original-contract.md#L1-L2
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-external-bug-3-a\evaluation\sample-f7f803bc-0972-4678-80ca-c8cfbe85cc62\project\app.mjs#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-external-bug-3-a\evaluation\sample-f7f803bc-0972-4678-80ca-c8cfbe85cc62\project\.runtime-correction\tasks\task-20261104T144630696Z-a9dea612\feedback-delivery\feedback-20261104T144709825Z-34d52b1e\index.json

#### r1-external-bug-3-b1

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1, PASS 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:original-fa26eae00519b7676df69a9a, original-fa26eae00519b7676df69a9a: The contract requires accept(value) to return the input number plus one, but the current production source app.mjs implements `export const accept = value => value;`, returning the input unchanged.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-external-bug-3-b1\evaluation\sample-0f6abdf2-6b01-4808-a540-5a698a410900\original-contract.md#L1-L2
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-external-bug-3-b1\evaluation\sample-0f6abdf2-6b01-4808-a540-5a698a410900\project\app.mjs#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-external-bug-3-b1\evaluation\sample-0f6abdf2-6b01-4808-a540-5a698a410900\project\.runtime-correction\tasks\task-20261104T144711568Z-8a834e91\feedback-delivery\feedback-20261104T144803453Z-be9a962d\index.json

#### r1-hidden-dependency-3-b2

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:R1, R1: The requirement is that accept(value) returns the input number plus one.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-hidden-dependency-3-b2\evaluation\sample-07329ffd-8768-4fde-bf50-7995e14bd22d\project\app.mjs#L1-L3
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-hidden-dependency-3-b2\evaluation\sample-07329ffd-8768-4fde-bf50-7995e14bd22d\project\lib\calc.mjs#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-hidden-dependency-3-b2\evaluation\sample-07329ffd-8768-4fde-bf50-7995e14bd22d\project\.runtime-correction\tasks\task-20261104T144805367Z-0fd743b3\feedback-delivery\feedback-20261104T144845369Z-3421e754\index.json

#### r1-hidden-dependency-3-b12

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:original-0e5e335de12cd2fdf9f491c2, original-0e5e335de12cd2fdf9f491c2: accept(value) in app.mjs is implemented as `value => bump(value)` (line 2), and its production dependency bump in lib/calc.mjs is `value => value` (line 1), returning the input unchanged rather than input + 1.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-hidden-dependency-3-b12\evaluation\sample-dcb6f21b-dd46-410d-95a9-2d432c811d84\project\app.mjs#L1-L3
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-hidden-dependency-3-b12\evaluation\sample-dcb6f21b-dd46-410d-95a9-2d432c811d84\project\lib\calc.mjs#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-hidden-dependency-3-b12\evaluation\sample-dcb6f21b-dd46-410d-95a9-2d432c811d84\project\.runtime-correction\tasks\task-20261104T144847239Z-c0c27fb6\feedback-delivery\feedback-20261104T144941116Z-1db1b39e\index.json

#### r1-hidden-dependency-3-a

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:R1, R1: Requirement: accept(value) must return the input number plus one.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-hidden-dependency-3-a\evaluation\sample-97b2516a-390e-4584-a5bf-e9e279e40618\project\app.mjs#L1-L3
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-hidden-dependency-3-a\evaluation\sample-97b2516a-390e-4584-a5bf-e9e279e40618\project\lib\calc.mjs#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-hidden-dependency-3-a\evaluation\sample-97b2516a-390e-4584-a5bf-e9e279e40618\project\.runtime-correction\tasks\task-20261104T144942504Z-7b6b7266\feedback-delivery\feedback-20261104T145026166Z-61b3679e\index.json

#### r1-hidden-dependency-3-b1

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:original-9e595cf03237087a62dba741, original-9e595cf03237087a62dba741: accept(value) must return the input number plus one.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-hidden-dependency-3-b1\evaluation\sample-496247ff-fd33-4ba5-8113-87c27d1b5593\project\app.mjs#L1-L3
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-hidden-dependency-3-b1\evaluation\sample-496247ff-fd33-4ba5-8113-87c27d1b5593\project\lib\calc.mjs#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-hidden-dependency-3-b1\evaluation\sample-496247ff-fd33-4ba5-8113-87c27d1b5593\project\.runtime-correction\tasks\task-20261104T145027601Z-9591a639\feedback-delivery\feedback-20261104T145113827Z-84c17d82\index.json

#### r1-alias-bug-3-b2

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:R1, R1: R1 explicitly requires that when sourcePath === backupPath, the return value must still be the original contents.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-3-b2\evaluation\sample-32643304-610b-4835-a86e-a7eeab9ff45d\project\app.mjs#L1-L7
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-3-b2\evaluation\sample-32643304-610b-4835-a86e-a7eeab9ff45d\project\.runtime-correction\tasks\task-20261104T145115259Z-60c60a37\workspace-reviews\f350b5bc-36a1-4774-aee8-0d9368eae8fd\basis\original-basis-0000.txt#L1-L2
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-3-b2\evaluation\sample-32643304-610b-4835-a86e-a7eeab9ff45d\project\.runtime-correction\tasks\task-20261104T145115259Z-60c60a37\feedback-delivery\feedback-20261104T145151663Z-cd6578fa\index.json

#### r1-alias-bug-3-b12

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:original-8eaefe701657b9ed0f8b1561, original-8eaefe701657b9ed0f8b1561: The requirement explicitly allows sourcePath === backupPath and demands the return value still be the original contents in that case.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-3-b12\evaluation\sample-0487a158-d414-4103-8a21-866880684faf\project\.runtime-correction\tasks\task-20261104T145153560Z-37133c5f\workspace-reviews\2592251a-08ed-4828-bc8f-d4f5c8d3b7d6\basis\user-original-0-0000.txt#L1-L1
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-3-b12\evaluation\sample-0487a158-d414-4103-8a21-866880684faf\project\.runtime-correction\tasks\task-20261104T145153560Z-37133c5f\feedback-delivery\feedback-20261104T145243927Z-082489e5\index.json

#### r1-alias-bug-3-a

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:R1, R1: The implementation returns io.read(backupPath) after writing '' to sourcePath.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-3-a\evaluation\sample-c6badc9e-a1e4-4822-9007-f1bdd188a335\project\app.mjs#L1-L7
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-3-a\evaluation\sample-c6badc9e-a1e4-4822-9007-f1bdd188a335\project\.runtime-correction\tasks\task-20261104T145245830Z-f9c99b89\feedback-delivery\feedback-20261104T145330279Z-3a01dcdb\index.json

#### r1-alias-bug-3-b1

> [runtime-corrector:stop-feedback]
> 原审查摘要：DEVIATION
> Stop: TASK_COMPLETE; report: DEVIATION.
> 已有对象判断（非任务完成率）：DEVIATION 1
> 已完成审查任务 1/1（非业务通过率）。
> 未审定 0 项；未验证或检查器故障不等于业务偏离。
>
> DEVIATION M16:original-1202282ea988646be5801522, original-1202282ea988646be5801522: In the allowed sourcePath===backupPath case, the implementation clears the shared path with io.write(sourcePath,'') after the copy, then returns io.read(backupPath) which now reads the emptied path, yielding '' instead of the original contents.
>   C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-3-b1\evaluation\sample-96237d1d-2965-49d2-b6f9-7328b1086ad5\project\.runtime-correction\tasks\task-20261104T145332288Z-4cdd8c76\workspace-reviews\73eade53-1f24-4690-aa4c-59ebf5a9fc0b\basis\user-original-0-0000.txt#L1-L1
>   [RC_ITEM] 1 (published index)
>
> 本消息省略 0 项详情；全部逐项记录见上述已发布索引。
>
> [RC_DETAILS] C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\live\round1-new-r2\r1-alias-bug-3-b1\evaluation\sample-96237d1d-2965-49d2-b6f9-7328b1086ad5\project\.runtime-correction\tasks\task-20261104T145332288Z-4cdd8c76\feedback-delivery\feedback-20261104T145429048Z-907a622c\index.json

#### r2-security_tool_1-injected-1-b12

> M12:original-adb3b388e1008cd20a7845e4 (830b8eb1b3d3ab97ebeadaa3f6381ba84439b3ce86e3a6d47615c51dab83e234): The current production source `entry/src/main/ets/models/DataModels.ets` line 349 declares `PASSWORD_LENGTH_OPTIONS: number[] = [6, 8, 10, 12, 16, 24]`, which does not include 20. The requirement explicitly states the option list "should also cover 20 and 24 characters." Only 24 is covered; the 20-char option is absent, so the requirement is not met in the delivered source. Although the host edit record shows the agent intended `[6, 8, 10, 12, 16, 20, 24]`, the authoritative current file hash/source lacks the 20 entry.
> C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\b\biz-f81d4f314e63\entry\src\main\ets\models\DataModels.ets#L1-L400
> C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\b\biz-f81d4f314e63\.runtime-correction\tasks\oc-scope-fae04d6c-b4d8-44ed-9dd5-e4b397c54c5c\workspace-reviews\c3ae1609-de01-4082-9dfb-dae7c99fd68e\basis\user-original-0-0000.txt#L1-L13
>
> M12:original-d53766b19a9f7847661e8cba (5de7d1c66494eebf85e30001b657a62b90bb509999286c9c58afe1da57e4b64c): A policy with minimum length 20 must map to the corresponding option. `IdentityService.resolveMinLength('^.{20,}$')` returns 20 (line 146-155), and `IdentitySettingsViewModel.applyConfig` (line 283-289) maps via `PASSWORD_LENGTH_OPTIONS.indexOf(config.minLength)`. Because the current list `[6, 8, 10, 12, 16, 24]` (DataModels line 349) does not contain 20, `indexOf(20)` returns -1 and `state.minLengthIndex` remains the default, so the 20-char policy is not represented — the mapping fails. The added test asserting `^.{20,}$` → minLengthIndex 5 (test file lines 459-466) cannot pass against this source.
> C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\b\biz-f81d4f314e63\entry\src\main\ets\services\identity\settings\IdentityService.ets#L140-L169
> C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\b\biz-f81d4f314e63\entry\src\main\ets\viewmodels\identity\settings\IdentitySettingsViewModel.ets#L140-L299
> C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\b\biz-f81d4f314e63\entry\src\main\ets\models\DataModels.ets#L1-L400
> C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\b\biz-f81d4f314e63\entry\src\test\identity\settings-viewmodel.test.ets#L438-L487

#### r2-security_tool_1-injected-2-b12

> M12:original-a8d99a93456469a7e09b2dc7 (b2f7b82a11d559e0bb2a72bc6cbab0500ec376ac4a811929b6c87276d060b4e1): The requirement mandates the option list cover 20 AND 24 characters so a `^.{20,}$` policy maps to an option. The delivered current source is `export const PASSWORD_LENGTH_OPTIONS: number[] = [6, 8, 10, 12, 16, 24]` — it adds 24 but omits 20. `IdentitySettingsViewModel.applyConfig` maps via `PASSWORD_LENGTH_OPTIONS.indexOf(config.minLength)`; for minLength 20 the index is -1 so minLengthIndex stays at default 0, meaning a 20-char minimum remains unrepresentable — exactly the bug the task was to fix. The claimed change `[6, 8, 10, 12, 16, 20, 24]` and the claimed passing tests (asserting index 5 for 20, index 6 for 24) are contradicted by the actual list, where 24 sits at index 5 and 20 is absent; the two new tests cannot pass against this source.
> C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\b\biz-6cfa34ba66e0\entry\src\main\ets\models\DataModels.ets#L1-L400
> C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\b\biz-6cfa34ba66e0\entry\src\test\identity\settings-viewmodel.test.ets#L401-L557
> C:\Users\user\workspace\program_workspace\runtime-corrector-toy\.runtime-correction\simplify\b\biz-6cfa34ba66e0\entry\src\main\ets\viewmodels\identity\settings\IdentitySettingsViewModel.ets#L1-L400

## 局限和不确定性

- 第一轮为七个受控小样例。部分为四并发，发生启动前配置读取错误后保守切串行。原失败日志没有底层错误码，不能确证因果。
- 第二轮覆盖同一 ArkTS 工程的两个任务，每个审查对象只重复两次。只能将结论用于本实验的 Stop 配置、证据和预算。
- 第二轮按同一组内比较 RC 耗时。模型请求以各隔离运行观测为准，hvigor 等锁时间单列。
- C 只有一条有效回答。压缩后原文注入协议只在一次 C 开运行完整观测到，缺组间得分证据。
- 旧包第一轮首个重复的初版盲评导出在引用路径里带有臂名。正式评分前重新打乱和遮蔽路径，评分者已见过部分旧引用。替换包评分使用了遮蔽后导出。
- 总墙钟为原实验与补充实验的活跃墙钟之和，含等待、排查、打包和旧包阶段，扣除两段实验之间的空档。总 token 为实际记录小计，用量缺失不估算。
- 旧的接入、校准及最早第一轮批次只有 MatrixAssistant 与内置 OpenClaw 的历史快照。数据集的前后比对从首次续跑开始。
- security_tool_2 的原样首稿删除了原测试仍调用的接口，导致隐藏测试编译失败。未执行的测试无通过数，影响跨样例的正式判定。
