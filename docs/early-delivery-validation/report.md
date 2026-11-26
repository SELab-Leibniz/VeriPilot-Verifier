# Stop 提前交付与续审验证

基于 A 的 `cfe21222816ab931dca7edd01faa17ca288849a1`，产品提交为 `b95744a64303dcc85ad0daf82180b2db24bc2ddb`。此次回放使用脚本化 Reviewer，调用生产 SessionStart 和 Stop、原件读取工具、校验、落盘和纠偏准入。对照记录包含 Stop 的公开状态、反馈正文、覆盖情况和逐项分类。[原版 A](before.json) · [修改版](after.json)

| 用例 | 原版 A | 修改版 |
|---|---|---|
| 164K 必审文档，中途打断 | 第 1–10 行及实现已经读到。尝试常规封存得到 TASK_BASIS_UNREAD。公开偏差 0，allow | 第 2 行规定密封模式重试上限为 0，实现为 3。偏差工具成功保存后，宿主可立即结束本次 Reviewer。随后注入 CONTEXT_OVERFLOW，Stop 仍返回 UNVERIFIED、block 和仅针对已证实偏差的修复指令，附实现位置。签署证明列入缺证，第 11–4557 行列入未审 |
| 同一文件，修复后续审 | 从第 11 行向后读取，前缀不能恢复为本次提取进度，公开 UNVERIFIED | 原文哈希相同，新 Stop 取回 2 条义务和前 10 行的提取进度。只读其余原文，核对已修复的实现和已补齐的签署文件。3 条义务纳入清单，公开 NO_DEVIATION_FOUND，范围完整 |
| 跨阶段漏审，重放原提交 | NO_DEVIATION_FOUND，原评分只匹配 2/290 | UNVERIFIED，scanCompleted 为 false。未核对范围包含整组映射、跨阶段修订对应关系及当期执行 |
| 跨阶段正确组，补齐检查 | — | 同一冻结输入上，逐一比较 288 条实际生效映射，核对三个阶段与当前修订号及本期调用和返回，用共享证据提交检查。NO_DEVIATION_FOUND，scanCompleted 为 true |
| 旧版本执行回执 | DEVIATION，两个偏差使用了旧运行输出 | 两条旧引用均被拒绝，确认偏差 0。当前修订缺执行证据，公开 UNVERIFIED |

## 复现与证据

- 压力文档有 4,557 行、734,870 字节。使用实验冻结的 DeepSeek V4.1 Flash tokenizer，直接编码正文得到 **164,010 tokens**。文档 SHA-256 为 `3e7de15a24a0c9996c3ada444595ff63bf5ce8ef2e3cac70f03ebff2a8f5aa0f`。中段明确标为历史背景，验收条件分布于前段和末尾；此用例隔离了材料长度与义务密度。
- 两次续审输入使用相同的业务修复、签署文件和新消息。修复由用例施加；首轮断言检查真实 Stop 准入、反馈及结构化报告。复验跨阶段和旧运行使用原始开发样本 `t-bfa76c3174a7d07042`、`t-3d89a0524144a149d5`，从冻结对象重新物化候选文件和执行记录，重放 A 归档清单、逐项判定和引用坐标。产品未读取评分器或期望答案。
- 原版 A 和修改版的观察文件 SHA-256 分别为 `3808f1a1d3137cb05e8b8ee5154c8166b7904b2b6fb8926abc6a5bf6ddd7028d`、`1625d36077f7e23ee416d9acdf9fcfc2165739060097dd2b593ae967194adbe6`。完整运行目录位于同级 worktree 根目录下的 `early-delivery-validation-20261126/{before,after}`。
- 在此分支运行 `node scripts/validate-early-delivery.mjs <产品工作树> <原实验目录> <新输出目录> <before或after>`。回归覆盖 10 个测试文件。修改前后均为 96 通过、3 跳过、2 失败（同一条旧断言及其父测试）。该断言期望一项未核实时返回 NO_DEVIATION_FOUND，原版 A 已返回 UNVERIFIED。原始两份日志分别为 `early-delivery-validation-20261126/regression-before.log`、`regression-after.log`。

## 能力边界

- RC 保存原件版本、已提取范围、义务和判定。续审重新核对当前候选；宿主管理 Reviewer 的上下文和 compact。此回放覆盖正常取得并保存偏差回执后发生的 Reviewer 中断。宿主强制结束整个 Stop 进程、取消任务或使发布截止时间失效属于另一条终止路径。
- 修订校验覆盖带结构化修订号、提交号或构建标识的业务输出与所引当前交付文件，也允许程序发起的当期验证。分组检查让 Reviewer 可提交一次有证据的比较；自然语言义务的完整提取、所选证据是否能解释实际业务行为仍需要 Reviewer 作判断。
- 本轮未调用真实模型。该实验验证工具与公开反馈行为，不能据此推算模型主动选择提前交付的频率、成本或 30 例开发集的整体审完率。原实验冻结记录和第 1 轮选优仍有效。
