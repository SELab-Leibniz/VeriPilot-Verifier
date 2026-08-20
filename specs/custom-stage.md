# 通用 Stage 全局规范

本规范适用于项目在 `.runtime-corrector/config.yaml` 中注册的所有业务 Stage。项目配置、
硬规则和 Agent reviewer 是该 Stage 的客户可见权威来源；插件核心不内置业务 Stage。

## 注册与启用边界

1. `artifacts[]` 中出现一个 stage，表示该 stage 已注册；`enabledStages` 决定它当前是否启用。
2. stage 名必须以小写字母开头，只能包含小写字母、数字和连字符，最长 64 个字符。
3. 一个 stage 可以声明一个或多个 artifact；命中任一 `patterns` 后，按该 artifact 的规则执行。
4. `rules`、`reviewer` 和规则引用的 Schema 必须位于项目 `.runtime-corrector/` 内，不得通过绝对路径或 `..` 越界。
5. 关闭 stage 只停止命中，不删除配置、规则、reviewer 或历史诊断。

## 纠偏执行契约

1. Claude `Write` 或 `Edit` 写入命中路径后触发检查；也可通过 `check` 手动检查。
2. PostToolUse 先运行 `*.rules.yaml` 中的确定性规则，再从当前 session 创建一次性只读 fork，按 `*.reviewer.md` 和本规范审阅现有快照。
3. hook 将确定性与语义诊断合并后生成并校验候选 Patch；不会自动修改 artifact，也不会自动应用 Patch。
4. 主 Agent 应基于诊断做最小修正，然后重新检查，直至通过、转人工或发现规范冲突。
5. `spec <stage>` 必须同时展示本全局契约、实际 artifact 匹配、完整 rules、引用 Schema 和 reviewer，确保失败恢复不依赖猜测。

## 自定义 Markdown Stage 的精确语法

- `require-heading` 按 Markdown ATX 标题匹配，例如 `## 设计目标`。
- `require-checklist` 要求目标章节内使用 `- [ ]` 或 `- [x]` 开头的检查项。
- `require-text` 要求至少出现一个配置值；`forbid-text` 禁止出现配置值。
- 规则只能检查其明确声明的结构或文本；业务语义、事实忠实度和取舍合理性应写入 reviewer。
- reviewer 无权扩张用户需求；无法由证据确认的内容必须标记为待人工确认。

## 失败恢复

发生失败时，反馈必须包含确定性诊断、项目 reviewer、完整 stage 规范地图和候选 Patch 数量。若同一问题反复失败，应运行 `spec <stage>`，通读展开后的所有规则再做一次有界修正，禁止读取插件测试来猜隐藏格式。
