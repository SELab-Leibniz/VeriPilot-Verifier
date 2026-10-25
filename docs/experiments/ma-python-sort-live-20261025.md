# MatrixAssistant 真实模型：Python 归并排序

2026-10-25，北京时间 20:29:57–20:44:50。按本次用户要求，先用简单排序任务验证真实链路，暂未执行 TodoList。

**两组实现均通过独立 8/8 测试；K=1 的 RC 审查完整通过，K=3 因总请求预算退出，仅完成 16/17 项。实验整体为 NOT_ACCEPTED，不宣称 K 的性能收益或需求 v1.1 整体交付完成。**

## 范围与隔离

- 宿主为 MatrixAssistant 内置 OpenClaw `2026.7.1-2`，只读取宿主接口，没有修改 MatrixAssistant 或其内置 OpenClaw 代码，没有向 `18789` 的日常主会话发送测试消息。
- 使用当时 MA 默认模型 `custom/deepseek-v4-flash`。只读获取与该模型、地址匹配的 MA 认证配置；密钥不写入实验文件。
- Gateway、配置、会话、源码和证据均在本仓库的新隔离目录；Gateway 使用独立端口 `18947`。观察器没有编写或修复排序实现。
- 原始要求、八项冻结测试和 AGENTS 在两组中相同且始终未修改。Stop 保留默认六项 M 开关，总窗口 20 分钟、交付预留 3 分钟，K 分别为 1、3；独立文件质量检查关闭。
- 全实验共享上游真实请求上限 160 次，未在触顶后扩大或补跑。最早一次单独的认证失败记录保留在 `ma-python-sort-live-20261025-01`；成功认证后的本次试验为 `...-02`。

运行脚本：[python-sort-development-live.mjs](../../scripts/diagnostics/python-sort-development-live.mjs)。转发器只转发真实模型响应、记录上游用量并执行请求上限，不生成任何模型判断。

## 业务要求与结果

从空源码创建 `sort_demo.py`，提供 `merge_sort(values, reverse=False)`：

- 升序/降序，覆盖空列表、负数、重复值和大整数。
- 返回新列表，保留原输入，各次调用不共享可变状态。
- 手写归并排序，使用分治和合并；不调用 `sorted()` 或 `list.sort()`，不使用外部排序包、文件存储或共享可变全局状态，导入无业务副作用。

冻结测试包含 8 个测试方法，其中包含固定种子的 100 组随机输入及升降序检查。两组都由真实模型编写源码，随后由观察器独立运行同一测试，结果均为 8/8 PASS。

可直接查看两份模型产物：

- [K=1 实现](../../.runtime-correction/test-temp/ma-python-sort-live-20261025-02/K1/sort_demo.py)
- [K=3 实现](../../.runtime-correction/test-temp/ma-python-sort-live-20261025-02/K3/sort_demo.py)

两组没有发现已确认偏差，没有自动业务返修，实际业务纠偏消耗均为 0。正常开发中的工具使用和审阅 Agent 启动没有被计为纠偏。

## 审查与用量事实

K=1：

- 从开发请求到完整结束约 8 分 19.840 秒。
- 实际启动 10 个分组 SDK Agent，保存 10/10 个 PASS 回执；M12 为 6/6，M13 为 1/1，M16 为 3/3，RC 最终 PASS。
- 上游请求 92 次，返回的 prompt_tokens 合计 912,298、completion_tokens 合计 42,648。
- 已保存 source 工具日志披露 353,654 字节，包含引用头和重复读取；此值不等于磁盘 I/O 或网络输入量。

K=3：

- 从开发请求到预算退出约 6 分 14.675 秒；这不是完整审查耗时。
- 实际启动 7 个分组 SDK Agent，保存 16/17 个 PASS 回执；M12 为 9/9，M13 为 1/1，M16 为 6/7。
- 未完成项为 `M16:gt-009`，原要求是模块导入无副作用；没有将它改成 PASS，也没有因功能测试通过替代该正式回执。
- 上游请求 68 次，返回的 prompt_tokens 合计 994,546、completion_tokens 合计 32,781。
- 已保存 source 工具日志披露 371,109 字节。最后一个 Agent 没有完整结束，因此不能把它的整体结果或完整指标当作已生成。

160 次上游请求均记录了返回用量。这些数值按供应商返回字段汇总，不推导价格，也不将缓存输入解释为新的独立证据。

## 比较限制与退出恢复

两组业务原文和测试相同，但各自的真实 GT 抽取产生了不同拆分：K=1 的适用条目为 10 个，K=3 为 17 个。冻结原文、条件和测试没有被观察器改动；本次不能把启动数或耗时差异归因于 K。后续正式性能对照必须在两组开始前共享同一套冻结 GT 单位，再保持相同分母进行比较。

预算退出时，独立 Gateway 已结束，但 K=3 的原始持久化 Stop 仍为 RUNNING/WAIT_REVIEW。原始失败报告保留不变；随后显式调用标准存储和回执恢复接口，记录 OWNER_LOST、关闭旧审查轮及等待，把整体状态记为 UNVERIFIED。16 条单项回执和原始请求证据保留，恢复没有调用模型。

这次显式对账**不是自动宿主重启恢复已验收的证据**。根据此发现，当前工作区随后补上了评估拥有者和审查范围的持久身份、死进程恢复、原截止恢复计时，以及旧迟到事件不能取消新等待链的围栏；这些后续代码只有本地回归覆盖，没有混入本次真实模型快照。

## 可追溯证据

证据目录为 [.runtime-correction/test-temp/ma-python-sort-live-20261025-02](../../.runtime-correction/test-temp/ma-python-sort-live-20261025-02)，被 Git 忽略但保留在工作区：

- `sort-experiment-result.json`：原始 FAIL 报告，不用后续恢复改写。
- `post-trial-verification.json`：独立 Python 验收、16/17 未核验范围、最终释放和对账结果。
- `model-request-metrics.json`、`comparison-observations.json`：真实上游请求、用量及读取日志统计。
- `budget-exit-before-reconciliation.json`、`budget-exit-after-reconciliation.json`：保留恢复前后的实际状态，恢复没有产生额外模型请求。
- `source-admission.json`、`source-identity-after.json`：实验插件快照的 277 个源码/配置文件在结束后全部匹配。不能据此声称后续已修改的工作区也参加了该次实测。
- `K1-summary.json`、各组 `review/events.jsonl`、宿主 `gateway.jsonl` 和 `wire.jsonl`：逐项保存、工具、真实宿主运行及完整链路轨迹。

本次验证了简单排序实现和真实分组协议，但没有覆盖真实模型发现偏差后的业务返修、TodoList、真实 17/20 分钟边界或固定 GT 下的性能对照。
