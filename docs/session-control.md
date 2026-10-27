# 项目与 Session 开关：一步步使用

这里的“宿主”是 MatrixAssistant / OpenClaw，“项目”是代码所在的文件夹，“Session”就是一个聊天会话。下文的 `true` 表示开，`false` 表示关。

先看自己的使用场景：尚未配置项目，按下面的命令初始化；自己开关会话，按情景一操作；给宿主做按钮，按情景三接入。示例假定插件已安装、加载，Session 已通过宿主选择了项目，或在旧版宿主完成 RC 绑定。

## 在 Session 中初始化和开关

首次使用，在当前 Session 中依次发送：

```text
/rc-project init
/rc-project on
/rc-session on
```

`init` 把插件内的 `.runtime-corrector-default` 五个文件复制到当前 Session 实际绑定的项目下，目录名为 `.runtime-corrector`。`reviewers.defaults.model` 在创建时取当前 OpenClaw RC 的 `reviewerModel`，不使用业务会话临时模型；尚未配置该模型时提示先执行 `/rc-setup`。已有 `.runtime-corrector`（包括空目录）不会覆盖。初始化后的项目总开关和首次登记 Session 的默认开关均为 `false`；不创建基线、评审或任务运行目录。

日常控制可以使用：

- `/rc-project on|off|status`：开关整个项目或查询，修改根级 `enabled`。关闭时暂停本进程中该项目所有活动会话的 RC，保留各会话选择、任务和额度；其他进程在下一次检查点读取新配置。
- `/rc-session on|off|status`：只修改当前会话的选择，继续使用现有逻辑。项目关闭时不能用会话开关越过项目总开关。
- `/rc-session-default on|off|status`：修改当前项目的 `sessionDefaults.enabled`，只影响后续首次登记 RC 状态的会话，不修改已登记的选择。返回的 `sessionDefaultEnabled` 是项目默认值，`requestedEnabled` 是当前会话的选择，二者可以不同。

这些命令不需要重启 OpenClaw。项目未初始化时，开关命令会报错，先执行 `init`；状态查询不创建文件。修改命令需要可信用户及宿主写入权限，查询需要读取权限；私有 Reviewer/Worker 不可执行。配置写入采用项目锁、临时文件及替换前检查，保留其他参数、独立行注释与换行格式；发现并发手工修改或 Session 项目切换时拒绝覆盖。

原有旧版 `/rc-project bind /绝对项目目录` 和 `unbind` 保留；宿主原生项目模式仍由 OpenClaw 选择目录。通用 CLI/工具的 `init` 保持原有按项目推导模板的行为，`/rc-project init` 是复制上述默认模板的独立入口。

## 情景一：A 写快速排序，B 只看代码

目标：两个会话使用同一个项目，只有 A 使用 RC。

### 第 1 步：允许项目使用 RC

在项目的 `.runtime-corrector/config.yaml` 中设置下面两个字段，保留文件中其他规则：

```yaml
# 整个项目允许使用 RC
enabled: true

# 第一次登记的新会话，默认关闭 RC
sessionDefaults:
  enabled: false
```

- 根级 `enabled`：控制这个项目里的所有会话。`false` 表示整个项目暂停纠偏。
- `sessionDefaults.enabled`：RC 第一次登记一个会话时，为它选择的初始值。它不改变已经保存的会话选择。因此下一步仍要分别设置 A 和 B。
- 两个字段不写时，都按 `true` 处理。

这两个字段只是控制“是否允许 RC 工作”。产物纠偏、Skill、Stop、需求抽取仍按项目原有配置分别决定是否运行。

### 第 2 步：在会话 A 的聊天框发送

```text
/rc-session on
```

A 允许使用已经配置好的纠偏功能。命令需要宿主确认是用户本人发起，并有写入权限。

### 第 3 步：切到会话 B 的聊天框发送

```text
/rc-session off
```

B 可以继续聊天、读写代码，RC 不再审查 B；A 的选择不变。关闭还会取消 B 的 RC 评审、解除 RC 等待，并拦截旧评审迟到的反馈。

### 第 4 步：在各自会话里查看状态

```text
/rc-session status
```

A 的关键结果应为下面这样。这里仅截取四个字段：

```json
{
  "projectEnabled": true,
  "requestedEnabled": true,
  "effectiveEnabled": true,
  "reason": null
}
```

这表示：项目允许，A 选择开启，现在实际也允许开启。

B 则应为：

```json
{
  "projectEnabled": true,
  "requestedEnabled": false,
  "effectiveEnabled": false,
  "reason": "RC_SESSION_DISABLED"
}
```

这表示：项目允许，但 B 自己选择了关闭。

选择保存在项目的 `.runtime-corrector/sessions.local.yaml`，正常重启后仍保留。不同会话分别保存；重置或新建会话会产生新的实例，使用新的记录。`status` 只查询，不创建会话选择记录、需求基线或评审。

## 情景二：我想临时暂停整个项目的纠偏

**第 1 步：** 把项目配置中的根级 `enabled` 改为 `false`，然后查询 `/rc-session status`。A 此时会返回：

```json
{
  "projectEnabled": false,
  "requestedEnabled": true,
  "effectiveEnabled": false,
  "reason": "RC_PROJECT_DISABLED"
}
```

A 原来选择了开启，所以 `requestedEnabled` 仍为 `true`；整个项目关闭，所以实际状态 `effectiveEnabled` 为 `false`。这两个值不同是正常的。

**第 2 步：** 把项目根级 `enabled` 改回 `true`。下次查询或正常检查点会看到：A 恢复开启，B 继续关闭。

项目配置的文件改动会在下一次消息、状态查询或结果检查点生效；保存文件本身没有后台推送。项目关闭期间，`/rc-session on` 会提示 `RC_PROJECT_DISABLED`，不会替你打开项目开关。

## 宿主 Gateway / UI 对接

### 情景三：给 MatrixAssistant 加一个“本会话纠偏”按钮

下面供宿主开发者接入。JavaScript 示例放在宿主代码中；普通用户在聊天框使用情景一的命令即可。

**第 1 步：确认 RC 插件已经加载。**

加载后，RC 提供两个方法：

- `runtime-corrector.session.get`：读取当前会话的开关状态。
- `runtime-corrector.session.set`：把当前会话设为开或关。

它们通过宿主现有的 Gateway 连接调用。`gateway` 在下方代码中代表这个已经登录、连接好的客户端。接口名无需拼接到浏览器地址后面。

**第 2 步：从宿主的当前 Session 记录中取身份。**

```js
const target = {
  sessionKey: "agent:main:coding",
  sessionId: "instance-a",
};
```

上面是示例值，实际接入必须换成当前会话的真实值。切换或重置会话后，重新读取身份。

**第 3 步：打开会话页面时，读取状态。**

```js
const status = await gateway.request("runtime-corrector.session.get", target);
// status.effectiveEnabled 为 true，按钮显示“开”；为 false，显示“关”。
```

**第 4 步：用户点击“开启”时，保存 true。**

```js
const saved = await gateway.request("runtime-corrector.session.set", {
  ...target,
  enabled: true,
});
// 使用 saved.effectiveEnabled 和 saved.reason 更新界面。
```

用户点击“关闭”时，把上面的 `enabled` 换成 `false`。这里传的是明确目标值：重复发送 `true` 仍然是开，不会变成关。

**第 5 步：按实际返回结果显示。**

`set` 保存并协调启停后才返回。关闭会取消对应 RC 评审并解除等待，宿主已经接受的业务执行继续。重新开启后，在下一个正常检查点继续，保留原来的任务基线和纠偏预算。

调用失败时进入客户端的错误处理分支，显示失败并重新读取状态，不能把点击按钮当作已经保存。RC 不会为宿主自动生成这个按钮；按钮需要宿主接入。

### 调用参数逐个解释

`get` 传 `sessionKey` 和 `sessionId`；`set` 在这两个参数上增加 `enabled`：

- **`sessionKey`，必填字符串**：要控制哪个聊天会话。从宿主当前 Session 记录中取，不能用会话标题代替。
- **`sessionId`，必填字符串**：这个会话当前这一次的实例编号。会话重置后可能变化；传旧值会被拒绝，避免改到新实例。
- **`enabled`，设置时必填布尔值**：`true` 开启，`false` 关闭。不要写成字符串 `"false"`。查询时不传它。
- **`agentId`，可选字符串**：会话所属 Agent，例如 `main`。通常可以省略，RC 从 `sessionKey` 中识别；如果传了，必须与会话键一致。

项目路径不用传，RC 会根据宿主的当前会话记录查找。不要额外传 `workspaceDir` 等字段。

### 返回字段逐个解释

`get` 和 `set` 成功时返回同一种结构。下面是开启成功的完整示例；路径、身份及记录键以实际返回为准：

```json
{
  "projectRoot": "C:/work/shop",
  "source": "host",
  "identity": {
    "agentId": "main",
    "sessionId": "instance-a",
    "sessionKey": "agent:main:coding"
  },
  "projectEnabled": true,
  "requestedEnabled": true,
  "effectiveEnabled": true,
  "reason": null,
  "registered": true,
  "recordKey": "s_<generated-hash>",
  "settingsFile": "C:/work/shop/.runtime-corrector/sessions.local.yaml"
}
```

做按钮时，先关注下面四个字段：

- **`projectEnabled`**：项目总开关是否打开。
- **`requestedEnabled`**：这个会话保存的开关选择；尚未登记时使用项目默认值。
- **`effectiveEnabled`**：结合项目、插件、会话和配置条件后，现在实际是否允许 RC 工作。按钮显示这个值。它不表示代码检查通过，也不代表某一项纠偏功能已经开启。
- **`reason`**：为何关闭。`null` 表示没有阻断原因；`RC_SESSION_DISABLED` 表示会话关闭，`RC_PROJECT_DISABLED` 表示项目关闭，`RC_PLUGIN_DISABLED` 表示插件自己的总开关关闭。

其他字段用于确认目标和定位文件：

- **`projectRoot`**：RC 当前使用的项目绝对路径。
- **`source`**：项目从哪里选来。`host` 表示跟随宿主的项目选择；`rc` 表示旧版宿主中的 RC 手动绑定。
- **`identity`**：本次查询对应的准确身份，内含 `agentId`、`sessionKey`、`sessionId`，含义与输入一致。
- **`registered`**：是否已经为这个会话实例保存本地选择。`false` 时仍可按项目默认值计算状态。
- **`recordKey`**：这个会话在本地设置文件中的记录键，由 RC 生成，不要自己拼接或修改。
- **`settingsFile`**：保存会话选择的文件路径。只查询过而未登记时，该路径下的文件可能还不存在。

如果项目或配置无法识别，部分字段可能是 `null`，实际状态会是关闭。`reason` 也可能包含目录、权限或配置错误文本，不只上面三个固定值。

### 接入权限和失败时的表现

宿主客户端须以可信 `operator` 身份连接：读取需要 `operator.read`，设置需要 `operator.write`；`operator.admin` 也可以。私有 Reviewer 身份不能调用这些控制方法。

常见失败情景：

- 项目关闭时请求开启会话：提示 `RC_PROJECT_DISABLED`，不更改项目总开关。
- 插件自己的总开关关闭时请求开启：提示 `RC_PLUGIN_DISABLED`。
- 传了旧实例编号：提示 `HOST_SESSION_REPLACED_OR_MISSING`。
- 参数、权限、配置或文件保存有问题：调用返回错误，不应显示“保存成功”。RC 方法回调的错误码为 `INVALID_REQUEST`，具体原因在 `message` 中。
- 插件根本没有加载、被宿主完全禁用或连接断开：方法可能不可用，先检查插件和宿主连接。

目前没有项目开关接口。宿主若要做“整个项目纠偏”按钮，需要修改项目配置里的根级 `enabled`，保留其他字段并校验，再查询会话状态刷新界面。

## 情景四：让 Agent 现在检查一个文件

例如想检查项目中的 `quicksort.py`。先在项目配置中声明这个产物，再让宿主调用 RC 提供的 `runtime_corrector` 工具，输入：

```json
{
  "command": "check",
  "subject": "quicksort.py",
  "format": "json"
}
```

- **`command`**：做什么。这里的 `check` 表示检查一个文件；`project` 则表示查看当前项目。
- **`subject`**：检查哪个文件，这里是相对当前项目的 `quicksort.py`。未匹配项目产物配置时会返回错误。
- **`format`**：返回文本的格式。`json` 返回结构化结果；`text` 返回便于人阅读的文本。
- **`enabled`**：只有工具的 `stage` 命令需要，用于开关某个配置阶段；不是本会话的开关。工具命令全集见[接口参考](interfaces.md#openclaw--matrixassistant-原生入口)。

工具结果放在 `content[].text` 中；JSON 模式也先是一个字符串，解析它后查看 `status`、`diagnostics` 等检查结果。失败时还可能只有错误文本。检查会按项目配置运行确定性规则和已启用的语义审阅，返回反馈供主 Agent 修复，不直接改业务文件，也不等于整个任务已经验收通过。

普通自动纠偏不需要每次手动调用这个工具。宿主会在发消息、写文件等已接入的检查点触发 RC，RC 按当前会话开关和功能配置决定是否运行。

## 想看实现代码时，从哪里找

插件构建目录是 `dist/runtime-corrector-openclaw/`，安装后使用实际安装目录。宿主从 `openclaw.plugin.json` 的 `main` 加载入口，宿主调用上面的方法即可，无需直接导入内部代码。

- `lib/openclaw/entry.mjs`：注册插件入口、自动检查点和 `runtime_corrector` 工具。
- `lib/openclaw/session-control.mjs`：注册 `get/set` 和 `/rc-session`，校验参数、权限，返回状态。
- `lib/openclaw/session-projects.mjs`：找当前会话的项目，组合项目和会话开关。
- `lib/openclaw/session-settings.mjs`：读写保存会话选择的文件。
- `lib/openclaw/runtime.mjs` 中的 `reconcileSessionControl`：按最新开关协调 RC 的启停。

项目如何跟随宿主选择、旧版何时允许手动绑定，见[项目说明](session-projects.md)。当前实际开放哪些宿主入口，见[接口参考](interfaces.md#openclaw--matrixassistant-原生入口)。

<details>
<summary>高级用法：直接编辑本地会话文件</summary>

### 手工编辑会话文件

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

重新启用会保留原任务和会话累计纠偏额度。已有流程不会因开关重置而重新获得额度；后续新输入使用新的启用代次标识，旧评审的迟到反馈不会进入新一轮。

</details>
