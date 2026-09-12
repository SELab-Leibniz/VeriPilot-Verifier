# OpenClaw 2026.7.1-2 适配验收

日期：2026-09-12。基线分支：`codex/multi-host-plugin-root-compat`，
起点提交：`33ea6ff737d28a2d97d477bf211dbcfb32ddbcd6`。
适配分支：`codex/openclaw-2026.7.1-2`。

环境：macOS、Node 26.0.0、OpenClaw `2026.7.1-2 (0790d9f)`。
真实模型使用用户授权的 Anthropic Messages 兼容接口和 `ark-code-latest`。
测试使用独立的临时 OpenClaw 状态目录和项目，未修改日常 Gateway 配置。
凭据不进入源码、安装包或本记录。

## 自动回归

- `npm test`：550 通过，2 跳过（Windows 专属用例）；此数字含三个构建产物内的示例测试。
- `node --test --test-concurrency=4 test/*.test.mjs`：501 通过，2 跳过。
- OpenClaw 专项 16 项全部通过：同步加载、精确版本检查、会话与来源编号、重复用户请求、
  只读隔离评审、结构化结果修复、需求编号校验、绝对超时、会话交接、
  工具调用关联、宿主重载、观察模式、证据重复、规则和语义评审、候选补丁不自动应用、完成预算。
- `npm run build:plugins`：OpenClaw、Claude、CodeAgent 三种互斥产物均可构建。
- `git diff --check` 通过。

## 真实安装

安装目录及 `.tgz` 包均通过目标版本的 `openclaw plugins install`。
`openclaw plugins inspect runtime-corrector --runtime --json` 的 `diagnostics` 为空，
识别到七个原生 Hook、`runtime_corrector` 管理工具及原生工具结果 middleware。
安装时显示 npm 包名与 manifest id 不同的说明；配置键仍为 `runtime-corrector`。

## 模型联调

1. API 连通与正常交付：实际创建并回读 `acceptance.txt`，内容严格为 `VERIFIED\n`；
   原核心最终记录为 `COMPLETED`、`PASS`。
2. 写后纠偏：项目规则要求 `Goal` 章节，初始文档只有 `# Draft`。
   原生工具结果返回规则及语义诊断；主模型补充目标章节，再次评审通过并读回验证。
   主模型执行修改，插件没有自动应用候选补丁。
3. 故障恢复：一次主模型运行被宿主报告为 `incomplete_turn`，账本未记录通过。
   续接同一会话时，一次评审超过绝对截止时间，账本记录 `UNVERIFIED`，
   并通过真实 `before_agent_finalize` 触发一次续跑；随后恢复评审。
4. **完成拦截未达到原插件的功能等价要求**：在专用临时测试目录中，主模型正确写入并读回
   `VERIFIED\n` 后，独立测试 Hook 在最终验收前仅注入一次 `DRAFT\n`。
   原纠偏核心正确发现实际文件与要求冲突，记录 `DEVIATION`，消耗 1 次纠偏预算，返回 `revise`。
   但 OpenClaw 记录 `requested revision after potential side effects; finalizing`，拒绝自动续跑。
   最终文件仍为 `DRAFT\n`，任务为 `ACTIVE` / `DEVIATION`，不是 `PASS`。
   这个受控用例使用单抽取器以缩短测试时间；另一个真实零配置用例已验证双抽取器加裁定器。

最初把“等待插件反馈”写成用户测试步骤时，评审合理地分类为 `WAITING_FOR_USER`，
未触发硬性问题拦截。适配保留该判断规则；后续采用独立文件故障注入验证完成门。

## 保留的边界

OpenClaw 的副作用保护会拒绝文件写入后的最终续跑。未触发该保护时最多续跑 3 次，
最后一次可能跳过完成 Hook。超时、取消、宿主异常和无法验收
均不等于通过。账本中的 `PASS`、`UNVERIFIED`、`NOT_YET_EXECUTED` 等状态保持区分。
带精确运行标识的频道最终回复可附加未通过说明；CLI 本地输出与中间流式内容不保证附加说明。
远程/容器运行时和逐次美元预算没有获得本次验收覆盖，具体限制见 [安装指南](openclaw.md)。
本分支没有修改或绕过 OpenClaw 的副作用保护。可安装适配和写后纠偏已验收，
严格的最终强制纠偏仍受宿主限制，不能声明本次已经完整保留全部行为。

## 2026-09-13 防递归补充

安装包版本：`1.9.1-openclaw.2`，宿主仍严格限定 `2026.7.1-2`。

原生评审增加异步执行身份和嵌套创建拒绝。新增四项自动测试覆盖跨模块重载的
评审嵌套与交接拒绝、最多一次 JSON 修复、元数据缺失时内部 Hook 隔离、
并行主任务仍能接受纠偏、超时清理后的迟到回调，以及递归追问不取消原评审。
任务级控制器尚未实现，其单一控制权、去重、预算与取消规则见
[受控任务与防递归设计](openclaw-supervised-tasks.md)。上述历史模型联调不代表该控制器已获验证。

源码回归：505 通过、2 个 Windows 专属测试跳过。OpenClaw 与安装产物专项：27 项全部通过。
三种宿主产物重新构建成功；本次没有重新调用真实模型接口。
新版 `.tgz` 已在独立临时配置下通过目标 OpenClaw 的安装和原生加载检查，
版本识别为 `1.9.1-openclaw.2`，七个 Hook 与管理工具已加载，`diagnostics` 为空。
