# Runtime Corrector（运行时纠偏器）

[English](README.en.md) · [文档导航](docs/README.md)

在宿主 Agent 工作时检查产物、需求基线和完成证据，将有依据的偏差交回主 Agent 修复。插件保留 Claude Code、CodeAgent 和 OpenClaw 三种宿主；默认构建面向 MatrixAssistant 的 OpenClaw 产物。

插件不直接修改业务文件。版本 1 支持项目规则、Schema、工作流入边和隔离语义审阅；显式启用的版本 2 增加 Ground Truth、Skill 看护、M01–M16 和有预算的 Stop 纠偏。允许停止与验收通过是不同结果，证据不足必须保留 UNVERIFIED。

## 安装

在源码目录执行：

```sh
npm run build:plugins
```

- Claude Code：`claude --plugin-dir ./dist/runtime-corrector-claude`
- CodeAgent：用宿主插件安装流程选择 `dist/runtime-corrector-codeagent`。
- OpenClaw：`openclaw plugins install ./dist/runtime-corrector-openclaw`。
- MatrixAssistant：使用其内置 OpenClaw CLI 安装，再按 [宿主指南](docs/openclaw.md) 登记加载路径。

只构建默认宿主使用 `npm run build:plugin`，指定宿主使用 `npm run build:plugin -- --host claude`。源码根目录不提供安装 manifest，安装时选择构建后的目录。

Claude/CodeAgent 的 CLI 与 Hook 要求 **Node.js >= 18**，支持 Windows、Linux、macOS。Claude 产物包含 `.claude-plugin` 并读取 `CLAUDE_PLUGIN_ROOT`；CodeAgent 产物包含 `.cac-plugin` 并读取 `CODEAGENT3_PLUGIN_ROOT`。根路径在执行前规范化并校验，包括 Windows Git Bash 的盘符路径。OpenClaw 原生入口仅适配 `2026.7.1-2` 和 `2026.10.3`，Node 要求与自动续作边界见宿主指南。

OpenClaw 产物内置锁定版本 `typebox 1.3.27`，仅由插件内部的相对路径加载，随插件一同安装，无需额外运行 npm，也不读取或修改系统及其他项目的 TypeBox。构建会验证仓库内依赖压缩包的 SHA-512，并保留原始许可证和依赖锁文件。Claude/CodeAgent 的基础 CLI 与 Hook 无需安装 npm 依赖。

## 快速开始

在目标项目中调用 `/runtime-corrector:init`；OpenClaw 使用 `runtime_corrector` 工具：

```json
{"command":"init"}
```

初始化不会覆盖已有策略。通用模板的阶段默认关闭：先在 `.runtime-corrector/config.yaml` 声明实际文件、规则和 reviewer，再启用需要的阶段。OpenClaw 自动模式要求项目已存在有效配置；可先在该项目运行 `node <插件目录>/scripts/cli.mjs init`，或复制最小配置。项目选择与启停见 [Session 项目](docs/session-projects.md)。

```sh
node <插件目录>/scripts/cli.mjs validate --cwd <项目目录> --format json
node <插件目录>/scripts/cli.mjs stages --cwd <项目目录> --format json
node <插件目录>/scripts/cli.mjs check docs/requirements.md --cwd <项目目录> --format json
```

CLI `check` 执行确定性检查并返回待执行的语义审阅请求；宿主 Hook 才负责启动隔离审阅。可以直接复制 [最小规则项目](examples/simple-project/) 或 [Stop 配置](examples/stop-metric-switches/.runtime-corrector/config.yaml)。详细步骤见 [快速开始](docs/tutorial.md)。

## 例子：写代码的会话开启纠偏，只做 review 的会话关闭

这里的**项目**就是一个代码文件夹，**Session** 就是一个聊天会话。假设同一个项目里有两个会话：A 负责写 Python 快速排序，B 只负责看代码。

**第 1 步：允许这个项目使用 RC。** 项目应已完成初始化，保留原有配置，在 `.runtime-corrector/config.yaml` 中设置：

```yaml
# 这个项目允许使用纠偏
enabled: true

# 第一次登记的新会话，先默认关闭
sessionDefaults:
  enabled: false
```

根级 `enabled` 控制整个项目；`sessionDefaults.enabled` 只是新会话的初始选择，修改它不会覆盖已有会话的选择。两个字段省略时都按 `true` 处理。

**第 2 步：进入会话 A，发送这条命令。**

```text
/rc-session on
```

效果：A 允许运行项目已经配置好的纠偏功能。产物、Skill、Stop 哪项关闭，就仍然关闭。

**第 3 步：进入会话 B，发送这条命令。**

```text
/rc-session off
```

效果：B 可以继续聊天、看代码，RC 不再审查 B，也不影响 A。

**第 4 步：在各自会话里确认结果。**

```text
/rc-session status
```

先看这三个返回字段：

- `requestedEnabled`：这个会话选择了开启还是关闭。
- `effectiveEnabled`：现在实际上是否允许 RC 运行；界面开关应显示这个值。
- `reason`：为什么关闭。`null` 表示没有阻断原因；`RC_PROJECT_DISABLED` 表示整个项目已关闭。

如果想让 A、B 都暂停纠偏，把项目根级 `enabled` 改成 `false`。改回 `true` 后，A 恢复开启，B 仍关闭。文件改动会在下一次消息、状态查询或其他检查点生效。会话选择保存在 `.runtime-corrector/sessions.local.yaml`，重启后仍保留。

## 例子：给宿主界面加一个“本会话纠偏”按钮

“宿主”指 MatrixAssistant / OpenClaw。宿主开发者用下面两个接口；自己在会话里操作时，用上面的命令即可。

**第 1 步：拿到当前会话身份。** 从宿主的当前 Session 记录读取，下面只是示例值：

```js
const target = {
  sessionKey: "agent:main:coding",
  sessionId: "instance-a",
};
```

- `sessionKey`：要控制哪个会话。
- `sessionId`：该会话当前这一次的实例编号；重置会话后要重新读取。

**第 2 步：读取按钮当前状态。** `gateway` 是宿主已经登录并连接好的通信客户端。

```js
const status = await gateway.request("runtime-corrector.session.get", target);
// 按 status.effectiveEnabled 显示开或关。
```

**第 3 步：用户点击开启时，保存明确的目标值。**

```js
const saved = await gateway.request("runtime-corrector.session.set", {
  ...target,
  enabled: true,
});
// 按 saved.effectiveEnabled 更新按钮；有阻断原因时显示 saved.reason。
```

这里的 `enabled: true` 表示开启，改成 `false` 就是关闭。调用失败时显示错误，不能当作已经保存。项目总开关仍在配置文件中修改，目前没有项目开关接口。

两个接口在 `lib/openclaw/session-control.mjs` 注册，由插件入口 `lib/openclaw/entry.mjs` 加载。完整返回示例、每个字段的解释、权限及手动检查文件的例子，见[一步步使用说明](docs/session-control.md)。

## 配置与行为

项目可控制阶段、匹配路径、规则、JSON Schema、reviewer、输出目录和审阅时限。版本 2 必须显式启用相应能力。Stop 默认开启 M08、M09、M12、M13、M15、M16，额外文件质量审查默认关闭；每会话和每流程默认最多实际开始三次纠偏。

配置错误与普通 Hook 故障按各入口的 fail-open 约定处理；活动 Stop 无有效结算时保留未验证状态。不要把所有故障都理解成无条件放行。取消、超时、依据变化及额度耗尽均不会伪造 PASS。

- [配置与规则](docs/configuration.md)
- [接口、命令与宿主协议](docs/interfaces.md)
- [工作原理与信任边界](docs/how-it-works.md)
- [Stop 审查与预算](docs/stop-task-review.md)
- [MatrixAssistant / OpenClaw](docs/openclaw.md)

验证与维护命令见文档导航中的维护说明。所有自动测试使用本地受控输入；构建和测试不会启动真实模型评测。
