# MatrixAssistant 适配验证记录

基线为 `371253e`（`codex/rc-general-efficiency-bench`）。只修改 RC；MA、已安装扩展和用户配置均不在本次写入范围。真实宿主安装和验证由用户执行。

## 地基分支：E1、E2、X1

- `.gitattributes` 固定测试和夹具为 LF；二进制及原始问题陈述保留逐字节内容。执行 `git add --renormalize .`，其余规范化差异仅涉及行尾。
- `lib/path-utils.mjs` 新增 `isSameFile`（优先 bigint dev/ino，Windows 路径回退忽略大小写）及 `hasLinkedPath`（逐级 lstat 识别链接/Junction）；本分支不替换调用点。
- `scripts/test.mjs` 在缺少源码测试依赖 typebox 时给出准确安装命令，继续运行并保留失败。README 写明 `npm ci --prefix lib/review-task --ignore-scripts`。
- 新增 `test/path-utils.test.mjs` 三项行为测试与 `test/test-dependencies.test.mjs` 一项依赖诊断测试；全部通过。链接测试在 Windows 使用无需符号链接权限的目录 Junction，在 POSIX 同时覆盖文件符号链接。

| 回归观测 | 测试 | 通过 | 失败 | 跳过 | 失败文件 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 原始环境，未安装 typebox | 2136 | 1893 | 185 | 58 | 53 |
| 地基层，已安装依赖 | 2735 | 2397 | 280 | 58 | 29 |

原始环境中 34 个文件因缺少 typebox 无法加载，不能直接以两行的失败总数判断回归。在 `371253e` 的隔离副本中安装同一锁定依赖，补跑这 34 个文件：637 项，495 通过、142 失败。结合原始其余文件，补全观测为 2739 项、2388 通过、293 失败、58 跳过；嵌套测试会随前置结果改变实际执行数。

按文件及失败测试名称核对，地基层没有新增失败。依赖安装使 20 个原先加载失败的文件及 `openclaw-task-runtime`、`review-result-proof-boundary`、`stop-task-compat` 恢复通过；这些是开发依赖恢复，不能计为适配逻辑修复。`document-cli-e2e` 的 200ms 启动输出断言本次恢复通过，属于时序观测差异，尚未修改其行为。

原始失败还包括 9 个文件中的 Windows 文件符号链接权限问题，以及缺少宿主校验器路径引发的基线提取失败（`stop-baseline-task` 原始观测有 122 项失败）。它们继续保留在失败清单中。两次全量均无文件超时。

三个宿主的 `npm run build:plugins` 均成功；`npm run test:artifacts` 17/17 通过。完整 JSON、日志和差异记录位于忽略目录 `.runtime-correction/fix-baseline/`，不提交产物。

## 已确认的设计决策

- B4：可归因于 RC 自身错误提示的边界拒绝不扣减共享修复额度；其他拒绝保持原规则。
- X2：显式 host-setup 默认追加内部会话排除规则；先备份、保留已有规则并保持幂等。开发测试只用临时配置。
- T1：最多重试 12 次、60 秒后升级，保留 UNKNOWN；安全解除需要二次确认。
- T3：待用户确认长期共存策略；MA 当前已停止。
