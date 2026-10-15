# OpenClaw 小 Skill 看护示例

`skills/rc-mini-note` 生成项目内的 `note.json`，然后实际运行自带的只读校验器。输入只有业务项目绝对目录和标题，产物只有 `title`、`status` 两个字段。需要 `python3.13`。

将 `rc-mini-note` 文件夹放入 OpenClaw 当前 Agent 的实际工作区 `skills/` 目录。宿主负责发现和调用 Skill，RC 负责项目内的执行看护，不接管业务工具或目录选择。

业务项目必须明确启用 RC。在现有 `.runtime-corrector/config.yaml` 中合并以下设置，保留项目已有产物及 Reviewer 配置：

```yaml
version: 2
dynamicGroundTruth:
  enabled: true
skillCorrection:
  enabled: true
  selection:
    mode: include
    include: [rc-mini-note]
stopCorrection:
  enabled: true
```

在 OpenClaw `2026.7.1-2` 当前 Session 中先选择 RC 项目，再调用原生 Skill：

```text
/rc-project bind /absolute/business-project
/skill rc-mini-note 项目绝对目录=/absolute/business-project，title=本次交付
```

Skill 会写入 `{"title":"本次交付","status":"ready"}`，真实执行校验并得到 `NOTE_VERIFIED` 后交付。看护记录保存在绑定业务项目的 `.runtime-correction/tasks/<taskId>/skills/rc-mini-note/`，可核对原始约束、watcher、评审及反馈预算。

候选插件 `.3` 会将宿主可信执行上下文中的 `skills/` 纳入当前 Session 的 Skill 源解析，因此 RC 业务项目与 Agent 工作区不同也不需要为这个标准目录额外设置 `skillRoots`。这不改变宿主工作目录。自定义目录仍沿用项目的显式 `skillRoots` 配置；未提供可靠执行目录时不猜测 Agent 默认目录。

真实故障与正常对照实验使用 `scripts/diagnostics/session-skill-guard-live.mjs`。它把 Skill 安装到临时宿主工作区，在两个独立 Session 中通过 `/skill` 调用，并用真实 Reviewer、原生续作和独立校验核验结果；凭据只通过环境变量注入。
