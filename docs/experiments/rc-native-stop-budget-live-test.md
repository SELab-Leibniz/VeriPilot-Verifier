# 原生 Stop 独立预算 Todo 隔离实测（2026-10-12）

从 c29ca4c 创建 codex/openclaw-native-stop-budget。代码提交 0116513。仅修改 RC，OpenClaw 固定2026.7.1-2，GLM-5.3-Flash；原分支、原安装与宿主设置未改变。本实验不自动合并。

结论：独立预算与原生回复分离已修复，真实完整终审可以完成。原候选本轮在一般终审的格式修复阶段耗尽约10分钟共享窗口，最终UNVERIFIED、未进入实现验收；修订候选完成需求刷新、一般终审和实现验收，最终RC记录PASS。不能把该结果扩展成App全部需求通过或完成度提高：两组独立功能验收为21/22和20/22，均漏掉CSV同路径覆盖JSON，新候选另漏结构损坏报错中的文件路径。没有把独立失败结果预先喂给模型，也没有代宿主修改App。

| 指标 | c29ca4c 基线 | 0116513 修订候选 |
|---|---:|---:|
| 独立首轮/最终功能验收 | 21/22 → 21/22 | 20/22 → 20/22 |
| RC终审 | UNVERIFIED | PASS |
| 实现Reviewer | 未进入 | COMPLETED |
| 业务纠偏次数 | 0/3 | 0/3 |
| 原生文字增量/工具事件 | 164/40 | 171/33 |
| 首次原生交付后缓存派发结束 | 约602.8秒 | 约2.1秒，含独立检查观察开销 |

候选独立RC终审实测547.902秒：需求刷新约43.050秒、一般Stop 386.074秒、实现验收118.526秒。宿主回复已经结束、RC仍在评审时，真实浏览器能看到完整交付报告且没有working状态。角色均配置1200000ms（20分钟），RC总窗口沿用本轮配置3600000ms（60分钟），宿主Hook仍600000ms。RC主任务预算与每个Reviewer预算含义不同；总窗口未配置时沿用既有角色预算与设备预算之和，不新增同义字段。

实现：回复/自有续作结束Hook只保存PENDING回执并返回。RC经公开session.runWithWorkAdmission与自己的取消信号执行完整Stop，用directReviewBudget和固定job截止时间，角色按min(自己的timeoutMs, RC总窗口剩余)计时。没有注册before_agent_finalize或业务harness，没有扩大宿主模型、工具、审批、沙箱或业务超时。新用户轮、重置、会话结束、Gateway关闭仍取消旧检查；原来源、证据和决策失效保护保留。已经确认的业务偏离仍用原native-followup机制与k预算。

基础设施故障按原核心有限重试预算复评，复评使用独立评审身份，避免同一个幂等身份反复读取首次失败；不重置job总期限，不消耗业务k，不让宿主为检查器故障盲目改业务。回执位于.runtime-correction/openclaw/native-stop-reviews，保存PENDING/RUNNING/SETTLED与reviewStatus。重启遇到未结记录保留UNVERIFIED且不重放旧业务派发。

回归：702项，700通过、2跳过、0失败。包括慢评审前快速登记、短Hook窗口下连续角色保留自己的预算、重复回调/重启不重放、取消不影响宿主信号、暂时故障自行复评、永久故障在原上限退出。测试夹具初次错误配置为Stop开启但GroundTruth关闭，按真实配置约束修正；又暴露重复评审身份导致读取缓存失败，修正后通过。模型实测过程中未热改候选代码或包。

程序引文核对：基线4条、候选195条，冻结内容哈希与选择行原文均一致。这仅证明引用来自真实位置，不证明判断覆盖所有失败输入；独立验收揭示的漏检如实保留。保护文件AGENTS.md、reviewer.md、config.yaml逐字节未变，两组包哈希未变，原openclaw.json、exec-approvals.json、已安装插件文件未改变。

协议：完整同一原始Todo/OpenSpec需求、同一模型/API、角色20分钟、格式修复3、k=3、Hook10分钟、业务每轮60分钟、RC总窗口60分钟。均从空业务目录开发，无预埋缺陷。共同增加Git基线与只读Git检查许可，使原需求的Git范围验证可实际执行；相对上一轮是共同夹具改动。临时exec full/ask-off、sandbox-off仅存在两组隔离配置，未测试真实审批UI和外部渠道。观察器等待私有Reviewer、自有RC任务和续作全都结束；保留有真实chat.error对应的缓存错误，不重发用户请求。

局限：一次配对开发，需求提取145/102条及产物不同，前期耗时差不能归因于只在交付后执行的预算修订。候选本次真实终审约9分8秒，没有物理跨过10分钟；实测证实宿主回复不等待且完整终审完成，独立窗口的结构与短窗口回归另有代码/测试依据，不能宣称已覆盖所有极长任务。两组均没有因业务偏离产生真实续作，本轮未把既有续作合同测试当新的真实纠偏收益。App自测OK及RC PASS都不能替代独立验收；尚未证明App完成度提高，不自动合并。

配置示例：
```yaml
stopCorrection:
  enabled: true
  maxCorrectionsPerEpoch: 3
  assessmentTimeoutMs: 3600000 # 可选，整套RC终审总窗口
reviewers:
  defaults:
    timeoutMs: 1200000        # 每个角色的预算
    formatRepairAttempts: 3
```

全部证据：/private/tmp/rc-native-stop-budget-20261012，含原始请求、会话/wire、首轮业务快照、22项CLI检查、Stop记录、job回执、quote-audit与integrity文件。可提交的精简结果在native-stop-budget/comparison.json，检查脚本在同目录acceptance.py。没有更改OpenClaw代码、替换安装或合并目标分支。
