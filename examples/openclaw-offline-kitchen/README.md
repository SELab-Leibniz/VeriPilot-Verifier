# 离线厨房 Python 应用与 Skill 验证示例

`app/kitchen.py` 是 OpenClaw `2026.7.1-2` 在隔离项目中通过原生
`build-offline-kitchen` Skill 从空代码实际生成的应用，归档时未手动修改源码。
它使用 Python 标准库和本地 JSON 管理菜谱、食材库存、缺料判断与烹饪扣减。
运行应用无需网络或第三方依赖。

用 Python 3.13，在选定的数据目录运行，例如：

```sh
python3.13 /absolute/path/to/kitchen.py --store kitchen.json recipe add '番茄炒蛋 🍳' '{"番茄":2,"鸡蛋":3}'
python3.13 /absolute/path/to/kitchen.py --store kitchen.json pantry set 番茄 2
python3.13 /absolute/path/to/kitchen.py --store kitchen.json pantry set 鸡蛋 3
python3.13 /absolute/path/to/kitchen.py --store kitchen.json can-cook '番茄炒蛋 🍳'
python3.13 /absolute/path/to/kitchen.py --store kitchen.json cook '番茄炒蛋 🍳'
python3.13 /absolute/path/to/kitchen.py --store kitchen.json pantry list
```

所有命令支持全局 `--store PATH`。`recipe list` 查询保存的菜谱；`--help`
显示完整用法。库存不足、未知菜谱和非法输入会失败，已有存储字节保持不变。

原生 Skill 位于 `skills/build-offline-kitchen/`。将该文件夹放入实际 OpenClaw
工作区的 `skills/`，在明确启用 RC 的业务项目中调用：

```text
/rc-project bind /absolute/business-project
/skill build-offline-kitchen 项目绝对目录=/absolute/business-project，请按Skill合同实现并真实验收。
```

适用于本轮候选插件 `.3` 的标准工作区 Skill 目录，不需要为它额外配置
`skillRoots`；RC 绑定不改变宿主工作区或业务工具路径。项目需启用
`dynamicGroundTruth`、选中该 Skill 的 `skillCorrection` 及 `stopCorrection`。
完整功能合同在 Skill 的 `references/requirements.md`。

Skill 自带 `scripts/verify_kitchen.py`，实际运行 21 个独立 CLI 场景，检查
Unicode、跨进程持久化、库存不足时不扣减、错误操作不改写字节及存储隔离。
验收通过 Python 审计钩子拒绝应用的 socket 和派生进程调用，并用 `-I -S`
隔离应用进程；模型开发与 RC 评审仍使用已授权的外部模型接口。

复现实验使用 `scripts/diagnostics/offline-kitchen-live.mjs`，传入宿主目录、无
凭据的 provider 描述 JSON、新输出目录与空闲端口，以环境变量提供测试 key。
所有宿主状态、业务项目、数据与运行记录均在新的隔离目录中创建。

本轮应用独立功能验收为 21/21 PASS，但两个负向纠偏试验最终都耗尽预算，
因此不是整轮全通过。Skill 约束缺失、过程要求误送源码评审及历史流程违规的问题、
原始 FAIL 和后续措施见 [隔离实测报告](../../docs/experiments/offline-kitchen-openclaw-20261015.md)。
