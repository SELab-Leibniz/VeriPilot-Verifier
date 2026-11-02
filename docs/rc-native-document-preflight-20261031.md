# 原生文档两轮组件交付

最新真实文档live-001结论为`CONTENT_CORRECT_LOCATION_INCORRECT`，semanticAccepted=false：偏差文字正确，但design.md遥测在物理第2行，模型finding及引文却声称第3行。第二轮读取修订稿后PASSED、无旧finding，不能抵消首轮定位错误。

现已按独立审计实现最小定位校验：仅从已声明、当前hash校验的文档验证明确路径/行号/逐字引文（含闭引号后常见终止标点），不强制自由语义推断逐字匹配、不自动挪动finding。首轮/修复/缓存三路真正await；非法缓存审计后重新评估。验证读取不授予remember已读资格。原始模型失败输出和有限修复预算保留，native协议升为v13。

最新复测准备位于`.runtime-correction/native-component-preflight-20261031/document-location-fix-001/`，38项共享检查全部通过，实际原生read/rc_document离线捕获body为20379/23617字节，真实请求0。原始3文件及控制修订完全不变。采用该目录的`batch-manifest.json`，全新真实输出为`native-document-live-002`；当前seed为settlement-010的103次/USD11.175444。其他真实批次若先结算，唯一owner须先更新seed/新鲜度。下面首次准备与live-001说明保留为历史。

基线live-003已由监督方按原始要求独立验收：v0→v1完整保留实现、实际成功执行verifier、本地/无状态/输入域等义务；v1→v2只更新指定上界到19，执行义务与其他条件保持，助手自定strings规则未采纳。该批10次请求，参考USD1.144175，累计71次/保守参考USD6.395990；在途0、实际账单未知。authority和foreign-citation两次实际拒绝均保留，不从耗时/token中删除。此结果仍是显式refresh组件，自动触发与Gateway闭环另验。

文档下一批已完成离线接线，尚无真实文档语义结果。使用独立`native-document-pair-v1`清单、`metered_native_document_batch`与临时环境名`RC_NATIVE_DOCUMENT_API_KEY`，不借用baseline或Stop类型。唯一启动方为监督会话。

## 实际路径与范围

真实运行从空账本开始，先以生产`refreshRuntimeRequirements`提取当前原始用户请求和引用需求，要求正式发布非空基线。此后使用构建后的OpenClaw策略、`checkArtifact`、显式PostToolUse的`handleRuntimeV2Event`、`runSemanticReview`、实际factory.handoff，以及`finalizeArtifactCheck`/`finalizeArtifactRuntimeV2`。

handoff复用普通调用的模型固定、CLI字段清理、共享计量、准备回调、绝对deadline及取消信号，仍调用原factory.handoff，保留原handle关闭与所有权语义。文档角色必须具有匹配session/run的真实`rc_document`绑定；仅允许`read`和`rc_document`，通用read限制在虚构工作区。缺失或跨run绑定在派发前拒绝；Stop缺任务绑定的既有拒绝规则不变。

第一轮当前设计包含远程遥测，第二轮在首轮结算后才由受控driver替换成工作区外冻结的修正版。原始用户与需求字节保持不变。两轮结果和准备反馈保存供监督方检查；不标记host已送达，不宣称真实模型业务编辑或自动宿主Hook。这些边界与后续Gateway真实闭环分开。

## 离线证据

当前目录`.runtime-correction/native-component-preflight-20261031/document-component-001/`包含`batch-manifest.json`、`qualification.json`及`offline-capture-002/result.json`。

- 12项针对性检查全部通过：文档绑定所属身份、专用工具保留、独立批次类型、真实运行策略/原始材料解析，以及旧Stop和共享计量守卫。
- 安装版OpenClaw 2026.7.1-2实际运行并结算一个原生审查调用；两次受控HTTP的body为19770/22996字节。真实`read`和`rc_document open`结果进入下一请求，设计和需求的完整行及摘要匹配，两份文档均无未读分页。
- 919个源码/资源/必要driver身份、3个宿主身份、3份原始文件和工作区外修正版均匹配；未暴露未来修正或评分要求。新增真实模型请求0、在途0、队列0、semanticAcceptance=null。
- 离线只走生产node-review：动态提取与依赖账本的artifactReview同时关闭，原始文档输入、native handoff及rc_document保持。空账本没有伪造claim或语义输出。真实模式启用两者并要求真实初始基线发布。首次离线配置违反这一前置依赖的失败保留，未发请求。

本次只调整开发driver/helper并新增验证；上一轮全量2017项不自动覆盖这些增量。监督方的Gateway helper/probe不属于此driver依赖，本线程未编辑这些文件。

## 启动与验收

由监督方在内存中向临时子进程注入`RC_NATIVE_DOCUMENT_API_KEY`后运行：

```sh
TMPDIR=/private/tmp node scripts/evaluate-native-document.mjs --live \
  --host-root /opt/homebrew/lib/node_modules/openclaw \
  --manifest .runtime-correction/native-component-preflight-20261031/document-component-001/batch-manifest.json \
  --output-root .runtime-correction/native-component-preflight-20261031/native-document-live-001
```

引用`settlement-008.json`的71次/USD6.395990。防故障参数为最多48次HTTP、每轮24次、共享15分钟，完整body131072字节、输入预留262144、输出32768，参考USD帽128；新增全请求最坏参考USD122.683392，累计USD129.079382。用户总token/API仍不设限。启动新鲜度截止为香港时间2026-10-31 07:38:36（UTC 2026-10-30T23:38:36.384826Z），输出和一次性claim必须全新；未知usage仍停发。

`SETTLED_REVIEWED`只证明基础流程结算。监督方须核对第一轮对远程元数据遥测给出有原文依据的偏差，第二轮确实读取当前修正设计、保留全部本地/错误处理/范围要求，且没有旧发现或新增义务误报。原始请求、每次模型调用、读取结果、拒绝、费用及准备反馈均保留。正式bench、F2P/P2P和效率收益仍未验收。
