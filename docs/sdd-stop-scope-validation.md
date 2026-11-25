# 整份 SDD 与强制附录的 Stop 验收

2026-11-25。主文规定普通模式重试 3 次，并要求遵循一个附录。附录规定密封模式重试 0 次，候选函数对两种模式都返回 3。旧版只看主文便可报告无偏差。新版把附录登记为验收来源，能够指出密封模式的偏差。若还有一份强制附录取不到，整体验收为 `UNVERIFIED`，已经证实的偏差和缺失的附录分别列出。

## 修改前后

同一组使用相同的初始消息、规范和候选代码，脚本实际调用候选函数核定返回值。两版均从 `SessionStart` 和 `Stop` 进入，使用各自版本的读页、建清单、证据验证、归档和报告代码。Reviewer 的取证选择由脚本固定。基线为 `8a2bfa3`，实现为 `5d4b9d4`。[公开入口对照脚本](../scripts/validate-sdd-stop-scope.mjs)

逐组的输入哈希、公开结论、未核实原因、宿主回执和容量对照已随本分支留存。[机器可读对照结果](sdd-stop-scope-results.json)

| 同一取证操作 | 修改前 | 修改后 |
|---|---|---|
| 按登记的来源审查，用户只点名主文 | 无偏差，漏掉密封模式 | 确认 1 项偏差，密封模式应为 0，实为 3 |
| 全文读完附录，建清单时省略附录条款 | 无偏差 | 整体未核实，指出 `annex.md` 已读完、未进入清单 |
| Reviewer 主动用主文指向的附录建项 | 程序拒绝这条原件引用 | 引用有效，确认同一偏差 |
| 用户也在初始消息里点名附录 | 确认 1 项偏差 | 确认同一项，普通示例文件在验收范围之外 |
| 主文另明确要求缺失的 `unavailable.md` | 无偏差 | 整体未核实。已证实 1 项偏差，另列 1 份缺失附录 |
| 确认附录偏差后中断，尚未判定普通模式 | 留存 1 项偏差，整体未核实 | 留存同一偏差，另列 `workflow.md` 第 1 行的普通模式条款 |

混合结果下，业务纠偏只携带已证实的问题。用户通知和 `/rc-report` 都显示偏差和未核实范围，持久化 evaluation 保存两份完整列表。短通知列举前几项。[Stop 结果发布](../lib/runtime-v2/production-stop.mjs) · [宿主报告](../lib/openclaw/report.mjs)

## 同一份 164K 原件的两种入口

中文原件共 **164,012 tokens、734,837 字节、4,557 行**。两种入口与修改前后的原件 SHA-256 均为 `cf01ab06a64b204b09ba2d9f4dedbf3e5bb5c89475c2d23a235b8f0a05c69043`。试验使用 MatrixAssistant 附带的 OpenClaw `2026.7.1-2`、本地 tokenizer 和脚本化提供方。宿主实际执行预检、原生 compact 和工具调用。单文件用例另从公开 Stop 入口重放同样的 33 个回执，核对面向用户的结果。

| 入口与条件 | 修改前 | 修改后 |
|---|---|---|
| 公开 Stop 入口，同一 `AGENTS.md`、相同的 33 页回执，每页 125 行 | 在第 4,125 行后注入已观测的中断，Stop 报 Reviewer 失败 | 指出未读第 **4,126–4,557 行**，共 432 行。前 4,125 行已交付，条款清单尚未提交，已证实偏差 0 项 |
| 原生宿主实际读取同一必读文件，两版使用同一绝对输出路径 | 33 个读页回执，覆盖 4,125 行。32 个完整结果进入后续普通请求 | 32 个回执，覆盖 4,000 行。31 个完整结果进入后续普通请求。报告准确列出未读的 **4,001–4,557 行**，共 557 行 |
| 一次性内联到初始消息，宿主放行业务首轮后审查原消息 | Reviewer 读完 45 个原文分块中的 42 个，中断 | 仍读完 42 个。按逻辑原文定位已读 4,266 行，未读 **4,267–4,557 行**，未提交清单 |
| 同一内联消息，使用默认业务首轮预检 | 首轮被宿主拦下，发给提供方的请求为 0 | 仍为 0。这个位置在 Stop 审查之前 |
| 两种入口各自放宽宿主窗口估算，提供方仍用同一容量 | 两组都读完全文，找到末尾例外 | 两组都读完全文，保存同一项偏差 |

同路径的原生对照中，两版各发生一次宿主 compact。首次普通请求从 14,464 增至 14,708 个本地计量 tokens，新版早停了一页。固定回执重放用来检验同样进度下的报告，原生对照保留各版真实停点。这一步改善了验收范围的可见性，本轮没有测得窗口容量改善。

原件行覆盖只计入当前任务中版本匹配的读页回执。一个逻辑行横跨两块时，两块对应内容均需交付，这一行才算已读。宿主可能在下一次发包前停住，因此机器记录另外保留普通请求里实际出现的完整回执数。即便完成全部读页，未建清单或尚未判定的范围仍能单列。[原件覆盖计算](../lib/runtime-v2/stop-source-coverage.mjs) · [原生宿主对照脚本](../scripts/validate-large-context.mjs)

把初始要求缩短为“请验收本次发布。”并保留同一份 `AGENTS.md`，Stop 仍会依据项目指令登记这份 SDD，固定 33 页回执的未读范围相同。另用一份超过 4 MiB 的项目指令验证了原件哈希和末行声明的强制附录也能进入范围。[来源范围回归用例](../test/stop-sdd-source-scope.test.mjs)

## 验收边界

- **范围与体积独立。** 小文件可先读，大文件可按页取证。嵌套附录相对声明它的文件解析，循环引用只登记一次。显式参考资料、示例和待生成的交付物保持各自角色。
- **结论绑定原件版本。** RC 在本地顺序读取验收原件，计算 SHA-256 并查找附录声明。Reviewer 获得来源索引，可按页取证。有任务起始快照时使用快照。首次登记以前、且没有快照或变更记录的编辑无法回溯。
- **找不到的来源可见。** 缺文件、没有任务起始原件、版本变化、无法解码、不可访问，以及已识别但无法定位的附录，各有待核实原因和声明位置。只有读完整份来源，Reviewer 才可说明其中没有独立适用条款。
- **已读、已提取、已判定分别记录。** 一份原件已有条款入单时，Reviewer 仍可指出待提取行段。在 257 条独立义务的用例里，宿主允许单次提交 256 条，第 257 条有有效原件引用，追加被拒绝后，报告单列第 257 行，整体验收未完成。[容量与一字节边界用例](../scripts/validate-large-sdd-authority.mjs)
- **语义覆盖仍由 Reviewer 判断。** 一份来源读完且已有条款入单，不能据此证明每个自然语言例外都已提取。这里验证了显式来源登记、可观察的清单缺口和已存证据的发布。未做真实模型的盲测，无法从这些数据推算真实漏审率。宿主继续负责上下文与 compact，接续会话和分片建清单属于后续步骤。

## 复验

8 组公开 Stop 入口的修改前后对照、两组原生套件和 195 项定向回归均通过。完整原始记录位于本 worktree 的 `.runtime-correction/paired-hooks-before`、`paired-hooks-after`、`paired-single-before`、`paired-single`、`inline-before` 与 `scope-inline` 目录。

全库运行完成 329 个测试文件，共 3,410 项通过、49 项跳过、3 项失败。将宿主输入排队与模拟提供方校准的两个测试文件分别重跑，30/30 和 8/8 通过。剩余的零纠偏额度用例在旧版和新版单独运行都得到 `UNVERIFIED`，该既有断言期望 `SKIPPED`。[零额度断言](../test/stop-review-groups.test.mjs)

切到本分支，准备基线 `8a2bfa3` 的独立 checkout。两次执行使用同一份观察脚本，输出目录须尚未存在。原生试验所用宿主目录、Python 和 tokenizer 参数见已有环境说明。[宿主与 tokenizer 准备](large-context-validation.md)

```powershell
node scripts/validate-sdd-stop-scope.mjs ../lc-single-required-20261125 .runtime-correction/recheck-before before
node scripts/validate-sdd-stop-scope.mjs . .runtime-correction/recheck-after after
node --test test/stop-sdd-source-scope.test.mjs
node scripts/validate-large-sdd-authority.mjs $hostRoot
node scripts/validate-large-context.mjs --host-root $hostRoot --python $python --tokenizers $tokenizers --cases single-required-file --output-root .runtime-correction/recheck-file
node scripts/validate-large-context.mjs --host-root $hostRoot --python $python --tokenizers $tokenizers --cases initial-sdd-164k --output-root .runtime-correction/recheck-inline
```
