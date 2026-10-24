# Stop 单项 Review 交付范围

本版冻结已经对照验证的 Prompt，不再做开放式调参。OpenClaw 默认 `stopReviewEngine: "task"`；设置为 `"native"` 可恢复之前的审阅传输。配置属于插件设置，未改变项目需求或验收分母。

## 接入位置

既有 Stop 编排仍负责 Ground Truth 刷新、Stop 分类、指标分母、截止时间、纠偏次数和宿主续作。既有 collector 负责逐项落盘、失败隔离、PASS 缓存、引用字节核验与有界短反馈。新模块仅替换其中可支持的单项审阅。

- 任务完成且明确适用于当前任务的 M01、M05：需求分解覆盖和验收单元覆盖。
- 实现审查中的 M12：源码实现子证明。
- 任务完成且实现归属的普通 Stop M12：实际运行证据审查，不能用源码 PASS 代替。
- 其他指标、PROCESS、条件适用性尚待判断、阶段完成、中间 Stop、分类、Ground Truth 与 Skill：继续原 native 路径。

新工厂按单个冻结对象分派，同源多个指标仍是不同职责；不枚举验收条件的笛卡尔积。没有新增总评模型。M01 的对象覆盖 PASS 不被转换成文件整体质量 PASS；补充文件质量职责继续由原有 native 子项承担。本版未消除 general Stop 与后续 implementation reviewer 之间所有既有重复检查。

## 输入、输出与稳定性

原始义务、公共约束与显式依赖复用同一 `reviewScopeClaims` 选择函数。过大的必读 JSON 按准确 UTF-8 字节分片，未删条件、未另起模型摘要。完整原始基线另外保存，供有具体疑问时检索。进程记录按原事件分别保存，初始 Prompt 不携带完整过程索引或整份源码文件表。

源码仅在允许的业务文本范围内复制；私密目录、认证文件、构建缓存与符号链接不能进入该输入。实现引用仍受原 sourceManifest 约束。模型只读其专属快照，可用 read、grep、find、ls 和本轮历史检索，不能执行或改写业务文件。

每个 Review 使用独立 Pi 会话，沿用已经实验的原生提前 compact、旧轨迹索引和请求前健康检查。每项仅提交状态、短诊断和最多六个 citeId；程序获取原文和位置。父取消、任务替换、GT/源码变化与迟到结果均不能升级为 PASS。单项未完成保留为 UNVERIFIED，其他已完成项仍由原 collector 保存和反馈。

PASS 缓存身份包含新协议和固定 Prompt 摘要。复用前仍核验冻结输入和读取依赖；证据不足或范围太大不能安全缓存时重新审查，不猜测旧结论有效。

当前缓存仍沿用最多128个读取依赖的保守限制；大项目可能不复用 PASS。新单项指标才按一对象拆分，其余 native 指标保留原有同源组批，避免扩大请求数量。执行器中止时只透传白名单失败类型与该项 result.json 位置，未知提供商错误不直接回显给宿主。

## 开发与安装

仓库开发环境先安装独立 SDK 依赖：

```powershell
npm ci --prefix lib/review-task --ignore-scripts
npm test
npm run build:plugin -- --host openclaw
```

发布产物的根 package.json 和锁文件包含相同的精确 SDK 依赖，使用 `npm ci --ignore-scripts` 安装。构建排除所有层级 node_modules 和实验数据。其它 CLI 宿主不会新增这些根依赖，也不会加载这条 OpenClaw 传输。

Pi 仍为 1.4.0；传输依赖 undici 覆盖为 8.12.2，区别于原实验锁。这是接入交付时的明确依赖补丁，需同时跑机制和真实模型验证。

## 解释结果

本版的目标是稳定收集可定位的纠偏信息，不承诺完美检出。已知的未知商品 ID fallback 漏报仍是准确度边界。只有源码子证明通过不代表运行、其它指标或整个 Stop 通过。

验证区分：scripted-provider 的故障与缓存机制、真实模型的生产单项传输、使用宿主/reviewer doubles 的 Native Stop 续作闭环。不会把它们合并宣称为完整真实模型端到端验收。原业务项目和原 session 保持只读；构建和隔离验证不要求替换运行中的 Gateway。

本次记录见 [交付验证](experiments/stop-task-integration-20261024.md)。仓库中的 stop-task-integration.mjs 可重跑已提交厨房/花店冻结案例，默认只预检，真实模型调用需显式 --live。stop-task-complex.mjs 另外依赖本机此前的冻结 complex-preflight-01 capture，不会读取当前原项目或 session；这些复杂业务快照不随安装包分发。
