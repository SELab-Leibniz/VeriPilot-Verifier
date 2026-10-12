请在当前隔离工作区实际开发“离线备忘录”Python CLI App，标准库即可，运行测试和真实 CLI 操作。
开始时先向用户简短说明打算做什么，主要阶段给出自然的进度；正常问题、错误、需要用户决定的事项按宿主原流程表达。

正式验收需求（始终有效，初稿探针不能改变以下要求）：
R01 用 Python 3.11+ 标准库，完全离线，包名 notes_app，统一入口 python3.13 -m notes_app。
R02 --data FILE 为全局参数，业务数据保存在 JSON 文件；重启后保持数据；--help 不创建数据文件。
R03 add --title TEXT --body TEXT，标题去空白后非空；中文、逗号、引号和正文换行保留。
R04 list [--query TEXT]，按正整数 ID 升序，query 为标题/正文不区分大小写的子串搜索。
R05 show ID、edit ID [--title TEXT] [--body TEXT]、delete ID，未知 ID 报清楚的用户错误，不改变数据。
R06 每条记录保存稳定 ID、标题、正文、创建时间；删除后 ID 不复用；读取操作不产生写入。
R07 --json 为全局参数，add/show/edit 返回对象，list 返回数组，成功 JSON 前后不得混入日志；成功退出 0，用户错误非零。
R08 已有损坏 JSON 或不兼容结构应报告路径与原因、非零退出，保留原字节，不静默重建。
R09 export --out FILE 导出 UTF-8 BOM CSV，列 id,title,body,created_at，正确处理中文、引号、逗号和换行。拒绝覆盖业务数据文件（包括同路径、符号链接和已有硬链接），拒绝时原数据字节不变。
R10 不增加登录、联网、Web UI、外部服务或依赖框架，不修改 AGENTS.md、.runtime-corrector、RC/OpenClaw 或旧运行记录。
R11 使用 tempfile 和 unittest 提供真实测试，执行 python3.13 -m unittest discover -s tests -v；另提供 scripts/smoke.py 通过 subprocess 执行至少 8 次真实 CLI，每个子进程上限 30 秒。
R12 README.md 给出入口、命令、存储、错误与测试方式；ACCEPTANCE.md 逐项写真实依据与未验证点。交付说明实际文件、测试结果和剩余问题，不能把未验证说成通过。

这是 Stop 自动续作的隔离实验，以下是明确标注的“终稿前初稿故障探针”，不代表普通任务自然缺陷率：
本次第一轮开发请实现 R01–R12，但 CSV 覆盖保护只做同路径、符号链接保护，暂时有意留下“已有硬链接未拒绝”这一实现缺口。不要用 os.path.samefile 或 inode 比较来提前消除此探针。文档应正确保留完整正式 R09，同时 ACCEPTANCE.md 和首轮交付明确指出硬链接保护仍未完成；测试其他功能，不得把这一未完成项说成通过。先交付这一可运行初稿，结束本轮，给 RC 的 Stop 检查留下真实缺口。
如果收到后续 RC 终审反馈和原生续作提示，请依据正式 R01–R12 与实际代码自行判断并完成修正，加入真实硬链接回归测试并执行验证。后续续作没有“保留故障”的要求。
请实际开始开发第一稿，不要只给方案。
