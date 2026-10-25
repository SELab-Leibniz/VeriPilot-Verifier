# 快速开始

先按 [根 README](../README.md) 构建并安装对应宿主产物。Claude/CodeAgent 使用 slash 命令；OpenClaw 使用 `runtime_corrector` 工具的同名 `command`，参数见 [接口参考](interfaces.md)。

## 初始化和校验

在业务项目运行 `/runtime-corrector:init`，或用产物中的 CLI：

```sh
node <插件目录>/scripts/cli.mjs init --cwd <项目目录>
node <插件目录>/scripts/cli.mjs validate --cwd <项目目录> --format json
```

已有 `.runtime-corrector/` 时初始化停止。模板提供配置、规则、reviewer 与说明，`enabledStages: []` 默认不检查业务产物。OpenClaw 自动项目解析要求已有有效配置，因此首次使用可先通过 CLI 初始化。

## 最小产物规则

仓库的 `examples/simple-project/` 可整目录复制。配置将 `docs/requirements.md` 绑定到项目自己的 `.runtime-corrector/rules.yaml` 和 `reviewer.md`，输出默认不持久化。运行：

```sh
node <插件目录>/scripts/cli.mjs check docs/requirements.md --cwd <复制后的目录> --format json
```

CLI `check` 不创建隔离会话；节点或工作流入边开启语义审阅时，返回待处理请求。自动写后检查由宿主 Hook 执行，并把诊断和候选补丁交回主 Agent。插件不自动应用补丁。

## 启用任务基线与 Stop

将本页配置复制到项目 `.runtime-corrector/config.yaml`，按需开启独立能力：

```yaml
version: 2
artifacts: []
dynamicGroundTruth:
  enabled: true
skillCorrection:
  enabled: false
stopCorrection:
  enabled: true
  waitMode: until_pass
  maxCorrectionsPerSession: 3
  maxCorrectionsPerFlow: 3
  assessmentTimeoutMs: 1200000
  feedbackReserveMs: 180000
  reviewGroupSize: 3
```

默认六项指标和完整开关见 [Stop 指标](stop-metric-switches.md)。宿主 reviewer 的模型、工具和审批由宿主配置；配置文件只保存密钥环境变量名，不保存密钥。

Stop 依据冻结要求审查；没有证据不能默认通过。`assessment` 等结算与交付，`until_pass` 还会等待已实际开始的修复及后续 Stop。会话额度不会因需求或项目变化而清零。宿主没有可信启动/取消能力时不会自动续作，见 [宿主限制](openclaw.md)。

## 日常查看

使用 `help`、`stages`、`explain <stage>`、`spec <stage>` 和 `validate` 核对生效配置。仅开启需要的阶段；`stage <stage> on|off` 修改开关，不删除 criteria。持久化结果位于项目配置的输出目录或 `.runtime-correction/`，应排除出版本控制。
