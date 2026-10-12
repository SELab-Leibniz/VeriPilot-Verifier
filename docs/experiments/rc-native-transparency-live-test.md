# RC 原生输出隔离实验（2026-10-12）

基线 `codex/openclaw-2026.7.1-2` 的 `f19f2fc39675f3fb02055809d4d2c56503d4c996`；候选 `codex/openclaw-native-transparency`。宿主固定为 OpenClaw `2026.7.1-2`，模型为 GLM-5.3-Flash，只修改 RC。

结论：候选恢复了宿主过程文字、工具活动和正常交付；本次 App 14/14，过程偏离意见由宿主实际采纳，完整 Stop/Implementation 评审完成并保存 PASS。但是仪表盘聊天没有显示 RC 最终摘要，不能将此候选当成已经全面通过的替换版。本实验分支保留供审阅，未合入原分支、未替换安装。

## 历史措施与边界

`codex/reviewer-information-map` 中可追溯的措施：`dfc6c59` 将业务执行交回原生宿主，`02d0608` 只读来源与原生证据，`459e421` 将 RC 准备/故障作为建议反馈。不是整体 cherry-pick 历史分支。

采用：不注册业务 harness、私有工作会话或业务继续/停止入口；原生会话只读观察；工具原文/媒体/错误/问题/审批保留；已完成的宿主执行结果绑定源码版本，RC 不另跑业务命令；RC 故障不 veto 宿主工具。保留 f19 的需求账本、引用挑选与程序获取、逐项进度/部分反馈、输出字段容错、默认三次格式修复。

未采用历史观察器、额外并发调度、缓存、信息地图重写、总结 LLM。完整 Stop 核心保留，但移至最终回复处理阶段作为建议，不另启业务修正轮；是否继续修改由宿主和用户判断。这是与旧控制器自动修正行为的明确差异。

## 同任务对比

同一离线 Python 备忘录 App，R01–R12，从空业务目录开始。三组需求文本与项目策略 SHA-256 相同，模型/API 相同，运行时绑定和插件版本为有意变量。包含明确标注的首稿错误探针：首个写入的 `spec/requirements.md:2` 声称数据只在内存、退出丢失，与正式 R02 的 JSON 持久化冲突。它用于验证反馈链，不代表自然任务缺陷率。

| 指标 | 无 RC | 原版 f19 | 最新候选 V3 完整补跑 |
|---|---:|---:|---:|
| 独立业务 CLI 检查 | 14/14 | 14/14 | 14/14 |
| 首段原生过程文字 | 4.611 秒 | 无过程文字流 | 5.004 秒 |
| 原业务运行工具事件 | 35 | 0 | 38 |
| RC 工具结果反馈 | 0 | 2 | 2 |
| 业务控制器数量 | 0 | 1 | 0 |
| RC 保存的最终验收 | 不适用 | COMPLETED / PASS | COMPLETED / PASS |
| 业务交付文字到达 | 200.532 秒 | 905.330 秒 | 396.268 秒 |
| 回复处理确认结束 | 约 210 秒整轮 | 约 913 秒整轮 | 631.397 秒（本次业务请求） |

候选整轮含问答/启动共 645.459 秒；宿主交付文字之后的约 235 秒用于 RC 回复阶段评审。各组仅一次主要对照，模型等待波动明显，不能据此宣称平均性能优势。

最新候选以真实原生 Gateway 会话执行，不是回放响应。首稿偏离意见指出 `spec/requirements.md:2` 与 R02 的位置，宿主修订后再次检查通过。生成 13 个 unittest、13 次真实 CLI 冒烟，宿主实际修复了测试导入和冒烟子进程找不到包的问题。独立检查另跑 14 项，覆盖增删改查、持久化、中文/引号/换行、损坏与不兼容数据保护、只读无写入、CSV 同路径/符号链接/硬链接保护。

完整补跑 Stop Reviewer 170.178 秒、Implementation Reviewer 43.482 秒，均 SETTLED；任务 `COMPLETED`，verification `PASS`，无 OPEN 偏离。115 条程序引文逐条核对冻结源文件 SHA-256 和行区间原文一致。候选源码完整回归 703 项：701 通过、2 跳过、0 失败。最终帮助/说明更新后再跑注册与打包检查 37/37；冻结的 11 个生产文件中 10 个字节不变，entry 仅帮助字符串变化，最终包与源码一致。

## 确认的输出原因与尚未通过的部分

原版 `lib/openclaw/supervised.mjs` 的 `suppressLiveStreamOutput: true` 及删除输出回调，使业务 worker 过程输出没有进入父会话。

仅移除业务 harness 的 V2 仍不够：工具在 7.65 秒出现，文本到 1031 秒终审后才发出。固定宿主 `dist/selection-JInn13lc.js` 在发现 `before_agent_finalize` 时启用 `deferBlockReplyDelivery` / `deferredAssistantEvents`。因此 V2 未通过文字透明要求，未采用为最终候选。

V3 不注册该终止门，完整评审移到 `reply_payload_sending`，过程文字恢复。原生聊天的 `chat.final` 在该回复 Hook 完成之前已到达。固定宿主 `dist/chat-pg-BxhF6.js` 在原生 Agent 已启动时仅重新广播带 source-reply mirror 或 status-notice 的交付内容；普通回复文字经 Hook 追加摘要，并不自动重写仪表盘已显示的原生文字。完整补跑等到原请求缓存状态 `ok` 后，依然只有一条原生 final，没有 `[runtime-corrector:summary]`。

因此“终审保存 PASS”与“摘要已显示/交给宿主”是两项不同事实。当前前者已通过，后者在仪表盘未通过。没有伪造状态消息、改宿主代码或重新接管业务来绕过这个结果；其他渠道摘要交付未真实验证。当前候选不能直接作为完整发布版。

## 实验纠正与限制

- 首个真实候选发现无身份/内部结束事件错误取消 RC 信号，导致工具 Hook 报错。作为候选失败保留，修正事件身份隔离和故障建议反馈后重跑。
- 最初驱动未等原生问答结束导致任务未执行，排除。V3 第一轮在可见 `chat.final` 后提前关网关，App 14/14 但终审被截断，亦未算完整通过。完整补跑对同一 `chat.send` 幂等键查询缓存，只在宿主完成回复处理、状态为 `ok` 后关闭网关；不产生第二个业务请求。
- 原独立检查错误要求 JSON 模式下错误必须写 stderr。R08 未限定渠道，候选实际在 stdout 的 JSON 错误中包含路径/原因、非零退出、保留原字节。保留原测试源及失败证据，统一改为检查 stdout + stderr，并对三组全部重跑 14/14；没有替 App 修改业务代码。
- 旧 Coding 接口三组均长思考、无 App 文件，作为模型/驱动预检保留排除。本机注册的凭据在 Anthropic 接口返回 401；之前已授权的测试凭据最小请求返回 200，随后三组统一使用该凭据。全局凭据未改，用户补充的备用 key 未使用。
- 初始隔离遗漏导致宿主迁移原审批文件，已从迁移备份逐字节恢复。后续使用独立 `OPENCLAW_HOME`、状态与配置。最终 327 个已安装插件文件无变化，原审批文件与备份字节相同，原分支仍为 f19且干净。
- 三组临时执行策略均为 `security: full, ask: off`，仅在隔离测试配置中。真实审批 UI 未覆盖；审批/问题/媒体保留的契约夹具不能当成真实审批已验证。
- Python 测试平台仅存在于两组实验构建包，源码清单明确包含 App、tests、文档和 smoke。未设置设备构建检查；真实 CLI 和 unittest 另行执行，不能声称设备/构建集成已验证。
- RC 角色设置仍可在自己的 YAML 中使用 20 分钟，原生同步 Hook 仍受宿主 10 分钟上限约束。未通过修改宿主超时、关闭检查或 shadowMode 取得通过。

## 证据位置

原始目录 `/private/tmp/rc-native-transparency-20261012-1`，完整候选 `anthropic-valid/candidate-v3-complete`。其中 `phase-results.json` 包含业务原生 final 和缓存交付确认；`wire-events.jsonl` 按实际业务 runId 筛选，排除 RC 私有评审与 replace 快照；`history.json` 是宿主真实历史。`comparison.json`、`v3-complete-quote-audit.json`、`host-integrity-final.json`、各组 `*-acceptance.log`、`v3-full-regression.log` 保存结果。

同目录 `request.md`、manifest 和源码冻结 hash 可核对条件；凭据文件和完整原始会话不进入 Git。业务检查源与无凭据对比数据附在 `native-transparency/`；使用 `RC_APP_WORKSPACE=/absolute/app/workspace python3.13 acceptance.py` 重跑。
