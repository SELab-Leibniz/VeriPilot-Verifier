# Runtime Corrector 1.9.1-openclaw.6

这是 **OpenClaw 2026.7.1-2 专用插件**。原生执行器接管普通聊天的执行、验收和修正，复用原纠偏核心；不修改宿主源码或替换模块，不需要聊天专用命令。其他 OpenClaw 版本拒绝加载。`.6` 修复 GLM 最终评审链路，验证范围为独立接口和隔离原生 reviewer，见[本版验收记录](openclaw-acceptance-6.md)。本版尚未在真实网页／终端聊天重新验收完整任务。

## 安装与启用

```sh
openclaw plugins install /absolute/path/runtime-corrector-openclaw-1.9.1-openclaw.6.tgz
# 已安装旧版时
openclaw plugins install --force /absolute/path/runtime-corrector-openclaw-1.9.1-openclaw.6.tgz
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

在网页聊天或 `openclaw tui` 正常提交任务。普通问答沿用原核心的任务触发规则，没有额外模型分类器。项目规则在 `.runtime-corrector/`；可通过 runtime_corrector 管理工具初始化，或使用安装目录下的 scripts/cli.mjs。

## 工作过程

1. 内部原生工作会话继承有效聊天上下文、模型、工具限制、工作目录和沙箱策略。
2. 原工具前后检查继续生效。工作会话结束后，控制器调用原完成评审一次。
3. 有偏差且原预算允许时，串行修正，再验收；没有后台定时续跑。
4. 只有核心确认 TASK_COMPLETE、报告 PASS、任务完成且证据未变、未取消时，交付最终结果。

执行进度可见，未通过的候选完成回复不进入父聊天最终历史。父历史保留真实用户输入、必要工具证据与最终结果；自动纠偏提示和评审提示保存在内部记录。等待用户、预算耗尽和未验证均明确说明，不能视为成功。

执行中补充要求：等到出现执行进度后，终端直接发送第二条消息；网页可能先显示 Queued，点击该消息的 **Steer** 可投递给当前执行。普通排队表示等待下一回合。插件必须收到宿主的写入确认才记为已接收；投递失败停止续跑。自动反馈不更新需求权威，不重置预算。网页 Stop、终端 Escape 或原生 `/stop`、会话重置、插件关闭均取消当前执行和评审。此版 TUI 的 Ctrl+C 用于退出提示，不等同于取消。

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

本次按阶段要求只生成安装包，没有替换当前插件或重启 Gateway。若以后安装 `.6` 后需要回退，重新安装保留的 `runtime-corrector-openclaw-1.9.1-openclaw.5.tgz` 并重载 Gateway；无需删除 `.runtime-corrector/`。

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

退回 `.3` 可直接重新安装保留的旧包后重启，配置结构兼容；旧版不包含上述长评审和上下文修复：

```sh
openclaw plugins install --force /absolute/path/runtime-corrector-openclaw-1.9.1-openclaw.3.tgz
openclaw gateway restart
```

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
