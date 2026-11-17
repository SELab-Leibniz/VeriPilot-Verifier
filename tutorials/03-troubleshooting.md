# 失败、中断、恢复与日志

## 先保存这几个位置

运行开始后，终端会给出 `runs/<run-id>`。遇到问题先保留这个目录和原 ID。

- `run.json`：执行阶段、原始请求 ID、Session、原生运行、输入哈希和实际项目路径。
- `result.json`：宿主结果、RC 结果、脚本状态和原因。
- `logs/gateway.stderr.log`、`gateway.stdout.log`、`runner.jsonl`：宿主与控制器日志。
- `rc-status/latest.json`、`history.jsonl`：即时状态、结束条件和未结算项。
- `transcripts/index.json` 与 JSONL：主会话及私有审查轨迹；缺失来源会在索引中标记。

若错误出现在创建 Session 之前，可能只有 `run.json` 和部分准备文件。没有运行 ID 的准备失败，不等于已向模型提交任务。

## 退出码怎么处理

- `0`：普通执行已收尾，或 `--prepare-only` 成功。继续读取 `host` 和 `rc`。
- `1`：配置、入口或准备错误，按错误路径/日志修正。
- `2`：`NEEDS_ATTENTION`。原工作可能继续运行，先查原 Gateway/Session。
- `3`：已留档，但至少一个宿主原生运行为 `error`。不当作业务任务成功，也不自动重跑。

RC 的 `NO_DEVIATION_FOUND`、`UNVERIFIED` 等结果保持独立。CLI 返回、文件生成和一次 `ended: true` 均不足以单独证明所有纠偏工作结束。

## 常见配置问题

**找不到 node/git/python 或路径不存在**

检查 `machine.yaml` 中的实际可执行文件位置。Git 字段误填 Node 等程序会在预检被拒绝。Python 填完整解释器路径，使用 `python -c "import sys; print(sys.executable)"` 核实；Windows Store 别名、无效路径和版本不兼容会被检查发现。

**SDK 路径报错，但这次只想跑 Python**

将不用的 `harmony` 路径设为 `""` 或省略；保留非空路径就必须存在。鸿蒙构建失败时再核对项目 API 与 SDK 版本、Java、OHPM、Hvigor，以及项目自身 `local.properties`。

**YAML 解析失败、字符串转义错误**

使用两空格缩进，不用 Tab。Windows 路径写成 `C:/tools/...`；双引号中不要直接写未经转义的 `C:\Users\...`。模板支持普通映射和列表，不支持 YAML anchors 等复杂语法。重复键、未知字段和拼错的 `execution` 会报错。

**模型/Agent 不存在**

先看 `doctor` 解析到的 ID，确认 `hostConfig` 和 `hostState` 属于同一个有效 Profile。`auto` 读取当前配置；可显式指定现有 Agent 与 `provider/model`。更换模型是一次实验条件变化，原运行记录应保留。

**宿主版本或 RC 包不匹配**

当前仅适配 MA OpenClaw 2026.7.1-2。RC 必须是包含 Session 状态接口的 1.11.0 MA 包；旧的同版本包可能不含这些接口。`--prepare-only` 会检查包与真实加载，不以文件名当作版本证据。完整复制宿主安装，保留 `dist/` 和运行依赖。

## 网络与鉴权

```powershell
node scripts/doctor.mjs --network
```

`ENOTFOUND` 通常表示域名解析失败；`ECONNRESET` 表示连接被中断；连接超时、代理和 TLS 错误按输出逐项排查。检查这台机器实际使用的网络、VPN/代理和服务地址。Doctor 的连接检查与宿主实际模型客户端可能有不同代理行为，最终以原生运行日志为准。

HTTP 401/404 的 HEAD 响应证明 HTTP 链路有响应，不证明模型调用可用。真实模型的鉴权错误、限流或服务不可用会体现在宿主结果中。修复网络或鉴权前保留失败尝试，修复后显式创建新尝试，不修改旧结果为成功。

## 原 Gateway 还在工作，脚本关了

`Ctrl+C` 停止脚本观察，会保留尚未结束的业务与 RC。确认旧观察进程已退出后：

```powershell
node scripts/run-experiment.mjs --resume 'D:/rc-lab/runs/<run-id>'
```

恢复只观察旧请求，不创建 Session、不再次发送提示词。控制锁会拒绝两个观察进程同时接管。旧控制进程已退出时才回收它的锁。

## 原 Gateway 已停止、电脑重启或输出被搬到另一台机器

`--resume` 不会自动启动替代 Gateway。无法连接原 Gateway 时，写入 `NEEDS_ATTENTION / GATEWAY_UNAVAILABLE`，保留原请求 ID，不声称完成。旧的 `latest.json` 是历史快照，不能据此认定后台仍在运行。

运行目录包含原机器绝对路径、PID 和原生状态，不是跨机器续跑包。迁移的是源码、样本包与新的机器配置。原运行先保留证据并核对状态，再明确决定是否开新尝试。

## 显示 STOPPING / UNKNOWN 或 HOST_TERMINAL_MISSING

这表示 RC 正在收尾，或仍缺少精确运行 ID 的原生终态。即使业务文件已经写出，仍可能有宿主排队、回复排空、私有审查或启动准入尚未结算。

查看 `rc-status/latest.json.completion.reasons` 和对应日志，继续观察原运行。不要手动把状态文件改成完成、重发同一任务或关闭不明归属的 Node 进程。

## RC_HOOK_UNAVAILABLE / 前置热钩子超时

本次完整默认配置的两次受控触发测试都在前置钩子阶段出现该错误。当前 RC 把热钩子上限限制为 10 秒，内部通常留约 1 秒返回余量；配置中的两小时 Stop 审查预算不会扩展这个上限。

结果应保留为 `UNVERIFIED`。`scripts/test-correction.mjs --without-frame` 可隔离 requirementFrame 的影响，已在本机验证自动纠偏闭环。它只证明关闭该前置模块时的链路，不能作为完整默认配置已经修复的证据。脚本不会自动为正式样本关闭模块。

## 端口占用、Gateway 启动失败、Git 全局设置干扰

每次运行使用临时分配的端口，不会用 `--force` 接管已有进程。若分配后发生端口竞争，查看本次 Gateway 日志；在提交前失败时修正环境后新建尝试。

种子 Git 仓库使用自己的空 hooks 目录和关闭签名的本地配置；它不修改用户全局 Git 设置。全局签名和钩子干扰已纳入 Windows 准备测试。其他 Git 策略、路径权限或磁盘问题仍会留下具体错误。

## 清理与分享

正常归档后，脚本只关闭自己启动、进程身份匹配的 Gateway。`NEEDS_ATTENTION` 的目录先保留，不批量清理正在工作的状态或临时文件。

原始轨迹、配置副本和环境变量可能包含敏感信息。分享时优先选择经过检查的业务产物与验证说明，保留私有原始证据；源码迁移时跳过 `runs/`、旧机器的 `machine.yaml` 和个人 Profile。
