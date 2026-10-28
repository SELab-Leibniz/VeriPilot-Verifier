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
- [x] 建立不泄露答案的共享源码缓存、评分器；13 例原生校准均完成并审计。
- [ ] 实际运行 c33bae6 的完整配对基线；两例开发基线已完成，其余方案选择及留出仍待执行。
- [ ] 实现、消融、选择通用优化；冻结候选。
- [ ] 执行所有留出任务，比较实际 F2P/P2P、token、时间和失败。
- [ ] 完整工程回归和逐项完成审计；最新完整回归通过，准确率、同等审查完成度及留出审计尚未完成。

本次进度、运行清单和原始日志位于 `.runtime-correction/system-optimization/`。后续压缩恢复先读本文件及该目录的状态，不重启已确认仍活跃的运行。

## 2026-10-29 实施与恢复记录

- 生产候选 α：共享增量 UTF-8 行分页、宽范围导航跳过明确的依赖/构建缓存、控制 Skill 共用启动模板并收窄触发描述、补齐 OpenClaw `rc_skill_care` 工具注册声明。各协议的原文回执、权限、哈希和判定责任没有合并。
- 候选实现已提交为 `2909891`；另修复取消/过期获取空闲基线会话时取消清理计时器的问题。原版复现无法按时释放，候选按时释放；相关 16 项回归通过。候选产物位于 `candidates/2909891/runtime-corrector-openclaw`，与 c33 产物分别保留。
- **2909891 已失去候选资格**：精简后的 description 含未引用冒号，实际 YAML 校验失败（原字符串测试没发现）。源码已改正，Skill Creator 校验通过；新评测入口使用安装宿主的真实 YAML 解析器在模型启动前验证所有打包 Skill，真实宿主回归也覆盖这个反例。旧产物原样保留；不能把 Skill 未发现的实验当成优化成功。
- Windows 长路径导航另提交 `1e7cc8a`：Git 调用显式开启 longpaths，默认状态排除程序自己的控制目录，但明确指定路径仍可查看其 diff。静止的旧试跑目录中，原调用错误报告 3 个未修改文件，开启后消失；18 项 workspace review 回归通过。
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
- 13 例校准均完成并审计：45 个 F2P 在 base 均失败、gold 均通过；7547 按任务累计 P2P 均保持通过。新增三例在 calibration-retry-001；旧网络失败保留。此成绩属于评分器校准，不能算 RC 改进。
- 公共实验入口首次 paired-dev-001 在模型启动前因忽略的锁文件无法加入准备提交而失败；已仅对两个明确的准备锁文件使用 force，不改业务提交规则。
- paired-dev-002：security_tool_1 基线已完成、评分通过，用量总计 575877 tokens（含缓存）；其旧候选因 YAML 缺陷在实际 6 次模型开始后取消，原始日志和 invalid-artifact-audit.json 保留。该取消不计正式候选得分，但开发消耗不能隐去。
- cf4a172 轮曾采用已完成的 security_tool_1 基线：比较器逐字节检查原公共协议，仅允许机械删除 YAML 启动前校验后恢复原 runner 摘要。新短路径协议已改变 cwd、公共工具及评分器位置，**之后不再采用旧基线**；不能混用不同协议的 token/耗时。
- `dist/runtime-corrector-openclaw` 是 c33 冻结基线产物；不要直接运行默认 build-plugin 覆盖它。候选用 buildPlugin 的专用 outputRoot 构建。

### 当前不采纳的改动

不把文档私有协议直接移出公开目录：现有发布兼容测试将该 Skill 纳入发现契约，迁移需要单独的兼容方案与真实调用依据。也不为代码行数融合 baseline/document 的权限和会话管理；先测真实调用与失败证据。生产未打包的旧 prompts.json 不作效率优化对象。

## 原生路径问题及新一轮协议

- paired-dev-valid-001 的 security_tool_1/cf4a172 业务模型在过长的工作树中反复调查测试问题，发生上下文溢出并自动压缩，739766ms 后退出，未进入 RC 审查；提供方记录 2498674 tokens（含缓存）。这些消耗保留，不能归为 RC 自身审查成本。
- 该轮隐藏评分也因 es2abc 找不到深层 filesInfo.txt 而编译失败。使用**同一补丁、同一 SDK 和隐藏测试**，仅把工作树移至仓库内短路径后，实际 F2P 1/1、P2P 611/611 全部通过。原生工具链的路径限制污染了上一轮，不能宣称候选准确率回退，也不能宣称提升。相关 happyword_12 试跑已在进一步花费前取消，审计记录保留。
- 新物理工作树统一位于 `.runtime-correction/b/biz-<12位摘要>` 与 `grd-<12位摘要>`；各 arm 等长，不把描述性实验目录名带入 CLT 缓存路径，启动前检查 filesInfo.txt 的路径预算。仍共享原裸对象缓存与 detached worktree，不复制仓库；所有文件仍在 RC 工作区内。旧工作树和日志不搬移、不覆盖。
- 实际记录有 6 次以 glob 调用字面 find。生产 frozen/live 工具现共享空结果的语义提示，保持字面匹配和证据权限不变；公共实验 wrapper 同时写明 find/grep 的字面规则，暴露 includeGenerated。旧轮不用于新协议下的性能比较。
- 新公共工具应统一使用同一个冻结导航产物（可由 --navigation-artifact 显式选择），其模块摘要也进入协议冻结。两组得到相同公共工具，不能将公共实验工具的改善归因于候选 RC。
- 实验入口在原业务 600s 预算耗尽时向**该隔离 Gateway 的该原 run**请求 chat.abort，保留 side runs；不让宿主自动压缩无限延长已声明的预算。整体未停止的模型不得被评分；保留中断与未完成状态。
- 新增离线 context-profile：只输出工具名、响应大小和实际提供方用量，不反复读全文。汇总报告区分业务完成、RC 审查状态、缓存/非缓存和缺失用量；P2P=100% 不算严格提高，未执行的任务不显示为 100%。
- 短路径、字面导航与报告门槛等相关回归 17/17 通过；长路径导航 18/18、真实宿主及 YAML 39/39 通过。最终仍需新协议的真实模型配对、留出及完整工程回归。

恢复时先检查比较目录的 progress.json 和 owner PID。旧 paired-dev-001、002、valid-001 均不应重启；它们保留开发失败和历史基线。13 例校准已完成，切勿重复拉取或重跑黄金补丁。新协议必须重新运行 baseline/candidate，不能套用旧基线结果。

### 03:30 当前恢复点

- 新冻结候选 `0b72285`，产物 `candidates/0b72285/runtime-corrector-openclaw`，6 个 Skill 均通过实际 YAML 校验。公共导航也统一使用此产物；基线 RC 仍是 c33，不把公共工具变化计作候选效果。
- **活跃配对** `paired-short-dev-001`：security_tool_1、happyword_12，前者 baseline→candidate，后者 candidate→baseline；日志 paired-short-dev-001.log。没有采用旧基线。先检查本目录 progress.json / manifest.ownerPid / 子运行 progress.json，不要重复启动。
- 无模型的原生工具预检 `preflight-short-001`：业务根路径 113 字符、关键内部缓存路径 198 字符；编译与测试均完整执行，真实报告 PASS=452、FAIL=2（原始测试，不是隐藏成绩），退出码 0。结构化输出正确保留失败。
- 短路径复评分 `grades/short-path-cf4a172-security1`：同一旧补丁实际 F2P 1/1、P2P 611/611。旧长目录的编译失败不算代码回退。当前只证明开发例两组都能通过，尚无准确率提升证据。
- 新全量工程回归 160 文件 / 1823 用例：1798 通过、23 跳过、2 失败，均在 provider-fetch-timing 的本地 HTTP 请求中报告 fetch failed；其源码未改。真实宿主及独立复测 6/6 通过，原失败仍保存于 full-regression-short-protocol.log，暂不能称全量全绿。
- 本机 TCP 临时端口实际为 1024–60000，包含 Fetch 禁用端口。受控端口 6000 可稳定复现 fetch failed / cause=bad port；旧两次失败未记 cause，不能断言同因。HTTP 测试夹具现先验证端口，只对精确 bad port 原因重选，其他错误照常失败；探测在安装观察器前完成，不改变计数断言、真实传输或生产代码。真实宿主复测仍 6/6；最终全量再验证。
- 比较器现在锁定实际宿主版本及公共导航依赖；离线报告保留业务完成和 RC 审查状态。单纯代码隐藏测试通过不能冒充业务模型正常完成或 RC 已审查。
- 待办：完成有效开发配对；判断是否需要新的候选消融；冻结后跑方案选择集 3 例与留出 8 例；比较实际 F2P/P2P 和业务/RC/总 token、缓存与耗时；解决全量检查剩余问题；逐条审计原始目标。不能因开发例或 P2P 上限把目标标完成。

### 04:05 后续候选依据（尚未完成模型验证）

- 有效短路径样例 security_tool_1：c33 和 0b72285 都通过 F2P 1/1、P2P 611/611；会话记录 token 分别 1148214、1175987。没有严格准确率提升，且不能从这一对宣称省 token。
- c33 的实际审查因 STOP_REVIEW_DEADLINE 中止，只有 3 个响应轮次；两个 source_find 把代码标识符/不匹配文件名当路径，未取得足够实现证据。新候选将首屏空结果引导扩展为“路径区分大小写，内容/标识符用 grep”，保持字面查询，不暗中改为内容检索；翻页末尾不再补提示。不是针对任何仓库或标识符硬编码。
- c33 实际基线读取分 3 个模型响应完成（1、2、2 个 read）；后续候选为 baseline/protocol 共用独立读取计划，按真实文件字节、32KiB/4文件上限提示可并发的 read 调用。它只提供调度元数据，不合并工具、不授予读取覆盖或引用，不减少任何必读源/条件/权限。初轮给提示，后续修复仍恢复已保存回执。
- 读取计划及完整回执/Scope 回归 89 项：88 通过、1 条件跳过。该候选尚无真实模型收益证据；必须在相同已冻结公共协议下与 c33 比较，不以回归测试或预期少一次往返代替成绩。
- 0b72285 两例开发配对已全部完成：两组 F2P 5/5、P2P 843/843；会话总 token 1449935→1343126（约 -7.4%），记录耗时 951849→937488ms（约 -1.5%）。所有业务模型都正常结束；但 c33 尝试了两次 workspace 审查，0b72285 在基线提取阶段耗尽预算、未进入 workspace 审查，四条最终状态均 UNVERIFIED。因此这些原始下降**不具备同等审查完成度资格**，不能宣称纠偏更高效或更准确。
- 原始错参进一步定位：缺少 operation 被旧错误当成“非 ADD 缺 claimId”；缺少/不完整 binding 没给当前原文文件与已签发 citeId；一次错误行偏移也没有行数提示。新候选只提供精确恢复信息，动作、来源、权限和已有回执仍须显式选择，缺失证据继续拒绝，不自动填判定。
- 恢复提示和真实宿主回归 59/59，无跳过。统计汇总另增加 workspace 协议完成度门槛；少做/没完成审查不能仅靠低 token 被称为效率提升。

### 04:29 恢复点

- `2e059b0` 完整回归：161 文件 / 1824 用例，1801 通过、23 条件跳过、0 失败；原日志 `full-regression-read-recovery.log`。
- 活跃 `paired-recovery-dev-001`，协调 owner PID 13112，统一公共协议/导航 0b72285；比较器已验证并采用 `paired-short-dev-001` 的两条 c33 基线，只运行两个新候选，不能重新启动。终端运行句柄 50274。先检查 progress 的 state/ownerPid/id/arm/stage，不输出整个 results，避免重复读测试列表。
- 当前后续开发（未纳入 2e059b0）扩展 multipart 原文行选取：原实现已有跨块精确字节回执合并，textFrom 却只允许单块，且 full-mode 提示反而要求重复完整 text/source/bindings。新实现允许原始全局行号、记录每块原始行跨度，优先程序捕获原文和已有回执；来源权限、连续覆盖、所有必读源和完整结束检查照常执行。须通过 UTF-8 跨块/未读/虚假回执/权限反例后另冻结，不能把它的收益归给正在运行的旧候选。
- multipart 候选实际宿主适配和基线/控制台回归 59/59，0 跳过；含 UTF-8/CRLF 跨块、未持久化回执、缺块、权限与伪造原文反例。测试夹具补齐真实 catalog 的规范路径和 projectRelativePath，避免把测试目录的祖先 `.runtime-correction` 错当材料内部来源。生产权限规则未放宽。私有提取 Skill 通过 Skill Creator 校验。模型表现尚待独立试验。
- `8a8ec79` multipart 候选已独立打包，6 个公开 Skill 均经宿主实际 YAML 解析器验证；未改当前比较公共协议。
- 轻量 context-profile 修正统计名称：assistant 的 toolCall 是 requestedCalls；持久化 toolResult 是 resultRecords/errorRecords，可能包含宿主合成修复。security_tool_1/c33 实测 finish_baseline 为 1 个实际请求、2 条结果（含 1 条合成错误），不能将第二条结果说成额外一次模型调用或真实执行失败。提供方 usage 和总 token 不受此派生统计修正影响。

### 04:43 控制端终止授权修复

- `paired-recovery-dev-001` 已停止，不能恢复成有效配对：security_tool_1 的 600s 预算终止返回 unauthorized，仍未开始 RC。核对 owner PID 11148 的实际命令后终止其专用进程树；协调进程 13112 随即记为 NEEDS_ATTENTION，后续 happyword 未启动。保留 native-host/session、abort 响应与 interruption-audit。已持久化提供方用量下界 1735759 tokens（含缓存），尚在途用量未知；不评分、不计候选准确率/效率。
- 根因在实验控制端：每次 callGateway 是新连接，默认最小权限不能终止另一连接创建的 run。仅在该隔离控制端的 chat.abort 请求中显式申请 operator.admin，仍指定原 sessionKey、runId、preserveSideRuns；未改安装宿主、RC 生产权限或任何既有会话。
- 新模型外部零调用的真实宿主探针：本地悬停 provider 收到请求后，实际 chat.abort 返回 aborted=true，原业务终态为 aborted。probe-001 的宿主单例残留导致进程不自然退出，已验证后释放；脚本仿照主入口等待 shutdown 后显式退出，probe-002 检查完整退出。
- 基线复用仅允许机械恢复到原控制端摘要，且被采用基线不能存在任何 business-budget-abort.json；两条现有正常基线符合条件。该例外写入新 manifest.adoptionExceptions。无模型负对照人为加入 abort 记录，比较器明确拒绝复用；其他字节变化仍拒绝。业务模型输入、工具、预算、评分和公共导航均相同。
- 新候选 `8a8ec79` 的无模型配对计划已通过：paired-split-dev-plan-001。当前完整回归运行句柄 39538，日志 full-regression-split-selections.log；通过后才开始新模型，避免回归负载污染耗时。旧配对、全部失败和校准不得重启。

### 04:47 当前活跃运行

- 完整工程回归已结束：161 文件 / 1825 用例，1802 通过、23 条件跳过、0 失败；`full-regression-split-selections.log`。
- abort-authorization-probe-002 成功且正常退出，外部模型请求 0；原失败与 probe-001 原样保留。
- 活跃 `paired-split-dev-001`，候选 `8a8ec79`，比较 owner PID 30580，终端句柄 9296。先 security_tool_1 candidate，后 happyword_12 candidate；复用两条正常 c33 基线，manifest 记录受限授权修复例外。公共导航仍冻结 0b72285。当前源码 HEAD ed67340 仅补实验控制端，不能把其差异算成 RC 候选收益。
- 模型运行期间停止全量回归，避免 CPU/原生测试竞争。先检查 progress + owner PID，不重启活跃模型。后续先评估真实 RC 完成度，再决定三例方案选择与八例留出；尚无严格 F2P/P2P 提升证据。

### 04:52 阶段计时依据

- 统计工具现保留真实 native-run 的 dispatch/settled 时间和各角色 summedRunMs；缺失计时明确记录，不从总耗时相减伪造业务时间，因为不同 run 可能重叠。此为离线派生报告，不改公共模型协议。
- security_tool_1/c33 原始记录：提取 152097ms，实现审查 27625ms，后者 STOP_REVIEW_DEADLINE。因此新候选需要证明更早结束提取并取得完整审查，不能只用低总 token 宣称效率。更新派生 usage 前另存 before-role-timing 快照，原始宿主日志未改。

### 05:04 开发对照与输入链路修复

- `paired-split-dev-001` 已全部 SETTLED：两组 F2P 5/5、P2P 843/843。会话总 token 1449935→1171210，记录耗时 951849→798126ms；这些原始差异仍不具备同等完成审查资格，不能宣称优化成功。候选 security1 提取 181879ms 后停止，无 workspace 审查；happy12 提取 114468ms、审查 65364ms 后 STOP_REVIEW_DEADLINE。四条最终状态仍 UNVERIFIED。保留所有失败和耗费。
- 真实工具链路发现 `8a8ec79` 的分片坐标只进入 request 旁路记录，未进入 worker 实际必读的 frozen request；相关早期测试只读旁路，覆盖不足。现实际冻结请求携带最小 sourceNavigation（sourceIndex、lineCount、每片 file/startLine/endLine，navigationOnly=true），回归直接断言真实 source_read 响应包含坐标，不复制完整 identity/sourceCatalog 或授予新证据。
- 新 `textFrom` 支持 file+工具显示的局部行号，或 sourceIndex+原始行号，明确拒绝两者混用、未知文件和边界残行；原始全文、来源权限与当前连续读取回执仍由程序校验。避免模型手算坐标和为已有引用反复读取。边界完整行仍可使用全局坐标跨块选取。
- 该候选实际宿主/基线/控制台回归 60/60，无跳过；私有 Skill 校验通过。完整全量回归仍对应此前 8a8ec79，不能声称新候选也已全量通过；在方案选定后再做最终全量检查。
- 下一步用相同冻结原始输入做提取器组件对照，减少反复业务实现的昂贵波动。新工具明确标识组件实验、使用共享 Git worktree、验证每份源字节摘要、只调用真实私有角色；不伪造业务完成/纠偏反馈，不作为 F2P/P2P 成绩。之后仍须整任务选择及冻结留出。

### 05:14 组件对照结果与紧凑协议选型

- 两个无模型准备的 sourceInputId 均为 b68e519d390de3233fc939b553fa52e759dd3ec7c22b6a65232a4e3551829b21。组件源来自已完成的 c33 security1 开发运行，输入仅冻结公开用户与 AGENTS；复用业务仓库 Git 对象和 detached worktree，没有复制 RC 仓库。
- `component-extractor-c33-001` 完成：真实私有 run 95760ms、46123 记录 tokens、5 reads、1 save、1 finish，4 条候选要求。终态的额外 assistant aborted 记录 usage 为 0，不是第五次模型请求；实际模型开始 4 次。未执行业务完成事件、反馈或隐藏评分。
- `component-extractor-local-001`（119f279）完成：真实私有 run 145632ms、88513 tokens、5 reads、3 saves、1 finish，5 条候选要求。确实采用 4 个局部选取和 1 个原始坐标，消除了此前的反复 grep/read，但重复 source 字段和 PROCESS 的 implementationRole=null 导致两次修复。未证明总体更快/省 token。
- 内容审计：c33 四条全为 USER_MESSAGE，未保留项目命令/约束；119f279 将“旧缺陷背景”单独设为 IMPLEMENTATION 要求，并把命令目录含 optional scenarios 的整块视为当前流程。两者均不能因 complete=true 宣称语义准确，项目 UTF-8 禁止项/条件仍需核对。候选条数不是准确率指标。
- 新选型复用现有 compact 协议作为长/分片来源的默认方式，隐藏 full text/source/bindings，支持局部 file+lines；仍显式保留完整格式回退、原文回执和权限。Skill 加入“背景与所请求修复合组、命令目录/可选示例不自动成为执行义务”的通用规则，不含任务/仓库/答案硬编码。IMPLEMENTATION 的 PRODUCTION/TEST/SUPPORT 仍由模型明确选择，PROCESS/ARTIFACT 不填无用 null。
- 紧凑默认及宿主/基线/控制台回归 61/61，0 跳过；新增实际 schema 拒绝重复 source 的反例及同会话完整格式回退；私有 Skill 校验通过。下一步在同一组件输入验证，不重复业务模型；之后再作整任务对照和最终全量回归。

### 05:20 编号原文视图与未完成结果

- `component-extractor-compact-001`（7b9ec12）已 SETTLED，但 completed=false / REVIEWER_DEADLINE；私有 run 182030ms，记录 51952 tokens，1 history、6 reads、8 greps，没有保存候选。原日志保留。紧凑 schema 消除了 source/null 误填的接口机会，但本次仍未证明端到端收益。
- 实际错误为在 33 行的 `source-0001-0001.txt` 使用 offset=382；拒绝后未自动换算/夹紧，未授予错误覆盖。进一步发现 source_read 仅有整页 start/end 元数据，正文没有逐行标签，先前“工具显示行号”的描述过强。
- 新增可选 numbered=true 视图，复用共享 UTF-8 增量 render 分页；默认原始响应保持不变。offset 参数/错误明确为命名文件的局部行号。基线提取工具指南建议原始 source-* 使用编号视图，request/baseline JSON 可保持原文。显示前缀计入页预算；原文选择仍捕获原始字节，不把编号写入要求。
- 真实宿主/基线/控制台/分页/grep 共 68/68，无跳过。编号读取可产生当前有效原文回执并提交紧凑选取；伪造编号开关或篡改显示内容被拒绝；高密度行的编号开销计入字节上限。此为工具/权限回归，尚非模型效率收益。
