# Python TodoList 文件事务验收样例

一个无第三方依赖的 Python CLI，用 JSON 文件保存待办事项和操作回执。用于实际执行应用功能，并验证 Runtime Corrector 的工具前后 hook、决策持久化及中断恢复。

## 运行应用

要求 Python 3.9 或以上。每条命令都是一个独立 Python 进程。

```sh
python3 todo.py --store /tmp/example-todos.json --operation-id add-one add "买牛奶 🥛"
python3 todo.py --store /tmp/example-todos.json list
python3 todo.py --store /tmp/example-todos.json --operation-id rename-one rename 1 "买面包"
python3 todo.py --store /tmp/example-todos.json --operation-id complete-one complete 1
python3 todo.py --store /tmp/example-todos.json --operation-id reopen-one reopen 1
python3 todo.py --store /tmp/example-todos.json --operation-id delete-one delete 1
```

相同操作 ID 和输入返回原回执；相同 ID 对应不同输入会拒绝。空标题或不存在的 ID 不修改文件。应用使用临时文件、文件同步和替换保存状态；此样例用于顺序 CLI 调用。

## 应用测试与完整场景

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v test_todo.py
```

在仓库根目录运行：

```sh
npm run test:python-todolist
npm run test:python-todolist -- --keep --output /tmp/python-todolist-results.json
npm test
```

完整场景会构建 OpenClaw 插件，复制应用到新建临时目录，并调用插件实际的 `beforeTool`、`toolResult` 和终止验收流程。检查器运行真实 Python 测试，以测试退出码和当前文件摘要作出判定；真实模型服务和正在运行的 OpenClaw 服务器不在该测试范围内。

场景先注入完成状态错误，验证验收被阻止；修正后继续 72 条 CRUD 命令、重复 hook 和无效输入测试。随后在五个持久化阶段用独立进程强制终止并重启，包括报告只写完第一个文件的情况。还验证当前投影删除后的恢复、未发布残缺日志尾部、事件去重、输出原轮次重试和两份检查点的保留边界。

业务命令的重复执行由示例应用的操作回执处理；插件负责 hook 提交、事件和输出的去重与恢复。它不能替任意外部工具消除副作用。

`npm test` 在具备 Python 3 的 POSIX 系统上运行该场景；缺少 Python 或 Windows 平台会跳过包含 SIGKILL 的场景。应用单测可独立运行。

完整结果见仓库的 `docs/experiments/python-todolist.md` 和 `python-todolist-results.json`。使用 `--keep` 时，结果包含实际测试目录，保留应用数据、测试原始输出、提交审计及报告。
