# 项目与 Session 开关

OpenClaw 和 MatrixAssistant 可以让同一项目中的编码会话开启 RC、review 会话关闭 RC。开关只停止对应会话的纠偏工作，业务会话继续执行；不同会话的需求、评审和预算保持独立。

## 项目设置

在项目已有的 `.runtime-corrector/config.yaml` 中增加控制字段，其余规则继续保留：

```yaml
version: 2

# 项目总开关
enabled: true

# 新登记 Session 的初始选择
sessionDefaults:
  enabled: false

artifacts: []
dynamicGroundTruth:
  enabled: true
stopCorrection:
  enabled: true
```

根级 `enabled: false` 覆盖本项目所有 Session 的开启选择。重新设为 `true` 后，按各 Session 保存的选择恢复，不把手动关闭的会话一起打开。

`sessionDefaults.enabled` 只影响尚未在项目登记的会话实例。首次生命周期登记会保存自己的选择，即使默认值为 `false`；后续修改默认值不会改变已有记录。两个字段缺省均为 `true`，版本 1 和版本 2 的旧配置无需迁移。

Session 开启后，各项纠偏功能仍遵循原配置。宿主插件停用、项目配置缺失或无效、目录或权限无法核验时，Session 不能单独绕过。OpenClaw 仍要求项目有有效配置；本功能不改变其他宿主原有的零配置行为。

## 当前会话的使用方式

在当前会话执行：

```text
/rc-session status
/rc-session on
/rc-session off
```

`status` 返回项目、当前会话选择 `requestedEnabled`、实际状态 `effectiveEnabled`、原因 `reason`，以及本地记录的 `settingsFile` 和 `recordKey`。查询不创建会话记录、需求基线或 Reviewer。

`on`、`off` 仅修改当前 Session。操作需要可信用户身份和宿主写权限；状态查询需要读权限。项目或插件总关闭时，`on` 返回阻断原因，不自动打开上层开关。保存失败会返回错误，不声称设置已经持久化。

关闭会取消 RC 评审、解除 RC 等待，并拦截旧评审的迟到反馈。它不撤回宿主已经接受的业务执行。重新开启在下一个正常检查点继续，保留同一任务的需求基线和预算，不重放旧纠偏。

## 手工编辑会话文件

RC 将选择保存在项目的 `.runtime-corrector/sessions.local.yaml`。该文件属于本地设置，项目应在自己的 `.gitignore` 中忽略它：

```gitignore
.runtime-corrector/sessions.local.yaml*
```

以下展示一条自动生成的示例记录：

```yaml
version: 1
sessions:
  s_c0f4acc9913665045d3ecf03c904590253773f36b1001f1c9f8155859cd491a8:
    namespace: "3f798a554b81fb1d21f380d5ab8738871ad90ef176acd6965be2c7bbbb2569d9"
    agentId: "main"
    sessionKey: "agent:main:example"
    sessionId: "example-instance"
    enabled: false
```

通过当前会话的 `status` 找到实际文件和记录键，只修改目标记录的 `enabled`。记录键、`namespace` 和身份字段由 RC 生成，不能用显示标题替换；不同宿主 profile 和会话实例分别识别。需要备注时可增加字符串 `label`。

合法修改在下一次生命周期回调、状态查询或结果提交／反馈派发检查点生效，**不承诺保存瞬间取消正在运行的请求**。需要即时关闭时使用 `/rc-session off` 或 UI 的关闭操作；没有额外的 `apply` 命令。

文件读取器使用受控 YAML：两空格缩进，键不加引号，布尔值使用 `true` 或 `false`，注释放在独立行。不要把多个会话拆成开启和关闭两份列表。非法文件会返回错误并停用无法准入的 RC 工作，不自动覆盖用户内容。

删除记录或整个会话文件后，后续登记再次采用项目默认值；这不会清空已经存在的任务和预算。会话 reset/new 更换实例时使用新记录。真实项目切换仍遵循原项目作用域边界。

## UI 对接

当宿主提供 Gateway 方法注册能力时，插件注册两个接口。当前 Session 页面中的按钮由宿主 UI 接入，这里不提供新的独立状态页。

读取调用 `runtime-corrector.session.get`，参数为：

```json
{
  "sessionKey": "agent:main:example",
  "sessionId": "example-instance"
}
```

设置调用 `runtime-corrector.session.set`，另加明确的目标值：

```json
{
  "sessionKey": "agent:main:example",
  "sessionId": "example-instance",
  "enabled": true
}
```

`agentId` 可选，提供时必须与会话键一致。宿主读取接口需要 `operator.read`，设置接口需要 `operator.write`，或使用 `operator.admin`；参数不能指定工作目录或冒充用户授权。`sessionId` 必须是准确的当前实例，reset 后旧请求不能写入新会话。

结果包含 `projectRoot`、`source`、`identity`、`projectEnabled`、`requestedEnabled`、`effectiveEnabled`、`reason`、`registered`、`recordKey` 和 `settingsFile`。UI 使用 `effectiveEnabled` 显示实际状态，同时展示上层阻断原因。例如 `requestedEnabled: true` 但 `reason: RC_PROJECT_DISABLED` 时，显示“RC 已关闭：项目已停用”。

UI 设置后由 RC 保存并立即协调启停，重复 `set` 同一个值不反转状态。手工编辑没有后台推送，UI 需要通过状态读取刷新显示。
