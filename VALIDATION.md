# MVP 验证记录

这是首次 MVP 验证的历史记录。最新的纠偏触发、Windows 迁移测试及已知问题见 [CORRECTION-VALIDATION.md](CORRECTION-VALIDATION.md)。

日期：2026-11-17。环境为 Windows、Node v26.13.0、MA OpenClaw 2026.7.1-2、RC MA 1.11.0。使用指定的 RC 配置，未缩短其审查预算；业务模型为宿主配置的 deepseek-v4-flash，评审模型为 deepseek-v4.1-flash。没有独立评估或评分。

## 本地检查

- 最终 `npm test`：15 项通过、0 失败、0 跳过，包含真实 RC TGZ 提取检查。
- 配置预检：通过；机器与样本相对路径分别解析，SDK 路径和环境注入已检查。
- 真实 `--prepare-only`：两次通过，均创建独立 Gateway、原生 Session/Worktree、启用 RC 后关闭 Gateway，没有提交业务任务。
- 第一次 Python 交付的 `python -m unittest -v` 复核：8/8 通过。
- 尚未执行鸿蒙项目的真实构建；目前验证的是工具路径/环境注入和 Python 样本流程。

## 真实样本一：完成，包含原运行恢复观察

运行目录：`runs/quicksort-20261117T092508929Z-14118f4c/`。

- 业务 runId：`6f5ac9db-e4b9-4dcd-ac4b-70adcc376436`。
- 宿主终态：`ok`。
- RC：`ENDED / NO_DEVIATION_FOUND`，无待办，私有工作结算后才关闭 Gateway。
- 交付 `quicksort.py`、`test_quicksort.py`、`test-output.txt`，8 个测试通过。
- 开发时发现观察超时和临时轨迹路径问题，修正后恢复同一 Session/同一业务运行的观察，没有再次提交业务提示词。
- 原始过程保留在 `logs/runner.jsonl`、`rc-status/history.jsonl`，最终结果在 `result.json`。首次开发运行的临时文件曾位于系统临时目录；最终脚本已将 TEMP/TMP/TMPDIR 纳入本次运行目录。

## 真实样本二：模型网络错误，自动收尾

运行目录：`runs/quicksort-20261117T093509643Z-05f93a6c/`。

- 业务 runId：`dd95a15e-f0d5-44b0-a849-91afc3b76b22`。
- 从普通入口启动，未人工恢复、未重发任务。
- 模型请求出现 `getaddrinfo ENOTFOUND`。宿主终态为 `error`，RC 为 `UNVERIFIED / HOST_RUN_NOT_COMPLETED`。
- 脚本等待剩余私有工作结算，自动留档部分产物并关闭 Gateway。保存 7 份轨迹文件，索引没有缺失来源条目；这不等同于独立的轨迹完整性审计。
- 此次没有完整测试输出，不记为业务任务成功。错误记录保留，未重新运行替换。
- 原型当时对所有已留档运行返回 0。最终入口已区分宿主失败，返回 3 以停止批次；该策略通过本地测试验证，没有为此再调用模型。

两次实验均保留输入、实际配置、原生终态、RC 状态、产物和原始轨迹。`ARCHIVED` 只表示执行已收尾留档；具体业务结果和 RC 结果分别读取。运行目录包含凭据和私有日志，被 Git 忽略，不能整体当作公开报告分发。
