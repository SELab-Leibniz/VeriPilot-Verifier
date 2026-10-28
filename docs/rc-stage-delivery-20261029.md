# RC 端到端阶段交付（2026-10-29）

按用户选择，本次先交付可安装、真实链路正常运行的阶段版本；完整基准验收后续继续。五分支共同基点、融合取舍和原始实验见 [五分支融合记录](five-branch-fusion.md)，持续优化和失败记录见 [系统优化记录](rc-system-optimization.md)。

## 本次固定产物

- 开发分支：`codex/rc-general-efficiency-bench`，外部 worktree 共享原仓库 Git 对象。
- 插件版本：`1.9.1-openclaw.11-session-projects.15`。
- 运行源码：`bacea56c2f571f9d4cd24c28b2232c283d05e549`。其后的变更只涉及开发验收、计量与本次交付记录。
- 实测：Node `24.16.0`，MatrixAssistant 内置 OpenClaw `2026.7.1-2`，真实模型 `glm-5.3-flash`。
- 安装包来自同一份冻结产物；验收不改 MatrixAssistant 或其内置 OpenClaw，在本仓库的隔离状态、会话与小型验收工程中运行。

## 已通过的真实端到端验收

两组均经已认证 `sessions.create` + `chat.send` 发起真实用户请求，由模型实际写入业务文件，使用注册的宿主 Hook 和原生运行终态。没有注入模型转录、假完成事件或假审查结论。

1. **正常完成**：宿主写入实现 → 提取原始需求基线 → Stop 审查 PASS → 任务 COMPLETED。自动纠偏 0 次；提取器 1 个、审查器 1 个，均 SETTLED。
2. **发现偏差并修复**：仅在原始模型真实完成时，测试夹具将已写入的实现改成缺陷版本 → 原始审查 DEVIATION → 宿主真实启动 1 次纠偏 → 修复文件 → 第二次审查 PASS → 任务 COMPLETED。提取器 1 个、审查器 2 个，均 SETTLED。
3. **独立离线复核**：两组均通过。原始对象集合保留；故障组前后的同一对象从 DEVIATION 变为 PASS，未删除义务或缩小分母。纠偏额度只扣实际业务启动的 1 次。实际导入最终模块检查行为通过，Gateway 正常关闭。

原始证据保存在 `.runtime-correction/system-optimization/delivery-e2e-normal-001/` 和 `delivery-e2e-correction-001/`，包含 `result.json`、`audit.json`、真实宿主记录和任务状态。交付包只附去敏摘要，不包含宿主配置、令牌、会话转录或测试夹具插件。

完整回归通过：**163 文件，1833 项用例，1810 通过、23 条件跳过、0 失败、0 超时**。结果随 [去敏摘要](rc-stage-delivery-20261029.results.json) 和包内 `acceptance-summary.json` 固定；原始日志为 `.runtime-correction/system-optimization/full-regression-delivery-20261029.log`。跳过项不计为通过。

## 安装与启用

解压交付 ZIP，在解压目录使用 PowerShell。关闭 MatrixAssistant 后，将下方宿主路径改为本机安装目录，依次执行：

```powershell
node "<MA安装目录>/resources/openclaw/openclaw.mjs" plugins install --force ./runtime-corrector-openclaw
node ./runtime-corrector-openclaw/scripts/configure-ma-host.mjs --tool-agent main
```

配置工具会备份原配置；重新打开 MatrixAssistant 后，在已选择目标项目的会话中依次发送：

```text
/rc-project init
/rc-project on
/rc-session on
```

已有 `.runtime-corrector` 的项目跳过 `init`，保留现有规则。项目与会话开关不会自动打开 Stop 功能；需在项目 `.runtime-corrector/config.yaml` 中启用所需功能。自动纠偏至少需要：

```yaml
stopCorrection:
  enabled: true
  waitMode: until_pass
  maxCorrectionsPerSession: 1
  maxCorrectionsPerFlow: 1
```

合并这些字段到现有配置，保留审查窗口、指标及其他配置。`reviewers.defaults.model` 使用宿主已注册的 `provider/model`，不填写 API key；初始化命令从宿主 RC 设置取得该模型。若提示未配置模型，先执行 `/rc-setup`。默认模板的 Stop 功能关闭，模型或项目未配置时不会自动开始审查。

用 `/rc-session status` 检查 `effectiveEnabled`；当前 Gateway 的 `/plugins/runtime-corrector/` 控制台可查看基线、M01–M16、响应时间线与反馈回执，支持搜索、筛选和分页。完整说明见包内 `runtime-corrector-openclaw/docs/openclaw.md` 和 `docs/session-control.md`。在解压目录执行 `node ./verify-package.mjs` 可只读核对全部 244 个插件文件的字节与 SHA256；完整 ZIP 的 SHA256 另附于同名 `.sha256` 文件。

## 验收范围和后续工作

本次真实模型验收聚焦 **M16 实现义务** 的正常完成和一次自动纠偏闭环；不代表 M01–M15、所有 Skill/文档纠偏、长任务、Electron 桌面长时交互或其他 OpenClaw 版本均已通过真实模型验收。相关模块仍由工程回归和既有专项证据覆盖。

完整 SWE-ArkTS 的 F2P/P2P 同时提高、同等审查完成度下 token 与耗时更低，**尚未证明**。为满足本次交付时限，`paired-blank-selection-001` 的在途候选已明确中断并保存停止记录，不能作为有效配对或准确率失败样本。没有丢弃旧失败、超时或计费下界。后续从固定选择集和留出集继续，不能以本次小型端到端成功代替完整效果对比。

计量工具已补充提供方请求与非零 usage 记录的覆盖检查：中断请求的缺失用量保持未知，宿主合成的零 usage 终态不能冒充零消耗；只有完整核算且完成同等审查时才能宣称效率改善。
