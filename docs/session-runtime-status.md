# Session 运行状态、即时自检与终止当前轮

这些接口供外部前端读取 RC 后台状态和调用控制能力。只修改 RC，不需要改动 MatrixAssistant 或其内置 OpenClaw。

## 状态文件

每个已运行 RC 的项目维护一个文件：

```text
<项目>/.runtime-correction/session-runtime-status.json
```

`schemaVersion` 为 `runtime-corrector.session-runtime.v1`。`sessions` 是以 Session 身份哈希为键的对象；每条记录都包含明文 `agentId`、`sessionKey`、`sessionId` 和 `projectRoot`，前端可按这些字段查找自己的记录。不同 Session 的并发更新使用项目锁和原子文件替换，读取方不会看到半个 JSON。文件未创建或没有目标记录表示尚未登记，不能据此声称纠偏已经结束。

主要字段：

- `roundId`：当前轮的精确标识。终止请求使用查询所得的值；旧轮次请求不会终止新轮次。
- `runId`、`taskId`、`scopeFingerprint`、`controlRevision`：所属宿主运行、任务和项目作用域。
- `phase`：`RUNNING`（观察业务执行）、`FINALIZING`、`COEXIST_WAIT`、`REVIEW_QUEUED`、`REVIEWING`、`WAIT_CORRECTION`、`CORRECTING`、`RELEASING`、`USER_DISPATCHING`、`IDLE`、`ENDED` 或 `CLOSED`。
- `stage`：有实际私有 Agent 活动时是其角色，如 `onboarding-extractor`、`ground-truth-extractor`、`stop-reviewer`；否则为当前调度阶段。`activities` 列出这一轮当前活动的评审调用。
- `status`：`IDLE`、`WAITING`、`RUNNING`、`STOPPING`、`ENDED`、`TERMINATED`、`INTERRUPTED` 或 `UNKNOWN`。
- `active`：本轮是否仍在等待、审查、修复或停止收尾；`running` 只表示正在执行 RC 检查或修复。单纯等待业务执行结束时，前者为 `true`，后者为 `false`。
- `ended`：本轮确认结束时为 `true`，仍在进行时为 `false`；未登记或无法确认时为 `null`。
- `canTerminate`：当前状态是否可以请求终止。正在提交下一条用户任务时不提供纠偏终止操作。
- `outcome`、`reasonCode`：当前轮的验收结果与原因；当前轮尚无结果时为 `null`，不会继承上一轮结果。运行结束和验收通过分别记录，超时、用户终止与异常中断保留 `UNVERIFIED`。
- `projectEnabled`、`sessionEnabled`、`effectiveEnabled`：开关状态，与运行状态分别记录。
- `pendingUserTasks`：遗留 RC 待办的计数。新版 RC 只保留旧记录供核对。
- `heartbeatAt`、`heartbeatExpiresAt`、`checkedAt`、`owner`：发布实例与状态新鲜度。活动状态每五秒更新心跳，二十秒未更新需要自检，不能一直当作真实“运行中”。有新阶段变化时会异步发布，不必等下个心跳。
- `startedAt`、`endedAt`、`lastEndedRound`、`history`：当前轮的时间和最近结束记录。历史最多保留二十轮，方便在新一轮启动后查看上一轮的终止结果。

前端可以直接读取该文件；需要判断新鲜度时，推荐调用下面的读取函数或查询脚本。它们会把过期或已退出的活动实例显示为 `UNKNOWN`，保留 `lastObservedStatus`，不把旧快照当作当前运行事实。PID 存在只说明进程存在，不证明插件或模型仍在工作。

## 三个脚本

脚本位于安装包的 `scripts/` 下，输出一条 JSON：成功为 `{ "ok": true, "result": ... }`，失败为 `{ "ok": false, "error": ... }`。

```powershell
# 只读查询，不连接 Gateway
node "<RC插件>/scripts/rc-status.mjs" --project-root "<项目绝对路径>" --session-key "agent:main:<会话键>" --session-id "<宿主Session实例ID>"

# 即时核对并刷新文件
node "<RC插件>/scripts/rc-refresh.mjs" --project-root "<项目绝对路径>" --session-key "agent:main:<会话键>" --session-id "<宿主Session实例ID>" --openclaw-root "<MA目录>/resources/openclaw"

# 终止查询所得的当前轮
node "<RC插件>/scripts/rc-terminate.mjs" --project-root "<项目绝对路径>" --session-key "agent:main:<会话键>" --session-id "<宿主Session实例ID>" --round-id "<查询所得roundId>" --openclaw-root "<MA目录>/resources/openclaw"
```

`sessionKey` 和 `sessionId` 必须来自宿主同一个当前 Session，不能只传显示标题。`agentId` 默认由 `sessionKey` 解析，也可通过 `--agent-id` 显式指定并校验一致性。

即时自检和终止通过安装宿主的公开 Gateway CLI 调用后台 RC。宿主位置可由 `--openclaw-root`、环境变量 `RC_OPENCLAW_HOST_ROOT` 或可解析的 `openclaw` 包提供。宿主认证沿用调用进程的既有 OpenClaw 配置和环境；不同配置文件或状态目录可显式传 `--config <openclaw.json>`、`--state-dir <目录>`。这些路径不会从项目状态文件中执行或加载，状态文件不能决定脚本要启动什么程序。

`--timeout-ms` 为 100–60000，默认 30000。退出码 `0` 表示命令完成，`1` 表示调用错误，`2` 表示状态未知、在线自检未确认，或终止仍在等待实际收尾；必须继续检查 JSON 中的 `ended`，不能只根据退出码推断验收通过。

不传 `--round-id` 时，终止脚本会先读取当前快照并绑定其中的轮次；遇到冲突或丢失回执不会自动换轮次重试。前端按钮应始终显式传入最近查询所得的轮次。

## 可导入函数

```javascript
import {
  readSessionRuntimeStatus,
  refreshSessionRuntimeStatus,
  terminateSessionCorrection,
  sessionRuntimeStatusPath,
} from "<RC插件>/lib/openclaw/session-runtime-client.mjs";

const target = { projectRoot, agentId, sessionKey, sessionId };
const snapshot = await readSessionRuntimeStatus(target);
const checked = await refreshSessionRuntimeStatus(target, { openclawRoot });
const stopped = await terminateSessionCorrection(
  { ...target, roundId: checked.roundId }, { openclawRoot },
);
```

`refreshSessionRuntimeStatus` 确认原发布进程已退出时，直接将对应旧快照落盘为 `INTERRUPTED`，不等待 Gateway 连接超时；原记录已被新实例更新时保留新记录。其余情况向当前 RC 实例查询实际内存状态，并在需要时触发已有宿主终态核对。在线调用不可用且进程仍存在、状态过期时记录 `UNKNOWN`。进程退出也可能来自崩溃或强杀，这是一种结束，不能写成 PASS。状态未知时保留待核对信息，不冒充终止成功。

`terminateSessionCorrection` 始终向后台发送携带轮次的请求，不以本地文件中的“已结束”替代在线核对；终止请求不会自动重投。返回结构包含 `target`（本次终止的轮次）和 `current`（返回时最新状态）。后续用户任务可能已经启动，因此两者的 `roundId` 可以不同。

## Gateway 与后台函数

- `runtime-corrector.runtime.get`：读取当前 Session 快照，需要 `operator.read`。
- `runtime-corrector.runtime.details`：按当前 `roundId` 读取可核对的终审、简报交付记录和修复输入，需要 `operator.read`。
- `runtime-corrector.runtime.refresh`：即时自检并刷新，需要 `operator.write`。
- `runtime-corrector.runtime.terminate`：终止指定当前轮，需要 `operator.write`。

四个方法都接受 `projectRoot`、`sessionKey`、`sessionId` 和可选 `agentId`。明细和终止都需要传入查询结果中的 `roundId`，明细也接受尚无轮次时的 `null`。后台核对宿主当前的会话实例和项目。嵌入宿主的 RC 代码可通过 `runtime.sessionRuntime.get/refresh/terminate` 读取和控制会话。

访问 `/plugins/runtime-corrector/` 并选择宿主会话，即可查看 MA 输入框状态栏预览。终审和修复输入来自同一会话对应轮次的已有记录。无法核对实际正文时显示「不可用」。页面唯一的纠偏操作是「停止本轮纠偏」。

状态查询的 `inputMode` 描述同一宿主会话的新消息准入。`HOST_DEFAULT` 沿用 MA 规则，`WAIT` 表示 RC 当前轮持有续跑机会。状态栏使用 `display.line`。MA 在提交时由宿主再次核对，并在返回等待时保留草稿。

## 终止的准确范围

终止停止当前轮的后台检查、需求框架、审查及 RC 所属的自动修复和复验，并阻止迟到回调重新启动这一轮。不会修改项目或 Session 开关，不结束 MA/Gateway，不停止其他 Session，也不会回滚已经发生的业务文件修改。

当前轮确认停止后，MA 恢复按宿主规则接收新消息，用户可以发送保留的草稿。若 RC 自动修复仍在执行，后台先取消该修复运行并核对宿主终态，期间保持 `STOPPING`。普通业务运行继续遵循 MA 的准入规则。

重复终止同一已结束轮次返回 `alreadyEnded`；同一仍在收尾的轮次返回既有结果。过期按钮指向的轮次不再可核实时返回冲突，不能终止最新轮次。现有 autopilot 互斥与未知宿主终态规则继续生效。
