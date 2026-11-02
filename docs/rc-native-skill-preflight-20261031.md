# 原生 Skill 三案组件资格

三案runner与共享接线已完成离线核验，尚未启动真实Skill模型批次。代码为`scripts/evaluate-native-skill.mjs`，资料位于`.runtime-correction/native-component-preflight-20261031/skill-component-001/`的`batch-manifest.json`和`qualification.json`。

## 实际运行顺序

每案采用独立虚构项目、原始用户请求和隔离profile，共用同一个提供方计量账本与绝对deadline。先从空账本执行真实原始任务refresh，再通过生产PreToolUse Skill提取完整原始Skill、发布真实非空约束图并建立ACTIVE watcher。只有检查已发布watcher仍ACTIVE且source digest匹配后，driver才实际运行`node verify.mjs`。成功/失败按真实退出码、stdout/stderr和匹配invocation ID记录；孤立结果案明确没有真实调用，不冒充运行证据。

这些记录明确标记`controlled-component-driver`，不称模型业务历史或宿主原生工具回执。完成尝试通过生产Stop watcher检查和真实factory.handoff执行；保留原始evaluation、watcher状态及准备反馈，语义由监督方独立核对。没有手填claim、Skill约束图或watcher。

专用类型为`native-skill-triplet-v1`/`metered_native_skill_batch`，临时凭据名`RC_NATIVE_SKILL_API_KEY`。仅允许ground-truth-extractor和skill-reviewer；普通Skill角色必须具有当前真实reviewer scope及Skill care，仅开放read和rc_skill_care。不可变native-run上下文和当前case所有权拒绝旧run/旧case回调，原有bounded任务读取围栏保留。

转录可在模型阶段之间追加实际受控工具历史；原始字节前缀不能修改，追加内容必须有driver来源标记，不能新增用户权威。每次更新记录前后SHA与长度，不重置请求计数、案例数量或deadline。其他原始文件保持不变。

## 已完成的无模型证据

共享6个文件38项检查全部通过，覆盖文档定位与缓存修复、旧Stop/计量守卫、Skill真实scope及旧run/case隔离、追加转录的来源/计数边界、取消/未准入先拒绝、实际本地exit0/3和孤立结果。local-helper单测使用受控准入回调，不算真实watcher语义验收。

安装版OpenClaw 2026.7.1-2的真实Skill提取器已完成一个原生私有调用、两次受控HTTP，body为14334/30706字节。实际read与rc_skill_care结果进入第二请求：完整Skill原文132字节，SHA与冻结文件匹配，nextOffset=null；执行库存只有execution/0原始用户，没有未来命令/结果。没有发布伪造约束图或watcher，也没有执行验证器。真实模型请求0、该离线过程在途0，semanticAcceptance=null。

离线只跳过初始任务baseline并以panel.size=0隔离直接Skill提取；生产增量提取和实际PreToolUse路径保持。真实模式保留默认onboarding配置，但先真实发布任务基线，随后按生产已有账本规则进入Skill提取。首次离线只证明此角色、当前原文与私有工具接线，完成检查及三案语义仍须真实运行。

## 监督方启动

```sh
TMPDIR=/private/tmp node scripts/evaluate-native-skill.mjs --live \
  --host-root /opt/homebrew/lib/node_modules/openclaw \
  --manifest .runtime-correction/native-component-preflight-20261031/skill-component-001/batch-manifest.json \
  --output-root .runtime-correction/native-component-preflight-20261031/native-skill-live-001
```

由监督方在内存中向临时子进程注入`RC_NATIVE_SKILL_API_KEY`。清单当前引用settlement-010的103次请求/保守参考USD11.175444，包含此前未知usage预留，实际账单未知。若Gateway或其他批次先结算，启动前须由唯一owner同步最新结算与新鲜度；不并发启动两个真实批次。

防故障参数为60次HTTP、每案20次、共20分钟，输入预留262144、完整body131072字节、输出32768，参考USD帽160；新增最坏参考USD153.354240，按当前seed累计USD164.529684。用户总token/API不设限；未知usage仍停发，不删除失败与重试成本。启动新鲜度截止为香港时间2026-10-31 08:11:05（UTC 00:11:05.284342Z），输出及claim必须全新。

基础结算不等于语义验收。监督方须检查实际失败是否产生有归属的偏差、成功是否无多余纠偏、孤立结果是否未被当作执行证明，并核对完整原始Skill、真实watcher建立时点、全部调用/反馈/费用。自动宿主激活、反馈送达、模型业务修复、正式bench和效率收益仍另验。
