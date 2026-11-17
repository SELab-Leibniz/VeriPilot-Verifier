请在当前项目完整解决 ./requirements.md 中的 security_tool_2 需求。它来自原始公开任务，不包含参考补丁或隐藏评测信息。

遵守项目 ./AGENTS.md 和它引用的 AI 执行原则。先阅读相应模块设计文档；如果改变模块行为，先更新设计文档，再实现代码和必要的公开测试。只处理本项目，不调用子 Agent，不连接或部署到设备，不签名应用。

当前环境为 Windows PowerShell。所有命令均在本次实际 Session 工作树执行。机器工具路径由环境变量提供，不要把本机绝对路径写进项目。项目提供 ./demo-checks.ps1，使用配置的鸿蒙工具链运行真实检查：

1. `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./demo-checks.ps1 -Phase install`
2. 完成实现后运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./demo-checks.ps1 -Phase test`
3. 运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./demo-checks.ps1 -Phase build`
4. 运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./demo-checks.ps1 -Phase docs`

脚本在项目 ./demo-output/ 保存真实输出及退出码。检查失败时依据原始日志定位；不要把检查未执行或零测试说成通过，也不要为了通过检查删除现有测试。不要修改 requirements.md、AGENTS.md、demo-checks.ps1 或 .runtime-corrector/、.runtime-correction/。

最终说明修改、测试和仍有的限制。仅执行公开项目任务，不执行独立评估或评分。
