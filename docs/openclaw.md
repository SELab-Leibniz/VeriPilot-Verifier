# Runtime Corrector 1.9.1-openclaw.10

`.10` 补充原生子任务兼容和临时模型过载的有限续跑。子任务沿用 OpenClaw 原生执行，不创建第二套纠偏任务；仅在宿主确认模型请求被临时拒绝、历史持久化且工具结果齐全时，使用同一工作会话等待 10/30 秒后最多续跑两次，不重置纠偏预算或总时限。最终仍须验收。详见[续跑修复记录](openclaw-acceptance-10.md)。

`.9` 修复原生 Hook 模式等待评审时，主会话收不到评审活动而被宿主误判卡死的问题。只转发属于当前评审的真实模型、工具活动；父运行结束或被恢复机制中止时取消评审。受控模式补充需求提取、基线核对、写文件和文档评审的阶段提示。预算耗尽的需求提取面板不再自动完整重跑；仍保留增量提取与最终验收。详见[本版修复记录](openclaw-acceptance-9.md)。

`.8` 修复受控会话无法进行原生上下文压缩的问题：显式将压缩交回宿主 context engine，保留宿主的历史、认证、取消及队列机制，不创建纠偏控制器、不调用评审。`.7` 缺少 `compact` 入口时，宿主在执行前即返回 `unsupported_harness_compaction`，可能表现为“Context is too large and auto-compaction could not recover”。既有 `.7` 验收记录仍只代表其当时的验证范围。

`.8` 已通过真实 GLM 手动压缩、超限自动压缩及压缩后续聊；详见[压缩验收记录](openclaw-acceptance-8.md)。

这是 **OpenClaw 2026.7.1-2 专用插件**。原生执行器接管普通聊天的执行、验收和修正，复用原纠偏核心；不修改宿主源码或替换模块，不需要聊天专用命令。其他 OpenClaw 版本拒绝加载。`.7` 增加独立状态页、终端控制、仅验收模式、核心提交保护和发送回执。保留 `.6` 的 GLM 修复。实际验证范围、未满足的原生入口能力和逐项证据见[本版验收记录](openclaw-acceptance-7.md)。

## 安装与启用

```sh
openclaw plugins install /absolute/path/runtime-corrector-openclaw-1.9.1-openclaw.10.tgz
# 已安装旧版时
openclaw plugins install --force /absolute/path/runtime-corrector-openclaw-1.9.1-openclaw.10.tgz
```

将以下内容合并到现有配置；ark 请替换成已配置的 provider。**插件开关与模型运行时都要设置**；默认开启的 supervisedExecution 不会自动改写模型配置。

```json
{
  "models": {
    "providers": {
      "ark": { "agentRuntime": { "id": "runtime-corrector-supervised" } }
    }
  },
  "plugins": {
    "entries": {
      "runtime-corrector": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true, "allowPromptInjection": true },
        "config": {
          "supervisedExecution": true,
          "reviewerTimeoutMs": 600000,
          "hookTimeoutMs": 600000
        }
      }
    }
  }
}
```

若配置了 plugins.allow，也要加入 runtime-corrector。重启并检查：

```sh
openclaw gateway restart
openclaw plugins inspect runtime-corrector --runtime --json
```

升级插件后需完整停止并重新启动 Gateway 进程。仅热重载配置或在原进程内发送 `SIGUSR1` 可能仍使用旧的 ESM 模块；新启动的 CLI 显示 `.8` 也不能证明旧 Gateway 已加载新代码。

在网页聊天或 `openclaw tui` 正常提交任务。普通问答沿用原核心的任务触发规则，没有额外模型分类器。项目规则在 `.runtime-corrector/`；可通过 runtime_corrector 管理工具初始化，或使用安装目录下的 scripts/cli.mjs。

## 工作过程

1. 内部原生工作会话继承有效聊天上下文、模型、工具限制、工作目录和沙箱策略。
2. 原工具前后检查继续生效。工作会话结束后，控制器调用原完成评审一次。
3. 有偏差且原预算允许时，串行修正，再验收；没有后台定时续跑。
4. 只有核心确认 TASK_COMPLETE、报告 PASS、任务完成且证据未变、未取消时，交付最终结果。

执行进度可见，未通过的候选完成回复不进入父聊天最终历史。父历史保留真实用户输入、必要工具证据与最终结果；自动纠偏提示和评审提示保存在内部记录。等待用户、预算耗尽和未验证均明确说明，不能视为成功。

执行中补充要求：等到出现执行进度后，终端直接发送第二条消息；网页可能先显示 Queued，点击该消息的 **Steer** 可投递给当前执行。普通排队表示等待下一回合。插件分别记录接收、基线提交和工作会话投递确认；未确认的变更不能被视为执行器已采纳，也不能沿用旧完成资格。自动反馈不更新需求权威，不重置预算。网页 Stop、终端 Escape 或原生 `/stop`、会话重置、插件关闭均取消当前执行和评审。此版 TUI 的 Ctrl+C 用于退出提示，不等同于取消。

## 状态页与独立终端控制（.7）

正常任务仍在原生聊天提交。工作进行期间，打开同一个 Gateway 的 `/plugins/runtime-corrector/`，例如 `http://127.0.0.1:18789/plugins/runtime-corrector/`。填写聊天网址中 `session` 参数解码后的会话键（如 `agent:main:main`），使用现有 Gateway 凭据或已有设备认证连接。页面沿用固定版本原生浏览器客户端的认证和配对，不包含任务数据或预置凭据。

页面每两秒读取状态，等待秒数在本地显示；计时不会续期任务或伪造进展。逐文件区分别显示问题、反馈已送达、发生修改、复验确认解决。展开记录可核对工具调用编号、评审及文件快照。没有可靠旧证据时显示未验证，不补造通过。

原生聊天还可输入 `/runtime-corrector status`、`/runtime-corrector feedback` 或 `/runtime-corrector help`。这些命令只读，不使用模型；该固定版本缺少独立聊天回复的可靠历史回执，忙碌队列仍可能延迟到达。

终端入口与页面共用认证 Gateway 方法：

```sh
openclaw runtime-corrector status --session agent:main:main
openclaw runtime-corrector feedback --session agent:main:main
openclaw runtime-corrector stop --session agent:main:main --command-id stop-001
openclaw runtime-corrector update-requirements --session agent:main:main --command-id req-001 --text '最终文件必须保留重启后的数据'
openclaw runtime-corrector reverify --session agent:main:main --command-id verify-001
openclaw runtime-corrector continue-correction --session agent:main:main --command-id fix-001
openclaw runtime-corrector receipt --session agent:main:main --command-id verify-001
```

加 `--json` 查看完整结构化记录；`--action-id` 默认为 `main`，同一原消息的子动作使用不同 actionId。客户端未指定 commandId 时生成并在当前 OpenClaw 状态目录的 `runtime-corrector/cli-commands/` 保存编号。响应丢失后先查回执；同一身份、commandId/actionId 的重复请求复用原记录，同键不同内容返回冲突。浏览器和 CLI 可能具有不同设备身份，指令回执应使用原客户端身份查询。

- 状态／反馈查询不调用模型，不创建任务，不更改需求版本或预算。任务须先经原生聊天建立可信会话绑定；客户端不能指定工作目录。
- 要求变更区分 RECEIVED、BASELINE_COMMITTED、APPLIED_TO_WORKER；无活动 worker 时明确返回 NO_ACTIVE_WORKER。接收后旧完成证据立即失效。队列确认不等于模型已采纳。
- 停止保留文件与记录。运行句柄仍未退出时显示 STOPPING／STOP_REQUESTED_UNCONFIRMED，不能当作全部调用已经退出。
- 仅重验使用新、有限的评审时间窗，不继承旧任务过期时限或取消信号；一次指令只授权一次核心验收，不扣内容修正次数。reviewer 的一次格式修复仍共用该时间窗。活动执行尚未结束时需先停止或等待，避免并行验收。
- 仅重验发现当前阻断偏差后，才可授权继续修正。派发意图与预算同事务提交，一次授权只扣一次；基础设施故障不能变成修正授权。文件或需求又变了，需先重验。
- 最终发送有 READY、SEND_COMMITTED、ACKED／UNKNOWN 四种状态。UNKNOWN 不自动重发；可用 `receipt --delivery-id <状态中的 delivery.id>` 核对原生历史。ACKED 只证明宿主历史持久化，不能证明用户已阅读。发送提交之后才取消，不承诺消息绝不会到达。

页面与 CLI 的回复独立于活动聊天回复，不镜像为用户消息，不再送入 reviewer。原生网页普通发送／Queue 和 TUI 忙碌输入受到 `2026.7.1-2` 的入口能力限制；不能保证立即答复状态，也不能以独立入口通过替代它们通过。Steer 仅在宿主确实提供可信 recorder 与确认投递时更新真实要求；纯查询指向独立入口。会话重置后必须重新建立绑定。

故障注入的任务验收、已检测故障覆盖、完整纠偏闭环、逐文件质量分别展示。核心确认注入步骤执行完毕，不表示保留的坏 design/tasks 已合格；旧记录缺乏逐文件评审证据时仍标为未验证。

## 模型与凭据

默认评审使用当前模型；config.reviewerModel 可指定已配置的 provider/model。本次联调使用 Ark coding 接口：api 为 anthropic-messages，baseUrl 为 https://ark.cn-beijing.volces.com/api/coding，authHeader 为 true，模型为 ark-code-latest。凭据由 OpenClaw provider 的环境引用管理，例如 `"apiKey": "${ANTHROPIC_AUTH_TOKEN}"`。仅设置环境变量不能替代 provider/model 注册。凭据不进入插件源码、安装包或报告。

评审只开放 read，有独立身份、会话和截止时间，不能创建其他评审或控制器。JSON 修复最多一次。session: fork 在此后端表示携带冻结证据的独立原生评审；正常后续提问保留其会话与截止时间。显式 independent provider 保留原配置规则。原生后端不接受 reviewerRuntime.executable 和每次评审 maxBudgetUsd。

主运行总超时、Hook 超时和各评审超时同时生效。检查器故障沿用独立有限重试，不消耗实际纠偏次数；两次重试后仍失败则停止为 UNVERIFIED。

## 评审配置与排错

OpenClaw 使用原生评审会话，不设置 `reviewerRuntime`。如果项目从 Claude/CodeAgent 迁移，删除整个 `reviewerRuntime` 段（包含 `executable` 和 `argsPrefix`），不能留下空对象。`.4` 会在项目配置校验及受控工作启动前报告冲突，避免先执行工具再发现评审无法启动。

在 `openclaw.json` 的 `plugins.entries.runtime-corrector.config.reviewerModel` 指定注册过的 `provider/model`。项目 `reviewers.defaults.model` 或各角色的 `model` 可以覆盖该默认值；独立 provider 配置保持原有语义。执行与评审可以使用不同 provider、凭据及模型。

如果执行模型已经注册为 `ark-work/ark-code-latest`，可直接让 reviewer 使用这个已注册模型（仍是独立只读评审会话）：

```sh
openclaw config set plugins.entries.runtime-corrector.config.reviewerModel ark-work/ark-code-latest
```

若要不同 provider，在 `models.providers` 中注册其 API 地址、凭据引用和模型，然后将上述值换成对应的 `provider/model`。无需设置 executable。

单个评审的有效时限取项目角色 `timeoutMs`（未设置时继承 `limits.semanticReviewTimeoutMs`）、插件 `reviewerTimeoutMs`、当前 Hook 剩余时限和父运行剩余时限中的最小值。因此只把项目 `limits.semanticReviewTimeoutMs` 增加到 900000，并不能突破插件 180000 的配置上限。需要长评审时，可在 OpenClaw 配置中设置：

```sh
openclaw config set plugins.entries.runtime-corrector.config.reviewerTimeoutMs 600000
openclaw config set plugins.entries.runtime-corrector.config.hookTimeoutMs 600000
```

改后重启 Gateway；前台 `gateway run` 需停止后重新启动。600000 毫秒仍是有限上限，不改变偏差纠正次数和基础设施重试次数。不同角色交接使用各自时限，但共同受当前 Hook/父运行截止时间限制；同一角色 JSON 修复和后续追问不续期。

`.4` 超时/取消时会先等待原生评审退出，再清理其会话文件；迟到回调仍保留内部身份。父聊天分别上报最近模型调用的上下文用量与累计任务用量，避免把累计用量当成当前上下文。

长评审的实际模型/工具进展同时上报给父会话和正在等待工具 Hook 的工作会话，避免后者被宿主误判卡住。没有定时伪造进度；真正无进展仍受原生恢复和超时限制。私有工作/评审配置中的默认会话锁时限按当前运行时限加 5 秒设置（至少 5 分钟），全局配置与显式 `session.writeLock.maxHoldMs` 不变。宿主主动中止工作会话时，控制器也会取消尚未退出的工具评审，并保留未验证状态。

模型配置会影响时限是否足够。2026-09-14 的真实测试中，GLM-5.3 在上述 Anthropic 接口上曾仅思考就耗尽 8192/16384 输出预算；同一 Stop 评审也有返回有效 JSON 的样本，但不能据此保证完整任务稳定。OpenClaw 的 `effort: low` 需要由实际 provider 协议正确映射，不能将 UI 标签或更大的 timeout 当作生效证据。不要通过关闭 Stop 或改成 shadowMode 来掩盖评审失败。可先选已验证的 `ark-code-latest`；若使用其他 reviewer 模型，请先验证完整 JSON、工具读取、时限和复验闭环。

## GLM-5.3 评审修复（.6）

`.6` 对模型 ID `glm-5.3` 的内部 reviewer，在系统提示中传达其官方模板使用的 `Reasoning Effort: Low/High/Max`。低档来自项目 reviewer 的 `effort: low`（未指定时默认 low）；medium 映射 High，high/max 保留对应档位。其他模型不添加此提示。这是经过合成实测的提示兼容处理，不是硬性思考 token 限额，也不等于火山接口保证支持 `reasoning_effort` 参数。

例如在项目现有 reviewers 中合并以下设置；不要覆盖其余规则或 provider 配置：

```yaml
reviewers:
  stopReviewer:
    effort: low
```

仍通过 `reviewerModel: review/glm-5.3` 或项目各角色的 `model` 选模型。无需改 URL、密钥或 executable，不要求把执行模型换成 GLM。不自动提高输出额度、超时或纠偏预算。独立接口复现和隔离原生 SDK 测试命令见本版验收记录。

运行失败、无最终输出或输出被截断时，明确记录 `REVIEWER_RUNTIME_FAILED` 及失败代码；它们不再触发“JSON 格式修复”。真正的 JSON／schema 格式错误仍最多修复一次，共用原截止时间。原核心负责基础设施有限重试与 UNVERIFIED 停止，失败不计为实际偏差纠正，也不视为验收通过。

`.6` 的历史验证保留在 [acceptance-6](openclaw-acceptance-6.md)。本次仅在临时配置中安装与重启测试 Gateway，未替换用户安装。

## 总运行时限与未验证交付（.5）

`agents.defaults.timeoutSeconds` 是整个聊天任务的总时限，包含工作执行、需求基线、工具审阅和最终验收。它与 `reviewerTimeoutMs`（单个角色）和 `hookTimeoutMs`（单个 Hook）分别生效。将后两者设为 600000，不会改变原有 1800 秒（30 分钟）总时限。

`.5` 将内部 reviewer 和 worker 限制在父任务剩余时间内。总时限耗尽时取消内部工作、保留未验证状态，并向聊天交付明确说明；不会再把插件自身的计时器当成用户取消而抑制回复。真正的用户停止、会话重置和关闭插件仍取消交付。已结束工作会话的工具证据与最近模型调用的上下文用量也保留；未经验收的候选完成文字不进入最终历史。

如果需要为较慢的 reviewer 留出更多总时间，可由你调整为 3600 秒（60 分钟）：

```sh
openclaw config set agents.defaults.timeoutSeconds 3600
```

这是有限总时限，不增加纠偏次数或评审故障重试次数，也不保证模型一定返回合格评审。当前本机 reviewer 和 1800 秒总时限未被本次升级改写。前台 Gateway 重新启动后配置生效；后台服务用 `openclaw gateway restart`。超过总时限的旧任务仍未通过验收，升级不会将它改成成功。

回退 `.4` 可重新安装保留的 `.4.tgz` 后重载 Gateway；它不包含本节的总超时修复。

## 关闭与回退

回退基线为 `.6`。先停止活动任务并核对停止回执，再安装保留的旧包，重启 Gateway：

```sh
openclaw plugins install --force /absolute/path/runtime-corrector-openclaw-1.9.1-openclaw.6.tgz
openclaw gateway restart
```

保留 `.runtime-corrector/` 配置和 `.runtime-correction/` 运行记录。旧版不会提供本版状态页、独立控制及新事务保护；回退不是已暂停任务的自动续跑授权。不要在不确定旧运行是否退出时重新执行有副作用的操作。

仅关闭受控执行：将 plugins.entries.runtime-corrector.config.supervisedExecution 设为 false，重启 Gateway，执行器恢复原生 Hook 行为。运行时关闭该开关会取消当前受控任务。

退回 .2：先将 provider 的 agentRuntime.id 改为 openclaw（或移除该运行时覆盖），然后安装旧包：

```sh
openclaw plugins install --force /absolute/path/runtime-corrector-openclaw-1.9.1-openclaw.2.tgz
openclaw gateway restart
```

保留 `.runtime-correction/`，保留需求与预算历史。.2 和关闭受控执行后的 Hook 模式仍受宿主限制：发生写入等副作用后，OpenClaw 可能拒绝最终 revise，因此不具备受控闭环的完成保证。

## 范围与恢复

- Node 版本以目标宿主 engines 为准：22.22.3、24.15.0、25.9.0 或相应受支持的更高版本。
- 控制记录在 `.runtime-correction/openclaw/controllers/`，包含父会话、任务、需求版本、代次、轮次、原生运行编号和交付收据。
- 跨进程锁、原子写入与收据阻止重复派发。重启状态不明时返回未验证，请先核对成果再提交要求。
- 只读兼容模块锁定目标版本的排队确认和用户来源接口，契约不符明确报错，不修改宿主或静默降级。
- 面向本机工作区。有效沙箱模式与工具策略有契约测试；远程/容器路径和其他消息渠道不纳入同等保证。
- 证据包括显式读写路径与评审实际读取的本地文件，交付前校验内容。外部服务的并发状态不属于文件指纹保证。
- Skill 监督仍依赖显式读取已发现的 SKILL.md；即时文件检查覆盖 write/edit/apply_patch，exec 内修改由原完成验收检查。
- shadowMode 只观察，受控模式不会将观察结果当成完成认证。

源码检查：`npm test`、`npm run build:plugins`。实现约束见[控制与防递归](openclaw-supervised-tasks.md)。
