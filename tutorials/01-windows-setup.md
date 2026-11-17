# 新机器安装与第一次运行

## 1. 准备工具和源码

准备好：

- 兼容 Node：22.22.3 起的 22.x、24.15 起的 24.x，或 25.9+；当前实测 v26.13.0。
- Git for Windows。
- Windows PowerShell 5.1 与内置 .NET C# 编译能力（用于本实验独立进程组守护）。脚本对这个隐藏子进程设置 `-ExecutionPolicy Bypass`，不修改系统执行策略；企业策略禁用 PowerShell/Add-Type 时会在提交模型任务前失败，应先由本机管理员处理环境限制。
- 使用本适配版本的 MatrixAssistant/OpenClaw 完整安装目录，包含 `openclaw.mjs`、`dist/` 和运行依赖。
- 带 Session 状态接口的 RC MA 1.11.0 `.tgz` 安装包。
- Python 示例另需 Python 3.9+。鸿蒙样本另需项目要求的 DevEco、SDK、Java、OHPM、Hvigor。

脚本本身没有第三方 npm 依赖，无需 `npm install`。这些工具由操作者安装，脚本检查和使用现有环境。

建议把实验脚本放在较短的本地目录，例如 `D:/rc-lab`。从开发 Worktree 迁移时，复制 `lib/`、`scripts/`、`examples/`、`test/`、`tutorials/`、`package.json`、`machine.example.yaml` 和说明文档。`.git` 是旧机器 Worktree 的指针，不作为便携源码使用；`runs/`、`machine.yaml` 和凭据需要单独处理。

把指定 RC `.tgz` 放到新目录的 `packages/`，或在机器配置中指向它。复制源码目录并不会自动携带被 Git 忽略的插件包。

## 2. 配置这台机器

进入脚本目录：

```powershell
Set-Location D:/rc-lab
Copy-Item machine.example.yaml machine.yaml
```

已有配置时保留它，不用模板覆盖。打开 `machine.yaml`，把示例路径全部改为实际位置。路径可以有中文或空格，建议写成 `C:/Program Files/...`。

寻找实际解释器：

```powershell
(Get-Command node).Source
(Get-Command git).Source
python -c "import sys; print(sys.executable)"
```

Python 应填写真实 `python.exe`，避免 Windows Store 的命令别名。Node 尚未加入 PATH 时，使用完整路径启动脚本：

```powershell
& 'C:/Program Files/nodejs/node.exe' scripts/doctor.mjs
```

`paths.hostConfig` 和 `paths.hostState` 应指向这台机器上同一个有效 OpenClaw Profile。先在宿主中配置模型和鉴权，并确认所选 Agent 能正常对话。源码和样本包不包含可直接迁移的个人模型凭据。

仅运行 Python 示例时，可以把 `harmony` 下的路径设为 `""`，或省略整个 `harmony` 段落。配置了路径就会检查存在，避免默默使用错误工具。

## 3. 先检查，不调用模型

```powershell
node scripts/doctor.mjs
node scripts/doctor.mjs --network
node scripts/run-experiment.mjs examples/quicksort/experiment.yaml --plan
```

`doctor` 检查工具、目录、配置模型和鉴权来源；不展示凭据值。`--network` 发送不带鉴权的 HTTP HEAD 请求。401、404、405 都可能说明服务可连通，但不能证明鉴权有效或模型可用。它不调用模型。

`--plan` 解析本次输入、模型和哈希，不创建 Gateway 或 Session。标准 JSON 和宿主安装依赖支持的 JSON5 配置均可读取。若 Profile 使用跨文件 `$include` 或复杂外部 SecretProvider，先准备本 MVP 可直接读取的平铺模型配置；不要把解析失败当作鉴权成功。

可指定其他机器配置文件：

```powershell
node scripts/doctor.mjs --machine 'D:/实验配置/machine.yaml' --network
node scripts/run-experiment.mjs examples/quicksort/experiment.yaml --machine 'D:/实验配置/machine.yaml' --plan
```

## 4. 验证真实宿主准备

```powershell
node scripts/run-experiment.mjs examples/quicksort/experiment.yaml --prepare-only
npm run test:windows
```

`--prepare-only` 提取插件、生成隔离配置、创建原生 Session/Worktree、开启 RC，然后关闭专属 Gateway，不提交业务提示词。成功应输出 `PREPARED`，`result.json` 中有 `noModelDispatch: true`。

`test:windows` 还会在中文与空格目录下，通过 Windows PowerShell 5.1 使用独立 JSON5 Profile 验证准备流程，并模拟旧 OpenClaw 环境变量、全局 Git 签名与 Git 钩子干扰。它不会提交模型任务。

若机器配置不在默认位置：

```powershell
npm run test:windows -- --machine 'D:/实验配置/machine.yaml'
```

## 5. 跑一个实际样本

普通快速排序任务：

```powershell
node scripts/run-experiment.mjs examples/quicksort/experiment.yaml
```

受控纠偏测试：

```powershell
node scripts/test-correction.mjs
```

当前完整默认配置存在前置热钩子超时问题。用于隔离验证 Stop 自动修复的入口是：

```powershell
node scripts/test-correction.mjs --without-frame
```

该选项只把测试样本的 `requirementFrame.enabled` 改为 false，其他纠偏开关和预算保持原值。它不会更改普通样本或全局宿主配置。测试钩子在首轮交付结束前植入一次明确缺陷，随后由 RC 负责检测和修复。看到 `CORRECTING` 只是修复进行中，应等到原生终态、复验和留档均结束。

普通实验使用 `run-experiment.mjs`，其中没有缺陷注入。

## 6. 核对与保存结果

终端会输出本次运行目录。先查看 `result.json` 中的宿主 `host` 和 RC `rc`，再查看 `artifacts/project/` 的业务交付。`ARCHIVED` 代表执行已收尾，不能单独代表任务正确或 RC 通过。

每次执行都创建新目录，原记录保留。脚本会在确认本样本工作已结束后关闭自己启动的 Gateway。脚本没有独立评分环节。

整个 `runs/` 按私有运行资料处理：其中的配置、环境变量、Profile 和原始会话可能包含凭据或敏感业务内容。迁移源码和分享结果时按需挑选产物，并检查内容；不要把整个运行目录混入便携源码包。
