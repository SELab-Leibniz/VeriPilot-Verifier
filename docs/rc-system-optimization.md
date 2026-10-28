# RC 系统优化：固定基线、可复用能力与 ArkTS 对照

## 目标及完成门槛

原始目标全部保留：系统盘点 RC 的工具、Skill、Agent、prompt；复用适合融合的通用能力；优化执行、取证与恢复；避免按样例硬编码；以真实基线和实验决定取舍；在 swe-arkts-bench 上同时提高 f2p 和 p2p，并降低纠偏耗时和 token。没有实际逐例测试结果，不能以编译、静态检查、黄金补丁通过或程序化 verdict 代替完成。

- 固定插件基线：`c33bae6`，保留 `codex/fuse-care-observability-baseline`。
- 实现分支：`codex/rc-general-efficiency-bench`，复用当前外部 Git worktree，不复制 RC 仓库。
- 实现、测试与实验工具放在 RC；MatrixAssistant 及其内置 OpenClaw 保持只读。用户指定数据集和 Huawei 工具安装也只读。
- 数据集：13 任务，45 F2P、7547 按任务累计 P2P；不能把重叠 P2P 当作独立统计样本。

## 实验前协议

1. **评测器校准先于优化。** 在原 base_commit + 完整 test_patch 验证 F2P 必失败、P2P 必通过；黄金补丁只供独立评测器上限校准。缺失、未执行、跳过、编译失败分别记录，不伪装成成功/普通测试失败。
2. **输入隔离。** 模型仅看 problem_statement、hints 和基准源码。不得暴露 patch、patch_commit、test_patch、预期判定列表或黄金修改路径。判定补丁在评分工作树中应用，不进入业务 agent 输入。因首轮格式检查读到 security_tool_1 黄金内容，此例只作开发/接线，不作留出证明。
3. **划分提前固定。** 接线/开发：security_tool_1、happyword_12；方案选择：security_tool_3、security_tool_5、security_tool_7；冻结留出：security_tool_2、4、6、8、9、10、soduku-harmony_11、happyword_13。不能在看过留出结果后调整协议再把它叫未见数据。
4. **公平配对。** 同一业务模型、提示、初始代码、工具/时间/输出预算、修复额度、SDK 配置与测试判定；基线 RC 与候选 RC 交替运行。记录业务与纠偏用量、总量、缓存量、调用/读取数、阶段耗时、最终补丁和源摘要；失败与重试计入。
5. **两级评测。** 原生 Windows ArkTS 测试是正式成绩；工具机制、审阅判定及跨语言合成用例辅助解释收益，不能替代 F2P/P2P。按任务宏平均、按测试微平均和完整任务解决率分列。
6. **泛化与消融。** 先测通用算法/资源共享，再逐项消融：取证分页/搜索、笔记、Agent 生命周期、prompt/Skill 组合。不得向生产代码加入任务 ID、仓库名或黄金规则。跨域和反例保留源变更、缺失执行、条件/例外、取消与压缩恢复等边界。
7. **真实判断提升。** 固定基线尚未知。若出现 P2P=100% 等上限，必须明确不能证明严格更高，不能暗中改成“未下降”并宣布目标完成。

## 当前调查及候选方向

- 工具至少存在 frozen source、live workspace、document 和 Skill 四条读/搜/分页实现。先统一无权限含义的 UTF-8 分页与有界导航原语；各自的路径授权、冻结摘要、原文回执和判定权限仍由所属协议负责。名称合一不是收益，需实测 I/O、模型工具数和正确性。
- 文档每次分页均重新读取/拆分整文件；live grep 使用全文件读取且每页从头遍历；frozen grep 已有流式实现和小缓存。优先测这些可证实的开销，避免无理由改写已正确的协议。
- baseline 与 document 的项目会话管理不同，需盘点并发、策略变化、失败/取消、释放和压缩后工具绑定，不能仅为减少代码行数强行融合。
- 业务与私有协议分别盘点，工具 schema、通用角色指令、证据限制和领域审查提示的重复成本分别统计。优化必须保留完整条件、例外、禁止项和证据归属。

## 环境依据与待办

- 已确认 devecocli 可用；指定 Huawei CLT 为 6.1.1.280，SDK API24 / 6.1.1.125，Hvigor 6.24.2。devecocli 没有 Local Test 子命令，正式单元测试需调用该安装的 hvigorw test；应用构建/设备操作优先走 devecocli。
- 发现用户已有只读参考实验：`Experiments/arkts-toolchain-compare-20261028`，happyword_12 的黄金补丁曾在 Windows CLT 跑通 236 用例，但未做 base 必失败校准；不是 RC 基线。
- 原日志已有 Hypium 测试名称受 GC 日志污染的案例，评分不能仅依赖 test_result.txt；需要核对真实 start/class/outcome 事件及总数。
- Linux 参考实验已证实其 Previewer 不支持 Linux，不重走不可执行的 Linux 路线。
- [x] 固定分支与原始目标，确认工具链及数据集结构。
- [x] 产出 RC 能力清单与成本证据；见 `rc-capability-inventory.json`。
- [x] 建立不泄露答案的共享源码缓存、评分器；13 例原生校准仍待全部完成。
- [ ] 实际运行 c33bae6 的配对基线。
- [ ] 实现、消融、选择通用优化；冻结候选。
- [ ] 执行所有留出任务，比较实际 F2P/P2P、token、时间和失败。
- [ ] 完整工程回归和逐项完成审计；目前目标未完成。

本次进度、运行清单和原始日志位于 `.runtime-correction/system-optimization/`。后续压缩恢复先读本文件及该目录的状态，不重启已确认仍活跃的运行。

## 2026-10-29 实施与恢复记录

- 生产候选 α：共享增量 UTF-8 行分页、宽范围导航跳过明确的依赖/构建缓存、控制 Skill 共用启动模板并收窄触发描述、补齐 OpenClaw `rc_skill_care` 工具注册声明。各协议的原文回执、权限、哈希和判定责任没有合并。
- 候选实现已提交为 `2909891`；另修复取消/过期获取空闲基线会话时取消清理计时器的问题。原版复现无法按时释放，候选按时释放；相关 16 项回归通过。候选产物位于 `candidates/2909891/runtime-corrector-openclaw`，与 c33 产物分别保留。
- 分页实测：与 c33 的完整响应逐字节比对，ArkTS/Python/中文文档各 9 轮交替样本、每轮 80 次调用，CPU 耗时约减少 78–83%。仅证明分页算法收益，不证明模型 token 或 F2P。
- Skill 实际宿主适配后的体积：Claude 16960→6723 字节，CodeAgent 16966→6724，OpenClaw 4711→4668。OpenClaw 原来已转换重复启动代码，其收益很小，不能宣传成全宿主节省 60% token。所有控制命令和根目录防护保留。
- 导航合成树：ArkTS/Python 每例 120 个依赖文件，搜索读取 121→1；Node 原来已排除 node_modules，保持 1→1。业务 build/target/vendor 目录、直接读取缓存和 includeGenerated 的可达性均有回归。此为 I/O 机制验证，不是端到端业务成绩。
- 实际宿主发现 c33 的注册工厂遗漏 `rc_skill_care` 声明；候选补齐并通过真实安装宿主 registry 测试。冻结 c33 产物仍保留原样，不为基线偷偷补洞。
- 评分器读取真实 Hypium start/class/outcome 和终止状态，不能用 hvigor 的 exit=0 判 PASS。处理 GC 污染只能使用同次运行的独立元数据，不能根据期望测试名猜测。原始失败和旧解析结果保留；当前离线审计已确认 10 例 base 必失败、gold 必通过。
- 源码缓存曾只有 FETCH_HEAD、缺少持久 base refs，导致重复拉大包；保留已有 base refs 后，security_tool_10 的同一 SHA 在约 5 秒拉取成功。旧网络失败、部分包和终止记录保留，不计业务失败。
- 已完成回归：控制与打包 56/56；导航与 Stop/宿主 52/52；评分与有界进程 9/9。完整工程回归待运行。
- 全量工程回归：156 文件 / 1815 用例，1792 通过、22 条件跳过、1 个 SessionEnd 1200ms 时间门槛失败（实际 1328ms）。未降低门槛；原失败保留，单独复测 10/10 通过，包含新补丁归属校验。不能把首次全量报告说成全绿。

### 活跃实验与禁止重启事项

- 基线开发试跑 `agent-runs/baseline-happyword12-003` 已 SETTLED：663346ms；业务 40 个持久化助手响应，RC 两个私有 Agent 均已释放，最终 UNVERIFIED。提供方用量总计 input=144335、output=15745、cacheRead=991808；总量 1151888 含缓存，不能只报非缓存输入。各业务/RC 归属见 usage-summary.json。
- 独立隐藏评分 `grades/baseline-happyword12-003` 已真实运行：F2P 4/4、P2P 232/232、完整任务通过。本开发例达到上限，不能证明严格更高；也不代表其他任务基线。
- 试跑 001 因实验工具缺少 main/contracts 在业务模型开始前失败；002 因工具退出等待及宿主中止而终止，完整记录保留。不能将它们当正式准确率样本。
- 003 修复实验工具等待，保留相同模型/任务与插件基线。业务 agent 只访问原 base 源码和公开问题，隐藏 test_patch/gold 只存在独立评分工作树。发现原工作区差异含宿主自动 bootstrap 和文件缺失；完整原 patch 保留，评分使用从成功 native write/edit 回执确定的 candidate-attributed.patch（4308 字节，两个文件），无评分答案参与归属选择。
- 正式配对前统一公共实验工具：bench_check 返回新鲜原始本地测试的计数、完整日志路径及运行完整性；不提供隐藏预期 ID。003 日志尾部缺失导致大量找报告和负对照动作，所以它只作开发接线和基线观察，不与新工具直接作 token 胜负比较。新协议生成工具、范围校验、评分和子进程共 11/11 回归。
- Windows Previewer 共享端口：业务模型的 bench_check 与评分器/校准严格串行，不能为了加速并发运行 native test。
- 剩余校准正在 `calibration-retry-001` 串行执行，命令会话 35329、owner PID 24456；security_tool_10 已校准通过（F2P 0→1/1，P2P 677/677）。继续检查其 progress.json，不覆盖旧失败。
- `dist/runtime-corrector-openclaw` 是 c33 冻结基线产物；不要直接运行默认 build-plugin 覆盖它。候选用 buildPlugin 的专用 outputRoot 构建。

### 当前不采纳的改动

不把文档私有协议直接移出公开目录：现有发布兼容测试将该 Skill 纳入发现契约，迁移需要单独的兼容方案与真实调用依据。也不为代码行数融合 baseline/document 的权限和会话管理；先测真实调用与失败证据。生产未打包的旧 prompts.json 不作效率优化对象。
