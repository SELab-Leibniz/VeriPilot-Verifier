# Session 项目作用域：已定位缺陷的修复与验证

分支 `codex/session-project-scope`，候选插件 `1.9.1-openclaw.11-session-projects.2`。代码已经实现；本地回归、真实宿主接口及确定性 Python 闭环通过。修复后的两版 GLM 完整会话和从空开发实验仍未完成，原因是供应商额度限制。

后续使用用户授权豆包模型完成真实补验，结果及首轮失败边界见 [豆包实测报告](session-projects-doubao-20261015.md)。下文保留最初 GLM 阻塞时的结果，不将后来实测混作当时已经通过。

## 实现

1. 新版宿主通过公开 V2 plugin service 的 `ctx.scheduler.schedule` 承载 Stop，脱离已释放的交付 RPC 根准入；服务关闭取消待运行评审，正在运行的评审保留宿主生命周期信号。仍通过公开 Session work admission 核验会话，未恢复 `before_agent_finalize`，未接管业务 harness 或工具路径。
2. 内部 Stop 调度直接获取本次评审结果或异常，不再通过宿主 Hook 的异常隔离包装器读取旧 `nativeAssessment`。准入拒绝结束为 UNVERIFIED；确实进入核心的评审故障继续沿用原先首次尝试加两次重试及同一截止时间。重试还必须推进核心故障计数，不生成无进展循环。
3. 评审携带精确 runId/assessmentId；先将当前轮结论和 evaluationId 持久化，再请求原生续作。新轮继续清空旧评审状态；即使在宿主派发返回前已经进入新轮，旧轮 checkpoint 仍保留 DEVIATION。恢复已完成评审但丢失执行者的 checkpoint 保留结论，不自动重派发不确定的业务续作。
4. 可信反馈观察持久化后，未完成的任务交付标记会在恢复时补齐；补写失败可再次重试。观察日志按 receipt 和来源记录去重，覆盖日志已落盘而确认标记未落盘的间隙；不会再次调用业务模型。

本轮生产代码修改限定在 OpenClaw 适配、Stop checkpoint/反馈投影及版本元数据。需求提取、语义 Reviewer 算法、纠偏核心、业务 k 和核心基础设施重试上限未修改。与旧适配分支相比，核心 orchestrator/task-store 仍一致；此前项目作用域改动只给外层失败记录增加 Session 命名空间，并给原 Reviewer 接入新版公开 SQLite 会话适配。

## 验证及边界

| 实验 | 结果 | 实际覆盖 |
| --- | --- | --- |
| 全量 Node 回归 | 808 项，806 通过，2 项既有 Windows 测试跳过 | 新增准入拒绝、旧 PASS 复用防护、派发竞态、评审恢复、反馈恢复和服务生命周期测试 |
| 旧版真实 Gateway 项目接口 | PASS | A/B 各自绑定、状态持久化、未启用不建立运行目录；未调用模型 |
| 新版真实 Gateway 项目接口 | PASS | 宿主项目、A/B 隔离、手动绑定禁用、真实 Git Worktree 目录；未调用模型 |
| 新版已安装调度器和准入防护 | PASS | 基线全局未关闭但旧根已释放，队列报 GatewayDrainingError；服务调度后队列与 Session 准入成功 |
| 两模式 Python 原生 Stop 闭环 | PASS | 真实 Python 3.13 子进程、文件、RC 原生 Hook/checkpoint/反馈/续作；宿主和 Reviewer 为确定性替身 |
| Python Todo 操作与恢复 | PASS | 九项真实 Python 测试、74 次操作、无效输入保持数据、重复 Hook、五处 SIGKILL 恢复、破损尾记录恢复 |
| 新版 GLM 真实 Gateway 完整 Stop | 供应商阻塞 | 业务首轮最终 HTTP 429；没有业务工具执行，没有基线或 Stop，不能评价修复后的完整闭环 |
| 两版 GLM 从空开发 Todo | 待补验 | 已提供独立开发与验收脚本，当前无可用额度，未伪造通过 |

调度器探针使用正式安装包中的实际 GatewayScheduler、plugin service scheduler、Gateway 根防护和 Session 准入实现；诊断脚本中的 registry 执行包装及权限断言为替身。它证明脱离旧根的机制，不证明真实 plugin owner 下的完整 Reviewer/续作权限链。生产代码只依赖公开服务接口，没有导入私有宿主导出。

Python 原生闭环中，A 的 complete 实现先保持 completed=false，冻结的九项测试实际失败，首轮 Stop 为 DEVIATION；一次原生反馈后受控业务执行修复 todo.py，末轮 Stop 为 PASS，receipt 同时具备观察和完成记录。B 的正确版本直接 PASS，k=0。两模式 A 均为 k=1、需求版本 1、epoch 1；A/B taskId 不同，默认工作区无运行目录。替身负责业务修改和结构化判断，不能称为 GLM 自动开发实测。

## 供应商阻塞证据

在已授权的同一 `https://open.bigmodel.cn/api/anthropic/v1/messages` 做最小请求，未打印或提交 key：

- 第二个 key：HTTP 429 / 1308，达到五小时上限，响应提示 `2026-10-15 07:44:05` 重置。
- 第一个 key：HTTP 429 / 1113，余额不足或无可用资源包。
- 已授权的原有本机测试凭据：HTTP 429 / 1310，周/月上限，响应提示 `2026-10-16 09:53:18` 重置。

真实 Gateway 首次实验目录 `/private/tmp/rc-stop-fix-native-20261015` 保留 FAIL 原记录。首次运行时脚本还有旧的 `ef3054e` baseline 常量；它不代表该轮真实插件源码，准确来源是目录中构建快照的文件哈希。现已把脚本改为显式 `RC_EXPERIMENT_BASELINE` 或 `working-tree`，未覆盖失败历史。

## 重复实验

所有 Gateway 实验使用新的临时目录、端口、配置、Session 和工作区。测试凭据通过私有环境变量传入，日志脱敏；不修改全局宿主配置或安装。以下命令在项目根目录运行，宿主路径按本机安装调整。

```sh
npm test
node scripts/build-plugin.mjs
PYTHON=python3.13 node scripts/diagnostics/python-native-stop-offline.mjs /tmp/rc-python-native-new
node scripts/validate-python-todolist.mjs --keep --output /tmp/rc-todo-new.json
```

无模型的真实接口探针：

```sh
RC_PROJECT_CONTRACT_ONLY=1 /tmp/rc-node/node_modules/node/bin/node \
  scripts/diagnostics/openclaw-session-projects.mjs HOST PROVIDER_JSON NEW_OUTPUT PORT
/tmp/rc-node/node_modules/node/bin/node \
  scripts/diagnostics/native-stop-owner-contract.mjs NATIVE_HOST NEW_OUTPUT
```

待有可用 `RC_TEST_MODEL_KEY` 后，按顺序对两版宿主运行以下两项，不同时启动两版以减少供应商并发限制：

```sh
RC_EXPERIMENT_BASELINE=REVIEWED_COMMIT /tmp/rc-node/node_modules/node/bin/node \
  scripts/diagnostics/session-project-stop-live.mjs HOST PROVIDER_JSON NEW_OUTPUT PORT
RC_EXPERIMENT_BASELINE=REVIEWED_COMMIT /tmp/rc-node/node_modules/node/bin/node \
  scripts/diagnostics/python-app-development-live.mjs HOST PROVIDER_JSON NEW_OUTPUT PORT
```

Stop 实测严格要求：BROKEN 交付后的首轮 DEVIATION、已观察且已完成的宿主原生续作、真实 READY 文件与最终 PASS、A/B 独立状态、Worktree 原仓库保持原样、真实 Gateway 重启不重放。开发实验从不存在 todo.py 开始，冻结五条正式需求，要求宿主实际编写文件、Stop 最终 PASS，随后独立执行八项 CLI 验收，包括跨进程持久化、Unicode、done 和错误 ID 不损坏数据。观察器不修改业务源码。

本轮脱敏汇总、实际源码哈希和原始证据位置见 [JSON 证据](session-projects-fix-20261015.json)。保留上一轮失败和诊断：[缺陷定位](session-projects-diagnosis-20261015.md)、[扩展失败记录](session-projects-extended-results.md)。
