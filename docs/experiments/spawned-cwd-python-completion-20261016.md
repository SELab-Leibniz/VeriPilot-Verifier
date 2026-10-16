# Python App 闭环补验与证据归属提示修复

2026-10-16，继续 [前次实验](spawned-cwd-python-20261016.md) 的终审与无配置项目验证，结果仍为 **MIXED**。原 B 的负向纠偏闭环跑到失败终态；无配置项目实际写入和重启检查通过。不能声称整轮完整通过：`.7` 正向对照因归属错误停在未验证；修复后的 `.8` 又实际违反路径实验要求，任务终审已落盘 DEVIATION，但观察器过早关闭使最后的原生 Stop 尾部回执未结算。

[机器可读结果与校验和](spawned-cwd-python-completion-20261016.json)。本轮没有再次触及实验请求上限，也没有供应商额度错误；未再追加 B 模型会话追求全绿。

## “请求上限中止”的含义

前次 60／24 是**实验观察器统计的总模型请求上限**。业务模型、需求提取、Stop Reviewer、实现 Reviewer，以及模型调用工具后的继续请求，都计入总数；达到上限时观察器主动关闭私有 Gateway。它不是供应商额度错误，也不是 RC 的纠偏次数 `k`。

关闭网关后，旧进程已结束。补验通过真实宿主发送新的业务消息，不能称为原请求自动断点续跑。没有编辑任务文件来伪造恢复。RC 配置仍是最多一次纠偏、单 Reviewer 240 秒、单次最终评估 720 秒；没有提高这些预算。

本轮分三步：续完原 B；用独立 Session 做一次正向对照；对实测发现的归属错误做最小提示修复，再用一个新 Session 验证。只验收现有 App，没有重做从空开发，也没有反复启动相同失败任务争取 PASS。

## 原 B：负向闭环确实完成，最终没有通过

原 taskId `oc-scope-96472897-9edc-4d5a-b3b9-e35e15b1a054` 的实际链路是：

1. 同一业务 Session 续验，实际运行 App 后交付。
2. 真实 Stop／实现终审得到 DEVIATION。
3. RC 派发一次原生续作，业务模型实际观察反馈并修改 `about` 的 JSON 输出格式。
4. 实现复验不再有源码缺口，但首轮历史路径违规仍存在。
5. 最终 `COMPLETED_WITH_ISSUES / DEVIATION`，k=1、预算耗尽。此次使用 36 次模型请求，没有触及实验请求上限。

原 B 的提示明确要求相对路径、禁止传 cwd/workdir、禁止 cd。原始工具轨迹却有绝对路径 read/edit 及多次 `cd ".../B worktree" && ...`；有原始要求和可归属业务调用支持，不能通过后续合规动作消除。这项约束是为本次验证宿主目录而明确写入的**实验要求**，不是 RC 默认给普通 App 开发增加的门槛。它不证明宿主目录解析错误。

初轮的另一条反馈把 `exactly ... as JSON` 解读为紧凑字节输出。原独立验收使用 JSON 结构等价，空白措辞存在解释空间；不据此认定项目绑定缺陷，也没有为此加入通用字面匹配。原生模型已修改格式。末轮只剩有独立事实支持的路径违规，因此该格式争议不决定末轮失败。

原生续作 runId 为 `e39399c8-efc4-415a-818e-4006d5b73b90`，记录有 `modelObservedAt`；首末评估及原业务调用保存在 `completion-negative-proof.json`。没有替换原 FAIL、重写需求、重置旧预算或声称这个原任务最终 PASS。

## `.7` 正向对照：保守停在未验证，定位到混合条款

新 Session 的 taskId `oc-scope-e668bfa0-9271-4184-beea-82cc35ea0dd3` 与旧任务独立。它实际遵守相对路径要求，源码功能也已满足，但冻结基线把原 R05 的“只编辑指定文件、保护其他文件、交付前实际测试”等过程义务整个标为 `IMPLEMENTATION`。

因此源码 Reviewer 收到 `M12:requirements-98a55ff653fa71aa` 后正确指出无法仅凭源码证明这些过程事实，返回 `CHECKER_ERROR / EVIDENCE_OWNER_MISMATCH`。原有有限基础设施重试后仍未审定，终态为 **STOPPED_UNVERIFIED / UNVERIFIED、k=0**，使用 41 次请求；没有把一般评审的 PASS 冒充实现终审通过。这次同样没有触及观察器请求上限。

这是证据归属错误，不是 Python App 必须再补某个功能，更不是宿主目录错误。重复评审不保证能修复冻结的错误分类；这份旧基线和未验证结果原样保留。

## 最小修复及 `.8` 验证

提交 `181ba6e` 只在共享 `VERIFICATION_ROUTING_INSTRUCTIONS` 增加一条提示：一个 claim 应对应一种证据归属；同一来源语句若混合应用／文档行为与任务执行过程，先按原意拆分再分配目标；材料标题或段落编号不决定其全部是实现要求。保留原意、适用范围和强制程度，不把“不需要”的建议升级为禁令。

没有新增分类器、正则路径规则、路由修复器或评审角色；没有改变提取算法、输出结构、分派实现、失败保护、预算与 Stop 复验机制，也没有修改旧任务的冻结 claim。新候选为 `1.9.1-openclaw.11-session-projects.8`，宿主仍为本机 `/opt/homebrew/lib/node_modules/openclaw` 的 `2026.7.1-2`。

修复后只创建一个新 Session，在同一真实 B Worktree、同一未修改的合同和 RC 配置下验收既有 App。新 taskId 为 `oc-scope-d0c7e652-9822-467f-9d6d-7d416c0455ec`。实际初始及最终基线保留 R05，并将其标为 PROCESS；它仍由 Stop Reviewer 用过程证据检查。两次源码评审均 COMPLETED、无实现缺口、无归属检查器错误；核对的 10 个源码评审对象均归属于 IMPLEMENTATION。修复有效地避免了这次材料的错误证据归属，不代表语义提取从此不会出错。

但这个 Session 的业务模型仍真实使用了绝对路径 read、显式 workdir 和 cd。原始 wire 的工具参数与 Reviewer 引用相符，不能算作误报，也不能用后来的合规操作消除。RC 实际派发一次原生续作、模型观察反馈并复验；最终任务状态为 **COMPLETED_WITH_ISSUES / DEVIATION、k=1**，本阶段使用 41 次模型请求。应用功能没有因此失败，失败原因是明确的路径实验约束。没有接管工具路径或修改 OpenClaw 来强制模型合规。

补验观察器另有一个竞态：它见到 `correctionBudgetExhausted` 就退出，没有等待对应 Stop 回执 SETTLED。因此 `.8` 末轮评估与任务状态已持久化，而该轮回执仍显示 RUNNING、owner 进程已退出；它不能算完整的最终回执生命周期证明。这是观察器的问题。已只修诊断脚本，改为等待匹配 evaluationId 的回执结算后才因预算耗尽退出；该等待修复只做语法检查，没有再发 B 模型请求复跑。旧回执未手工改写，重启时也没有伪装成已完成。

## 收尾结果

| 项目 | 实际结果 |
| --- | --- |
| 最新 Python App 功能 | 独立 CLI **9/9 PASS**，含 Unicode、跨进程持久化、done、未知 ID 不改存储、about 不改存储；观察器结果不冒充业务模型的过程证据 |
| 未启用 RC 的项目 | 宿主 source=host、RC_PROJECT_NOT_ENABLED；真实相对 write 创建 `off-only.txt`，只有 **2 次业务模型请求**，没有额外 Reviewer、基线或 `.runtime-correction` |
| 缺失字段回退 | 收尾后清除私有 Session 的 spawnedCwd，原手动 C 绑定恢复，来源 rc；不改宿主默认目录 |
| 实际 Gateway 重启 | 新增模型请求 **0**；A/B/C 全部任务的身份、基线、预算及验证状态未变，原失败和未验证状态保留 |
| 文件保护 | 九个冻结 spec/AGENTS/RC 配置哈希未变，宿主默认工作区没有 App 或 RC 运行目录 |
| 清理 | 最后的观察器与 Gateway 均退出，端口 19946 关闭；临时 key 文件删除，实验、旧归档及直接复核目录扫描无该 key 明文 |

本轮模型请求为原 B 收尾 36、`.7` 正向对照 41、`.8` 修复后对照 41、无配置项目 2，共 **120** 次；与前次 85 次合计 205 次。没有提高 RC 的一次纠偏预算。范围止于上述实测和最小提示修复；没有为了得到一个 PASS 再开第四个 B Session。

## 测试与证据

- `.8` 提示修复后的 onboarding、原生材料契约、实现评审和 OpenClaw 回归：**92/92 PASS**，约 12.3 秒。没有为提示文字添加照抄实现的测试。
- 前次 `.7` 全量 831 项中 829 PASS、2 项 Windows 专用测试跳过，属于前次验证；本次不将其写成 `.8` 重新全量执行。
- 旧证据在继续追加日志前完整复制到 `/private/tmp/rc-spawned-cwd-python-20261016-before-completion`；前次仓库 JSON 中列出的 28 个原始文件 SHA-256 均与该归档一致。
- 当前实验路径仍为 `/private/tmp/rc-spawned-cwd-python-20261016`。各阶段使用独立文件名前缀 `completion`、`positive-control`、`routing-fix-control`，不覆盖先前阶段的请求、结果和失败状态。
- 没有修改 OpenClaw 源码或用户正式配置；没有安装到正式实例或推送分支。这仍是宿主状态隔离，不是操作系统文件访问沙箱。

诊断入口为 `scripts/diagnostics/spawned-cwd-python-completion.mjs`；原样执行版本按阶段保存在实验目录，最后独立无配置项目脚本为 `driver-off-completion.mjs`。`completion-negative-proof.json`、`routing-fix-ground-truth-{initial,final}.json`、`routing-fix-business-proof.json`、`B-final-acceptance.json`、`off-completion-summary.json`、`all-projects-final-state.json` 及 `completion-post-cleanup.json` 保留具体证据，仓库 JSON 索引其 SHA-256。没有修改或安装用户正式宿主，分支尚未推送。
