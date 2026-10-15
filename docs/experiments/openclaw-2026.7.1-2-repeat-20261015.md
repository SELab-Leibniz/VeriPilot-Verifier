# OpenClaw 2026.7.1-2 再次真实复验

2026-10-15（Asia/Hong_Kong）按用户要求重新创建隔离环境实测，四组实验全部 PASS。此次完整旧版故障实验在同一轮同时通过 A 的真实纠偏、B 的零预算隔离及网关重启恢复，不再依靠不同轮次拼接这些结论。

测试宿主是本机 `/opt/homebrew/lib/node_modules/openclaw`，实际包版本 **2026.7.1-2**；加载插件 **1.9.1-openclaw.11-session-projects.2**。分支 `codex/session-project-scope`，代码基线 `dabd02516d266b4826e6bc6dafa2ae97fe127a99`，生产代码仍为 `e54485b`。四个成功环境内各有 62 个适配层及纠偏核心文件与当前源码逐一比较，均无差异。

使用用户已授权的 `doubao-seed-2.1-lite`，地址为 `https://ark.cn-beijing.volces.com/api/coding/v3`；真实请求由 OpenClaw 发起。运行环境为 macOS、Node 26.11.1、Python 3.13.12。每个网关分别使用自己的配置、状态、端口与临时项目；不修改全局默认目录或宿主源码。

## 实测结果

| 验证项 | 本轮结果 |
| --- | --- |
| 受控缺陷交付与检出 | 第一轮真实源码仍输出 `BROKEN`；Stop checkpoint 为 DEVIATION |
| 宿主原生续作与实际修复 | 一条续作 ADMITTED，反馈被实际观察；源码改为 `READY`，末轮 Stop 和 receipt 均 PASS，k=1 |
| 需求与预算稳定 | A 的需求版本 1、epoch 1；原 checkpoint 保留 DEVIATION，未被末轮 PASS 覆盖 |
| 并行 Session 隔离 | B 输出 `PEER_READY`，独立 taskId / sessionId，PASS、k=0，无续作；实际评审重叠 9 对 |
| 真实重启恢复 | 完成 Stop 后停止并重启网关，A/B 身份、绑定、任务、需求基线、预算和 epoch 一致；查询未启动模型 |
| 从空开发轻量 Python Todo | 由业务模型实际创建 `todo.py`、测试并交付；Stop / 实现终审 PASS，k=0 |
| 独立文件验收 | Todo 的 8 项真实 CLI 场景全部通过；冻结需求和配置未被改写 |
| Reviewer 运行中改绑 | 实际 Stop Reviewer 已开始后改绑；旧 Stop CANCELLED，旧文件仍为 BAD，无旧反馈进入新任务 |
| 新项目独立工作 | 新 taskId、需求基线版本 1、k=0；实际写入 `NEW_B_ONLY` |
| 未启用项目不干扰 | 业务模型实际写入 marker；仅一个业务模型运行，无 Reviewer、需求基线或 RC 项目目录 |
| 绑定管理 | 查询、绑定、改绑、解绑、真实重启恢复均正常；管理操作不调用模型，回复明确宿主目录未改变 |

Todo 的八项独立验收为：帮助、缺失存储时空列表、Unicode 添加、第二条添加、跨进程列表、done、done 后持久化列表、未知 ID。实际检查 JSON 内容、递增 ID、退出码、stderr，以及未知 ID 前后存储字节完全一致。观察器只准备项目内验收数据目录，不修改业务源码。A/B 与 Todo 的实际实现终审均读取到一份有效源码清单，没有空清单验收。

改绑实验的新项目明确关闭 Stop，因此该项只证明旧评审取消、新作用域基线和业务文件写入，不把它计为新项目的 Stop 终审。完整 Stop 通过来自另两组开启 Stop 和实现终审的实验。

## 原始证据与复现

脱敏汇总、精确运行编号、源码和证据 SHA-256、独立 CLI 原始输出见 [JSON 证据](openclaw-2026.7.1-2-repeat-20261015.json)。本轮成功输出目录：

- `/private/tmp/rc-legacy-repeat-stop-20261015`：故障纠偏、并行隔离、真实重启。
- `/private/tmp/rc-legacy-repeat-python-20261015`：从空开发、实际 `todo.py`、终审和八项验收。
- `/private/tmp/rc-legacy-repeat-switch-20261015`：实际 Reviewer 运行中改绑、取消和新任务。
- `/private/tmp/rc-legacy-repeat-disabled-20261015-r2`：未配置项目、真实业务写入及完整绑定管理。

分别运行 `scripts/diagnostics/` 下的 `session-project-stop-live.mjs`、`python-app-development-live.mjs`、`session-project-switch-live.mjs` 和本轮新增的 `session-project-legacy-disabled-live.mjs`。每个脚本接受宿主包目录、无凭据的 provider 描述 JSON、新建输出目录及空闲端口；凭据通过 `RC_TEST_MODEL_KEY` 环境变量注入。provider 的协议、推理参数和模型配置见 JSON 证据。使用新的输出目录，避免混入已有 Session 状态。

未配置项目的首轮观察器将“JSON 加宿主目录说明”的命令回复当纯 JSON 解析，在调用任何模型之前失败。修正诊断脚本的断言后，在全新目录重跑通过；首轮 FAIL 保留在 `/private/tmp/rc-legacy-repeat-disabled-20261015`，没有更改生产插件或掩盖失败。

本轮定向回归 45/45 PASS、0 跳过，覆盖 Session 项目、原生 Stop 预算、续作回执及 Stop 生命周期；没有把前次 808 项全量回归计为本轮执行。所有实验观察器和网关均已退出。宿主在隔离状态内生成的五份模型注册文件在实验结束后已将凭据替换为环境变量引用；临时凭据文件已删除，留存日志和证据复查无 key。

## 使用边界

本轮确认候选插件可在上述 **OpenClaw 2026.7.1-2** 环境正常完成真实纠偏闭环。旧版仍由用户通过 `/rc-project bind <绝对项目目录>` 选择 RC 纠偏项目，且项目必须存在有效 `.runtime-corrector` 配置。绑定只决定 RC 作用域，业务工具路径和权限仍由 OpenClaw 管理；本次业务调用均显式设置正确 workdir。结论限于列出的宿主、运行环境、模型和实际场景，不扩展为所有系统、模型或宿主 UI 均已测试。
