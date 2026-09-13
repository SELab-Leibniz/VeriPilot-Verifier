# Runtime Corrector 1.9.1-openclaw.3

这是 **OpenClaw 2026.7.1-2 专用插件**。原生执行器接管普通聊天的执行、验收和修正，复用原纠偏核心；不修改宿主源码或替换模块，不需要聊天专用命令。其他 OpenClaw 版本拒绝加载。实际验证范围见[验收记录](openclaw-acceptance.md)。

## 安装与启用

```sh
openclaw plugins install /absolute/path/runtime-corrector-openclaw-1.9.1-openclaw.3.tgz
# 已安装旧版时
openclaw plugins install --force /absolute/path/runtime-corrector-openclaw-1.9.1-openclaw.3.tgz
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
          "reviewerTimeoutMs": 180000,
          "hookTimeoutMs": 540000
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

## 关闭与回退

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
