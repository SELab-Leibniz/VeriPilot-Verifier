# OpenClaw .6：GLM 最终 reviewer 隔离修复记录

日期：2026-09-15。分支：`codex/openclaw-2026.7.1-2`。目标：OpenClaw `2026.7.1-2`。版本：`1.9.1-openclaw.6`。

## 结论与范围

GLM-5.3 在火山 Coding Plan Anthropic 兼容接口上的“仅思考、无最终评审 JSON”已在不依赖 OpenClaw 的脚本中复现。加入模型专用的 effort 系统提示后，独立三场景验收通过，随后隔离 OpenClaw 原生 reviewer 的两轮六次测试也通过。

这次完成的是 **reviewer 链路修复和隔离验收**。没有重放原会话，没有替换当前已安装插件，没有重启用户 Gateway，没有修改工作区 `.runtime-corrector/`。没有将本次结果宣称为网页／终端聊天完整三文件故障注入任务已通过；那是下一阶段。GLM 输出仍有随机性，大型真实上下文、更多指标和更高 effort 尚需单独验证。

所有模型请求仅使用已授权的 `https://ark.cn-beijing.volces.com/api/coding/v1/messages`；没有更换 provider、模型或 API 路径。凭据来自环境文件，只保留合成材料和脱敏评审结果，不保存原始思考内容。

## 根因证据

同一个合成文档任务，包含三项硬需求及原核心 `buildMetricPopulation` 生成的 12 个 M01/M02/M05/M12 对象：

| 请求条件 | 结果 |
| --- | --- |
| `max_tokens: 8192`，无 effort 提示 | HTTP 200；143.3 秒；8192 输出 token 全耗尽，最终正文为空 |
| `max_tokens: 16384`，`thinking.budget_tokens: 2048` | HTTP 200；293.8 秒；16384 输出 token 全耗尽，最终正文为空 |
| 16384 上限，`reasoning_effort: low`，思考预算 1024 | 故障样例 300 秒截止时仍无最终正文；不能视为可靠修复 |
| `thinking.type: disabled` | HTTP 400，接口明确拒绝该模型关闭思考 |

因此已证实至少一条失败路径发生在 **模型／兼容接口的输出阶段**，无需 OpenClaw 就能触发；并非仅仅 Gateway 不工作或认证失败。HTTP 200 不代表已得到可验收的结果。`max_tokens` 包含思考和正文，提高墙钟超时不会给被截断的回复补出 JSON。一次小样例成功也不能证明参数稳定生效。

当前目标宿主对配置为 `reasoning: false` 的 GLM，不会因为 reviewer 的 `thinkLevel: low` 就生成有效的原生低推理请求。单独提高思考预算或增加 `reasoning_effort` 参数的实测没有可靠解决复杂样例；不宣称这些参数绝对被接口忽略。

## 修复

1. 仅对模型 ID `glm-5.3` 的内部 reviewer，通过系统提示传达 `Reasoning Effort: Low/High/Max`。格式来自 [GLM 官方聊天模板](https://huggingface.co/zai-org/GLM-5.3/raw/main/chat_template.jinja)，默认 max 的说明见 [官方模型说明](https://huggingface.co/zai-org/GLM-5.3/raw/main/README.md)。这是提示兼容处理，效果由本次实验验证；不是硬性 token 限额，也不是火山对非标准请求字段的支持保证。
2. 遵守项目 reviewer 的 effort：默认/low → Low，medium/high → High，max → Max。未改执行模型、provider URL、凭据、模型 `reasoning` 配置、8192 输出上限或全局配置。其他模型不添加这条提示。
3. 明确 Stop 分类与验收通过不是同一件事。完成评审可以含阻断偏差；中间停止、等待用户、外部阻塞不输出最终指标。保留原核心对“INTERMEDIATE + 阻断 finding”发起纠偏的逻辑，不能为了测试通过强行把未完成任务归为成功。
4. 运行中止、无最终输出、原生错误或输出额度耗尽不再伪装成 JSON 格式错误而多启动一次评审。新增明确失败代码，读取正确的 `meta.stopReason`。实际 JSON/schema 错误仍最多修复一次，沿用同一截止时间；基础设施失败交还原核心的独立有限重试，不增加实际纠偏次数。

需求基线、规则与语义评审、严重性、偏差归因、预算、停止条件和评审防递归机制未替换。没有宿主补丁或模块替换。

## 最终验收

独立脚本不导入 OpenClaw，也不读取原工作区。场景依次为故障文档、修正后的文档、等待用户：

| 场景 | 独立接口最终测试 | 隔离原生 SDK：第 1 轮 / 第 2 轮 |
| --- | --- | --- |
| 持久化冲突、功能遗漏、登录／云同步越界 | 50.3 秒，通过；首次 schema 不合格，经原有一次格式修复完成 | 35.2 / 32.5 秒；均识别三类阻断偏差 |
| 三份文档已修正 | 11.3 秒，12 个指标全部 PASS | 27.8 / 22.8 秒；12 个指标全部 PASS |
| 未写文件，等待用户选择文档语言 | 5.3 秒，WAITING_FOR_USER，无最终指标 | 11.1 / 14.5 秒；均等待用户，不发起纠偏 |

六次最终原生评审均只启动一次 `runEmbeddedAgent`，没有格式修复或超时；工具调用只有 `read`。它们运行在新建临时配置和合成工作区中，插件工厂直接调用只读原生 SDK，不连接 Gateway。结束后删除临时状态和会话。

探索阶段曾出现低档提示下 JSON 格式不合格和 Stop 分类不一致；没有把这些样本从证据中藏掉。新增分类说明后按最终脚本重新执行上述验收。独立接口仍有一次正常的有限格式修复，因此不能宣称每次首次 JSON 都有效。

- 源码回归：598 项，596 通过、0 失败，2 个 Windows 专用测试在 macOS 跳过。
- 新增针对测试：GLM effort 传递与其他模型隔离、配置不被修改、运行失败不重启格式修复、截断但外观合法的 JSON 不放行、丢失／重复指标不能误报通过、SSE UTF-8 分片和不完整流、原核心中间停止的阻断逻辑。
- 原有纠偏预算、防递归、取消、迟到回调和三宿主打包测试继续通过。
- [完整合成证据](openclaw-acceptance-6-evidence.json)保留最终评审、工具名、次数、时长、输出用量及探索阶段失败。路径已脱敏，无密钥或原始思考内容。

## 重复执行

在源码根目录运行。以下环境文件仅用于读取选定的 API key；不要把密钥写进命令、仓库或报告。`--key-env` 可指定不同的变量名。

完全不依赖 OpenClaw：

```sh
node scripts/diagnostics/glm-reviewer.mjs \
  --env-file ~/.openclaw/.env \
  --base-url https://ark.cn-beijing.volces.com/api/coding \
  --model glm-5.3 --max-tokens 8192 \
  --effort-hint low --repair-once true \
  --scenarios deviation,corrected,waiting \
  --output /tmp/glm-standalone-result.json
```

隔离原生 SDK 检查（需该版本 OpenClaw 已安装，但不启动 Gateway）：

```sh
node scripts/diagnostics/openclaw-reviewer.mjs \
  --openclaw-root /opt/homebrew/lib/node_modules/openclaw \
  --env-file ~/.openclaw/.env --repeat 2 \
  --output /tmp/glm-native-result.json
```

安装包为 `dist/runtime-corrector-openclaw-1.9.1-openclaw.6.tgz`；安装、effort 配置与回退 `.5` 方法见 [使用说明](openclaw.md)。本次先保留该包供下一阶段联调，不修改正在运行的安装。
