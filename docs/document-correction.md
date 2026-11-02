# 文档纠偏：项目会话与按需证据

## 动态基线与真实 benchmark 需求文档

同一入口增加 `--dynamic-baseline`，启用生产动态需求抽取和文档 Ground Truth 评审。模型从原始用户任务及完整需求材料抽取并发布正式基线；文档自动 Hook 的两轮评审均绑定已发布的基线版本。只启用基线和文档，Skill、实现检查、Stop、额外指标和 onboarding 小组全部关闭。

固定案例位于 `examples/document-e2e/terminal-bench-batching/`，采用 Terminal-Bench 2.1 的 `llm-inference-batching-scheduler` 原始完整需求（78 行、4365 字节）。来源仓库固定到 `7131e4375048a0e408a8fb404b5f499d726b695b`；`case.json` 保存来源 URL、原始文件哈希和独立检查点，原始 Apache 2.0 许可证随文件保留。`requirements.md` 保持 benchmark 原字节；独立 `draft.md` 仅在对齐粒度、形状预算、性能表和输入保护四处设置受控偏差。期望结果和偏差清单不会写进模型工作区。

```sh
node scripts/evaluate-openclaw-document-e2e.mjs --live --dynamic-baseline \
  --benchmark-case examples/document-e2e/terminal-bench-batching \
  --host-root /opt/homebrew/lib/node_modules/openclaw \
  --config examples/document-e2e/dynamic-benchmark-options.json \
  --output-root .runtime-correction/openclaw-dynamic-benchmark-new
```

`baselineTimeoutMs` / `--baseline-timeout-ms` 独立设置需求抽取的时限，默认 1200000 毫秒。示例配置为基线 20 分钟、文档评审 20 分钟、Hook 30 分钟、主运行 30 分钟、整轮 40 分钟，均可调整到 60 分钟；较短的外层截止仍会先结束调用。输出额外保存 `dynamic-baseline.json`，报告中包含正式基线、原生抽取记录、两轮 artifact evaluation 及其绑定版本。

这项测试评价真实 benchmark 原始需求在文档中的保真和纠偏效果。原始任务的实现和执行指令作为方案内容保留，本次不执行调度器、不生成 benchmark 运行产物，也不报告官方 benchmark 得分。

## OpenClaw 自动 Hook 文档闭环

`scripts/evaluate-openclaw-document-e2e.mjs` 在独立目录内启动已安装的 OpenClaw 2026.7.1-2 Gateway，加载当前源码构建的插件，通过真实 `sessions.create` / `chat.send` 发起主 Agent 任务。主 Agent 将虚构草稿写入 `design.md` 后，生产工具结果中间件自动触发文档评审，把诊断附回这次写入结果；主 Agent 根据实际收到的反馈进行修改，修改后再次自动评审。运行器不会手动调用评审、注入 Hook 事件或替换修订稿。

```sh
node scripts/evaluate-openclaw-document-e2e.mjs --live \
  --host-root /opt/homebrew/lib/node_modules/openclaw \
  --config examples/document-e2e/openclaw-options.json \
  --output-root .runtime-correction/openclaw-document-new
```

输出目录必须全新。可提供完整的 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`（或 `ANTHROPIC_API_KEY`）和模型环境配置；没有提供器环境时，读取本机 `.claude/settings.json` 中已配置的同一提供器信息。`--claude-settings` 可以指定该配置文件。认证仅通过进程内普通提供器环境传入。Gateway 配置、会话和插件构建都保存在新输出目录内。

| 独立预算 | JSON 字段 | 命令行覆盖 | 默认值 |
|---|---|---|---:|
| 每次私有评审 | `reviewTimeoutMs` | `--review-timeout-ms` | 600000 |
| 每次自动 Hook | `hookTimeoutMs` | `--hook-timeout-ms` | 1200000 |
| 主 Agent 运行 | `businessTimeoutMs` | `--business-timeout-ms` | 1800000 |
| 整轮验收 | `totalTimeoutMs` | `--total-timeout-ms` | 1800000 |

单位为毫秒，可配置到 3600000，使用整秒；Hook 最少 2000，其余最少 1000。各层截止时间共同约束运行，放宽私有评审时应同时给 Hook 和主 Agent 留足时间。原生定位格式修复共享同一评审截止时间，不重新计时。超出总时限会请求宿主取消当前运行，并记录失败。

验收要求首轮真实发现第 2 行的遥测偏差、主会话真实消费对应工具反馈、主 Agent 至少两次写入/编辑、最新文档的原生评审返回 `passed` 且零诊断、私有评审均结算，以及需求文件保持原字节。评审输入哈希必须对应初始草稿和最终修改稿。保存的 `report.json` 包含实际生效的超时、评审记录和反馈回执；`business-session.json` 保留原生工具调用与工具结果。文档模式直接使用声明的原始需求，不依赖动态基线账本；动态基线、Skill 和 Stop 仍独立验收。

## 最小真实模型闭环（2026-11-02）

独立入口 `scripts/evaluate-document-e2e.mjs` 会生成一个包含遥测偏差的虚构文档项目，构建 Claude 插件，并使用生产 `checkArtifact`、`runSemanticReview`、`finalizeArtifactCheck` 和真实 `rc_document` MCP 工具完成评审。原始需求文件直接作为声明的依据，不依赖动态基线抽取。

首轮必须发现设计第 2 行的实际偏差。程序将本轮生产反馈交给业务 Agent，要求它读取原始需求、当前设计和反馈，并真实调用 Edit/Write 修改设计。随后重新读取当前文件进行第二轮评审；只有当前文档通过、存在成功编辑回执、原始需求保持原字节，整轮才返回 `PASSED` 和退出码 0。不会由测试程序替换修订稿。该入口是显式 CLI 协调的文档闭环；OpenClaw/Gateway 自动 Hook、动态基线、Skill 和 Stop 属于其他接入范围。

使用本机已配置且可正常调用的 Claude Code：

```sh
node scripts/evaluate-document-e2e.mjs --live \
  --config examples/document-e2e/options.json \
  --output-root .runtime-correction/document-e2e-live-new
```

输出目录必须全新。`--live` 会调用真实模型并产生相应费用。`RC_DOCUMENT_CLAUDE` 可指定 Claude 可执行文件；默认使用宿主的 Claude 路径解析，不修改全局模型或认证配置。

时间阈值可以通过 JSON 或以下参数调整（毫秒），命令行参数优先：

```sh
node scripts/evaluate-document-e2e.mjs --live \
  --output-root .runtime-correction/document-e2e-live-wide \
  --review-timeout-ms 1200000 \
  --repair-timeout-ms 1200000 \
  --total-timeout-ms 3600000
```

| 配置 | 默认值 | 用途 |
|---|---:|---|
| `reviewTimeoutMs` | 600000 | 每轮评审，包含模型启动、工具读取和定位错误修复 |
| `repairTimeoutMs` | 600000 | 每轮业务 Agent 编辑 |
| `totalTimeoutMs` | 1800000 | 所有评审和编辑共享的总时限 |
| `maxRepairRounds` | 2 | 最多允许的业务修复轮数 |
| `locationRepairAttempts` | 2 | 每轮允许修复定位错误的次数 |
| `killGraceMs` | 1500 | 超时后终止整个调用进程组前的宽限 |

三个时间预算接受 1000–3600000 毫秒。重试不会重置本轮或总截止时间；超时记录失败并返回非零，不能当作 PASS。输出保留 `options.json`、构建后的插件、原始及当前文档、每轮反馈、完整 CLI 工具调用/回执流和 `report.json`。模型用量及费用按 CLI 的报告值保存。

定位校验覆盖当前声明文件的物理行号和逐字引用，支持 `path:line: 'quote'`、双引号和行范围。定位错误要求模型重新读取并提交，程序不会悄悄挪动发现。修订后的检查必须使用当前哈希对应的完整文档，不能复用之前的 PASS。

## 目标与范围

本方案优化 MatrixAssistant / OpenClaw 的 artifacts、bundle、workflow 节点和入边文档评审。实现放在 runtime-corrector 插件中，不修改宿主。开发使用从当前分支建立的外部 Git worktree，共享原仓库对象；运行时直接读取项目原文件，不克隆或复制代码仓。

Stop 的任务评审引擎和 CLI 宿主的默认会话策略保持原协议。文档工具也提供独立 CLI / MCP 适配器，便于实验和其他宿主显式接入；不能把这个适配器描述为已自动改变 Claude / CodeAgent 的生命周期。

## 实现规划与落地

1. **项目级执行槽。** `document-session.mjs` 用项目真实路径和磁盘互斥锁串行接收文档轮次。每轮新建请求、运行编号、预算和工具绑定，但复用私有 agent 的原生身份和会话。不同项目独立执行；相同项目并发排队，等待仍受原截止时间和取消信号控制。
2. **拉起、复用、释放。** 首轮按需拉起。轮次结束后释放执行器、工具、监听器、内部租约及请求资源，保留可恢复的会话。空闲 30 分钟或达到 32 轮后释放/轮换；模型、权限、认证或协议变化也轮换。失败、取消不复用不确定会话。重置、关闭纠偏和插件退出清理空闲资源；不合作的在途运行仍须结算后才放开执行槽，防止两轮重叠。进程崩溃后的死锁按持有进程存活情况回收，开启新身份，保留笔记供重新核对。
3. **按声明读取。** `document-tools.mjs` 的 `rc_document` 仅接受本轮已声明的目标、前序文档和 ready Ground Truth 文件。`open` 一次返回清单、有效笔记和带原行号的当前文档页；剩余内容用 `read` / `search` 获取。所有原文件在结果接受前重新核对哈希；链接、越界、非文本和不稳定证据会被拒绝。一般文档页最多 8 KiB；长行明确返回 `requiresHostRead`，不会静默当成完整内容。
4. **精简 skill。** `skills/document-corrector/SKILL.md` 由文档执行器按需提供。它要求读完当前目标及适用依据、保留缺失前提的 pending 状态、只给当前偏离和最小候选编辑。完整语义评审协议继续负责具体节点、入边、Ground Truth 和指标约束。
5. **压缩后的笔记。** `remember` 只写项目私有笔记，只接受本轮读取过的文件引用；按键覆盖，最多 24 条，每条正文 1000 字节。`recall` 的正文预算为 4 KiB，明确标注省略条数。每条笔记绑定本轮完整文档范围的哈希、规则、基线及任务身份；任意依据变化后仅返回 stale 键。压缩前后自动保存私有 checkpoint；`open` 同时给出当前请求路径，便于重新加载。笔记和 checkpoint 只用于导航，不承认先前 PASS 或引述为当前证据。
6. **合理触发与看护。** 继续使用原有配置匹配、写入触发、节点/边开关和宿主取消协议。完整输入与证据完全相同的重复事件可复用已验证结果，模型调用为零；文件、规则、基线、转录证据或模型策略变化都会重新评审。额外读取声明范围之外的源文件、调用外部检索，或结果含临时私有路径时，不进入去重缓存。候选 diff 的可编辑范围和 exact-expect 校验继续由原程序执行。
7. **界面阶段标识。** 原生工具进度通道显示 `文档·评审`。阶段状态不追加到宿主模型消息或助手正文；真实诊断仍按原反馈协议送达。状态侧录在项目私有 `status.json`，不把定时状态当成真实模型活动，也不延长原截止时间。

## 生命周期与存储

`待命 → 排队 → 评审/取证 → 哈希及输出校验 → 本轮结束 → 待命或释放`。

私有文件位于项目 `.runtime-correction/document-agent/`：

- `active.lock/`：跨进程执行槽的独立排队凭据，含进程号、随机令牌和次序号；只回收死进程的独立凭据，不删除其他进程新建的共享锁。
- `status.json`：本轮阶段与会话身份。
- `notes.json`、`checkpoint.json`：有界笔记和压缩恢复导航。
- `<session-id>/session.jsonl`：支持文件转录的原生会话；使用 SQLite 的宿主继续由公开原生 session API 管理转录。

每轮请求、进展证据及审计记录各自使用独立编号，不能因会话复用覆盖上轮结果。文件转录按本轮新增区间归档，避免反复归档全部历史。此目录应保持项目原有的忽略规则。进程崩溃后的历史目录保留供诊断；重新启动不冒认旧原生身份。

## 验证

确定性测试覆盖同项目串行和复用、跨进程互斥与崩溃恢复、取消和截止时间、空闲/失败/策略变化后的释放、当前工具绑定、重复事件零模型调用、文件变化后的拒绝、笔记失效、压缩 Hook checkpoint、MCP 真实 stdio 往返、范围和链接约束。原有文档 workflow、diff、权限、宿主进度、插件打包和注册契约继续复验。

全量初测执行 144 个文件，出现机器负载相关的截止时间/性能阈值失败及新资源清单断言失败。补齐新工具与 skill 的打包断言后，13 个相关或失败文件改为串行复验，404 项全部通过；没有放宽既有时间与业务断言。最终文档专项和宿主/打包契约另行复验。历史初测失败与复验结果均保留在工作树的 `.runtime-correction/` 验证记录中。

真实模型实验使用本机已配置的 Claude Code 模型及真实 MCP 工具，生成一个小型文档夹具，不复制仓库：连续检查“云端导入偏离 → 离线导入正确 → 遥测网络调用再次偏离”。冷启动组每轮新会话、分步导航读取；优化组一个会话、批量 `open`。两组均 3/3 判断正确。

- 冷启动：3 个会话；输入 token 16,885（含缓存），输出 836；模型报告总耗时 80,187 ms。
- 优化：1 个会话；输入 token 12,524（含缓存），输出 439；模型报告总耗时 37,785 ms。
- 本次输入量减少 25.8%，耗时减少 52.9%。非缓存输入从 4,149 降到 2,348。

另做了仅复用会话、仍分步取证的对照：虽减少非缓存输入，总上下文输入却增加。因此批量取证与有界笔记是必要优化，不能用“复用”本身承诺 token 节省。结构化观测见 [实验记录](document-correction-experiment.json)。

实验只有每组 3 轮，结果受缓存和服务延迟影响，不代表所有项目的固定收益。压缩恢复验证包含真实 Hook 调用、工具状态重建和笔记恢复，没有强制对生产 MatrixAssistant 会话执行压缩。已只读验证本机宿主注册契约，尚未在运行中的 MatrixAssistant 界面发布或进行人工视觉验收。

## 复现

在仓库根目录执行：

```powershell
node --test test/document-agent.test.mjs test/document-agent-lifecycle.test.mjs
node scripts/experiment-document-agent.mjs .runtime-correction/document-experiment
node scripts/experiment-document-agent.mjs .runtime-correction/document-experiment-live --live --batched
```

第三条会使用本机 Claude Code 的已配置模型产生真实用量。可通过 `RC_DOCUMENT_CLAUDE` 指定原生可执行文件。MCP 适配器采用 [官方 stdio 协议](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)，可用 `node scripts/document-tools.mjs <semantic-request.json> --stdio` 启动；这是单轮工具进程，私有笔记持久化在项目中。
