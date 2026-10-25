# 维护与验证

源码在 `lib/`；`scripts/` 只保留 CLI、宿主事件入口、构建和 MA 配置工具。`config/`、`knowledge/`、`specs/`、`templates/`、`skills/`、`commands/` 及 `packaging/` 包含运行资源，修改后需同步检查产物。

开发环境使用 Node 24.16 或兼容的更高版本；Claude/CodeAgent 的基础兼容性仍在 Node 18 验证。原生 reviewer 的独立开发依赖通过 `npm ci --prefix lib/review-task --ignore-scripts` 安装，保留精确版本及锁文件。

```sh
npm run build:plugins
npm run test:artifacts
npm test
```

测试入口只发现 `test/*.test.mjs`，最多并行运行四个独立文件。每个文件默认最多运行 90 秒，超时终止所属进程树、记录失败并继续其他文件；断言失败和中断均返回非零退出码。需要调整单次验证上限时使用 `npm test -- --file-timeout-ms 120000`，不得把超时当成跳过或通过。CI 另有 15 分钟作业上限。

测试使用本地脚本和受控 reviewer，不调用真实模型。安装宿主契约测试可通过 `RC_OPENCLAW_HOST_ROOT`、`RC_MA_HOST_ROOT`、`RC_MA_ROOT` 指向已安装包；未提供时相关测试跳过。宿主包只读，禁止为通过测试改写安装目录。

库模块必须逐文件列入 `packaging/runtime-modules.json` 的 common 或对应宿主列表；目录位置和 `.mjs` 扩展名不构成准入。新增被入口引用的模块时，更新清单并验证本地依赖闭包；新增未引用的诊断脚本应留在开发工具范围，不能加入运行清单。其他资源使用 `lib/plugin-builder.mjs` 的固定清单。宿主 manifest、active-host、命令和 skills 在构建时生成。

产物检查覆盖各宿主入口、静态本地依赖、资源、锁文件、禁止目录，以及直接放入各运行库目录的未列入清单 `.mjs`。运行模块和资源的清单变化必须与相关产物断言一起审查。

CI 在 Windows、Linux、macOS 验证基础 Hook 兼容与完整套件，并在标签发布时生成三种宿主压缩包。运行记录、实验、依赖安装和 `dist/` 属于本地产物，不应跟踪；关键故障应固化为小型行为回归。

真实模型准确性、完整桌面长时续作、进程重启恢复和分组性能仍需单独验收，不能由离线测试推导。版本兼容、产品限制与迁移规则直接维护在正式宿主和配置文档中。
