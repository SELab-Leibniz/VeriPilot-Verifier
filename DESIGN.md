# MVP 流程

入口为 `scripts/run-experiment.mjs`。机器配置放在 `machine.yaml`，每个样本通过自己的 `experiment.yaml` 引用项目、提示词和 RC 配置。具体命令见 README。

1. 预检机器工具、鸿蒙路径、已配置模型和样本输入，计算实际文件哈希。
2. 创建唯一运行目录，复制项目，提取指定 RC 包，通过 RC 初始化函数生成实际配置并建立 Git 初始提交。
3. 生成本次私有 OpenClaw 配置、状态目录和随机认证 token，启动独立 Gateway。机器环境注入其子进程；生产配置与 MA/OpenClaw 安装保持只读。
4. 通过原生 `sessions.create(worktree: true)` 建立新业务 Session，采用返回的实际项目路径，通过 RC RPC 显式启用该 Session。
5. 持久化唯一请求 ID，再调用一次 `chat.send`。丢失响应时观察原 ID，不重发。RC 负责后续审查、修复与复验，业务 Session 持续保留。
6. 等待各业务/纠偏运行的 `agent.wait` 终态、RC 当前轮结束、队列清空、调度空闲、私有审查结算、启动准入无保留。状态和终态分别保存，不将宿主完成等同于 RC 通过。
7. 只在这些工作均结束后关闭本次 Gateway，保存最终项目、原始会话、状态、配置和日志。没有独立评估与评分。

异常或观察截止为 `NEEDS_ATTENTION`，保留原运行和 Gateway。`--resume` 只恢复观察。控制锁避免两个脚本同时观察同一运行；关闭前校验精确 Gateway 进程。已知宿主版本为 MA OpenClaw 2026.7.1-2，其他版本先失败并提示，不猜测适配。

`--plan` 仅检查；`--prepare-only` 进行真实宿主准备，不提交业务任务；正常入口执行完整样本。快速排序例子的 unittest 是业务交付内容，不是脚本附加的独立评分器。
