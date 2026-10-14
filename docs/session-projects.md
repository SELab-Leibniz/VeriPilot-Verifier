# OpenClaw Session 项目作用域

候选分支：`codex/session-project-scope`。候选插件：`1.9.1-openclaw.11-session-projects.1`。所有改动位于 RC；不修改、替换或升级已有 OpenClaw 安装。

## 使用

旧版 OpenClaw `2026.7.1-2`：用户在当前会话中执行 `/rc-project bind /绝对业务项目目录`。可直接包含路径中的空格，不加引号。`/rc-project status` 查询，`/rc-project unbind` 解除；再次 bind 修改绑定。身份必须经宿主认证，查询需 `operator.read`，修改需 `operator.write` 或 `operator.admin`；无 Gateway scope 的渠道必须提供可信 owner 身份。沙箱及文件系统限制优先，无法验证权限时拒绝绑定。

RC 绑定只选择纠偏项目，**不改变宿主工作目录**。业务工具相对路径仍由 OpenClaw 决定；RC 不把工具的相对路径改解释为绑定目录。旧版业务在另一目录工作时应由用户/宿主使用正确的工具路径，RC 只评审绑定项目内实际观察到的文件。

新版 OpenClaw `2026.10.3`：通过 New Session 选择项目、文件夹或 Worktree。RC 自动跟随宿主，`/rc-project status` 显示 `source: host`；bind、再次 bind、unbind 全部拒绝。旧绑定不参与原生目录解析。也可用 `runtime_corrector` 的 `{"command":"project"}` 查询；模型工具没有项目绑定写入入口。

项目须已有有效 `.runtime-corrector/config.yaml`。既有版本 1/2 配置就是显式启用，不新增配置格式或根级开关；插件级 `enabled: false` 仍优先。没有配置、配置非法、目录失效、Session 身份冲突或能力未核验时不创建基线、不启动 Reviewer、不自动建立项目运行目录。显式 `init` 仅在已经可靠解析的项目中按用户请求执行。

手动 check 使用相同的 Session 项目解析与宿主原生 Reviewer。静态检查与原有语义评审逻辑沿用核心；手动检查不声称完成整个业务任务。

## 宿主契约

`lib/openclaw/project-compat.mjs` 集中维护经过核验的版本和目录规则。`2026.7.1-2` 进入旧版模式；`2026.10.3` 进入原生模式；其他版本的插件入口拒绝加载，需要先验证其契约。不通过一个字段是否存在来判定宿主能力。

原生目录来自公开 `runtime.agent.session.getSessionEntry` 的最新、精确 Session incarnation。已核验的 v2026.10.3 执行入口先使用 spawnedBy Session 的 spawnedWorkspaceDir，否则使用 spawnedCwd。Worktree 使用宿主准备完成后保存的执行目录，绝不使用 worktree.repoRoot。有效运行上下文与持久化目录不一致时停用；没有可核验目录时不回退 Agent 默认工作区。远端执行、云仓库和尚未准备完成的项目保守停用，本次不实现远端文件系统桥接。

核验依据为正式 v2026.10.3 发布包，以及对应发布源码：[Session 创建](https://github.com/openclaw/openclaw/blob/v2026.10.3/src/gateway/server-methods/sessions-create.ts)、[运行目录解析](https://github.com/openclaw/openclaw/blob/v2026.10.3/src/agents/spawned-context.ts)、[公开 Session SDK](https://github.com/openclaw/openclaw/blob/v2026.10.3/src/plugin-sdk/session-store-runtime.ts)。新版 transcript 使用公开 SQLite transcript reader；旧版保持公开 Session 文件读取。兼容模块不修改宿主导出或源码。

新版宿主还要求 Reviewer 使用已登记的 SQLite 会话标识。`compat-2026.10.3.mjs` 只为 RC 随机生成的私有 Reviewer 身份登记 Session，传入公开 SDK 生成的 marker 和精确 sessionTarget，格式修复复用同一身份；角色关闭后按 expectedSessionId 清理。业务会话和业务执行器不参与该适配，原 Reviewer 提示、格式修复、超时及预算保持原逻辑。

宿主 API 兼容声明使用比较区间 `>=2026.7.1 <=2026.10.3`：两版宿主的 pluginApi 解析器不接受 `||`。实际加载入口仍严格限制两个已验证版本；npm peerDependencies 的 `||` 独立生效。

## 隔离和切换

绑定和作用域身份存放在宿主 `resolveStateDir()` 返回的状态目录下：`plugins/runtime-corrector/session-projects/<identity-hash>/`。identity 包含 agentId、sessionKey 和 sessionId；恢复相同会话可继续使用，reset/new 产生新 incarnation 不继承旧绑定。写入用私有文件、原子替换和独占锁；忙锁拒绝变更，不抢占写入者。

每次项目作用域有独立 taskId；同项目不同 Session 也不共用 Reviewer 状态、需求基线或预算。回到此前项目建立新的作用域；项目切换边界限制新作用域读取的用户依据。宿主状态目录持久化作用域身份，所以插件/Gateway 重载后仍可恢复。

任务记录在对应项目 `.runtime-correction/tasks/`，Session transcript 在 `.runtime-correction/openclaw/` 的独立作用域下，产物 rounds/latest 在 `<output.directory 或 .runtime-correction>/openclaw/session-artifacts/<scope-id>/`。产物配置始终从 Session 绑定的准确项目加载，不通过祖先/子目录的其他配置重新选项目。失败计数按 Session 作用域隔离，原次数与释放逻辑不变。

切换时取消旧 RC Reviewer 信号和待派发反馈，旧任务记录留在旧项目。返回结果及续作派发前再次核验作用域；迟到工具结果同时核验调用绑定的作用域，即使宿主提供了 Session 身份，也不能重新接入新项目。RC 不取消或接管宿主已接受的业务执行；宿主自身运行切换、取消和权限仍由 OpenClaw 管理。

## 验证

项目测试覆盖旧版独立绑定/恢复、相同项目两 Session 状态、无配置无产物、认证/沙箱/目录权限、升级原生优先、无目录及冲突拒绝、Worktree 实际目录、切换取消、迟到结果、并发首次 Hook、手动查询/检查。

真实 Gateway 的本地接口探针已分别验证 `2026.7.1-2` 与 `2026.10.3`，包括原生 A/B 项目、未配置项目、手动绑定禁用，以及真实 Git Worktree 的准备和准确目录。该探针没有调用模型，也没有让业务模型写文件；不能算完整模型纠偏闭环。

重复本地接口验证：设置 `RC_PROJECT_CONTRACT_ONLY=1`，运行 `scripts/diagnostics/openclaw-session-projects.mjs`，传入宿主包目录、测试 provider 描述 JSON、新建输出目录和空闲端口。所有宿主状态、配置、项目和网关均隔离；SDK 导入前也设置隔离环境。

真实模型测试使用相同脚本，去掉上述开关并设置 `RC_TEST_MODEL_KEY`。这会将临时测试会话及项目内容发送至测试 provider。本轮经用户授权使用 GLM-5.3-Flash。前两次凭据分别遭遇配额耗尽与无余额；更换可用凭据后，旧版和新版均已完成真实会话、write/read 文件操作、需求基线和 Reviewer 记录隔离验证。新版 Worktree 文件只写入实际工作树，原仓库未出现该业务文件；两版未启用项目均无 `.runtime-correction` 或 Reviewer 记录。独立新进程通过公开 Session SDK 确认绑定和 taskId 可恢复，任务 Session 身份不混用。

全量回归：798 项，796 通过，0 失败，2 项既有 Windows 专用测试在 macOS 跳过。脱敏验收和失败历史见 [证据](experiments/session-projects-20261014.json)。最终真实模型探针要求启用项目具有有效基线才计通过；初轮新版虽然完成写文件，但 SQLite Reviewer 身份不兼容，未作为最终验收通过。

本次真实探针关闭 Stop 和实现终审，验证最小纵向的项目目录、实际文件、基线、Reviewer 与跨 Session 隔离；完整 Stop 重修闭环没有在新版重新实测。现有 Stop 预算和复验行为由回归测试守护。项目切换及迟到反馈的并发测试通过，但没有把单元测试声称为宿主 UI 切换的真实模型实测。

2026-10-14 后续扩展实测已开启真实 Stop：旧版完成实际修复与最终 PASS，但首轮 checkpoint 不一致；新版 Worktree 的交付后 Stop 被宿主 Gateway 生命周期保护拒绝，完整终审验收失败。两版实际重启恢复、旧版 Stop 中改绑、新版需求评审中公开取消后切换通过。新版 Stop 阶段切换仍未完成。完整结果和三个已复现缺陷见 [扩展实测报告](experiments/session-projects-extended-results.md)，不能将此前最小项目探针通过解释为新版全部纠偏能力已验证。
