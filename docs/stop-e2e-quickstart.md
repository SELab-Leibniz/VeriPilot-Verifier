# 终审最小闭环

本分支从 `28071d1` 建立，专门验证正常任务及一次真实自动修复。原开发目录未提交的基线新协议不包含在内。两例通过仅支持这个最小终审闭环，不表示历史上的所有范围、条件语义问题或四模块整体验收均已解决。

使用已安装的 OpenClaw `2026.7.1-2`、Node `>=22.19` 及可用的 Anthropic Messages 兼容模型配置。Anthropic Messages 认证仅从运行进程环境读取：`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL` 和 `RC_EVAL_NATIVE_MODEL`（或 `ANTHROPIC_MODEL`）；不要把认证值写进项目或验收记录。

```sh
node scripts/evaluate-native-stop-pair.mjs \
  --host-root /opt/homebrew/lib/node_modules/openclaw \
  --timeout-ms 5400000 \
  --output /absolute/path/to/a-new-stop-pair
```

用户指定的 GLM Coding Plan 可使用同一入口：

```sh
# 先由当前进程环境提供 RC_EVAL_API_KEY；不要把实际密钥保存到脚本。
RC_EVAL_NATIVE_MODEL=glm-5.3-flash node scripts/evaluate-native-stop-pair.mjs \
  --coding-plan --host-root /opt/homebrew/lib/node_modules/openclaw \
  --timeout-ms 5400000 --output /absolute/path/to/a-new-glm-stop-pair
```

该模式使用 `https://open.bigmodel.cn/api/coding/paas/v4` 的 OpenAI Chat Completions 协议；支持 `glm-5.3-flash` 或 `glm-5.3`。密钥只通过 `RC_EVAL_API_KEY` 进入运行进程，不进入保存的宿主配置。与旧 Anthropic Messages 凭据分别配置。

`--timeout-ms` 默认 20 分钟，可按整秒配置到 12 小时。每个案例共用一份绝对截止时间，覆盖启动、原始任务、基线抽取、终审、业务修复及复审；反馈预留 30 秒。它同时设置宿主任务、Hook、角色审查及 Stop 的预算，消除旧入口中写死的 3 分钟、3.5 分钟和 9 分钟限制。项目独立运行时仍须分别配置宿主和项目预算；任何更短的父级截止时间仍然生效。例如 90 分钟配置是每例的窗口；配置到 12 小时时，两例顺序执行的最坏总耗时可能达到 24 小时。真实 benchmark 入口则在原始任务、Stop 和修复外共用一个 12 小时截止时间。

如果直接在已有项目中配置 90 分钟，需要同时设置项目的角色与 Stop 总窗口：

```yaml
stopCorrection:
  enabled: true
  assessmentTimeoutMs: 5400000
  feedbackReserveMs: 30000
reviewers:
  defaults:
    timeoutMs: 5370000
```

宿主 RC 插件配置的 `hookTimeoutMs`、`reviewerTimeoutMs`、`businessRunTimeoutMs` 以及宿主业务任务时限也须允许该窗口；本页的验收入口会自动统一这些设置。显式设置的更短父级时限仍然有效。

两例使用同一个构建产物和默认启用的六项指标（M08/M09/M12/M13/M15/M16），按实际要求生成适用检查项。业务任务是实现 `accept(value)`，对有限数字返回 `value + 1`，不保存状态。未采用 Skill，不进行文档纠偏。

- 正常例：模型通过真实 Gateway 接收用户任务、读取契约并写入代码；终审 PASS，修复次数为 0。
- 故障例：在真实原始业务回合结束前，将交付函数一次性改成错误实现；终审须发现偏差、通过真实自动派发交给业务模型修复，再对当前代码复审 PASS，修复次数为 1。

最终 `pair-result.json` 仅在两例都满足条件、认证的业务终态为 `ok`、私有审查全部结清、宿主关闭且进程退出码为 0 时报告 `complete: true`。各例保留 `result.json`、`closure.json`、业务及私有审查记录；故障例另有注入与修复回执。认证失败、未验证、取消或超时都会返回失败，不会变成 PASS。正常例失败后不再启动故障例。

只做宿主接线检查、不调用模型：

```sh
node scripts/evaluate-native-stop-loop.mjs --transport-check \
  --host-root /opt/homebrew/lib/node_modules/openclaw \
  --timeout-ms 5400000 --output /absolute/path/to/a-new-transport-check
```

该结果只证明宿主、会话及终审钩子可用，不证明模型判断或修复成功。
