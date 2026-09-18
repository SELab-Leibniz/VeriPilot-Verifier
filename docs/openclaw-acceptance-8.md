# OpenClaw .8：原生压缩衔接验收

日期：2026-09-17。OpenClaw `2026.7.1-2`，插件 `1.9.1-openclaw.8`。本次修复补充受控执行器的 `compact` 入口，返回 `undefined`，由宿主继续执行原生上下文压缩。摘要、历史检查点、认证、取消和队列仍由 OpenClaw 管理；纠偏插件不另外实现摘要器。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 完整回归 | 637 项，635 通过、0 失败、2 项 Windows 专用测试跳过 |
| 固定宿主契约 | 旧实现复现 `unsupported_harness_compaction`；补丁将压缩交回原生 context engine |
| 真实手动压缩 | 44 条合成历史消息，原生返回 `compacted: true`，产生模型生成的摘要 |
| 关键约定保留 | 最早消息中的 `CEDAR-4872`、`indigo`、`17` 全部进入摘要；后续问题不重复这些值，模型仍正确回答 |
| 历史与纠偏状态 | 手动压缩前的历史条目 ID 全保留；taskId、groundTruth、epoch、纠偏次数、偏差记录未改变 |
| 自动压缩后继续 | 独立会话模拟持久化用量 187422、上下文窗口 128000；普通 `chat.send` 自动创建 `auto-threshold` 检查点，再成功回答三个约定值，用量恢复至 7314 |
| 当前安装 | 已安装 `.8`，受控执行器文件与测试源码一致；完整重启后的 Gateway 健康检查通过，插件无加载错误 |

执行、压缩及 reviewer 配置均为 `review/glm-5.3-flash`。两种压缩方式的续聊均由 `runtime-corrector-supervised` 执行。机器可读结果见[压缩证据](openclaw-acceptance-8-compaction.json)。

## 范围与复现

真实模型验收使用临时独立 Gateway、独立工作目录和合成历史，不修改原始业务会话。为缩短测试，测试配置将保留近期历史设为 1024 tokens，并关闭测试会话的压缩前 memory flush；当前用户配置未作这些调整。自动场景通过宿主 SDK 仅设置合成会话的超限用量，验证原故障的 preflight 自动压缩路径，并非另行发送 187422 tokens 给模型。手动压缩结果中的 `tokensBefore` 来自夹具的合成用量，不能当作实际测量的压缩率。

纠偏状态检查使用合成任务及预算、偏差标记，另有完整回归中的 PreCompact 测试覆盖已有需求状态且不额外调用 reviewer。本记录不替代原应用任务的最终成果验收，也不改变 `.7` 记录中的其他已知限制。

```sh
node scripts/build-plugin.mjs --host openclaw
node scripts/diagnostics/openclaw-compaction.mjs
```

诊断脚本仅显式运行时调用真实模型，读取当前 `review/glm-5.3-flash` 配置及环境变量引用的凭据。凭据只进入测试进程环境，不写入配置或报告。测试结束停止临时 Gateway，证据位置由脚本输出。

## 升级注意事项

安装后必须完整重启 Gateway 进程。在旧进程内触发热重载曾保留 `.7` 的 ESM 模块，导致 CLI 显示新版本而原进程仍拒绝压缩；完整重启后该现象消失。
