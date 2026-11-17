# Windows 使用教程

按这个顺序即可：

1. [新机器安装与第一次运行](01-windows-setup.md)
2. [机器配置与样本包](02-configuration-and-samples.md)
3. [失败、中断、恢复与日志](03-troubleshooting.md)

平时只需维护一份 `machine.yaml`；每个样本带自己的项目、提示词和 RC 配置。普通测试用 `npm test`；真实 Windows 准备用 `npm run test:windows`，它也从同一份机器配置读取路径，不调用模型。

当前适配版本：MA OpenClaw **2026.7.1-2**、带 Session 状态接口的 RC MA **1.11.0**。宿主版本不匹配会在预检时报错。已在当前 Windows 上验证 PowerShell 7.6.9，以及 Windows PowerShell 5.1.26100.9711 的独立配置场景；尚未在另一台物理机器或鸿蒙项目上实跑。

当前已知问题：完整默认 RC 配置在本次两次触发测试中遇到 `RC_HOOK_UNAVAILABLE`，原因包含前置热钩子超过 9 秒内部预算。关闭该样本的 `requirementFrame.enabled` 后，已验证一次 `DEVIATION → 自动修复 → NO_DEVIATION_FOUND`。这两个结论不能混在一起；详情见 [纠偏实测记录](../CORRECTION-VALIDATION.md)。
