# MatrixAssistant incomplete turn 定位与隔离复验

范围：MatrixAssistant 1.8.160，内置 OpenClaw `2026.7.1-2`；仅修改插件仓库，使用独立 Gateway 状态、临时项目及新建测试 Session。没有安装插件到宿主、修改宿主文件或操作现有用户会话。

## 已确认原因

上一轮故障注入将已有 `BROKEN\n` 原样写回。MatrixAssistant 内置原生 `write` 对相同内容返回 `terminate: true`：

- 宿主 `resources/openclaw/dist/sessions-D8qGY7uC.js:7500`：相同内容不写文件，返回结束标志。
- 宿主 `resources/openclaw/dist/proxy-BzhBz8iM.js:279`、`:529`：整批工具结果均结束时，不再请求下一轮模型。
- 宿主 `resources/openclaw/dist/embedded-agent-DGUuxGR2.js:4402`：最后 Assistant 为 `toolUse`，无最终答复，报告 `incomplete_turn`；带副作用的工具不能自动安全重放。

零模型复现直接导入原装 `createWriteToolDefinition`，用内存文件操作验证：相同内容产生 `terminate=true`、实际写入次数为零；改变内容不产生该标志、实际写入一次。复现无需加载纠偏插件。因此这次错误的直接触发来自宿主的 no-op 写入行为，不是 `spawnedCwd` 项目适配失败，也没有 Reviewer 污染外层运行的证据。

## 最小变更

插件中间件通过展开原结果后追加反馈，保留宿主的 `terminate`、`details` 和原始内容。新增回归锁定该行为，不清除终止标志或自动重放业务操作。

隔离探针改为从 `SEED_A\n` 实际写成 `BROKEN\n`，以及从 `SEED_SWITCH\n` 实际写成 `BAD_SWITCH\n`。这使故障注入能够正常进入原生交付和 RC Stop，而不触发 no-op 短路。同步更正插件 Skill 的项目说明：可信 `spawnedCwd` 自动跟随，缺少字段才手动绑定。

探针每次使用一个独立 Gateway、三个临时项目，每任务一次纠偏，常规 Reviewer 配置 90 秒、单业务观察 360 秒、整段观察 15 分钟；需求初始提取保留原有更高时间下限，仍受外层观察及模型请求上限约束。达到请求上限关闭隔离 Gateway。请求统计来自宿主真实传输日志；不以配置或替身测试代替实测结果。脚本支持单独补跑 `switch`，不重复已通过的纠偏闭环。

## 复验结果

本轮 40 项定向插件、宿主合同与打包回归通过，构建已更新，未安装到宿主。

首个非 no-op 探针实际使用 18 次请求，正常生成最终回复，未重现 `incomplete_turn`。它明确要求先报告未完成、等待反馈，因而被正确判为 `WAITING_FOR_USER`，不触发纠偏，不能计为闭环。保留该失败并将负向场景调整为明确的错误完成交付；关闭与本轮无关的产物评审，不修改终审规则。

后续真实闭环通过：任务 `oc-scope-e3c8537b-91df-4d07-ba70-9436f2939f2e`，首次 Stop 为 `DEVIATION`，原生续作 `693eacd9-e138-483f-8842-288731c5644b` 于 `15:01:42.616Z` 被模型观察，`15:02:35.974Z` 完成且回执 `PASS`；最终任务 `COMPLETED`、Stop `TASK_COMPLETE/PASS`、k=1，`draft.txt` 字节严格为 `READY_A\n`。整段在开始下一场景后达到 32 次请求上限而停止，整段状态保留 `FAIL`，不冒充一次串行全通过。只对剩余切换场景做独立补验，上限 20 次请求。

切换隔离也已分组通过。首个切换观察器只等待 `stop-reviewer`，未在 60 秒内越过因模型缺少 `summary` 而重试的需求刷新评审，因此如实保留失败。后续复用同一专用临时 Session，不重复初始提取，在旧 Stop 流程中的真实 `ground-truth-extractor` 请求仍活跃时切换到 B：请求 `15:11:46.714Z` 开始，`15:11:47.069Z` 切换，`15:11:47.863Z` 中止，旧 Stop 记录 `CANCELLED`。本次不声称 `stop-reviewer` 模型已经启动。

B 使用新 taskId，基线 v1、k=0；12 条要求全部来自新的 B 用户消息，旧 `GOOD_SWITCH` 仅作为排除事项，没有旧正向义务。旧文件保持 `BAD_SWITCH_RESUME\n`，B 文件为 `B_ONLY\n`，没有旧评审反馈进入 B。未配置项目实际写入 `OFF_ONLY\n`，没有 `.runtime-correction`；切回 B 恢复启用。同一业务 Session 的 A → B → off → B 及作用域激活日志已核对。B → off 期间一次迟到旧执行上下文被 `HOST_PROJECT_CONTEXT_CONFLICT` 拒绝，随后正确解析 off，符合隔离守卫行为。

本轮各阶段实际请求数为 **18 + 32 + 18 + 13 = 81**（包含失败、格式修复和基础设施重试）。最后补验新增 13 次，未触及 16 次上限；没有再重跑已通过的闭环。结果为**各验收项分组通过**，而非一次整段串行探针全部通过。三个独立临时状态目录共四次 Gateway 启动、四个新建测试 Session，最后一次仅复用专用测试 Session；所有隔离进程均结束，逐文件实际模型令牌扫描零残留。范围未覆盖桌面 UI，也未绕过宿主 no-op 写入限制。

完整脱敏记录、失败状态、运行 ID、模型计数、日志及构建哈希见 [结构化复验证据](matrixassistant-incomplete-turn-20261015.json)。

上一轮失败记录仍保留在 [原始验收记录](matrixassistant-session-live-20261015.json)，不覆盖失败历史。
