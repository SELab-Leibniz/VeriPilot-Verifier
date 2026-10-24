# Stop 小模块开源适用性核查

核查日期：2026-10-24。范围：官方固定版本源码、已安装包及无模型 CLI。未调用真实模型，未重跑业务任务，未修改生产源码或实验代码。以下是接口与适用性证据，不是本复杂案例已经通过的证据。

## 1. 版本、来源与可复现性

- 已安装 `@alibaba-group/open-code-review@1.13.3`，Apache-2.0；npm 包是 Go 原生 CLI 的启动器，不是可导入的审查 SDK。直接检查 Windows 原生二进制得到 `v1.13.3 (375f64c)`。官方 `main` 和 `v1.13.3` 在本次查询时均指向 `375f64cd6f67a48a135da83cfcf59c52669a09cb`，因此本次文档/main 与安装版本来自同一提交；以后不能据此假定一直相同。[固定提交](https://github.com/alibaba/open-code-review/tree/375f64cd6f67a48a135da83cfcf59c52669a09cb)、[发布版本](https://github.com/alibaba/open-code-review/releases/tag/v1.13.3)、[许可证](https://github.com/alibaba/open-code-review/blob/v1.13.3/LICENSE)。
- 本机 `opencodereview.exe` 的 SHA-256 为 `09bf6d1b8a24859fcc88f7bab1576a290a074f147655b860be4e766b568c3809`，与官方 v1.13.3 Windows/amd64 发布资产 digest 相同。实验 package.json 和 package-lock 已固定 OCR 1.13.3，平台包也是 1.13.3；保留锁文件及其 integrity，避免把移动的 main 或自动更新结果当实验版本。
- 已安装 `@earendil-works/pi-coding-agent@1.4.0`、`pi-ai@1.4.0`，MIT；当前包声明的官方仓库是 `earendil-works/pi`，SDK 位于 `packages/coding-agent`，不是从旧包名或仓库名推断。v1.4.0 对应 `4a080252f06caf63a525d7873c5d94d3c23887e0`，要求 Node >=22.19.0。包有正式 ESM/类型导出，可复用 SDK。[固定源码](https://github.com/earendil-works/pi/tree/v1.4.0/packages/coding-agent)、[许可证](https://github.com/earendil-works/pi/blob/v1.4.0/LICENSE)。

## 2. OCR：可以取用什么

`delegate` 只有 `preview` 与 `rule` 两个准备接口，无须 LLM。它输出候选文件、排除原因、Git 范围及解析后的规则，让宿主组织工作；它不会代替宿主执行需求验收。实际执行安装版本的 `delegate preview --commit 20ec5b5 --format json` 成功，返回 schema_version、commit、reviewable_files、excluded_files 等字段：4 文件、3 可审、1 排除；文档 `docs/experiments/stop-bounds-20261024.md` 因 `unsupported_ext` 被排除。[实现](https://github.com/alibaba/open-code-review/blob/v1.13.3/cmd/opencodereview/delegate_cmd.go)。

可借鉴三项小机制：

1. **增量提交与完成信号分离。** `code_comment` 提交发现，`task_done` 表示本任务结束；已收 comment 独立于后续模型轮次。Stop 可采用同样职责划分，但保存的是带 obligation ID、状态、短原因和证据位置的验收记录，不能直接把 comment 数量或 CLI exit 0 当 PASS。[loop/collector](https://github.com/alibaba/open-code-review/blob/v1.13.3/internal/llmloop/loop.go)。
2. **程序校验分组覆盖。** 分组用短整数索引，去重、补齐遗漏文件，解析失败退回逐文件，组大小与 diff token 大小有兜底。可取“已知项目集合由程序保证不遗漏”的原则；不需要为 Stop 再引入一个模型来分组或生成组合验收项。[grouping](https://github.com/alibaba/open-code-review/blob/v1.13.3/internal/agent/grouping.go)。
3. **按需读证据。** 原生 `file_read` 支持行范围；`code_search`、`file_find`、`file_read_diff` 是只读取证能力。可复用接口思想；已有 Pi 工具时不应再实现一套等价工具。[工具注册表](https://github.com/alibaba/open-code-review/blob/v1.13.3/internal/config/toolsconfig/tools.json)。

实际结构化接口必须以注册表为准：`code_comment` 顶层要求 `comments` 数组，每条要求 `content`、`existing_code`、`category`、`severity`、`path`，`existing_code` 用于代码锚定；`task_done` schema 要求 `state: DONE|FAILED`。这不是需求验收所需的 PASS/FAIL/UNVERIFIED、基线版本、逐项覆盖账本。部分文档示例较简化，不能直接复制为适配器校验规则。自定义 `--tools` JSON 可配置已注册工具，新增 Go 工具实现仍需接线；不能只配置一个名字就得到新的持久化验收工具。[schema](https://github.com/alibaba/open-code-review/blob/v1.13.3/internal/config/toolsconfig/tools.json)、[工具文档](https://github.com/alibaba/open-code-review/blob/v1.13.3/pages/src/content/docs/en/tools.md)。

## 3. Pi：优先复用原生 loop 与读取能力

正式 `createAgentSession` 已处理模型调用、工具执行、会话、重试、压缩和事件，不应再在它外面重写一套等价 agent loop。1.4.0 的 `tools` 参数是**工具名字符串数组**；`customTools` 才接收自定义工具定义。可限制 `read`、`grep`、`find`、`ls`，增加一个小的验收提交工具；`createReadOnlyTools(cwd)` 返回工具对象，不能直接塞进该版本的 `tools` 参数。[SDK 源码](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/sdk.ts)、[只读工具工厂](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/tools/index.ts)。

每项用 `SessionManager.inMemory()` 可避免继承前项历史。还应使用显式 `SettingsManager.inMemory()` 和 `DefaultResourceLoader` 的 `noContextFiles`、`noExtensions`、`noSkills`、`noPromptTemplates`、`noThemes`，给出固定 system prompt 和明确模型运行时；只换 inMemory session 不会关闭项目 AGENTS/skills 等自动发现。完成以 `prompt()` 结束、`agent_settled` 或 idle 为准，不能把底层一次 `agent_end` 当作重试已经结束。[资源加载器](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/resource-loader.ts)、[会话](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/agent-session.ts)。

已有 read 分页与 grep/find/ls 可直接取用。本轮按最新要求先不施加额外的累计 token/读取预算或墙钟截止，只保留有限尝试、防循环及证据访问边界，先测是否能完成。原生 read 自带 2000 行或 50KiB 截断，需依据实际返回继续读，不应把它误记成全文已读；cwd 只是默认位置，不能限制绝对路径、父目录或符号链接。禁止写工具也不等于文件读取范围隔离。优先用工具已有接口包一层边界校验，避免复制完整读取实现。[read](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/tools/read.ts)、[truncate](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/tools/truncate.ts)、[官方安全边界](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/security.md)。

Pi 原生 compaction 可以复用为退路。其 summary 仍是模型调用，会消耗时间/token，不能取代确定性输入裁剪、分页、去重及程序保存的验收账本；压缩后也不能把未经核对的摘要视为冻结 Ground Truth 的等价替代。[compaction](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/compaction.md)。

## 4. 不要直接接入的部分

- **不能用找 bug 替代需求验收。** OCR `review` 是 diff 审查；OCR 也有不依赖 diff 的 `scan`，所以整个项目不能统称“仅支持 diff”。两者均未提供本 Stop 的冻结义务集合、通过项依赖失效、未验证覆盖统计与整体 PASS 规则。复用运行时/工具，不改变验收对象和语义。
- **不能把过滤当完成。** 固定版本明确支持 `.ets` 和 `.json5`，不能声称 ArkTS 扩展不支持；但文件扩展被接受不证明懂 HarmonyOS 运行语义。默认排除包含 `*.test.ets`、大量测试/fixture/dependency 文件。过大 diff 也会被标为 `too_large` 排除。需求义务或相关测试被排除时，必须记未验证，不能从分母中删除。[扩展白名单](https://github.com/alibaba/open-code-review/blob/v1.13.3/internal/config/allowlist/supported_file_types.json)、[默认排除](https://github.com/alibaba/open-code-review/blob/v1.13.3/internal/config/allowlist/default_exclude_patterns.json)、[size gate](https://github.com/alibaba/open-code-review/blob/v1.13.3/internal/agent/selection.go)。
- **不能把自动压缩当不超限保证。** OCR 60%/80% 阈值压缩主要处理中间对话，首两条消息冻结；若公共材料已塞满冻结区，压缩不能把它缩掉。压缩失败保留原消息，压缩后仍超阈值则停止；已收 comment 仍可取回。这能保住部分成果，不能保证所有项目在预算内完成。[compression](https://github.com/alibaba/open-code-review/blob/v1.13.3/internal/llmloop/compression.go)、[超限后的停止](https://github.com/alibaba/open-code-review/blob/v1.13.3/internal/llmloop/loop.go)。
- **不复制默认大流水线。** 不引入默认并发 8、额外规划/分组模型、多轮复审、独立过滤/定位/总评模型、预算耗尽后追加总评。对固定 Stop 时限，这些会增加请求数、重复读取和难以估算的开销。先保持每项一个原生 session、现有读取工具、一个提交工具、外部程序账本；宿主收到有界短诊断和证据位置。

## 5. 当前证据的边界

本文件记录的是开源接口核查，其初始核查没有调用真实模型；同目录后续 live 实验另行保存，不用接口核查冒充完成率证据。最新实验遵照“先有限尝试完成，再优化成本”的要求，没有施加旧 Stop 的 120 秒和 128KiB 累计读取限制，未删除原有条件。模型窗口和供应商输出上限仍有限；是否实际触发压缩、如何恢复必须分别报告。开源框架的存在不构成本案例通过证据，真实完成、摘要保真度、全项目覆盖及生产接入也必须分别核验。
