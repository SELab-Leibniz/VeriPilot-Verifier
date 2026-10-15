# 豆包真实模型补验：Session 项目与 Python 开发

生产代码基线 `e54485b`，候选插件 `1.9.1-openclaw.11-session-projects.2`，分支 `codex/session-project-scope`。本轮使用用户授权的 `doubao-seed-2.1-lite` 和 Coding Plan 地址；key 不写入仓库或报告。宿主配置、状态、项目、端口和 Git 仓库全部隔离。

## 已完成结果

| 实验 | 2026.7.1-2 | 2026.10.3 |
| --- | --- | --- |
| 从空业务代码开发 Python Todo | PASS | PASS |
| Todo 的真实最终 Stop / 实现终审 | PASS，k=0 | PASS，k=0 |
| 独立 CLI 验收 | 8/8 | 8/8 |
| 受控 BROKEN → 原生续作 → READY / PASS | 首轮 A 实测 PASS，k=1；该轮整体控制组 FAIL，见下文 | PASS，k=1 |
| 正确项目的零预算与隔离 | 两个正确项目均 PASS，k=0；与故障案例分开验证 | PASS，B 的 k=0 |
| A/B 实际评审重叠 | PASS，正确项目有 6 对重叠区间 | PASS，11 对重叠区间 |
| 完成 Stop 后真实 Gateway 重启恢复 / 查询不调用模型 | PASS，正确项目恢复 | PASS |
| Stop 评审中取消后切换项目 | 前次 GLM 旧版实测已通过 | PASS，通过宿主 reset 生命周期取消，再选择新目录 |

新版受控 Stop 的首轮交付仍为 BROKEN；服务调度中的真实 Reviewer 在业务 `chat.final` 后运行，首轮 checkpoint 为 DEVIATION，宿主原生 `subagent.run` 接受续作且反馈被实际观察。修改后的真实 Worktree 文件输出 READY；末轮 checkpoint 与 receipt 最终 PASS。A 的需求版本为 1、epoch 为 1、k 为 1；B 的任务编号不同，k 为 0。原仓库保持 BROKEN，Agent 默认目录没有 RC 运行目录。重启后的身份、项目、需求状态与预算一致，状态查询不启动模型。

两版 Todo 都从不存在 `todo.py` 开始，源码由业务模型经宿主 write/exec 实际生成，观察器不修改业务源码。旧版目录来自 RC Session 绑定，新版目录来自宿主真实 Worktree；新版原仓库没有 `todo.py`。冻结需求、AGENTS 与 RC 配置的哈希保持一致。

独立验收另建项目内数据目录，数据文件最初不存在；父目录自动创建不在冻结合同中，不作为额外要求。依次启动八个 CLI 场景：帮助、空列表、Unicode 添加、第二次添加、跨进程列表、done、done 后持久化列表、未知 ID。所有输出均实际解析，ID 是递增正整数，done 只改变目标记录，未知 ID 非零退出并产生 stderr，存储文件字节不变。该过程没有复用模型自报的成功结果。

## 首轮失败与修正

初轮新版已经真实启动交付后 Reviewer、派发原生续作、将 A 修复为 READY，并保持旧 checkpoint 为 DEVIATION，证明已修复的宿主生命周期和旧结果竞态进入实际路径。但终审读取到空源码清单，且 B 业务模型将输出写到 `/tmp`，整轮没有计为通过。快照保留在 `/private/tmp/rc-doubao-stop-native-20261015`；观察器中止原因单独记录，没有伪造最终 PASS。

测试平台声明本身有效：独立加载同一声明能收集到 `mini_app.py`。初轮在 Gateway 启动后才向插件目录添加声明，新版加载的插件未能使用它。测试辅助函数现改为启动前准备这些资源；新版重跑的真实实现终审请求包含 `mini_app.py` 及其 SHA-256，完整终审通过。没有修改生产源码清单算法、Reviewer 提示或判定逻辑。

初轮使用沿用 GLM 的 `reasoning: false` 模型描述，不能正确声明豆包可用的推理努力控制。本轮最终描述使用 `reasoning: true`、`supportsReasoningEffort: true`、`thinkingFormat: openai`、`maxTokensField: max_tokens`，上限为 32000；保持既有 Reviewer low、角色 240 秒、Stop 720 秒和 k=2。兼容参数只用于隔离模型配置。地址及协议依据 [官方 OpenClaw 接入说明](https://docs.volcengine.com/docs/ark/coding-plan-personal-ai-openclaw?lang=en)，推理参数兼容依据 [官方产品更新说明](https://docs.volcengine.com/docs/ark/product-update-announcements?lang=zh)；实际调用均由 OpenClaw 发起，没有改用其他推理计费地址。

旧版首轮 A/B 都最终 PASS、均 k=1，但 B 额外执行 `; echo`、重定向和项目外临时文件操作，违反只读验证要求。RC 的偏离来源确实是 B 的 transcript，不是 A 的预算或反馈串入。严格 B=0 断言因此 FAIL，原记录保留在 `/private/tmp/rc-doubao-stop-legacy-20261015`。重跑改用一次只读 Python subprocess 脚本在内存中获取原样默认入口和 --help 的退出码、stdout、stderr并断言相同验收条件，避免模型为了补足展示信息追加 shell 探测；不降低业务要求或跳过终审。

旧版受控故障重跑时，A 业务模型在收到 RC 反馈前就修好 BROKEN，导致“首轮保持故障”的实验条件失效，按无效试验记录在 `/private/tmp/rc-doubao-stop-legacy-20261015-r2`。没有将提前修复计为 RC 的纠偏成功。

随后把两个验证目标拆开：第一次有效故障案例保留 A 的真实 DEVIATION、反馈观察、一次修复和最终 PASS；另用两个已经正确的项目专门验证独立任务、零预算、实际评审重叠和真实重启，结果 PASS，目录 `/private/tmp/rc-doubao-peers-legacy-20261015`。该补验不要求业务模型故意保留缺陷，不将多轮数据伪装成一轮全部通过的故障实验。

## 原生 Stop 的取消与切换边界

首轮在 Stop Reviewer 实际运行中调用 `sessions.create` 更改目录，被宿主以仍有工作拒绝；随后 `chat.abort` 返回 `{aborted:false, runIds:[]}`。主业务已交付，该接口没有业务运行可取消，不能据此声称 RC Reviewer 被取消。脚本等待 Reviewer 自然完成后才在 idle 修改目录，旧 checkpoint 因此正确保留 DEVIATION，而“必须 CANCELLED”的实验断言 FAIL。目录变更生效时间确实晚于旧评审提交时间，原记录保留在 `/private/tmp/rc-doubao-switch-native-stop-20261015`。

补验在 `chat.abort` 返回 false 时使用宿主公开 `sessions.reset`，而不是私有调用或改写目录。`before_reset` 触发 RC 自有信号取消，旧 Reviewer/Stop 结算为 CANCELLED、旧 k=0；随后宿主允许同一 key 选择 new 目录。宿主保留物理 sessionId、变更 lifecycleRevision；项目作用域仍建立新 taskId 和基线，new k=0。old 文件保持 BAD，new 文件实际写为 NEW_B_ONLY，旧项目无续作记录，最终宿主历史没有旧 Stop feedback。补验 PASS，目录 `/private/tmp/rc-doubao-switch-native-stop-20261015-r2`。

这是隔离测试会话中的公开 reset 路径，不把 `chat.abort` 等同于取消插件后台评审，也不声称宿主允许绕过 busy 检查强行改目录。宿主决定何时可以变更，RC 按原生生命周期和可信目录更新作用域。

## 代码范围与证据

本轮只调整诊断脚本：测试平台资源在宿主加载前准备、旧版控制组只读断言、独立 CLI 数据目录准备、无效清单/预算耗尽时停止观察、失败时保留状态快照，以及新增 native Stop 阶段切换实验入口。生产 OpenClaw 适配与纠偏核心仍为 `e54485b`；没有修改宿主源码、需求提取、Reviewer 算法或预算。

全量回归再次通过：808 项、806 PASS、2 项既有 Windows 跳过；构建和诊断脚本语法检查通过。脱敏汇总、源码哈希和原始文件位置见 [JSON 证据](session-projects-doubao-20261015.json)。此前 GLM 额度阻塞及确定性测试仍保留在 [修复报告](session-projects-fix-20261015.md)，不能用后来的成功覆盖早先的失败历史。
