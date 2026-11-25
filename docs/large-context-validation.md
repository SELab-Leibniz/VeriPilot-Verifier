# 大型 SDD Stop Reviewer 上下文验证

## 本次结果

运行记录为 `.runtime-correction/sdd-context-verified/result.json`。宿主预算为 200,000 tokens，预检给输入留 180,000 tokens，模拟提供方上限为 204,800 tokens。

### Reviewer 取证量和历史重发

- 生成的 Git 仓有 1,565 个被跟踪文件，约 19.2 MB。小用例使用同一仓和同样数量的历史执行记录，选定范围只有 SOURCE。它保存 4 个读取回执，省略执行导航，请求峰值约 19.7k tokens。1,536 个无关模块的标记从未出现在请求中。
- 混合用例读取 64,701 字节的原始 SDD 约束文件，以及工作区源码和两组执行记录。5 个必读材料页、8 个执行记录页、5 个源码页都获得有效回执。触发压缩前已发送的请求峰值为 97.6k tokens。压缩后最后一个普通请求仅带 3 条工具结果，RC 仍持有 18 个读取回执，并完成 Stop 验收协议。
- 同一份需求、执行记录和 16 个需检查的源码文件，在 200k 组中只读完 10 个源码文件。第一次压缩成功，第二次预检达到约 246k，日志报告无可缩减的工具结果及无有效会话可压。活动上下文由摘要和工具调用、工具结果组成时，宿主跳过了进一步压缩。审查留下 23 个回执及部分结果，最终未完成。
- 同负载的 600k 模拟窗口组在第 14 个普通请求完成。从约 15.1k 增长到 290.7k tokens，最后一次请求包含全部 31 条已出现在普通请求中的工具结果，各条结果在后续请求中的 SHA-256 保持一致，29 个读取结果的文本哈希也与 RC 回执相符。这个容量配置用于控制变量。

### Token 预检偏差

- 中文主会话样本估算 **95,324**，公开模板分词 **54,079**，高估 76.3%。普通 TypeScript 加 Windows 路径的 Reviewer 样本为 **157,886 / 82,217**，高估 92.0%。将短数字目录层级和紧凑 JSON 混入工具结果的密集样本为 **139,446 / 179,948**，低估 22.5%。
- 原生 Reviewer 的密集路径用例中，发出的一次请求按相同预检函数对照为约 **173k**，分词为约 **211k**。原生中途预检通过，本地提供方按 204.8k 上限拒绝请求。宿主收到超限应答后压缩历史，随后完成审查。实际服务的用量仍依赖该服务的模板和计量口径。
- 新会话输入同类中文长文时，宿主预检给出 **223,414**，原文分词为 **126,147**。预检触发后，宿主连续尝试从旧历史恢复。会话刚开始，三次都跳过压缩，普通请求次数为 **0**。

### 裁剪与 LLM 压缩

- **单条裁剪。** 49,262 字节的必读文件在一次完整读时触发宿主 48,000 字符上限。裁掉的页出现在请求中，RC 日志无该次读取回执，清单创建返回必读范围未覆盖。原文件按 1–100、101–182 行重读后获得回执，清单通过并完成审查。
- **合计裁剪。** 直接调用原生工具历史裁剪入口时，12 条各自低于单条上限的结果共 505,956 字符。函数裁了 3 条，将发往请求的文本降至 399,827 字符，原消息数组保留原文。8 条结果的对照触发 0 次裁剪。当前的 custom DeepSeek 路由未进入 cache-ttl 剪枝，单条和合计上限仍生效。
- **可恢复的摘要。** 中文旧历史的原文分词约 131.7k。原生预检估算约 233.6k 后启动压缩。两次摘要请求约 40.1k、40.2k，普通请求随后用约 55.2k 完成。宿主摘要序列化对单条工具结果保留约 2,000 个正文字符，并可把历史拆成多次请求。
- **摘要请求仍超限。** 把一条长的密集机器输出放入旧用户消息时，普通请求约 294k，某些摘要请求仍含完整的大消息，分词约 273k。模拟提供方照同一窗口拒绝。当前宿主生成了压缩边界并重试，随后仍然超限并给出 `blocked`。这条失败与 Reviewer 压缩后缺少有效会话消息的失败分别存在。


## 运行方法

验证固定为 RC 基线 `8a8da1d` 和本机 MatrixAssistant 附带的 OpenClaw `2026.7.1-2`。脚本在 worktree 内生成 Git 测试仓、私有宿主配置和 transcript，通过生产 Stop Reviewer 入口执行。宿主发出的请求由本地脚本回应。脚本保存原始请求、原生预检日志、原生压缩记录和 RC 读取回执。

准备 Node、Git、Python 和本机 MA 安装目录，并在当前 worktree 运行以下 PowerShell 命令。下载内容为 DeepSeek 发布的 tokenizer 和模板，脚本逐个校验 SHA-256。

```powershell
uv venv .runtime-correction/large-context-venv
$python = '.runtime-correction/large-context-venv/Scripts/python.exe'
uv pip install --python $python tokenizers==0.22.2 jinja2==3.1.6

$assetRoot = '.runtime-correction/large-context-tokenizers'
$models = @(
  @{ name = 'DeepSeek-V4-Flash'; revision = '60d8d70770c6776ff598c94bb586a859a38244f1'; template = 'encoding/encoding_dsv4.py' },
  @{ name = 'DeepSeek-V4.1-Flash'; revision = '314113f8a7dadb388215396ba5fbee2c610a04d6'; template = 'chat_template.jinja' }
)
foreach ($model in $models) {
  $modelName = $model.name
  $revision = $model.revision
  $target = New-Item -ItemType Directory -Force -Path (Join-Path $assetRoot $modelName)
  foreach ($asset in @('tokenizer.json', $model.template)) {
    Invoke-WebRequest -UseBasicParsing -Uri "https://huggingface.co/deepseek-ai/$modelName/resolve/$revision/$asset" -OutFile (Join-Path $target (Split-Path $asset -Leaf))
  }
}

node scripts/validate-large-context.mjs --host-root 'C:/Users/user/workspace/program_workspace/MatrixAssistant/resources/openclaw' --python $python --tokenizers $assetRoot
```

可用 `--cases calibration,review-page-cap` 只跑指定用例。每次运行使用新目录，可显式传 `--output-root`。成功运行的 `result.json` 中 `validationFailures` 为 `[]`，脚本同时保留各用例的 `evidence.json`、`wire-*.json` 和共用的 `host.log`。Reviewer 的 `observations.jsonl` 位于结果所列的 `reviewDirectory`。

## 证据口径

- 原生实验以 MA 默认上限为例。预检使用 200,000 token 的宿主预算和 20,000 token 预留。单条工具结果上限为 48,000 字符。专门加宽窗口的对照把配套宿主和模拟提供方上限一起设为 600,000 token。
- 分词值使用对应模型公开模板和 tokenizer。实际发出的本地请求按完整消息和工具 schema 分词。中文历史的压缩前对照用播种的消息文本分词，宿主的预检日志还计入自己的系统提示等开销。合成响应、拒绝门槛和输入用量字段由本地请求代理控制。线上提供方仍可能追加自己的模板或使用不同的计量口径。
- 分词输入采用解码后的消息。外层请求 JSON 用于传输的转义在解码时还原，工具文本内部已有的 JSON 和路径字符会随内容进入模板。
- `wireEstimate` 将提供方格式的消息映射回宿主预检函数以便逐请求对比。宿主真实预检和恢复分支以 `pressureLog` 及完整 `host.log` 为准。
- Reviewer 的阶段动作由脚本驱动。完成状态指 RC 验收协议完成。真实模型的取证决策、语义判断、线上用量及故障频率仍待现场样本测量。

10 个原生场景和分词、裁剪对照均通过验证断言。现有的 159 项定向回归通过。本次共捕获 121 个本地模拟请求，外部模型请求为 0。

## 相关实现

- `lib/runtime-v2/stop-workspace-review.mjs` 把必读原始用户和被点名的材料绑定到 `basisFiles`。工作区和执行记录按选定验收项披露。
- `lib/review-task/protocol-task.mjs` 的 `requireBasis` 校验必读范围完整覆盖。`lib/review-task/task-evidence.mjs` 的 `observeReceipt` 要求最终工具消息与已发出的完整页逐文本匹配。OpenClaw 从 `lib/openclaw/task-tools.mjs` 的 `tool_result_persist` 把结果交给此校验。
- OpenClaw `dist/attempt.tool-run-context-CuQsIXnb.js` 执行分角色预检。普通文本约按 4 个 ASCII 字符或 1 个汉字估 1 token，工具结果每 2 个字符至少估 1 token，外加安全余量。`dist/tool-result-truncation-rzMcqvvu.js` 决定单条、合计裁剪及恢复。`dist/proxy-BzhBz8iM.js` 在摘要序列化时另行缩短单条工具结果。
- [DeepSeek-V4-Flash 模板与 tokenizer](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/tree/60d8d70770c6776ff598c94bb586a859a38244f1)
- [DeepSeek-V4.1-Flash 模板与 tokenizer](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/tree/314113f8a7dadb388215396ba5fbee2c610a04d6)
