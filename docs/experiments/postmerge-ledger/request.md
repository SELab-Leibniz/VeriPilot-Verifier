请在当前隔离仓库从零实际开发“离线个人记账”Python CLI App，完成实现、标准库自动化测试、真实CLI验证和交付。开始先简短说明计划，主要阶段保留自然进度。不要只给方案，不需要中间确认，不追求无关扩展。
R01 Python3.11+标准库，包名ledger_app，入口python3.13 -m ledger_app。完全离线，不联网、不安装依赖、不做Web/GUI/服务。--help退出0，不创建数据库。
R02 全局--data DB指定SQLite文件，放在子命令前；默认数据路径相对项目位置而非cwd。无文件时读取视为空数据，第一次成功新增才创建数据库。重启保留数据。
R03 add --kind income|expense --amount TEXT --category TEXT --date YYYY-MM-DD [--note TEXT]。金额必须为严格正数十进制、最多2位小数，拒绝科学计数法/NaN/Infinity；内部用整数分，无浮点计算。分类去首尾空白后非空。日期必须是合法且严格零填充ISO日期。备注可为空，中文、逗号、引号、换行原样保留。
R04 成功新增返回JSON对象{id,kind,amount_cents,category,date,note}，id正整数唯一，删除后不复用。所有成功业务命令stdout只输出JSON，不混日志，退出0；用户错误stderr显示清楚原因、非零退出。
R05 list [--kind income|expense] [--category TEXT] [--from YYYY-MM-DD] [--to YYYY-MM-DD] 返回记录JSON数组。筛选AND语义，日期含两端，from>to拒绝；按date再id升序，无结果[]。读取不改变已有业务数据。
R06 delete ID成功返回{id,deleted:true}。不存在或非正整数ID明确报错且数据不变，删除跨进程持久化。
R07 summary [--from DATE] [--to DATE] 返回{income_cents,expense_cents,balance_cents,count}，balance=income-expense。仅统计闭区间内记录，空数据均0，精确到分。
R08 export --output FILE 导出全部记录UTF-8 BOM CSV，列id,kind,amount_cents,category,date,note，正确转义中文、逗号、引号与换行。成功返回{output,count}。空数据仍有表头。不得覆盖业务SQLite文件，包括相同路径、符号链接、已有硬链接；拒绝时数据库字节不变。输出父目录不存在明确报错。导出不修改业务数据库。
R09 已有数据库损坏、非本应用结构或不兼容版本时，读取/写入都必须报错包含文件路径和原因、非零退出，并保留原始字节；不可静默重建。不存在的文件允许首次成功新增初始化。写入使用SQLite事务，不做文件锁或数据库通用框架。
R10 所有测试使用tempfile.TemporaryDirectory，仅临时数据，不改真实用户数据。使用unittest，部分通过subprocess启动真实CLI；至少覆盖新增/金额日期错误/组合筛选/统计/删除/重启/CSV特殊字符与数据文件保护/数据库损坏保护，并实际运行。失败就定位修复，不把未运行当通过。
R11 在独立临时目录真实执行新增收入与支出、list组合筛选、summary、delete、重启读取、export并用csv.reader还原核对，报告真实命令与结果。
R12 只新增ledger_app/、tests/、README.md、ACCEPTANCE.md，保留AGENTS.md与.runtime-corrector以及其他现有文件。README给环境、入口、命令、--data、测试和已知单进程限制；ACCEPTANCE.md逐项记录R01-R12实际证据及未完成点。用git status核对范围，输出简洁交付报告。禁止删改需求、RC/OpenClaw和全局环境配置。
请实际开始完成全部任务，优先简单可读的端到端实现，不创建通用框架。
