# Stop 真实需求试验

本试验使用 DeepSWE 1.1 的 `gql-incremental-graphql-delivery` 原始公开需求和任务镜像。它要求为 gql 增加增量执行 API、HTTP multipart / WebSocket 支持、递归 patch 合并及 DSL defer / stream，属于跨客户端、传输层和 DSL 的完整功能需求。

仅启用 Stop 默认六项指标及其必要的单阶段需求抽取；文档、Skill、写入时实现纠偏和抽取 panel 关闭。没有注入故障，也不向业务模型提供官方隐藏测试或参考答案。模型为 `glm-5.3-flash`，真实 OpenClaw `2026.7.1-2` 接收原始需求并自然完成任务，再由 Stop 决定是否修复；最多允许三次修复。

## 时间配置

本次按用户要求共用 12 小时绝对截止时间（`43200000` 毫秒），覆盖宿主启动、原始任务、Stop 审查、修复及复审。不会在 90 分钟结束；宿主任务、私有审查、无进展保护及会话锁均允许该窗口。角色审查比外层少 30 秒，用于反馈和清理。可配置范围扩大到 12 小时，其他入口默认仍为 20 分钟。

GLM 接入声明 `reasoning: true`、原生 `thinking: low` 和 `requiresReasoningContentOnAssistantMessages: true`，保存并回传工具回合之间的思考字段。中继只记录字段数量和长度、请求哈希、HTTP 状态及 token 用量，不保存认证密钥和响应正文。密钥只进入宿主进程；容器只拿到单次随机中继凭据。

## 固定输入与运行

本轮原始轨迹为 `.runtime-correction/stop-benchmark-gql-20261102-003/live-reasoning-005`。它在 198 次成功请求后遇到提供方 401，约 48 分钟时中断，尚未进入 Stop。用户更换凭据后，在 `.runtime-correction/stop-benchmark-gql-20261102-004/live-auth-resume-006` 保留代码和会话续跑；没有重做业务实现或代替模型提交。原始 12 小时截止时间继续生效，续跑只分配剩余窗口。

各准备目录包含冻结插件、运行源码、公开需求及 manifest；逐文件摘要见 `source-identity.json`。恢复前核对 HEAD、分支、工作区状态和全部变更文件摘要；`checkpoint.json`、`uncommitted-source.json` 及源码归档保留中断现场。之前目录保留接入、宿主保护和协议探测的失败及主动终止记录，不作为 Stop 成功证据。

使用已准备目录启动新的独立案例（认证值由当前进程环境提供）：

```sh
node scripts/run-native-stop-benchmark.mjs \
  --prepared-root /absolute/path/to/prepared-root \
  --attempt a-new-attempt-name
```

准备目录声明原始任务镜像与基准提交。控制器使用已有 Docker Node/OpenClaw 只读运行时卷、2 CPU 和 8 GiB 内存，避免改动本机 OpenClaw 配置。业务目录初始必须干净并位于基准提交；原始公开需求要求模型自行创建分支、提交修改。

## 独立评分

首次原始宿主完成且 Stop 审查已出现、尚无修复使用时，保存模型真实提交得到的 `first-stop/model.patch`。结束时保存最终 `model.patch`。未提交修改仅保存在诊断文件，不会由控制器代替模型提交或混入官方预测。

原始评分器运行在另一个禁用网络的全新容器中，不将评分器测试挂入业务容器。镜像由原始任务的 `tests/Dockerfile` 构建；指定单平台且关闭构建证明附件，避免本机 Docker 无法按镜像 ID 启动多平台索引的问题：

```sh
docker build --platform linux/amd64 --provenance=false \
  --tag rc-stop-gql-official-verifier:427384f-amd64 \
  /absolute/path/to/DeepSWE/tasks/gql-incremental-graphql-delivery/tests
```

评分前已核对镜像内四个评分文件与原始任务的摘要一致，再按不可变镜像 ID 运行：

```sh
python3 scripts/grade-native-stop-benchmark.py \
  --prepared-root /absolute/path/to/prepared-root \
  --attempt a-completed-attempt-name
```

`result.json` 是 Stop 运行结果；`official-scoring/comparison.json` 记录官方首稿/最终评分，两者分别报告。仅当真实宿主终态成功、Stop PASS、私有审查结清后，运行入口才返回成功。官方测试失败不会变成成功，也不会把隐藏失败内容回灌模型。首稿/最终比较来自同一条轨迹，不属于独立 RC 关闭对照试验。
