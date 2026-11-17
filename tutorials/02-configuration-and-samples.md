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

`env` 的值使用字符串。OPENCLAW 的路由/状态路径、HOME/USERPROFILE、PATH、NODE_OPTIONS、TEMP/TMP/TMPDIR、`PSModuleAnalysisCachePath` 由隔离环境管理，不能从这里覆盖。Node、Git、Java 等工具目录通过各自路径字段或 `extraPath` 配置。

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
  maxRuntimeMs: 7200000
  businessTimeoutMs: 0
  pollIntervalMs: 1000
  observerTimeoutMs: 7200000
  uncertainTimeoutMs: 300000
  queryTimeoutMs: 15000
```

这些路径相对本包的 `experiment.yaml`。ID 只使用字母、数字、下划线和横线。每次执行仍会分配唯一运行目录。

`project/` 放干净的源文件和项目自身的依赖声明。`.git` 和旧 `.runtime-correction` 不会作为输入复制。已有 `.runtime-corrector` 会被拒绝，规则应通过单独的 `rcConfigFile` 提供。符号链接、Junction 和特殊文件不在本 MVP 输入支持范围内；常见的链接型 `node_modules`、`oh_modules` 建议在工作副本中按项目说明安装。

输入包只读，实际开发发生在本次原生 Worktree。真实工作目录在 `run.json.identity.projectRoot`，它和 Gateway 的默认种子 workspace 可以不同。

## 超时与 RC 配置

- `maxRuntimeMs`：整个样本的硬上限，正整数毫秒，默认 `21600000`（六小时）。示例 `7200000` 为两小时。从创建运行目录开始计时，包含准备、主任务、私有审查、全部纠偏轮次和排队任务，恢复观察不重置截止时间。预检输入本身在创建运行目录之前进行。
- 到达硬上限后，独立守护进程终止本实验的 Windows Job，包含 Gateway 及普通方式启动的子孙进程；其排队任务随 Gateway 一起结束。保留原始工作树、状态、日志及已捕获轨迹。只有进程组确认没有活动进程才记录 `TIMED_OUT`。这与 RC 的手动“只终止当前轮、后续用户任务继续”接口是两种用途。
- `businessTimeoutMs: 0`：业务任务只受实验总上限约束；正数可额外限制单次业务运行。后续业务修复同样受总上限约束。
- `observerTimeoutMs`：一次观察窗口的上限，默认六小时。达到这个上限只停止观察，返回 `NEEDS_ATTENTION`，不重发任务，也不提前中断健康纠偏。独立守护进程仍在总截止时间清理该实验。
- `uncertainTimeoutMs`：状态持续无法确认的等待上限，默认五分钟。查询恢复且显示健康活动会清除此计时，不按同一正常阶段持续时间判断卡死。
- `queryTimeoutMs`：单次状态查询上限，默认十五秒；连续三次查询失败会停止本次观察并保留原工作。迟到的查询结果不会被当成完成依据。
- `pollIntervalMs`：观察间隔，至少 100 ms，默认 1000 ms。

除 `businessTimeoutMs` 外，上述值都必须是正整数，不能用 `0` 关闭保护。所有毫秒值最多为 `2147483647`（约 24.8 天），避免运行时计时器溢出。`run.json` 中的 `experimentDeadlineAt` 是该次冻结的绝对截止时间；修改样本配置不会延长已经开始的实验。旧版记录中的 `observerTimeoutMs: 0` 在恢复观察时采用有限默认窗口；没有进程组身份的旧版运行不会被自动按 PID 接管关闭。

RC 的评审预算、指标、最大纠偏次数、requirementFrame 等由每个样本的 `rc-config.yaml` 决定。初始化仅适配评审模型，不改这些预算；整个样本仍受 `maxRuntimeMs` 约束。原始配置和实际配置都留档。

默认配置中的 ArkTS 回归命令当前关闭，里面的 `C:/MABench/...` 路径不会执行。需要开启时，使用随实验包携带的检查脚本，例如 `command` 采用 `node` 和 `scripts/check-project.mjs`，由脚本读取机器环境中的 SDK/Java 路径；不要继续使用旧机器绝对路径。命令数组不会自动做 shell 变量展开。

## 多包顺序执行

```powershell
foreach ($sample in Get-ChildItem 'D:/samples' -Directory) {
  node scripts/run-experiment.mjs "$($sample.FullName)/experiment.yaml" --machine 'D:/rc-lab/machine.yaml'
  if ($LASTEXITCODE -ne 0) { break }
}
```

退出码 0 只代表正常收尾或准备成功，不是独立业务评分。宿主运行失败返回 3；遇到待核对返回 2；总时限到期清理确认返回 4，清理未确认返回 5。检查当前样本后再决定后续操作，不自动覆盖失败记录。
