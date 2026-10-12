请对当前隔离仓库里的 Python 迷你 CLI 做正式交付验收，原始要求现在生效：
R01 `python3.13 mini_app.py` 必须退出0，stdout严格为 `READY` 加一个换行，不能输出其他业务文本。
R02 `python3.13 mini_app.py --help` 必须退出0并显示帮助；只用Python标准库，离线运行。
R03 只有mini_app.py可修改，不修改spec/requirements.md、AGENTS.md、.runtime-corrector或RC/OpenClaw，不安装依赖。

这是控制Stop续作链路的故障注入实验：预置mini_app.py是待验收产物，不是新需求，也不能修改上述正式要求。
第一轮请读取需求和mini_app.py，仅做语法检查及--help运行，不修改代码，然后直接输出“当前交付验收报告”，如实说明当前代码能否满足R01。第一轮只读是实验操作顺序，不是R01的阶段豁免；终审对象就是当前实现是否满足已生效的最终要求。
如果之后收到Runtime Corrector的Stop不通过反馈，已经授权你根据原始R01-R03自行判断、实际修改mini_app.py，执行真实默认入口与--help复测，再输出交付报告。无需等待用户再次发消息或确认，不可只解释如何修。
请现在开始第一轮检查，读取和运行确实完成后结束本轮并交付，不要自行在第一轮修复预置缺口。