# 独立基线运行

该入口执行真实的“原始要求 → 候选提取 → 独立覆盖审查 → 正式基线发布 → 返回结果”。
它调用现有生产编排和 OpenClaw 工具，不运行文档纠偏、Skill 纠偏、业务代码生成或 benchmark。

需要 Node 22.19 以上、OpenClaw 2026.7.1-2 和可用的 GLM 凭据。
示例使用 Coding 接口 `https://open.bigmodel.cn/api/coding/paas/v4` 及 `glm-5.3-flash`。
首次在工作树中运行：

```sh
npm ci --prefix lib/review-task --ignore-scripts
```

## 运行示例

已有凭据放在本机 OpenClaw 的环境文件中时，可以直接加载；命令中只指定变量名称：

```sh
node --env-file="$HOME/.openclaw/.env" scripts/run-baseline.mjs \
  --input examples/baseline-e2e/requirements.txt \
  --material examples/baseline-e2e/materials \
  --config examples/baseline-e2e/config.json \
  --credential-env REVIEWER_API_KEY \
  --host-root /opt/homebrew/lib/node_modules/openclaw \
  --output .runtime-correction/baseline-example-001
```

也可以在进程环境中提供凭据，再使用 `npm run baseline -- ...`。
如果使用 Anthropic 兼容接口，配置 `api: "anthropic-messages"`，并通过 `baseUrl` 或 `ANTHROPIC_BASE_URL` 提供地址。
`--credential-env` 默认是 `ANTHROPIC_AUTH_TOKEN`；审查凭据可以另行选择 `REVIEWER_API_KEY`。
每次运行使用新的输出目录，保留旧尝试和失败证据。

示例原文要求建立无状态数值校验器、读取原始合同；合同要求只接受 1–9 的整数、拒绝其他输入，并且仅在发布时取消孤儿任务。
检查返回的 `claims` 时，应保留实现要求、读取合同的 PROCESS 要求，以及发布条件，不能把发布动作无条件激活。

## 时间与修复配置

示例配置位于 `examples/baseline-e2e/config.json`。各项均可在 JSON 中修改，或用命令参数覆盖：

| 配置 | 默认值 | 命令参数 | 作用 |
| --- | ---: | --- | --- |
| timeoutMs | 600000 | --timeout-ms | 提取与独立覆盖审查共享的 10 分钟窗口 |
| assessmentTimeoutMs | 900000 | --assessment-timeout-ms | 整轮上限 15 分钟，包含宿主准备和发布 |
| requestTimeoutMs | 600000 | --request-timeout-ms | 宿主模型请求超时配置 |
| maxRepairs | 8 | --max-repairs | 原运行内格式和领域修复额度 |
| model | glm-5.3-flash（示例） | --model | 本次使用的模型 |
| api | openai-completions（示例） | --api | 模型接口协议 |
| baseUrl | Coding 接口（示例） | --base-url | 模型接口地址 |

时间参数支持 1000–3600000 毫秒，整轮上限不得小于提取窗口。取消、父级截止和宿主自身限制仍然生效。
放宽时间不会跳过来源校验、独立审查、条件一致性或真实保存回执检查。

## 输出与失败

成功时，进程正常返回 0；`result.json` 包含 `status: "PUBLISHED"`、`complete: true`、基线版本、`claims` 和审查证明。
保存的宿主配置只引用凭据变量，不写入密钥。工作区、原始工具记录和正式账本均在本次输出目录中。

失败时进程返回非零，`result.json` 保留错误和实际耗时；不能把失败或空结果视为成功。
如果服务端返回 401，需要更新所选变量中的有效凭据。单纯放宽超时不能解决认证失败。

```sh
npm run test:baseline
```

这些自动化检查验证协议与回归行为；脚本化模型响应不能证明真实模型的提取准确率。
