# Skill 专项端到端运行

此入口使用真实 OpenClaw 2026.7.1-2、真实业务会话、原生工具和模型审阅，验证自动读取 Skill、生成规则图、失败反馈、业务修复及修改后的重新验证。它只启用 Skill 与终审 M08；明确关闭全局基线、文档审查及其他终审指标。结果不能当作整个 RC 的验收。

独立 Skill 现在允许 `dynamicGroundTruth.enabled: false`：仍从完整原始 Skill 建立和核对本地规则图，不生成虚构任务基线。原文变化、模型解释不确定、调用或结果无法归属时仍保留未验证状态。全局基线关闭时，终审仅允许明确启用 Skill、仅保留 M08 且关闭文件质量审查的配置。

运行时通过环境变量 `RC_NATIVE_GATEWAY_API_KEY` 提供模型凭据，不写入项目或命令参数。默认使用 GLM Coding 的 `glm-5.3-flash`；也支持显式使用当前 Ark Coding 的 OpenAI 兼容路由。

```sh
node scripts/evaluate-skill-e2e.mjs \
  --scenario repair \
  --role-timeout-ms 600000 \
  --assessment-timeout-ms 900000 \
  --business-timeout-ms 1200000 \
  --wall-ms 1800000 \
  --max-watch-turns 1 \
  --output .runtime-correction/skill-e2e-hour/repair-fresh
```

Ark 路由另加 `--base-url https://ark.cn-beijing.volces.com/api/coding/v3 --model ark-code-latest`。`--scenario success` 从正确产物开始，检查正常验证和退出。输出目录必须全新。

时间项分别控制单个审阅、一次终审及反馈、原始业务任务和整轮运行；原始业务不再被入口里的固定十分钟上限截断。所有阶段仍受整轮绝对截止时间约束，增大一个参数不会自动延长其他阶段。模型提供方的等待阈值随明确配置的整轮时间设置；未知用量或鉴权失败会停止继续发请求。

专项样例接受宿主默认的可选执行参数；不要求模型凑齐 `workdir/timeout/yieldMs/background` 四个字段。仍只允许原始验证命令、只读输入及两份可编辑产物，后台执行和其他工作目录仍被拒绝。原有集成评测的严格参数模式默认保持。

失败样例的初始代码固定为 `accept(value) => value`，指南已经正确。原始任务要求修改前先真实执行验证，随后修复并重新验证。看护回合上限在专项样例中设为 1，以便在首次失败工具结果返回时检查已发生的执行；生产默认值不变。Skill 明确说明非零退出是执行失败，并允许通过当前产物的新验证解决失败，不豁免首次失败。驱动不生成规则图或判决、不代写业务修复，不把人工构造的工具结果当作真实执行。

为确保确实检验纠偏而非 Agent 自行修复，`repair` 在真实验证失败后，仅替换主 Agent 的下一次决策为错误的完成声明。实际提供方请求、原始响应及完整用量仍保留，替换后的响应另存并记录两份摘要。该注入不是新的用户依据，不影响私有审阅或后续纠偏运行，也不提供审阅判决、工具结果或业务修复。该案属于受控故障注入，不是自然错误率或模型成功率统计。通过还要求真实 Skill 偏差记录及进入业务模型请求或工具返回的 Skill 反馈；仅有终审反馈不算 Skill 闭环通过。

每轮保留 `result.json`、实际业务会话、原生工具观察、Skill 规则图与评估、实际终审派发状态、请求和用量。`PASS` 要求实际 Skill 读取、规则抽取、Skill 审查、当前看护通过、最终产物匹配的验证成功、原生终态及私有运行结算；修复案还要求反馈实际进入业务会话和业务 Agent 的写入。历史失败目录不被覆盖。

针对本次改动的检查：

```sh
TMPDIR=/private/tmp node --test \
  test/skill-standalone.test.mjs \
  test/skill-e2e-budget.test.mjs \
  test/skill-e2e-fault-transport.test.mjs \
  test/skill-source-contract.test.mjs \
  test/skill-source-quotes.test.mjs \
  test/skill-source-semantics.test.mjs \
  test/native-skill-condition-receipts.test.mjs \
  test/native-gateway-batch.test.mjs \
  test/native-gateway-provider.test.mjs
```

测试直接引用 `typebox` 时，使用安装宿主提供的同版依赖。完整插件回归及全局基线协议修复不属于此 Skill 专项目标。
