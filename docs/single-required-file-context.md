# 只读一个必读材料，就可能超过 Reviewer 上下文

2026-11-25。在 MatrixAssistant 所附 OpenClaw 2026.7.1-2 和 RC Stop 上，上一轮 164,012 tokens 的中文 SDD 改为一个完整的必读文件，每页读 125 行。默认宿主在清单建立之前停住，4,557 行中只留下前 4,125 行的有效回执。此时还没有开始读候选源码或执行记录。

## 如何隔离这一个文件

业务快照只给一个文件名和一句完成声明。每组创建新的原生私有 Reviewer，会话开头的实际请求中没有材料的首、尾标记。脚本先读 RC 自动生成的短用户指令与依据索引，随后只读指定文件。原材料的 SHA-256、生产清单中是否必读、实际工具返回、RC 持久化回执和每次模型请求均单独核对。

- **中文 SDD** 使用上轮粘贴用例的同一原文，734,837 字节、4,557 行，两种模型的公开 tokenizer 均为 164,012 tokens。本组把原文放进合成仓的项目规则文件，以生产规则自然进入必读集合。RC 将它登记为单个物理文件。普通点名文件超过 256 KiB 时有另一套按需参考规则。[原文识别](../lib/runtime-v2/production-stop.mjs) · [上轮首条消息用例](initial-sdd-164k.md)
- **密集路径表** 是直接点名的普通 SDD 附录，246,276 字节，低于 262,144 字节的必读上限。里面的 1,821 行按 Reviewer tokenizer 计 239,008 tokens，正文就超过模拟提供方 204,800 tokens 的整窗。额外的 61,048 字节样本把同一串路径分别排成多行、挤入一行，用于定位读页本身的边界。

## 同一份中文 SDD 在哪里停住

默认组的首个完整请求为 14,471 tokens，随后每次只取文件的 125 行。宿主成功 compact 一次，后续预检估到 189,096，超过其 180,000 的输入预算，两次继续压缩都记录没有可处理的会话消息。宿主最终给出 `context_overflow`，RC 返回 `REVIEWER_RUN_FAILED`，仍有一个必读文件未完成。33 页、4,125 行已取得原文回执。在已经派发的普通请求中仅能逐字匹配其中 32 页。最后 125 行的工具结果已落盘，宿主拦住了下一次请求。第 4,126 行起的 432 行尚未取得回执。该组没有触发提供方拒绝。

对照组仅把宿主看到的窗口提高到 400,000，实际模拟提供方仍为 204,800，页大小、原件及每次请求的最大输出 8,192 均相同。原文读到第 4,250 行时，199,491 tokens 输入加预留输出超限。宿主在这一处 compact 后读到了第 4,557 行，在决策请求中同时回读末尾原文和候选实现，保存“应重试 0 次、实际为 3 次”的 `DEVIATION`。这项对照用于区分宿主提前拦截和提供方的容量边界。[默认组记录](../.runtime-correction/one-validated/one-zh-paged/evidence.json) · [同原文放行对照](../.runtime-correction/one-validated/one-zh-wide-host/evidence.json)

## 单次读、分页读与压缩

1. **一页也可能取不到完整回执。** 对密集路径表从第 1 行请求最大 400 行，RC 的 51,200 字节页上限只选中前 366 行。宿主又按 48,000 字符上限裁剪返回。这个调用获得 0 条有效回执，随即提交原文清单被拒绝。
2. **每页均可读，累计历史仍会超限。** 对同一份路径表改成每页 112 行。模拟提供方预留 8,192 tokens 输出时，材料读到第 1,344 行的请求含 202,003 tokens 输入，合计 210,195，超过 204,800。另一个对照只检查输入。在已经发到第 1,344 行时，请求输入 202,005，提供方接收。再读这同一文件的 112 行，输入达到 **217,628**，提供方在第 1,456 行拒绝。两组都由宿主完成一次压缩，读完全部 1,821 行，并对末尾条款与当前源码保存偏差。核对每一包已接受的普通请求，均没有同时包含全文件各行的完整工具结果。
3. **单行读不下属于另一种故障。** 61,048 字节样本按多行保存时共 455 行，可以读完。只把路径之间的换行换成空格后，文件字节数和正文的 59,244 tokens 都相同，但第 3 行长达 60,909 字节。针对这行分别请求 400 行和 1 行，原生工具两次都返回 “First line exceeds the evidence page byte limit”。前两行和末行均可取回，未覆盖的第 3 行仍会阻止建清单。两组故意在清单拒绝后结束的负控只验证门槛。[RC 读页](../lib/review-task/source-tools.mjs)

Stop 的完整读取门槛按文件检查已获回执的行区间。宿主在持久化之前裁短了本页，RC 就不给这次读页记覆盖。旧页已经获得回执后，宿主可以把它移出活动上下文。回执证明原文范围曾交付，业务条款是否提取完整仍需单独验证。[覆盖门槛](../lib/review-task/protocol-task.mjs) · [原文回执](../lib/review-task/task-evidence.mjs)

## 对场景路由的影响

路由需要看单个权威材料的页是否能交付、末端是否已覆盖，以及当前还剩多少可用输入空间。当宿主在建清单之前耗尽恢复机会，RC 可以保存原文版本、已获回执的行段和第一处缺口，把仍未核实的范围带到结果。要让后续 Reviewer 接手，还要验证同一版本下的覆盖与条款提取进度。仅续接已有清单项，无法解决这里的中断。

单行超过证据页上限时，可在 RC 原件读取接口探索带原始 UTF-8 字节偏移和哈希的分段读页。如果一条业务判断同时依赖首尾两处条件，可在判断时共同回读这两处。如果这项判断必需的原件合在一起仍超过可用窗口，则保留该项为 `UNVERIFIED`。模型窗口与 compact 继续由宿主管理。

## 复现

本地运行使用真实 OpenClaw 工具、预检、压缩调度和 RC Stop 工厂。模型的工具选择、摘要和判断由脚本驱动，目标条款位置预先已知。统计来自实际发出的消息按固定公开模型模板分词。线上服务计费、真实模型的自主召回率和完整 MA 图形会话另需独立验证。[实验入口](../scripts/validate-large-context.mjs) · [用例与断言](../scripts/helpers/single-required-file.mjs)

在本 worktree 中运行以下 PowerShell。依赖准备方法以及两个 tokenizer 的固定版本见[环境说明](large-context-validation.md)。

~~~powershell
npm ci --prefix lib/review-task --ignore-scripts --no-audit --no-fund
$assets = '../large-context-validation-20261125/.runtime-correction'
$hostRoot = 'C:/Users/user/workspace/program_workspace/MatrixAssistant/resources/openclaw'
$null = New-Item -ItemType Directory -Force '.runtime-correction'
node scripts/validate-large-context.mjs --host-root $hostRoot --python (Join-Path $assets 'large-context-venv/Scripts/python.exe') --tokenizers (Join-Path $assets 'large-context-tokenizers') --cases single-required-file --output-root '.runtime-correction/one-repeat'
~~~

7 个单文件用例共记录 158 次本地请求，各组预期结果均已核实，包括两组故意停止的负控。同一轮重跑了既有小型 Stop 和工具裁剪后重读的两个场景，另有 30 项相关回归测试通过。[单文件测量及证据索引](../.runtime-correction/one-validated/single-required-study.json) · [整轮验证结果](../.runtime-correction/one-validated/result.json) · [回归日志](../.runtime-correction/one-file-regressions.log)
