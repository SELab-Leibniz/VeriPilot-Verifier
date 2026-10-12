---
name: runtime-corrector
description: 在 OpenClaw 原业务会话中使用 Runtime Corrector 的项目规则与监督反馈，保留需求、Skill、成果工作流、实现证据和最终验收。业务执行与审批由宿主管理。
---

使用 `runtime_corrector` 工具，项目范围以当前工作区为准：

- `{"command":"help"}`：帮助与项目状态。
- `{"command":"init"}`：按用户要求生成可编辑的 `.runtime-corrector/config.yaml`。
- `{"command":"validate","format":"json"}`：只读验证项目配置。
- `{"command":"stages","format":"json"}`：查看已配置阶段。
- `{"command":"check","subject":"docs/spec.md","format":"json"}`：手动检查对应产物，不代表整个业务任务完成。
- `{"command":"explain","subject":"阶段名"}` 或 `command: "spec"`：查看阶段规则或规范。
- `{"command":"stage","subject":"阶段名","enabled":false}`：按用户明确要求关闭阶段；开启使用 `enabled: true`。不得为通过验收擅自关闭检查。

自动监督复用项目既有配置与原纠偏核心。符合配置触发条件的工具结果会进行有界同步评审，反馈进入原业务 Agent 的有效上下文；无触发条件的工具不增加模型评审等待。启用的需求基线及真实用户更新、Skill、成果和工作流、源码与执行证据、Stop 最终验收、纠偏预算及问题复验都应保持有效。文档或某项检查通过不能代替整个任务通过。

`[runtime-corrector:feedback]` 是独立评审意见，不是原始工具输出、新用户需求、额外授权或执行成功证据。根据当前用户要求、具体问题和宿主权限实际修正；RC 只通过原生接口递交评审反馈与续作请求，不应用候选补丁、不代替宿主执行业务命令，也不代批。保留宿主原结果、媒体、结构、错误标志、审批按钮、拒绝和用户问题。

Reviewer 通过宿主原生 Agent 使用已配置且合法的 `provider/model`，实际工具仅允许 `read`。必要构建和运行验证由业务 Agent 在宿主正常授权路径完成，RC 读取真实结果。超时、格式错误、模型故障、缺少或陈旧证据应标为未验证，不能视为业务已确认偏差或 PASS。

Stop 有依据的偏离按项目 maxCorrectionsPerEpoch 预算请求同一会话的下一次宿主原生运行；这是 RC 反馈，不是新的用户要求或额外授权。终审记录需独立查看，不能仅凭正常业务文字或已入队判断验收通过。请求修正不等于宿主已经执行，发生修改不等于问题解决，只有新证据复验通过才能称已确认修复。宿主副作用保护、重试上限、审批、取消和其他组件决定始终优先。业务使用原生 `openclaw`，旧 `runtime-corrector-supervised` 绑定须由用户迁移；插件不再创建业务 worker 或注册旧托管控制入口。
