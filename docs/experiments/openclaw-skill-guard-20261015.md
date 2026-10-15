# OpenClaw 2026.7.1-2 原生 Skill 看护实测

2026-10-15（Asia/Hong_Kong）完成真实模型验证，候选插件 **1.9.1-openclaw.11-session-projects.3** 在本机 **OpenClaw 2026.7.1-2** 上通过小 Skill 的正常执行与错误完成宣告两种实验。业务模型、Skill Reviewer、Stop Reviewer 和纠偏续作均由宿主实际运行，不使用替身结果。

## 小 Skill 与发现的适配缺口

新增可复用示例 [rc-mini-note](../../examples/openclaw-skill-guard/skills/rc-mini-note/SKILL.md)：输入业务项目绝对目录和标题，写入只有 `title`、`status=ready` 的 `note.json`，实际执行自带只读校验器，得到 `NOTE_VERIFIED` 后交付。用法及 RC 配置片段见 [示例说明](../../examples/openclaw-skill-guard/README.md)。

发现的问题位于 OpenClaw 适配层：旧版 RC 的 Session 绑定只选择业务纠偏项目，不改变宿主工作区。原生 Skill 可以来自宿主工作区的 `skills/`，但旧适配只在绑定项目、插件及显式配置的 Skill 根目录中识别读取。工作区与绑定项目分离时，真实 `read SKILL.md` 会返回“没有选中 Skill”，不建立 watcher；即使只补调用识别，后续源码解析仍可能找不到同一 Skill。

修复在生成当前 Session 的有效配置时，将宿主可信、绝对的 `executionDirectory/skills` 加入 Skill 源目录。调用识别、约束提取和后续源码刷新使用同一份有效配置。不猜测 Agent 默认目录，不改变业务工具路径，不修改项目配置文件。新增定向回归同时验证真实 runtime hook 创建 watcher、源码目录一致、记录仍写入绑定业务项目，以及缺少可靠目录时不猜测。

生产修改只有 OpenClaw 适配的配置衔接与目录补充，另更新候选版本；没有修改需求提取、Skill/Stop Reviewer、纠偏预算或纠偏核心算法，也没有改动 OpenClaw 源码。

## 完整成功实验

在全新隔离网关中，启动前将 Skill 放入原生工作区 `default/skills/rc-mini-note`，通过宿主 `skills.status` 确认来源为 `openclaw-workspace`、eligible、userInvocable、commandVisible。A/B 分别绑定不同业务项目，**均不配置 `skillRoots`**，再通过原生 `/skill rc-mini-note` 调用。

| 验证项 | A：负向故障 | B：正常对照 |
| --- | --- | --- |
| 原生 Skill 加载 | 真实 read，调用编号与 watcher 对应 | 真实 read，调用编号与 watcher 对应 |
| 首轮业务行为 | 写入 draft，不运行校验器，却明确宣告“Skill执行完成” | 写入 ready，真实执行校验器 |
| Skill 专门评审 | DEVIATION，指出完成宣告缺少正式合同前置条件 | PASS，无偏离 finding |
| 反馈与修复 | 宿主原生续作 ADMITTED，反馈被实际观察；修正 ready 并运行校验器 | 无续作 |
| 最终 Stop / 交付 | COMPLETED / PASS，续作回执 PASS | COMPLETED / PASS |
| Stop 纠偏次数 | 1 | 0 |
| 独立校验 | NOTE_VERIFIED | NOTE_VERIFIED |

A 的 finding 明确引用首轮完成宣告、真实 draft 文件和缺失的 verifier 调用，根因为 `MILESTONE_EVIDENCE_GATE_BYPASSED`。Skill 反馈计数为 1。A 的实际 verifier 调用属于纠偏续作的 runId，B 的调用属于原业务 runId；两次宿主 exec 都实际返回 `NOTE_VERIFIED`。观察器另起 Python 进程独立校验，两份实际文件均通过，未修改业务产物。

A/B taskId、sessionId、watcher 与反馈预算分开，实际评审有 8 对重叠区间；业务产物和运行目录写入各自绑定项目。Skill 及校验脚本哈希、RC 配置保持不变，宿主默认目录未产生 RC 运行目录。

A 的 watcher 保留历史 DEVIATION，这是首轮错误执行的真实记录。修复后的通过由最终 Stop、已完成的续作回执及实际校验输出证明，没有把历史 watcher 改写为 PASS。

## 未计为成功的试验

首轮 `/private/tmp/rc-skill-guard-legacy-20261015` 显式配置了 Skill 根目录。模型收到普通产物检查的 passed 提示后提前修复，未留下预期的错误首轮交付；因此观察器 FAIL，不能把这次修复归为 Skill 偏离检出。该轮使用 `.2` 候选。

第二轮 `/private/tmp/rc-skill-guard-legacy-20261015-r2` 已使用 `.3`、不配置根目录，能创建正确 watcher，B 也真实 PASS。但 A 的报告明确写着“非最终交付、未验证”，Skill Reviewer 返回 NOT_COMPLETED、无 finding；这个案例不足以证明“漏做校验却宣告完成”的检出。A 的 Stop 模型调用另发生超时，先记 UNVERIFIED，再进入既有重试，未虚构 PASS 或消耗纠偏轮次。观察器保留快照后中止被替代试验，没有伪造整轮总结。

最终成功轮 `/private/tmp/rc-skill-guard-legacy-20261015-r3` 关闭无关产物评审，明确注入错误完成宣告。首轮 draft 和完成文本、Skill finding、原生反馈观察、实际修复与校验、最终 PASS 均在同一轮取证。负向完成宣告是隔离实验故意注入的错误，不是推荐的正常 Skill 行为。

## 校验、复现与范围

- Skill 通过 `skill-creator` 的格式校验；自带校验器 6/6 行为检查通过，涵盖正确值、错误状态、错误标题、额外字段、损坏 JSON 和文件缺失，均不改写文件。
- 本轮全量回归实际输出：798 项、796 PASS、0 失败、2 项既有 Windows 平台跳过；插件构建、脚本语法及差异检查通过。
- 成功网关加载的 62 个适配层及纠偏核心文件与最终源码逐一核对，无差异。原始文件位置、哈希、调用编号和输出见 [JSON 证据](openclaw-skill-guard-20261015.json)。
- 使用 `scripts/diagnostics/session-skill-guard-live.mjs`，依次传入宿主包目录、provider 描述 JSON、新建输出目录和空闲端口；凭据通过 `RC_TEST_MODEL_KEY` 环境变量注入。观察器不写业务产物。原生 verifier 的额外取证检查也已对留存 wire trace 执行，并写入可复用诊断脚本。

真实运行环境为 macOS、Node 26.11.1、Python 3.13.12，使用用户授权的 `doubao-seed-2.1-lite` Coding Plan 接口。此次验证的是原生 `/skill` 与标准工作区 Skill 目录；自定义目录沿用显式 `skillRoots` 配置，未宣称所有宿主 Skill 布局或 UI 均已覆盖。

全部实验进程已退出，临时凭据文件已删除，宿主在隔离状态内生成的模型注册文件已脱敏。一次按存储 PID 强制清理的请求被自动审批以 PID 复用风险拒绝；该请求未执行，随后只读核验确认此前正常终止的两个进程均已退出，无遗留阻塞。
