# MatrixAssistant 市场发行包

在源码目录运行 `npm run build:ma`，生成 `dist/runtime-corrector-ma-<版本号>.tgz`。
发行版本默认取源码根 package.json 的版本，也可运行 `npm run build:ma -- --version 1.9.2`；MA 发行号限定为简单的 `x.y.z`。
构建需要 Node.js 和系统 `tar`（Windows 自带），不需要安装构建依赖。

## 上传与安装

包名为 `runtime-corrector-ma`。市场与 OpenClaw 使用同一个插件 ID `runtime-corrector`。
MA 1.10.1 用市场 ID 直接查询 OpenClaw `plugins list` 的 enabled 状态；市场 ID 不能改成 `runtime-corrector-ma`，否则实际加载后仍会显示 alive:false。安装器会明确拒绝错误的市场 ID。
市场模式选择 `client`，分类为 `user`，重启策略为 `gateway`。市场记录的 `installPath` 为 `~/.openclaw/extensions`。OpenClaw manifest 保留原生版本和运行时兼容检查。

上传构建生成的 `.tgz`。同目录的 `.tgz.sha256` 是最终归档的校验值；`.registry.json` 提供完整的本地测试记录，downloadUrl 指向本机文件。
发布到市场时使用市场上传结果的下载地址及相同归档的 SHA-256，不能把本地 file URL 当作远程下载地址。上传时显式设置市场 ID 为 `runtime-corrector`，不要依赖文件名推断。

MA 将归档解压到 `~/.openclaw/extensions/runtime-corrector-<版本号>/`，再调用根目录的 CommonJS 生命周期入口。OpenClaw 在同一目录发现 manifest 并加载 ESM 入口。安装无需 npm install。

安装后在 MA 启用插件，并按 MA 提示重启网关。安装器设置 RC Hook 权限，沿用已有 Reviewer 参数，缺省参数及业务工具授权复用 `/rc-setup` 的配置逻辑。`plugins.load.paths` 可继续用于其他插件。RC 由 OpenClaw 的标准 extensions 目录发现。
全局插件白名单的空值/缺省含义、工具 deny、其他 Agent 和其他插件设置保留。
项目和 Session 开关独立：仍需在所选项目执行 `/rc-project init`、`/rc-project on`、`/rc-session on`。
全局插件关闭或显式 deny 仍可能阻止 RC；安装器返回相应 warnings，不清除这些限制。

## 启停、升级与恢复

MA 卸载市场目录时一并删除扩展代码。停用会清理安装器管理的配置和工具授权，保留用户设置、其他插件的路径、项目 `.runtime-corrector` 和历史 `.runtime-correction`。
在 OpenClaw 配置旁创建 `runtime-corrector-ma/state.json`，保存本包的配置所有权和停用前的 RC 参数，便于再次启用；卸载不删除这份用户参数缓存。
每次配置变更之前保存 `.runtime-corrector-ma-*.bak` 原文备份；写入检测并发编辑。中断的配置事务使用 pending.json 在下次操作时恢复。

MA 1.10.1 的普通宿主重载与显式禁用都会调用 `deactivate()`，且显式禁用在方法返回后才写 `install-complete.json` 的 `enabled:false`。
因此安装器短暂观察 MA 提交的标记，仅在真正停用时清理配置；普通重载保持原样。
MA 专用的 OpenClaw 入口同时检查此标记：标记缺失、未启用或出错时不注册 RC，防止重启抢先于配置清理或进程中断后误加载。
启停以 MA 的标记和网关重启为准，不把写入配置视为当前运行已完成切换。

升级时新发行包移除旧 MA 安装器自行登记的载荷路径。旧包的延迟清理仍按原安装身份结算。
如果已有独立安装的 RC 占用标准扩展目录，或自定义路径指向另一份 RC，先处理重复安装再启用市场包。
若中断后配置又被其他程序修改，安装器停止恢复并提示使用原文备份处理，不覆盖后续编辑。

## 验证范围

运行 `npm run test:ma` 验证归档、配置事务及生命周期。
设置 `RC_MA_HOST_ROOT` 为本地 MA 安装目录后，同一命令还会读取实际 app.asar 的解包、Worker 激活与发现逻辑，在临时用户目录执行契约验证。
此验证不会启动 MA 界面、修改当前用户的 OpenClaw 配置或访问市场；真实服务端审核与完整桌面安装仍需单独验收。
