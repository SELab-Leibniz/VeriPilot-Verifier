# Skill 看护准入与评审错分派修复：隔离验证

结论为 **MIXED：两项局部修复及回归完成，Python 应用功能通过，真实 RC 终审未通过**。
保留原始失败，不以功能验收或已派发续作代替最终 PASS。

2026-10-15（Asia/Hong_Kong）。代码提交 `1de97b8`，分支
`codex/session-project-scope`，候选插件 `1.9.1-openclaw.11-session-projects.4`。
真实实验使用 OpenClaw **2026.7.1-2**、Node 26.11.1、Python 3.13.12，模型为
已授权的 `doubao-seed-2.1-lite`。宿主安装、源码和全局配置未修改。

## 修改范围

- Skill 提取使用条件化协议，要求有效的 `skillGroundTruth` 对象；普通 Stop
  仍可省略。复用原有格式修复次数、同一角色会话和截止时间，不增加模型角色。
- 约束文档必须成功落盘，taskId、skillId、源码摘要、结构和文档摘要一致，
  才能记录成功 cursor 并激活 watcher。已有 cursor 不能掩盖缺失或过期文档。
  提取失败记录 `SKILL_WATCH_NOT_ESTABLISHED`，不创建空的 ACTIVE watcher。
- 实现评审增加可选 `reasonCode: EVIDENCE_OWNER_MISMATCH`。明确错分派时
  保留原始判定，将有效结果归为 CHECKER_ERROR，复用既有有限故障处理，
  不消费业务纠偏 k，也不以通用 Stop PASS 代替实现验证。
- 真正实现对象的普通 UNVERIFIED/DEVIATION 仍按原规则阻断。没有自动修改
  冻结标签、自动拆分需求、解析理由关键词或增加新分类器。
- 历史违规保留原判、审计和预算；只收紧反馈措辞，不承诺通用提前停派。
  没有修改指标算法、业务纠偏上限或 OpenClaw 业务工具路径。

## 回归结果

新增关键回归 **4/4 PASS**：Skill 缺字段的有限修复与失败准入；成功 cursor
但文档缺失/过期/损坏时重新提取；明确错分派保持未验证且 k 不增、有限退出；
真正实现证据不足仍覆盖通用 PASS 并使用原有纠偏机会。普通 Stop 缺 Skill
字段合法，以及真实 OpenClaw Reviewer 同一会话内格式修复，也在这些用例中检查。

全量回归执行一次，共 **814 项**：811 PASS、2 项平台条件 SKIP，1 项发现
npm 包与插件清单版本不一致。修正清单后，相关 OpenClaw 用例 **31/31 PASS**；
未重复全量测试。最终安装包已重新构建，包与清单均为 `.4`。

日志：`/tmp/rc-admission-full-20261015.log`、
`/tmp/rc-admission-package-recheck-20261015.log`、
`/tmp/rc-admission-focused-20261015.log`。

## 真实 Python 应用实验

观察器只做一次坏文件注入，不编写或修复业务实现；21 项 CLI 验收器沿用旧实验，
未降低功能标准。应用子进程通过审计钩子拒绝 socket 和派生进程，使用标准库、
本地 JSON 与 `-I -S`。模型调用仍连接已授权接口。

首轮从不存在 kitchen.py 开始，宿主业务模型实际生成 6281 字节源码，真实验收
21/21 PASS。Skill 约束成功落盘，包含 11 条。观察器在成功验收后 37 ms
将源码改坏，但业务模型在交付前自行检查发现回归，从先前保存的快照恢复源码；
该恢复早于首次 Skill Reviewer 启动。原始 FAIL 原样保留，原因是负向实验无效，
不能记作 RC 检出或原生续作成功。终态后独立验收仍为 21/21 PASS。该观察器
在负向样本失效后退出，因此本轮不具有有效最终 RC 验收结论。

首轮目录：`/private/tmp/rc-kitchen-admission-fix-20261015`。
模型生成源码 SHA-256：
`bc5a0620db868a5c917dbdfa0e2a81da8809b26a21ff9f660bc3192ca4b1c4f1`。
首轮发现发行清单标识仍为 `.3`，npm 包及实际纠偏源码已为 `.4`；
四个修改的纠偏源码哈希与最终提交一致。发行清单已同步修正。

第二轮使用这份真实生成、已独立验收的源码作为只读参考，在新的隔离网关、
Session 和项目中正式验收；两种发行标识均为 `.4`。业务合同不披露故障注入。
工作目录约束只针对应用及验收器调用，不包含首轮旧实验过度约束的所有目录查询。
观察器在真实验收成功后 42 ms 改坏文件，模型交付时文件仍坏，负向样本有效。
Skill 约束成功落盘，包含 19 条，真正启动了 Skill Reviewer，并记录一项
项目合同未直接读取的流程 finding。源码回归由 Stop/实现终审检出，不能把它
归功于 Skill Reviewer 的该 finding。

首轮 Stop 为 DEVIATION，宿主真实接收原生续作并观察到反馈；模型读取项目合同，
从只读参考恢复源码，再次真实运行验收器，得到 21/21 PASS。恢复后的源码与
原始通过版本逐字节一致，观察器未参与修复。两条续作回执均为 ADMITTED、
OBSERVED，最终复验状态均保留 DEVIATION，不能将接收回执视为通过。

但后两次评审阻断于四个读取顺序对象（M01、M08 两项、M11）。Reviewer
声称“第一次 kitchen.py 编辑早于实际读取 spec/requirements.md”，据此认定
历史顺序违规不可补救。原始工具记录与这个具体事实判断冲突：

- 初始业务 run 只有 read/exec 验收，没有业务源码修改；坏文件改写来自观察器。
- 原生续作中的项目合同 Read `call_bhsxu72y9fi9gwnw5d2jstyu` 于
  **05:46:45.423 UTC** 完成。
- 首次业务源码编辑 `call_5e2rayinj3te2kml1iwc5os8`（cp 只读参考至 kitchen.py）
  于 **05:46:52.298 UTC** 才开始，即晚于读取完成 6.875 秒。

因此不能把观察器改写归因于业务 Agent，也不能直接把上述“先编辑后读取”
理由当作已证实的历史事实。初始验收前确实没有直接读取项目合同，这是另一项
流程事实；它不证明编辑顺序违反，也不能据此自动豁免其他 HARD 要求。
本轮没有扩展到 Reviewer 的通用时序/行为归因修复。

最后一轮 Reviewer 另发生一次 JSON 尾随内容错误，格式修复耗尽该角色原有
240 秒截止时间。插件正确保留 UNVERIFIED，业务 k 不增；既有有限基础设施
重试随后返回有效 DEVIATION。最终 **COMPLETED_WITH_ISSUES / DEVIATION，k=2，
预算耗尽**。未增加预算、重置任务或追加第三个模型试验以取得 PASS。

终态后对实际恢复文件独立运行验收器，仍为 **21/21 PASS**。另外真实启动、
停止并重启网关，绑定、taskId、基线、watcher、失败状态及已用预算保持不变；
查询没有启动模型。该恢复验证 PASS 不代表任务终审 PASS。

第二轮目录：`/private/tmp/rc-kitchen-admission-seeded-20261015`。

模型实际生成的源码原样归档为
[kitchen.py](../../examples/openclaw-offline-kitchen/app/admission-20261015/kitchen.py)。
完整角色原判、工具顺序、回执、独立验收、源码哈希和原始文件引用见
[JSON 证据](offline-kitchen-admission-fix-20261015.json)。
七个实验进程均已退出；临时凭据文件已删除，宿主生成的模型注册文件已脱敏。
两个项目的冻结输入及 Skill 字节均未改变，默认工作区没有项目运行产物。

## 验证边界

本轮仅针对旧版真实宿主，不重复 v2026.10.3 的模型实测。
结构化错分派协议保证已明确报告的错误不会变成业务代码修复；不保证模型
从不误分类，也不自动纠正历史冻结标签。没有开发通用不可补救性判断器。
前次报告的两次缺 Skill 字段输出中，仅 `22341fc8…` 对应 Skill；
`c63bfa55…` 对应普通 Stop，省略该字段合法，不能作为第二次 Skill 协议失败。
