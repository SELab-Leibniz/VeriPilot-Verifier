# OpenClaw Session 项目作用域

支持 OpenClaw `2026.7.1-2` 与 `2026.10.3`。插件适配不修改、替换或升级宿主安装。

## 使用

OpenClaw `2026.7.1-2` / MatrixAssistant：每次已有生命周期回调或状态查询时，从公开 Session SDK 读取当前会话的最新记录。记录有非空 `spawnedCwd` 时自动跟随该项目，新建 Session 无需手动绑定；切换项目在下次回调或查询时生效，不增加轮询器。有宿主目录时禁止 RC 手动改绑，避免两套选择相互覆盖。路径非法、不存在、未获权限或配置无效时停用并记明原因，不偷偷回退旧项目。

`spawnedCwd` 缺失、null 或空串时保留手动模式：用户在当前会话中执行 `/rc-project bind /绝对业务项目目录`。可直接包含路径中的空格，不加引号。`/rc-project status` 查询，`/rc-project unbind` 解除；再次 bind 修改绑定。身份必须经宿主认证，查询需 `operator.read`，修改需 `operator.write` 或 `operator.admin`；无 Gateway scope 的渠道必须提供可信 owner 身份。沙箱及文件系统限制优先，无法验证权限时拒绝绑定。

RC 绑定只选择纠偏项目，**不改变宿主工作目录**。业务工具相对路径仍由 OpenClaw 决定；RC 不把工具的相对路径改解释为绑定目录。旧版业务在另一目录工作时应由用户/宿主使用正确的工具路径，RC 只评审绑定项目内实际观察到的文件。

新版 OpenClaw `2026.10.3`：通过 New Session 选择项目、文件夹或 Worktree。RC 自动跟随宿主，`/rc-project status` 显示 `source: host`；bind、再次 bind、unbind 全部拒绝。旧绑定不参与原生目录解析。也可用 `runtime_corrector` 的 `{"command":"project"}` 查询；模型工具没有项目绑定写入入口。

项目须已有有效 `.runtime-corrector/config.yaml`。既有版本 1/2 配置在省略新控制字段时仍按启用处理；根级 `enabled` 是项目总开关，`sessionDefaults.enabled` 设置首次登记会话的默认状态，各会话选择保存到 `.runtime-corrector/sessions.local.yaml`。宿主插件级 `enabled: false` 仍优先。没有配置、配置非法、目录失效、Session 身份冲突或能力未核验时不创建基线、不启动 Reviewer、不自动建立项目运行目录。显式 `init` 仅在已经可靠解析的项目中按用户请求执行。配置、`/rc-session` 命令和 UI 接口见 [项目与 Session 开关](session-control.md)。

手动 check 使用相同的 Session 项目解析与宿主原生 Reviewer。静态检查与原有语义评审逻辑沿用核心；手动检查不声称完成整个业务任务。

## 宿主契约

`lib/openclaw/project-compat.mjs` 集中维护经过核验的版本和目录规则。`2026.7.1-2` 仅对经过 Session 身份校验的持久化 `spawnedCwd` 做能力检测；不读取模型参数里的同名字段。这个检测只切换目录解析，Reviewer、转录读取、Hook 和 Stop 仍沿用 7.1 适配。`2026.10.3` 保持原生模式；其他版本仍拒绝加载，不因出现同名字段而放开。

MatrixAssistant 1.8.160 的 `register-gateway-method` 插件将项目选择写入 `spawnedCwd`，工具运行目录使用该字段；7.1 子会话也以此字段为准。7.1 Hook 若仍报告 Agent 默认工作区，RC 使用已核验的会话目录解析相对路径；其他项目路径冲突继续拒绝。宿主选择只决定纠偏项目；有效项目配置、项目总开关及当前 Session 的选择共同决定是否运行 RC。

原生目录来自公开 `runtime.agent.session.getSessionEntry` 的最新、精确 Session incarnation。已核验的 v2026.10.3 执行入口先使用 spawnedBy Session 的 spawnedWorkspaceDir，否则使用 spawnedCwd。Worktree 使用宿主准备完成后保存的执行目录，绝不使用 worktree.repoRoot。有效运行上下文与持久化目录不一致时停用；没有可核验目录时不回退 Agent 默认工作区。远端执行、云仓库和尚未准备完成的项目保守停用，本次不实现远端文件系统桥接。

核验依据为正式 v2026.10.3 发布包，以及对应发布源码：[Session 创建](https://github.com/openclaw/openclaw/blob/v2026.10.3/src/gateway/server-methods/sessions-create.ts)、[运行目录解析](https://github.com/openclaw/openclaw/blob/v2026.10.3/src/agents/spawned-context.ts)、[公开 Session SDK](https://github.com/openclaw/openclaw/blob/v2026.10.3/src/plugin-sdk/session-store-runtime.ts)。新版 transcript 使用公开 SQLite transcript reader；旧版保持公开 Session 文件读取。兼容模块不修改宿主导出或源码。

新版宿主还要求 Reviewer 使用已登记的 SQLite 会话标识。`compat-2026.10.3.mjs` 只为 RC 随机生成的私有 Reviewer 身份登记 Session，传入公开 SDK 生成的 marker 和精确 sessionTarget，格式修复复用同一身份；角色关闭后按 expectedSessionId 清理。业务会话和业务执行器不参与该适配，原 Reviewer 提示、格式修复、超时及预算保持原逻辑。

新版交付后的 Stop 通过公开 `registerService({apiVersion: 2})` 的服务生命周期调度器运行，再使用公开 Session work admission 核验会话。旧版保留已验证的 Hook 后后台路径。服务未启动或关闭时保留未验证结果，不回退到过期 RPC 根上下文。内部 Stop 每次返回本轮身份和结果；宿主 Hook 的异常隔离不会吞掉内部调度错误。评审结论先写入当前轮 checkpoint 再请求原生续作，新轮仍重置评审状态。恢复已观察反馈时补齐任务交付状态并去重观察日志，不重派发业务。

宿主 API 兼容声明使用比较区间 `>=2026.7.1 <=2026.10.3`：两版宿主的 pluginApi 解析器不接受 `||`。实际加载入口仍严格限制两个已验证版本；npm peerDependencies 的 `||` 独立生效。

## 隔离和切换

宿主日志中可搜索 `[runtime-corrector]`：`RC_PROJECT_RESOLVED` 仅在选择或启用状态变化时记录 Session 身份、宿主版本、host/rc 来源、前后项目路径、enabled 和 reason；`RC_PROJECT_SCOPE_ACTIVATED` 在作用域成功持久化后记录前后路径及独立 taskId。日志使用宿主已有 logger，未配置项目也能诊断停用原因；不另建日志系统。`/rc-project status` 或 `runtime_corrector` 的 project 命令可核对当前选择。

切至未启用项目后再切回，或从自动模式退回旧手动绑定时，建立新的作用域并隔离此前项目的用户依据；不把旧任务和流程状态接回新一轮；宿主级会话累计纠偏额度继续保留。

绑定和作用域身份存放在宿主 `resolveStateDir()` 返回的状态目录下：`plugins/runtime-corrector/session-projects/<identity-hash>/`。identity 包含 agentId、sessionKey 和 sessionId；恢复相同会话可继续使用，reset/new 产生新 incarnation 不继承旧绑定。写入用私有文件、原子替换和独占锁；忙锁拒绝变更，不抢占写入者。

每次项目作用域有独立 taskId；同项目不同 Session 不共用 Reviewer 状态、需求基线或会话预算。同一 Session 的累计业务纠偏额度跨作用域保留。回到此前项目建立新的作用域；项目切换边界限制新作用域读取的用户依据。宿主状态目录持久化作用域身份，所以插件/Gateway 重载后仍可恢复。

任务记录在对应项目 `.runtime-correction/tasks/`，Session transcript 在 `.runtime-correction/openclaw/` 的独立作用域下，产物 rounds/latest 在 `<output.directory 或 .runtime-correction>/openclaw/session-artifacts/<scope-id>/`。产物配置始终从 Session 绑定的准确项目加载，不通过祖先/子目录的其他配置重新选项目。失败计数按 Session 作用域隔离，原次数与释放逻辑不变。

切换时取消旧 RC Reviewer 信号和待派发反馈，旧任务记录留在旧项目。返回结果及续作派发前再次核验作用域；迟到工具结果同时核验调用绑定的作用域，即使宿主提供了 Session 身份，也不能重新接入新项目。RC 不取消或接管宿主已接受的业务执行；宿主自身运行切换、取消和权限仍由 OpenClaw 管理。

## 兼容与验证边界

项目解析、开关、切换取消、迟到结果围栏、回执与预算持久化由离线回归保护。宿主无配置时不调用模型；查询和恢复不得重放已完成业务。已交付后的 `chat.abort` 可能返回 false，不能据此声称取消了 RC 后台工作；Session reset 与精确所属运行取消分别遵守宿主协议。

OpenClaw 2026.10.3 的项目、SQLite reviewer 和服务生命周期适配，不等于新的自动业务启动协议已整体验收。真实模型缺陷检出、完整桌面长时运行及进程重启/GT 缓存恢复仍需独立验收；历史小样例成功不能外推为全部能力可靠。当前启动协议及限制见 [宿主指南](openclaw.md)。
