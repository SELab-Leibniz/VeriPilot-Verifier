# Windows 使用教程

按这个顺序即可：

1. [新机器安装与第一次运行](01-windows-setup.md)
2. [机器配置与样本包](02-configuration-and-samples.md)
3. [失败、中断、恢复与日志](03-troubleshooting.md)
4. [给外层控制器的实验状态接口](04-experiment-status.md)

观察恢复、总时限和异常清理的实际结果见 [流程验证记录](../FLOW-VALIDATION.md)。

平时只需维护一份 `machine.yaml`；每个样本带自己的项目、提示词和 RC 配置。普通测试用 `npm test`；真实 Windows 准备用 `npm run test:windows`，它也从同一份机器配置读取路径，不调用模型。

当前适配版本：MA OpenClaw **2026.7.1-2**、带 Session 状态接口的 RC MA **1.11.0**。宿主版本不匹配会在预检时报错。已在当前 Windows 上验证 PowerShell 7.6.9、Windows PowerShell 5.1.26100.9711 的独立配置场景，以及 security_tool_2 的真实鸿蒙公开测试和构建；尚未在另一台物理机器实跑。

历史快排测试使用旧 RC：完整默认配置曾遇到前置热钩子超时；关闭该样本的 `requirementFrame.enabled` 后验证过 `DEVIATION → 自动修复 → NO_DEVIATION_FOUND`，见 [纠偏实测记录](../CORRECTION-VALIDATION.md)。security_tool_2 当前使用 `codex/rc-general-efficiency-bench` 的固定提交和指定配置，requirementFrame 保持开启，见 [当前适配记录](../validation/SECURITY-TOOL-2-CURRENT-RC-20261124.md)。相同的插件版本号不代表内容相同，应核对包哈希与来源提交。
