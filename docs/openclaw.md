# Runtime Corrector for OpenClaw 2026.7.1-2

这是 OpenClaw **2026.7.1-2 专用原生插件**。插件直接使用 OpenClaw 的隔离评审会话，
不依赖 Claude Code 或 CodeAgent CLI。其他 OpenClaw 版本会在加载时被拒绝。

**功能尚非完全等价：目标宿主会拒绝执行过写入等副作用工具之后的最终自动续跑。**
写后纠偏、独立评审和验收记账可用；完成门仍请求 `revise`，但此时宿主会放行最终回复。
需要严格保留原插件强制 Stop 行为的使用场景，不能把本适配当作已满足要求。

## 构建与安装

在源码仓库执行：

```sh
npm run build:plugin
openclaw plugins install ./dist/runtime-corrector-openclaw
```

已经拿到安装目录时，直接 `openclaw plugins install /absolute/path/to/runtime-corrector-openclaw`。
也可以在该目录执行 `npm pack`，把生成的 `.tgz` 交给 `openclaw plugins install`。

在 OpenClaw 配置的 `plugins.entries` 中启用插件并允许完成验收读取对话：

```json
{
  "plugins": {
    "entries": {
      "runtime-corrector": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true, "allowPromptInjection": true },
        "config": {
          "reviewerTimeoutMs": 180000,
          "hookTimeoutMs": 540000
        }
      }
    }
  }
}
```

如果配置了 `plugins.allow`，其中也必须包含 `runtime-corrector`。以上是合并示例，
不要用它覆盖现有模型、频道等配置。重启 Gateway 后验证：

```sh
openclaw gateway restart
openclaw plugins inspect runtime-corrector --runtime --json
```

在对话中要求使用 `runtime_corrector` 的 `help` 命令查看状态。
手动 CLI 仍可使用：`node /path/to/plugin/scripts/cli.mjs help --cwd /path/to/project`。

## 工作方式

| 当前动作 | OpenClaw 接入点 | 纠偏动作 |
| --- | --- | --- |
| 会话启动 | `session_start` | 恢复本地记账状态 |
| 用户提交新回合 | `before_prompt_build` | 记录真实用户要求；系统重试不重置基线 |
| 执行工具前 | `before_tool_call` | 首次相关动作前冻结任务基线；读取已发现 Skill 时建立监督契约 |
| 执行工具后 | 原生 tool-result middleware | 检查 `write`、`edit`、多文件 `apply_patch`，把反馈交回模型 |
| 自然完成前 | `before_agent_finalize` | 验收并请求 `revise`；宿主的副作用保护可能拒绝续跑 |
| 上下文压缩／会话结束 | `before_compaction`／`session_end` | 记录游标及结束事件 |

任务基线、诊断、预算和审计账本继续使用项目内 `.runtime-correction/`；
可编辑规则仍放在 `.runtime-corrector/`。候选补丁不会自动应用。
`shadowMode: true` 保留评审记录，但不注入反馈、不拦截完成。

## 评审模型

默认使用当前 OpenClaw 模型。可在插件 `config.reviewerModel` 中指定已配置的
`provider/model`。密钥由 OpenClaw 的 provider 配置或环境管理，不能写进插件代码。

本次联调使用 `ark-code-latest`，provider 的 `api` 为 `anthropic-messages`，
`baseUrl` 为 `https://ark.cn-beijing.volces.com/api/coding`，并启用 `authHeader: true`。
在 OpenClaw 中显式配置 provider 和模型，再将 `reviewerModel` 指向该 `provider/model`；
不要假定设置三个 `ANTHROPIC_*` 环境变量就会自动完成 OpenClaw 的模型注册。
较慢模型可提高 `reviewerTimeoutMs`，但项目内每个 reviewer 的 `timeoutMs`、
一次 Hook 的总预算及主 agent 的整体超时仍同时生效。

评审只开放 `read` 工具，使用单独的会话、请求目录和执行队列；它不会分叉或继续主任务。
原配置的 `session: fork` 在此版本中表示携带冻结证据的独立会话，并写入适配记录。
同一评审的后续提问和 JSON 修复保留它自己的会话及绝对截止时间。
评审执行具有独立的异步身份，禁止再创建评审或递归追问自己；身份在插件重载和
超时后的派生回调中仍有效，不会关闭其他主任务的正常检查。JSON 格式修复最多一次。
后续任务级自动续跑必须由唯一控制器安排，修正后的正常复验继续保留；
具体约束及尚未实现的部分见 [受控任务与防递归设计](openclaw-supervised-tasks.md)。

项目级 `session: independent` 仍支持 Anthropic Messages 兼容接口：
`provider.baseUrl`、`provider.model`、`provider.apiKeyEnv` 必须完整。
provider 配置只用于该次评审，不修改 Gateway 全局配置，也不继承其他端点的认证头。
原来的 `reviewerRuntime.executable` 和每次评审 `maxBudgetUsd` 不适用于原生后端，
显式配置时会报错；请使用模型选择、时间限制和纠偏次数预算。

## 兼容边界

- 需要 Node 22.22.3、24.15.0、25.9.0 或各自受支持的更高版本，以目标 OpenClaw 的 engines 为准。
- OpenClaw 完成重试最多 3 轮；插件额外预算不能突破宿主上限。用户主动取消不会被插件续跑。
- 原版宿主在本轮出现潜在副作用（包括文件写入）后，会记录 `requested revision after potential side effects; finalizing` 并拒绝完成续跑。本次真实注入错误测试确认了这个限制，不能通过插件配置消除。
- 最后一次宿主重试可能跳过完成 Hook，账本会保留尚未验证的状态；有精确 runId 的频道最终回复会附上未通过提示。CLI 本地输出、流式中间块和缺少 runId 的投递不能保证附加提示，应以插件账本为准。
- Hook 超时配置最高 600000 ms；全流程评审共用该次 Hook 的剩余时间。宿主超时会放行原结果，不能视为验收通过。
- 评审通过 OpenClaw 内置模型运行时执行。工具结果接口声明支持 `openclaw`、`codex`，其他运行时需单独验证。
- 面向本机工作区。手动管理工具在容器沙箱会话中不注册，避免绕过宿主文件权限；远程／容器文件路径需要额外适配。
- Skill 监督基于读取已发现的 `SKILL.md`；没有显式读取、只注入提示词的 Skill 无法获得独立调用边界。
- `exec` 内部的任意文件变更在完成验收时检查；即时逐文件检查覆盖显式写入、编辑和 `apply_patch`。
- 此安装包不执行 Claude `hooks/hooks.json`，不包含 Claude／CodeAgent 插件声明。

## 改动范围

这是中等规模的宿主适配：新增原生事件层、消息与工具格式转换、隔离评审执行器和安装声明。
规则引擎、工作流边评审、M01–M15、需求权威判定、基线冻结、偏差归因、预算及候选补丁校验继续调用原实现。
核心仅增加评审会话交接的后端扩展点，并将默认配置的模块初始化改为同步读取，以兼容 OpenClaw 的插件加载器。
证据去重从原 Hook 脚本提取为共用函数，算法和计数上限保持一致。

## 验证

源码仓库中运行 `npm test`、`npm run build:plugins`。
OpenClaw 专项测试覆盖原生加载声明、事件归一化、会话隔离、只读评审、结构化输出修复、
工具反馈与终止预算。真实安装和模型联调结果见 [验收记录](openclaw-acceptance.md)。
