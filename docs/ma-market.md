# MatrixAssistant 市场发行包

在源码目录运行 `npm run build:ma`，生成 `dist/runtime-corrector-<版本号>.tgz`。
发行版本默认取源码根 package.json 的版本，也可运行 `npm run build:ma -- --version 1.9.2`；MA 发行号限定为简单的 `x.y.z`。
构建需要 Node.js 和系统 `tar`（Windows 自带），不需要安装构建依赖。

## 上传与安装

包名、市场插件 ID 和 OpenClaw 插件 ID 均为 `runtime-corrector`。
MA 1.10.1 使用这个 ID 在 OpenClaw 的 `plugins list` 中查询插件启用状态。
市场模式选择 `client`，分类为 `user`，重启策略为 `gateway`。OpenClaw manifest 保留原生版本和运行时兼容检查。

**正式市场条目必须下发 `installPath: "~/.openclaw/extensions"`。** 以 MA 客户端实际收到的条目为准。安装完成和重启后，MA 默认目录 `~/.matrixassistant/plugins/` 下必须没有任何 RC 文件，包括市场包、安装入口和状态文件。

**RC 扩展目录必须固定为 `~/.openclaw/extensions/runtime-corrector/`。** 安装完成和重启后，`extensions` 下只能有这一份 RC。发行归档仍使用 `runtime-corrector-<版本号>.tgz`。

上传构建生成的 `.tgz`。同目录的 `.tgz.sha256` 是最终归档的校验值；`.registry.json` 提供完整的本地测试记录，downloadUrl 指向本机文件。
发布到市场时使用市场上传结果的下载地址及相同归档的 SHA-256，不能把本地 file URL 当作远程下载地址。上传时显式设置市场 ID 为 `runtime-corrector`，不要依赖文件名推断。

MA 1.12.1 在调用 RC 之前，按市场条目中的插件 ID 和版本号生成子目录。即使 `installPath` 正确，它仍将归档解压到 `~/.openclaw/extensions/runtime-corrector-<版本号>/`。这个安装结果未通过固定目录名验收。
市场条目省略 `installPath` 时，MA 会先把市场包解压到默认目录并在该处保留安装入口和状态。入口调用 MA 内置的 `openclaw plugins install`，将实际运行的扩展部署到 `~/.openclaw/extensions/runtime-corrector/`。这条兜底路径会在 MA 默认目录留下 RC 文件，违反上述发布要求。两种方式都无需 npm install。

安装后在 MA 启用插件，并按 MA 提示重启网关。安装器设置 RC Hook 权限，沿用已有 Reviewer 参数，缺省参数及业务工具授权复用 `/rc-setup` 的配置逻辑。`plugins.load.paths` 可继续用于其他插件。RC 由 OpenClaw 的标准 extensions 目录发现。
全局插件白名单的空值/缺省含义、工具 deny、其他 Agent 和其他插件设置保留。
项目和 Session 开关独立：仍需在所选项目执行 `/rc-project init`、`/rc-project on`、`/rc-session on`。
全局插件关闭或显式 deny 仍可能阻止 RC；安装器返回相应 warnings，不清除这些限制。

## 启停、升级与恢复

直接安装由 MA 删除扩展文件。走默认市场目录时，运行中的 Gateway 根据 MA 清除的安装状态调用原生卸载，并清理本次安装的市场入口。
停用时从当前 `openclaw.json` 移除 `plugins.entries["runtime-corrector"]`，包括安装前已存在的字典，并收回主 Agent 的 RC 工具授权。用户编辑的 RC 参数写入本地缓存，再次启用时恢复。这样，MA 重启后即使跳过已停用插件的卸载回调，当前配置里也不会留下该字典。
确认卸载时还会清理注册到本次安装的路径、原生安装记录和明确指向 RC 的附加工具授权。用户的 deny 规则、其他插件的路径、项目配置及历史记录保留。如果严格白名单仅含 RC，清空会扩大权限，因此保留该限制。
新安装在 OpenClaw 配置旁创建 `runtime-corrector/state.json`，保存配置所有权和停用前的 RC 参数。卸载后可用这份缓存恢复参数。升级沿用已有的安装状态目录及其安装锁。
每次配置变更之前保存 `.runtime-corrector-*.bak` 原文备份。写入时检测并发编辑，中断的配置事务可在下次操作时从 `pending.json` 恢复。

MA 1.10.1 的普通宿主重载与显式禁用都会调用 `deactivate()`，且显式禁用在方法返回后才写 `install-complete.json` 的 `enabled:false`。
安装器观察 MA 提交的标记。`enabled:false` 表示停用，卸载时 MA 会移除 `source` 和 `enabled`，也可能直接删除安装目录。普通重载期间标记仍为启用，RC 配置继续生效。
MA 专用的 OpenClaw 入口同时检查此标记：标记缺失、未启用或出错时不注册 RC，防止重启抢先于配置清理或进程中断后误加载。
启停以 MA 的标记和网关重启为准，不把写入配置视为当前运行已完成切换。

升级时新发行包移除旧 MA 安装器自行登记的载荷路径。旧包的延迟清理仍按原安装身份结算。
如果已有独立安装的 RC 占用标准扩展目录，或自定义路径指向另一份 RC，先处理重复安装再启用市场包。
若中断后配置又被其他程序修改，安装器停止恢复并提示使用原文备份处理，不覆盖后续编辑。

## 验证范围

运行 `npm run test:ma` 验证归档、配置事务及生命周期。
设置 `RC_MA_HOST_ROOT` 为本地 MA 安装目录后，同一命令还会读取实际 app.asar 的解包、Worker 激活与发现逻辑，在临时用户目录执行契约验证。
此验证使用临时配置。桌面验收需要在独立用户目录用 MA 市场入口安装同一份归档，完整重启 MA 和 Gateway，再通过市场卸载。

### RC 1.11.1 离线桌面验收（新增固定目录名要求前）

2026-11-26 在干净的独立用户目录中，用 Playwright 调用原版 MA 1.10.1 的市场接口完成安装、重启和卸载。市场清单和归档均来自本地，清单指定 `installPath: "~/.openclaw/extensions"`。验收包为 `runtime-corrector-1.11.1.tgz`，SHA-256 为 `de79e319f671b5696476f778e5f848d6d699decfdc9e664a483867ea6d64a17d`。

- **安装通过。** MA 识别插件 ID 为 `runtime-corrector`，直接解压到 `~/.openclaw/extensions/runtime-corrector-1.11.1/`。297 个解包文件的 SHA-256 均与归档内容一致。MA 默认目录中没有 RC 文件。
- **重启通过。** 完整退出并重启 MA 和 Gateway 后，`openclaw.json` 中的 `plugins.entries.runtime-corrector.enabled` 仍为 `true`。市场显示插件健康，`runtime-corrector.runtime.list` 查询成功。MA 默认目录中没有 RC 文件，`plugins.load.paths` 中没有 RC 路径。
- **卸载通过。** 通过市场卸载后，RC 扩展目录和配置项已清理。再次重启 Gateway 后，市场仍列出该条目，状态为可安装。MA 默认目录中没有 RC 文件，`plugins.load.paths` 中没有 RC 路径。

正式市场实际下发的条目仍待核验。

### MA 1.12.1 固定目录名复验

在独立用户目录通过市场按钮安装 RC 1.11.1，退出 MA 和 Gateway 后，将扩展目录改名为 `runtime-corrector/`，再调用原版 RC 激活入口更新其安装记录。重启后 RC 可调用，MA 默认插件目录为空，`plugins.load.paths` 中没有 RC 路径。点击本地市场的「确认移除并重启网关」后，目录中仍有全部 297 个发行文件，`openclaw.json` 中仍有 RC 插件配置、白名单项和 Agent 工具授权。

用相同目录布局离线运行 MA 处理服务端清单的 `plugin:list` 查询，该分支返回 `installed: false`。直接改名无法通过市场识别和卸载验收。
