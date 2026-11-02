# 下一批建议：生产 Stop 原生判断与回执，一正一反

方案已获监督方批准进行无模型准备，原生 payload 捕获与四项边界检查已完成；本批没有新增真实请求。下面的真实语义实验仍待监督方核验并冻结派发清单。先测当前实现，不同时改prompt、指标或checklist。刚完成的Coding Plan批次只验证通道和合成工具，尚未取得最终模型判断。

复用现有`createOpenClawReviewerFactory` → `runOpenClawStopTask` → `runWorkspaceStopReview`，通过已安装OpenClaw的原生reviewer会话执行。现有`evaluate-stop-workspace.mjs`的单例/production路径可作为入口；隔离配置须明确采用用户指定Coding Plan base和`openai-completions`，不能直接运行仍用Anthropic配置的旧helper，也不新建通用评测框架。

| 场景 | 新编公开输入与产物 | 评分侧预期 |
| --- | --- | --- |
| 正例 | 原始任务：`next(value)`只接受整数0至9，必须返回value+1，不要求其他输入处理，不保存状态。toy代码为`export const next = value => value + 1;` | 所有自然适用义务被审查，最终PASS；无虚构偏差或多余修复要求 |
| 反例 | 完全相同原始任务，toy代码为`export const next = value => value;` | 指出原要求的返回值偏差，提交有效DEVIATION及当前源码引用；不能只给UNVERIFIED或空泛建议 |

两例分别使用全新的根目录和会话，相同模型/推理配置/策略。原始任务、派生账本和执行转录只含本批虚构材料。预期结论留在独立评分侧，不送模型。保留当前启用策略与全部自然适用对象，不用M16-only开关制造更低成本；没有文档/Skill/过程义务时不人为增加。手工构造的控制输入仅用于隔离组件，不据此证明基线提取或业务过程已经执行。

本批验收限定为Stop语义、原始工具引用、程序接收/结算及成本：实际模型调用、工具结果持久化边界、source citeId、逐项提交、全部适用对象完成和最终状态必须对应；保存正例误报、反例漏报、协议失败及所有重试。反例反馈需要有具体证据和可执行缺口。这里还不安排业务模型自动修复，反馈生成不冒充最终用户送达或完整until_pass通过。

启动前的必要无模型准备：

1. 捕获**该生产native会话**的完整初始prompt/tool schema和一次真实toy工具结果后的输入。允许必要RC通用控制文本及接口，不加入RC业务源码、其他仓库、私人AGENTS/记忆/历史、认证配置或bench答案。现有纯SDK捕获不能替代这一步。
2. 在实际文件读取前限制到本轮toy材料及RC生成的合成依据目录，拒绝外部/链接路径；认证和host profile置于不可暴露的独立目录。`evidencePolicy.trackFile=false`只是引用跟踪，不能充当读取边界。现有workspace工具允许外部访问，未完成这项范围核对前不派发。
3. 在真实native提供方fetch边界确认同一账本覆盖私有运行、协议修复及可能的压缩请求；所有重试均计数，遇错误/未知usage即停。维持manual redirects、固定model与单目标，不能仅凭SDK通道校准宣称整条native链已接好预算guard。

建议监督方审阅后冻结：串行两例，各最多6次HTTP、合计12次，整批共用12分钟绝对截止；每次保守输入上界65536、输出维持生产Stop当前32768上限。完整序列化JSON另限57344字节，留8192协议余量；这属于保守文本 envelope 假设，不是通用GLM tokenizer证明。后续轮超大小先拒绝，实际usage超上界即停，不隐式扩预算或缩义务。仍以输入USD7/M、输出USD22/M估算，每次最大USD1.179648，十二次USD14.155776，取整批USD15上限，包含失败/重试/私有阶段。它不是实际账单或本批派发批准。

已有累计请求为4，旧未知预留USD0.454656及本次完整usage的参考估算USD0.009842合计USD0.464498。拟议十二次上限须与整个USD30/60请求/4小时阶段累计核对。未用完额度不要求花完，单例未完成就诚实保留，不靠增加请求获得PASS。

阶段墙钟从2026-10-30T11:21:55Z保守锚定，截止15:21:55Z，包含准备和等待。真实小批应共用`min(首请求派发+12分钟, 阶段截止)`，不能每例、每个profile或helper重新计时/重置总额度。

已执行的最小准备位于`.runtime-correction/native-component-preflight-20261030/native-stop-preparation-001/`，`result.json`逐项列出控制文本、schema、bootstrap及工具结果来源，`qualification-freeze.json`保存入口、helper及安装宿主身份。复用`evaluate-stop-workspace.mjs --capture-native --case toy-a|toy-b --engine workspace --transport native --production --host-root /opt/homebrew/lib/node_modules/openclaw --output-root <全新目录>`；这条模式禁止联网，虚构模型流只驱动真实工具和原生持久化边界，不产生模型语义结论。

两例实际wire大小分别33230→46641和33230→46637字节；13个工具schema、生产Stop输出32768、默认启用策略完整保留，当前自然适用对象为M12:R1/M16:R1。每份follow-up实际包含basis、app.mjs和唯一外部虚构contract三份完整工具回执及citeId。模型可见目录/会话采用中性UUID，预期只留评分结果；host/profile/build在可读数据之外，父目录未开放。生产工具执行前拒绝外部/链接路径，递归导航同样拒绝链接；四项定向检查通过。

本机bootstrap八个常见文件均不存在，skillsSnapshot为空、新建会话无历史；完整host通用控制仍在。发现宿主Runtime行会带个人机器名称后，仅在实验wire中将该字段置为fixture-host，RC控制、义务和证据不变；早期离线发现快照保留且未联网。未修改安装宿主或生产RC语义。

真实fetch接线复用同一budget admission primitive，包住global与dispatcher runtime port，完整消费SSE后才按提供方usage结算，未知即停、manual redirect；已用原生两轮捕获验证到达这条边界。没有强制触发压缩，不能声称压缩行为验收通过。不符合本批已审控制文本/schema或额度的请求在派发前拒绝，不能悄悄扩大数据或输出范围。

监督方随后要求的最后live接线也已完成，但没有启动：同一现有CLI以`--case toy-pair`顺序运行两例，共用一个账本、绝对deadline和一次性launch claim。固定专用临时env为`RC_NATIVE_STOP_API_KEY`，读取后移除env副本，仅在内存配置中使用；保存配置只有env引用。每次实际fetch之前核对认证匹配布尔值、两份虚构原件及生成basis的SHA、完整已审系统控制和13个schema，认证值不会进入日志或payload。

最终清单和无网络资格记录位于`.runtime-correction/native-component-preflight-20261030/native-stop-live-preparation-001/`。`qualified-pair/batch-result.json`证明同一进程中两例共用同一deadline/账本，计四次模拟fetch、零真实请求；每例两次、三份真实生产工具结果回传。最新完整wire大小为33340→46795与33340→46791字节，仍在57344硬限内。五项定向检查通过，包含每例第七次不外发、总12次不重置、一次性claim拒绝重复启动、缺专用认证不回退及阶段截止失效。早期捕获和失败均保留；模拟零usage不是提供方用量或效果收益。

监督方将认证注入受限子进程env后，可核对以下无密钥模板；本线程未执行：

```sh
TMPDIR=/private/tmp node scripts/evaluate-stop-workspace.mjs --live --case toy-pair --engine workspace --transport native --production --host-root /opt/homebrew/lib/node_modules/openclaw --native-pair-manifest .runtime-correction/native-component-preflight-20261030/native-stop-live-preparation-001/batch-manifest.json --output-root .runtime-correction/native-component-preflight-20261030/native-stop-pair-live-001
```

输出目录必须全新。一次性claim防止用新profile/目录重置同一清单；初始累计四次与USD0.464498必须匹配，已封存失败不重开。提供方原始reportedUsage/终态及SSE单独保存，归一化账本对全部prompt按输入全价估算。运行失败或超帽可以没有语义结论，不得以低成本或UNVERIFIED替代组件通过。

两例均有可信结论、回执和完整成本后，再讨论文档/Skill及基线的独立语义对照；“按适用义务延迟披露专项指引”仍只作候选分析，先测当前生产行为再做单因素消融。此方案不代表三bench接入、27例冻结或F2P/P2P改善已完成。
