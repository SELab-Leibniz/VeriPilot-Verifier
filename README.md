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

OpenClaw 审阅任务依赖固定版本 `typebox`，产物包含对应依赖和锁文件；离线预装依赖可在产物目录执行 `npm ci --ignore-scripts`。Claude/CodeAgent 的基础 CLI 与 Hook 无需安装 npm 依赖。

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

## 配置与行为

项目可控制阶段、匹配路径、规则、JSON Schema、reviewer、输出目录和审阅时限。版本 2 必须显式启用相应能力。Stop 默认开启 M08、M09、M12、M13、M15、M16，额外文件质量审查默认关闭；每会话和每流程默认最多实际开始三次纠偏。

配置错误与普通 Hook 故障按各入口的 fail-open 约定处理；活动 Stop 无有效结算时保留未验证状态。不要把所有故障都理解成无条件放行。取消、超时、依据变化及额度耗尽均不会伪造 PASS。

- [配置与规则](docs/configuration.md)
- [接口、命令与宿主协议](docs/interfaces.md)
- [工作原理与信任边界](docs/how-it-works.md)
- [Stop 审查与预算](docs/stop-task-review.md)
- [MatrixAssistant / OpenClaw](docs/openclaw.md)

验证与维护命令见文档导航中的维护说明。所有自动测试使用本地受控输入；构建和测试不会启动真实模型评测。
