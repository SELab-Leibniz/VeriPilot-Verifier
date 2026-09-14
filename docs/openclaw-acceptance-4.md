# OpenClaw .4 调试与验收记录

日期：2026-09-14。目标宿主：OpenClaw **2026.7.1-2 (0790d9f)**，Node 26，macOS。分支：`codex/openclaw-2026.7.1-2`。版本：`1.9.1-openclaw.4`。

## 结论与边界

用户提供的三文件故障注入任务，已从真实网页聊天和真实 `openclaw tui` 分别提交并完成。两次均经历 proposal 首写矛盾 → 收到 error 反馈 → 单点 Edit → proposal 复验 passed；随后 design 与 tasks 的故意偏差均收到 failed 反馈，最终由原核心确认这次看护测试完成。网页完成后的追问正常返回，刷新后最终回复仍在历史中。

**这里通过的是故障注入与看护测试，不是 design/tasks 文件质量验收。** 主执行模型按测试要求保留这两个失败快照，并在最终回复中说明。它们不能被当成合格方案交付。两次控制器均为一轮工作执行，proposal 修正发生在该轮工具反馈之后；本次不冒称重新执行了 `.3` 的 DRAFT → VERIFIED 跨轮场景。该场景的历史 UI 证据见 [.3 验收记录](openclaw-acceptance.md)，控制器串行修正仍有本版源码回归测试。

实际通过的模型组合：主模型 `ark-work/ark-code-latest`，reviewer `review/ark-code-latest`；二者为独立 provider 配置，均使用已授权的 `https://ark.cn-beijing.volces.com/api/coding`、`anthropic-messages`。没有修改宿主源码、补丁或替换宿主模块。其他消息渠道、GLM-5.3 完整任务稳定性不纳入通过声明。

## 根因与修复

| 问题 | .4 行为 |
| --- | --- |
| Claude/CodeAgent 的 `reviewerRuntime.executable` 残留到 OpenClaw | 校验项目配置、启动工作前明确报错，要求删除整个 CLI 配置段，通过原生 provider/model 选模型。 |
| Ground Truth 评审耗时占用下一角色 Stop 的独立时限 | 角色交接继承共同 Hook/父运行截止时间；新角色获得自己的有限时限。同一角色 JSON 修复和追问不续期。 |
| 超时后立即删除原生 reviewer 会话文件，触发宿主 session takeover 错误 | 先取消原生评审并等待退出；非协作退出时延迟清理，保留内部身份，迟到回调不能进入正常纠偏。超时角色不再上报有效进展。 |
| 工作会话等待长工具评审时，只有父会话收到进展 | 将所属 reviewer 的真实模型/工具进展同时通知等待中的工作会话。忽略自身转发的通知，无定时假进度，无递归反射。 |
| 默认五分钟会话写锁早于长运行结束 | 私有原生运行配置按运行时限加五秒延长默认锁时限；显式操作员上限和全局配置保持不变。 |
| 宿主结束工作后，工具评审仍继续运行 | 独立工作取消信号结束残留评审；宿主异常终止保留 UNVERIFIED，不伪装成用户主动取消。 |
| 累计执行用量误作当前上下文，后续普通问题溢出 | 父运行上报最近一次模型调用的上下文占用，累计用量保留作独立统计。 |
| 未开启输出存档，却只显示三条诊断并声称剩余内容在 `diagnostic.md` | 只有真实存在完整诊断/补丁存档时才采用原有内联省略；无存档时发送完整列表。 |

需求基线、规则/语义判定、严重性、归因、候选补丁边界和原纠偏预算未改写。两个真实任务均保持需求版本 1、预算代次 1，最终 Stop 实际纠偏次数 0、基础设施故障次数 0。工具审阅中存在有限 JSON 修复（网页 2 次、终端 5 次校验失败后修复），不能表述为模型首次输出全部有效。

## 真实入口结果

隔离临时配置与工作区，Gateway 端口 19872；项目 `.runtime-corrector/` 从用户原项目复制，未降低或禁用检查。插件 reviewerTimeoutMs 与 hookTimeoutMs 均为 600000，父运行 3600 秒。

| 入口 | 网页聊天 | 终端聊天 |
| --- | --- | --- |
| 输入方式 | 实际网页输入框并发送 | 原生 TUI 的 `--message`，实际 PTY 界面 |
| 变更目录 | `persistence-conflict-probe-7f3a` | `todo-persistence-guard-20260914-1747-a91c4d` |
| 任务 ID | `task-20260914T094754643Z-61a03a2c` | `task-20260914T094715769Z-88b15c6b` |
| 耗时 | 1145.4 秒 | 1113.7 秒 |
| 工具反馈 | proposal failed → passed；design failed；tasks failed | proposal failed → passed；design failed；tasks failed |
| Stop | TASK_COMPLETE / PASS | TASK_COMPLETE / PASS |
| 控制记录 | DELIVERED / VERIFIED | DELIVERED / VERIFIED |
| 最终父回复 | 1 条，runId 去重收据 | 1 条，runId 去重收据 |
| 上下文显示 | 约 26% | 约 23%，connected / idle |

所有目标文件创建/修改均为 Write/Edit；模型也执行了只读目录探查、读取和哈希检查，没有以 exec 写目标文件。TUI 中有一条只读 Exec 非零退出提示及非 Git 仓库提示，未被当作评审通过证据。

网页 proposal 没有把编辑/删除写入产品需求，因此网页 tasks 的上游审阅没有覆盖这两项缺失。终端 proposal 包含编辑、删除、完成状态和持久化，tasks 反馈将四项遗漏合并在 `AGENT-EDGE-PROPOSAL-TO-TASKS-MISSING-CORE-REQUIREMENTS` 中，并单独报告登录/云同步越界。上游 design 自身与 proposal 冲突时，插件保留要求澄清的判断，未强行生成猜测性补丁。

网页追加“是否给过反馈、是否采纳”的原问题后，9.3 秒正常回复，没有调用工具，也没有创建新纠偏任务或重置预算。刷新后原任务最终回复与追问回复都在，当前提示上下文约 33.7k / 128k。宿主显示只加载最近 30 条、隐藏 3 条，这是原生分页；底层父历史仍包含真实首条用户要求。

实际网页 Stop 及 TUI Escape 在早期诊断运行中分别产生 CANCELLED，停止后没有报告通过。取消与评审竞态、迟到回调、重复运行、重启不确定状态等其余场景由专项测试验证；并非每项都重新进行了两种界面的模型测试。

项目 config.yaml 原文件与测试结束文件逐字节相同：

```
e21a73a75ef5b4e6c8d167426d6961a9ed474b33cdcca86b326aa49002b5ce13
```

## 最终修改验证与证据

两入口长任务验证包 SHA-256：`0fa312428a93ea9a6bacc24c849f4013c184653bcbf1954efecb92b7136b079c`。其后增加了“超时角色立即退出有效进展集合”的错误路径修正和“无存档时完整反馈”的显示修正；未再重复两个约十九分钟的完整 UI 流程。这两处通过源码回归，并针对最终构建作了真实模型只读 artifact-reviewer 复验。

该补充复验读取终端任务的原 `tasks.md`，不执行 Write/Edit，不创建控制器，不修改已完成任务基线。120.1 秒返回 5 条诊断，5 条全部出现在反馈中，没有引用不存在的诊断文件，文件与 config 哈希不变。它是补充的原生评审测试，不冒充第三次聊天端到端测试。

- `npm test`：589 项，587 通过，0 失败，2 个 Windows 特定测试在 macOS 跳过。
- `npm run build:plugins`：Claude、CodeAgent、OpenClaw 三宿主构建成功。
- OpenClaw 专项覆盖：评审防递归、worker 子控制器阻止但正常复验允许、有限 JSON 修复、跨角色时限、超时清理、跨进程锁、重复事件、需求来源连续性、两会话并行、取消、等待用户、预算耗尽、交付前证据变化、上下文用量、长运行进展和会话锁。
- [脱敏结构化证据](openclaw-acceptance-4-evidence.json)：真实提示、控制收据、Write/Edit 输入、反馈、初始/最终文件内容和哈希。
- [最终构建只读复验](openclaw-acceptance-4-replay.json)：完整五条诊断及无写入校验。
- [真实 TUI 最终界面文本](openclaw-acceptance-4-tui.txt)：保留可见最终回复和上下文显示，临时目录已替换。

## 模型限制与安装

GLM-5.3 在当前 Anthropic 兼容接口上存在长思考耗尽 8192/16384 输出预算、首次没有完整 JSON 的样本。提高超时只能解决时限不足，不能保证模型输出协议。对原失败 Stop 快照的独立测试分别约 175 秒、153 秒返回有效结果，但较复杂的完整任务仍不稳定，因此本次通过组合使用 `ark-code-latest`。

OpenClaw UI 的 low effort 不等于当前 GLM provider 已收到其原生 `reasoning_effort` 参数。本次没有修改宿主 provider 实现，也没有将 GLM 伪装成其他模型。切换另一 API 路径的真实数据测试被自动审批拒绝，原因是该路径未获明确授权；该操作未执行，后续仅使用原授权地址。

最终安装包：`dist/runtime-corrector-openclaw-1.9.1-openclaw.4.tgz`。安装、模型配置、关闭受控执行、回退 `.3` / `.2` 的步骤见 [OpenClaw 使用说明](openclaw.md)。不要用关闭 Stop 或 shadowMode 把未验证结果包装成完成。

本机交付：已通过原生插件安装器更新默认 `~/.openclaw/extensions/runtime-corrector` 为 `.4`，配置校验通过，运行时检查显示 `runtime-corrector-supervised` 已加载且无诊断错误。主 Gateway 于 18:31（香港时间）通过原生重载流程恢复监听 18789。原配置与 `.3` 插件备份在 `/Users/id02271616/.openclaw/backups/runtime-corrector-before-openclaw-4-20260914-182922/`（实际备份目录以本机为准）。只更新插件 reviewer/Hook 上限为 600000，保留用户原 `review/glm-5.3` 选择，不将其视为本次已通过的 Ark 组合。临时测试 Gateway 已停止。
