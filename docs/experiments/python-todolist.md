# Python TodoList 真实执行验收

独立分支：`codex/file-transaction-deltas`。运行时间：2026-10-14 16:44:53 UTC+8。环境：darwin、v26.0.0、Python 3.9.6。

应用位于 `examples/python-todolist-transactions/todo.py`，场景入口为 `scripts/validate-python-todolist.mjs`。不依赖第三方 Python 包。所有运行使用新建目录，没有读写原现场或已有业务项目。

## 实际执行范围

应用是真实 Python CLI，功能通过独立进程和真实 JSON 文件验证；插件由当前分支构建，实际执行 `beforeTool` → 应用命令 → `toolResult`，以及终止验收、报告读取和文件事务恢复。检查器根据真实 Python 测试退出码和当前代码、配置、测试、应用数据文件的摘要判定。真实模型服务、完整 OpenClaw 服务器和浏览器 UI 不在本次测试范围内。

9 项 Python 单测覆盖空列表、Unicode、新建、改名、完成与重新打开、删除及 ID 不复用、跨进程持久化、无效输入不改文件、重复操作回执、冲突 ID 和临时文件清理。每项都运行实际 CLI，不模拟文件系统。

先把 `complete` 的状态设置从 `True` 改为 `False`。真实 Python 测试出现 `test_complete_and_reopen` 失败，插件终止验收返回 `block`，记录偏离并使用一次纠偏预算。修正实际源文件后，9 项测试全部通过，验收返回 `allow`，偏离复验关闭。最终报告的验证结果为 **PASS**。

随后执行 72 条连续 CRUD 命令，每条都检查进程输出及新进程读回的数据，并重复前、后 hook。空标题和不存在的 ID 作为真实失败命令执行，验证工具错误内容保留、应用文件不变。

## 强制终止与恢复

以下每一行都启动独立 Node 进程，在实际持久化阶段触发 **SIGKILL**，然后用新运行时继续同一操作：

| 中断点 | 进程退出 | 结果 |
| --- | --- | --- |
| 提交已落盘、尚未发布 | SIGKILL | 恢复成功，输出引用 0 个 |
| 提交已发布、当前投影尚未写入 | SIGKILL | 恢复成功，输出引用 0 个 |
| 任务投影已写、其他文件与输出尚未完成 | SIGKILL | 恢复成功，输出引用 1 个 |
| 报告仅写完 diagnostic.md，剩余文件未完成 | SIGKILL | 恢复成功，输出引用 1 个 |
| 检查点指针已发布、旧日志尚未回收 | SIGKILL | 恢复成功，输出引用 1 个 |

输出部分写入的场景先确认原轮次只有 `diagnostic.md`，恢复后在同一轮次补齐 `result.json`，没有创建第二个输出轮次。已发布但未投影时可读取提交证据；未发布提交不会被当作已提交操作。每次恢复都验证同一个 post hook 只有一份逻辑提交。

删除当前 `task.json` 后，检查点回放严格恢复同一份状态；此次耗时约 32.65 ms，属于本机已有文件系统缓存的单次观测。另写入一个未被发布指针引用的截断增量文件，再通过真实 hook 恢复并继续最终验收。

## 结果与空间统计

| 指标 | 实测 |
| --- | ---: |
| Python 单测 | 9 项全部通过 |
| 正常及恢复后的逻辑应用修改 | 74 次 |
| 无效输入命令 | 2 次，文件保持不变 |
| 重复 hook 请求 | 至少 144 次，无新增逻辑提交 |
| 保留评估记录 | 167 条 |
| 普通 post 提交字节范围 | 1705–1717 |
| 72 次 post 提交累计字节 | 123,412 |
| 同组实际状态重建旧格式的累计字节 | 4,894,901 |
| 旧格式首/末 post 提交字节 | 39,247 / 96,740 |
| 任务目录保留文件数 / 字节 | 41 / 1,106,745 |
| 恢复增量及紧凑审计字节 | 497,475 |
| 整个运行时目录文件数 / 字节 | 62 / 1,173,075 |
| 恢复检查点 | 2 份 |
| 当前任务状态（紧凑 JSON） | 116,191 字节 |
| 重复事件 ID | 0 |
| 插件运行警告 | 0 |

旧格式列是同一组实际状态的序列化重建，未运行旧版本插件；新格式字节由实际提交读取。任务目录统计包含检查点、评估、正文与审计，整个运行时目录还包含会话记录及物化报告。当前状态仍整体覆盖写入，这部分 I/O 限制与前一份文件事务实验报告相同。

实际保留目录：`/var/folders/81/r2msm9k16ggbsn3kp91_2wv40000gp/T/rc-python-todo-e2e-hZcqlU`。其中 `app/data/todos.json` 保存最终数据与操作回执；`app/evidence/` 保存真实失败和通过的 Python 日志；`app/.runtime-correction/` 保存任务、审计及输出。

## 复跑

```sh
npm run test:python-todolist -- --keep --output /tmp/python-todolist-results.json
node --test test/python-todolist-transactions.test.mjs
npm test
```

机器可读统计：[python-todolist-results.json](python-todolist-results.json)。恢复案例和应用行为断言已加入 `test/python-todolist-transactions.test.mjs`。该 SIGKILL 场景要求 Python 3 和 POSIX 系统；本机实际执行，没有跳过。

完整回归 `npm test`：**777 项测试，775 项通过，0 项失败，2 项原有跳过**。本次 Python 场景实际执行并通过。

并行负载暴露了两处测试收尾问题：手动复验测试在后台任务完成清理前删除目录，以及模拟工作器进入时信号已取消却仍等待新的取消事件。测试现在等待实际收尾，并同时处理已取消状态；保留原有预算、错误与取消断言。运行脚本使用 `validate-` 命名，避免被自动发现机制重复执行。
