# 原生基线组件批次交付

基线初建与后续用户修改已有第三批可运行清单，状态为全文编码恢复修复后离线接线通过、同输入真实提取语义待复测。复用已安装OpenClaw 2026.7.1-2、生产reviewer factory、`refreshRuntimeRequirements`与正式来源绑定账本；没有预填claim，也没有把受控文本回答当语义结论。

上一里程碑live-004已在同批完成Stop正反两例：正例M12/M16均PASS，反例均DEVIATION。随后基线live-001的3次请求均200，输入30528、输出1016、30.134秒，参考USD0.236048；累计53次、保守参考USD4.556605，实际账单未知，在途0。失败批次和原始候选完整保留。此次离线修复没有新增真实请求。

首次基线批次有两个独立问题：driver漏了显式refresh需要的task.control元数据，提交时异常，正式账本仍为空；真实候选又把实现与实际运行verifier的混合原句整体标为IMPLEMENTATION，遗漏PROCESS。driver现仅补空control，不伪造交互回执或claim。生产提示与工具说明明确单claim单证据主体优先于段落/工作流cohesion；已有分句坐标无法准确分离时，使用现有fullTextReason/full模式，以同一完整原文及真实读取回执表达准确的两项义务。原始四文件、评分要求、claim schema、ledger和指标投影均未更改。

第二次真实基线live-002为8次HTTP全200，输入89554、输出3106、78.483秒，参考USD0.695210；累计61次、保守参考USD5.251815，在途0、无未知用量。模型已经按新指令切full并写出准确独立的I/P文本，但又同时带textFrom坐标，且缺bindings；工具先报缺outcome，引出超长label、source冲突、双坐标等串行修复，最终配额耗尽，仍未发布或运行第二阶段。纯合成形式原本就不要求outcome，本次修复不是放宽这一字段：现在优先指出两种编码混用，第一次反馈明确保留准确text/source、删除textFrom并补当前引用bindings。完整来源/读取校验、准确文本、原始材料和重试帽均保留。

提取协议现为`stop-baseline-task-v3-exclusive-encodings`，规范化提取Skill的摘要进入request身份；实际full工具字段说明和mode-switch回执都明确两种互斥形式。旧complete候选和笔记不能继续使用旧身份；既有原文读取、会话、deadline、版本和提交守卫继续生效。

## 本批输入与验收

原始用户请求同时要求按引用contract实现纯函数，以及实际运行提供的verifier并取得exit 0。真实提取器须保留完整条件、无状态要求、明确排除及禁止联网要求，并将代码义务与执行义务分别归属IMPLEMENTATION和PROCESS。随后真实用户只将上界9改为19，其他义务应保留；中间assistant自行提出的strings-only条件不能成为权威要求。账本版本和claim数量仅证明发布步骤，不证明这些语义正确。

执行工作区最初仅含两份虚构材料及当前原始转录。未来用户修改、预期答案和评分protocol留在工作区外。第二阶段才替换当前转录。该入口是显式生产refresh组件，不代表自动UserPrompt/onboarding触发，也不代表业务执行、修复或完整宿主闭环。

## 已完成核验

- 本增量4个相关测试文件60项：59通过、1既有MA环境前置条件跳过、0失败。真实失败形状首次就得到完整合成恢复路径，不保存半批候选；一次修正后发布独立I/P义务并保留完整原文。严格来源/读取、M12/M16代码与执行证据隔离、初始化及计量守卫继续通过。未提高repair次数。此前88项记录保留。
- 新`baseline-component-003/offline-capture-001`在安装版OpenClaw实际运行并结算2个native调用，保持同一私有会话，受控3次HTTP驱动真实source_read及fullTextReason切换。下一实际序列化请求的save工具schema已从keep/split更新为operations/bindings，且包含新的互斥编码说明和模式回执；payload为30298/42854/44315字节，真实读取结果和模式切换回执均进入后续请求。
- 918个受测源码/资源/helper身份、3个宿主身份匹配；4个原始虚构文件SHA与失败批次完全相同。初始捕获未包含后续用户修改或assistant新增条件。
- 真实提供方请求0，在途0、队列0；账本仍version 0/claims 0，semanticAcceptance=null。离线受控响应和零usage明确不算提供方或语义证据。

当前证据目录为`.runtime-correction/native-component-preflight-20261031/baseline-component-003/`，清单`batch-manifest.json`，核验`qualification.json`，捕获`offline-capture-001/result.json`。旧准备与live-001/live-002失败记录未覆盖。监督方最新全量integration-003为195文件/2017项，2006通过、0失败、11跳过，源码和测试清单稳定；此全量发生在本次互斥编码恢复修复前，不能代替当前增量验收。

## 监督方启动

由唯一监督方将凭证临时注入子进程环境`RC_NATIVE_COMPONENT_API_KEY`，本线程不接收凭证、不启动真实调用。无需重复索取已有授权。启动命令本身不含凭证：

```sh
TMPDIR=/private/tmp node scripts/evaluate-native-baseline.mjs --live \
  --host-root /opt/homebrew/lib/node_modules/openclaw \
  --manifest .runtime-correction/native-component-preflight-20261031/baseline-component-003/batch-manifest.json \
  --output-root .runtime-correction/native-component-preflight-20261031/native-baseline-live-003
```

批次最多36次实际HTTP、每阶段18次、共享12分钟，完整body上限131072字节，输入预留262144、输出维持32768，参考USD帽96；全请求最坏参考USD92.012544，连同已有账本USD97.264359，引用监督方`settlement-007.json`。以上是有限防故障参数，用户总token/API额度仍不设限。清单启动新鲜度截止为香港时间2026-10-31 07:19:54（UTC 2026-10-30T23:19:54.183889Z）；超时须由监督方刷新有限窗口及身份后启动，不能绕过。一次性launch claim和全新输出目录防重复派发。

运行结束后逐条对照原始请求、引用材料、真实读取和正式账本，审查初建及修订语义；保留全部失败、协议修正、usage及费用。该组件通过后再验收文档、Skill、真实业务修复及新鲜重审。正式bench、F2P/P2P和效率改善均尚未获得结论。
