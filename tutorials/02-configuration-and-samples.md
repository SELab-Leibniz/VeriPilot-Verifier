# 机器配置与样本包

## 机器配置只维护一份

`machine.yaml` 放机器相关设置，多个样本共用。相对路径以该文件所在目录解析，`${USERPROFILE}`、`${LOCALAPPDATA}` 等变量在启动脚本的进程环境中展开。未定义的变量会明确报错。

`paths` 字段：

- `node`、`git`：真实可执行文件的完整路径。
- `python`：可选，Python 示例需要；配置后将其目录加入 PATH。
- `openclawRoot`：包含 `openclaw.mjs`、`dist/`、运行依赖的完整 OpenClaw 包目录。
- `rcPluginPackage`：RC MA `.tgz`，不是安装目录或源码目录。
- `hostConfig`：当前机器已配置模型和鉴权的 OpenClaw JSON/JSON5 文件。
- `hostState`：同一个 Profile 的状态目录，用于读取所选 Agent 的模型凭据和鉴权文件。脚本不会复制它的历史业务会话。
- `outputRoot`：本地结果根目录。它和样本 `projectDir` 不能互相包含。

`harmony` 字段：

- `deveco` → `DEVECO_HOME`。
- `sdk` → `DEVECO_SDK_HOME`。
- `java` → `JAVA_HOME`，并添加其 `bin/`。
- `ohpm` → `OHPM_HOME`，并添加其 `bin/`。
- `hvigor` → `HVIGOR_HOME`，并添加其 `bin/`。

这些路径传入本次 Gateway 和业务子进程。构建脚本应使用这些环境变量。脚本不替换业务项目 `local.properties` 中写死的旧路径；SDK/API 版本是否适配仍需真实构建确认。

其他工具的 bin 目录放 `extraPath`。例如：

```yaml
extraPath:
  - "D:/tools/custom/bin"
env:
  HOS_SDK_HOME: "D:/Huawei/sdk"
  LANG: "en_US.UTF-8"
```

`env` 的值使用字符串。OPENCLAW 的路由/状态路径、HOME/USERPROFILE、PATH、NODE_OPTIONS、TEMP/TMP/TMPDIR 由隔离环境管理，不能从这里覆盖。Node、Git、Java 等工具目录通过各自路径字段或 `extraPath` 配置。

脚本使用独立 HOME、APPDATA、临时目录和 OpenClaw Profile。它不会更改系统环境变量。依赖旧用户目录缓存、全局 npm/ohpm 设置或硬编码路径的业务项目，需要在样本或构建脚本中明确处理。

## Agent 与模型

```yaml
models:
  agent: "auto"
  business: "auto"
  reviewer: "auto"
```

`auto` 读取当前宿主配置：优先显式默认 Agent，否则选第一个已配置 Agent；没有 `agents.list` 时使用宿主的隐式 `main`。业务模型读取该 Agent 的模型或 Agent 默认模型，评审模型读取宿主 RC 的 `reviewerModel`。

也可填写明确的 Agent ID 和 `provider/model`。未声明的 Agent 或模型会在预检时报错。这个检查只证明配置存在，不探测在线模型是否可用，也不会自动换模型重跑。

凭据优先使用宿主模型配置，并复用所选 Agent 的 `models.json`、`auth-profiles.json`、`auth.json` 中可用的鉴权。与原宿主绑定的认证服务、外部 SecretProvider 或其他插件能力，需要在迁移时单独核对。若标准环境变量提供密钥，新终端中也应有对应变量。

## 每个样本是一个目录包

```text
sample-001/
  experiment.yaml
  prompt.md
  rc-config.yaml
  project/
```

实验配置示例：

```yaml
version: 1
id: "my-sample"
projectDir: "./project"
promptFile: "./prompt.md"
rcConfigFile: "./rc-config.yaml"
execution:
  businessTimeoutMs: 0
  pollIntervalMs: 1000
  observerTimeoutMs: 0
```

这些路径相对本包的 `experiment.yaml`。ID 只使用字母、数字、下划线和横线。每次执行仍会分配唯一运行目录。

`project/` 放干净的源文件和项目自身的依赖声明。`.git` 和旧 `.runtime-correction` 不会作为输入复制。已有 `.runtime-corrector` 会被拒绝，规则应通过单独的 `rcConfigFile` 提供。符号链接、Junction 和特殊文件不在本 MVP 输入支持范围内；常见的链接型 `node_modules`、`oh_modules` 建议在工作副本中按项目说明安装。

输入包只读，实际开发发生在本次原生 Worktree。真实工作目录在 `run.json.identity.projectRoot`，它和 Gateway 的默认种子 workspace 可以不同。

## 超时与 RC 配置

- `businessTimeoutMs: 0`：业务运行不设置截止；最终脚本也将该值传给本次 RC 的后续业务修复运行。
- `observerTimeoutMs: 0`：脚本持续观察；正数只限制观察时间，不会中止或重发业务任务。
- `pollIntervalMs`：观察间隔，至少 100 ms，默认 1000 ms。

RC 的评审预算、指标、最大纠偏次数、requirementFrame 等由每个样本的 `rc-config.yaml` 决定。初始化仅适配评审模型；不会悄悄缩短预算。原始配置和实际配置都留档。

默认配置中的 ArkTS 回归命令当前关闭，里面的 `C:/MABench/...` 路径不会执行。需要开启时，使用随实验包携带的检查脚本，例如 `command` 采用 `node` 和 `scripts/check-project.mjs`，由脚本读取机器环境中的 SDK/Java 路径；不要继续使用旧机器绝对路径。命令数组不会自动做 shell 变量展开。

## 多包顺序执行

```powershell
foreach ($sample in Get-ChildItem 'D:/samples' -Directory) {
  node scripts/run-experiment.mjs "$($sample.FullName)/experiment.yaml" --machine 'D:/rc-lab/machine.yaml'
  if ($LASTEXITCODE -ne 0) { break }
}
```

退出码 0 只代表正常收尾或准备成功，不是独立业务评分。宿主运行失败返回 3；遇到待核对返回 2。检查当前样本后再决定后续操作，不自动覆盖失败记录。
