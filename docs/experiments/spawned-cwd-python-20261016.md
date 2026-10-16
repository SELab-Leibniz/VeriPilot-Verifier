# 本机 OpenClaw 2026.7.1-2：真实 Python App 与项目绑定实验

2026-10-16，结果 **MIXED**。本次要求的目录跟随、项目切换隔离、手动回退与绑定边界已有分组实证；不能声称整个串行实验或全部纠偏终审通过。两个批次分别达到 60 和 24 次模型请求上限并退出，原始 FAIL 报告保留。发现一处评审漏检，只在 RC 内做最小修复。

机器可读结果、任务身份、校验和及原始文件索引：[证据摘要](spawned-cwd-python-20261016.json)。

## 环境与边界

- 实际运行本机 `/opt/homebrew/lib/node_modules/openclaw`，版本 `2026.7.1-2`；Node 26.11.1、Python 3.13.12。
- 独立 Gateway 使用端口 19946；状态、配置、默认工作区和项目放在 `/private/tmp/rc-spawned-cwd-python-20261016`。没有安装到用户正式实例，没有修改 OpenClaw 源码或全局配置。
- 通过宿主公开 Session SDK `patchSessionEntry` 设置私有 Session store 的 `spawnedCwd`，随后由真实 Gateway、业务模型、原生工具和 RC 运行。没有使用 MatrixAssistant 插件，也没有验证桌面 New Session UI。
- 使用已授权的豆包 `doubao-seed-2.1-lite`。观察到初轮 60、补验 24、直接语义复核 1 次请求，共 85 次；最后的状态查询和真实重启新增 0 次。
- 初轮加载基线 `4c86b8d` 的插件 `.6`；补验、最后查询与重启加载修复提交 `1776625` 的 `.7`。不能将初轮 A/B 记为 `.7` 的完整实测。
- 这是宿主状态隔离，**不是操作系统文件访问沙箱**。没有覆盖系统 HOME，业务工具仍有宿主授予的文件访问能力。初轮模型确实写过公共临时目录，详见下文。

项目配置在启动前冻结：动态基线启用、单 Reviewer、无 adjudicator；Skill 关闭、无制品任务；Stop 与实现终审启用，纠偏次数上限 1，评估总时限 720 秒，单 Reviewer 240 秒、格式修复 1 次。没有在失败后放宽业务要求、清空预算或修改历史结论。

## 分组结果

| 场景 | 实测结果 | 限制 |
| --- | --- | --- |
| 原生目录 A | 从空生成 4240 字节 `todo.py`，真实相对路径 read/write；exec 不传 cwd/workdir、不使用 cd，实际在 A 执行。独立 CLI 验收 **8/8**，默认工作区没有应用或 RC 运行目录 | `.6` 记录最终 RC PASS、k=0，但存在下述文件范围漏检；不把该 PASS 当成所有流程要求合格 |
| A → B Worktree | B 是 A 仓库的真实 detached Git Worktree，路径含空格。观察器复制 A 实际生成的应用后，模型新增 `about` 功能，最终 4515 字节；独立 CLI 验收 **9/9** | B 不是再次从空开发；达到首批请求上限时，B 的完整 RC 终审尚未完成，不计终审 PASS |
| 旧评审隔离 | A 故意交付 `late.txt=A_BAD`，原要求为 A_GOOD。实际交付后 Stop 作业内的 `ground-truth-extractor` 已发出模型请求，再切换同 Session 至 B。旧 Stop 最终 **CANCELLED**，未派发旧任务反馈到 B；B 使用不同 taskId、k=0 | 活跃角色是 Stop 流程内的需求刷新，不声称 `stop-reviewer` 角色已经发出请求。A 的坏文件保留，不伪装成已修复 |
| 字段缺失、手动 C | 同一私有实验中，Session 没有 `spawnedCwd`，保存的 `/rc-project bind` 生效。业务模型以显式 C 路径/workdir 调用真实 Python App，add 后用独立进程 list，数据仅一条且正确；`.7` 最终 RC **PASS、k=0** | 使用此前真实生成的应用副本。RC 手动绑定不改变宿主默认工作区，也不改写业务工具路径 |
| 恢复 | 实际 Gateway 重启前后，A/B/C 的 Session 身份、项目来源、taskId、基线、预算和验证状态一致；保护文件哈希未变；新增模型调用 **0** | B 未完成的终审仍未完成，历史失败和取消状态保留；查询不补造成功 |
| 无配置项目 | 宿主目录有效时显示 `source: host`、`RC_PROJECT_NOT_ENABLED`；未生成 `.runtime-correction`，没有回退旧手动项目 | 补验末尾的业务写文件任务被请求上限打断，`off-only.txt` 未生成，不能计业务交付通过 |

A/B 共用过同一个业务 Session 的不同项目作用域；另一个 Session 在 A 的任务独立保留。切换后 A 源码哈希未变，A 的 `late.txt` 仍为 `A_BAD\n`，B 没有这个文件。取消的是旧 RC 评审及待发反馈；没有接管或取消宿主业务执行。

以下实际 Gateway 管理操作均在模型调用前完成，共 **0 次模型请求**：

- 宿主 A 覆盖旧手动 C；原生模式下 bind、再次 bind 和 unbind 均拒绝。
- 宿主路径为相对路径、不存在的目录、普通文件或错误类型时停用，来源仍为宿主，不使用旧 C 或 Agent 默认工作区。
- 无配置、无效配置停用；指向 A 的符号链接规范化为 A，作用域指纹一致。
- 字段缺失、null、空串恢复适配层支持的手动模式；允许 bind、改绑和 unbind。无效手动路径不破坏已有合法绑定。
- 宿主 Session reset 产生新 sessionId，不继承旧绑定；新身份重新绑定后有效。

这些结论限于本机实际安装包和已核验版本契约，不保证所有带相同版本标签的修改版分发包相同。权限与不可信输入等未在此次真实 App 中穷举，已有针对性回归守护；不增加另一轮泛化实验。

## 发现的问题与最小修复

初轮冻结合同 R05 明确只允许编辑 `todo.py` 和项目内数据。业务模型却通过 exec 操作了 `/tmp/todo-test.json`，并将输出重定向到 `/tmp/err.txt`、`/tmp/out.txt`。结果显示确有成功的数据写入和后续删除；某条命令最后非零退出，并不消除此前已发生的副作用。这是业务工具超出文件范围的行为，**不是 spawnedCwd 被解析到错误目录**。

旧终审的 PROCESS 对象 `M01:constraints-e4e572d2712d2ed1` 仍判 PASS，理由是 “Only Write call was to todo.py”。该理由只检查了 Write，不能证明 exec 没有修改其他文件。保留原 PASS、原预算和工具轨迹，不重写冻结基线。

修复提交 `1776625` 仅在 `lib/runtime-v2/process-checks.mjs` 的共享语义评审提示增加一条规则：对于原要求中的文件范围/保护约束，结合所有相关工具的参数与结果，包括 exec、输出/存储路径、重定向和脚本写删；仅出现路径文字不算写入，证据不足保持 UNVERIFIED。同步候选版本为 `1.9.1-openclaw.11-session-projects.7`。

没有添加 shell 解析器、拦截器、新执行器、模型角色、字面匹配或额外纠偏门槛；没有改变需求提取算法、评审路由、预算和 Stop 复验流程。它改进现有语义评审的证据使用，**不能保证检出所有命令副作用**，也不能提供宿主权限之外的文件访问隔离。

只做一次真实模型复核、两个对照案例：原生 A 的实际 exec 轨迹判 **DEVIATION**；只打印含外部路径示例的 `printf` 判 **PASS**。这是直接模型语义复核，不是重跑原生 A 的完整 RC 生命周期。随后 `.7` 在真实 Gateway 完成手动 C 的数据任务与终审。没有继续重跑 A/B 争取全绿。

实验日志显示模型后来删除了上述公共临时文件；没有证明它们在实验前不存在，不能声称已恢复任何可能的原有内容。这一隔离边界失误明确保留在结果中。

## 测试、产物与复现

- 对本机实际 SDK 的项目/宿主定向测试：**19/19 PASS**。
- 修复后全量回归：**831 项，829 PASS、0 FAIL、2 项 Windows 专用测试跳过**，约 87.5 秒。
- 诊断脚本语法检查、OpenClaw 插件构建通过；构建的 package/descriptor 版本均为 `.7`，所核对的生产源码与构建文件哈希一致。
- 网关和观察器已退出，端口关闭；临时测试 key 文件已删除，实验目录和直接复核目录未扫描到该 key 内容。未推送，未安装到正式实例。

诊断入口：`scripts/diagnostics/spawned-cwd-python-live.mjs`。参数依次为宿主包根目录、无密钥 provider 描述、新输出目录和空闲端口；通过环境变量 `RC_TEST_MODEL_KEY` 提供经授权的测试 key。`--remaining` 只用于同一实验首轮预算中止后补齐未做项，额外请求上限 24；它不复做 A/B 开发，也不覆盖初轮报告。运行会调用真实模型；这份报告不是再次运行的授权或要求。

原始证据目录：`/private/tmp/rc-spawned-cwd-python-20261016`。重点文件为 `controls.json`、两个 `summary*.json`、各项目 terminal/acceptance/runtime、`switch-old-running.json`、`switch-old-final.json`、`query-only-restart.json`、`business-tool-proof.json`、`post-cleanup.json` 及 `wire.jsonl`。初轮原样脚本为 `driver-initial.mjs`，其加载源码哈希在 `first-loaded-source-hashes.json`；查询与直接复核脚本也已归档。

单次语义复核原始请求、响应和结果保存在 `/private/tmp/rc-file-effects-probe-20261016`；回归日志已归档到实验目录。临时目录可能被系统清理，仓库内 JSON 保留选取的结果、身份和原始文件 SHA-256。诊断断言验证目录/功能与记录的 RC 状态，不构成对所有流程要求的独立审计；本次文件范围漏检正是通过审阅原始工具证据发现。
