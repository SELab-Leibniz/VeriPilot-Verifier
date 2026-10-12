# 原生独立预算候选 Mini Stop 重修实验（2026-10-12）

结论：闭环跑通。第一次Stop判DEVIATION，RC原生反馈实际进入宿主上下文；宿主真实修改一行print，从BROKEN改为READY，并执行默认入口及--help；第二次完整Stop记录PASS。共2次Stop、1次原生重修、已用业务机会1/3，RC自身故障复评0次。独立CLI检查从1/2到2/2。需求版本1、epoch1，反馈没有被当作新用户需求重开预算。

候选行为代码严格为0116513，文档HEAD ad92fa9；复制包后仅新增mini Python测试平台描述，未修改RC行为代码。固定OpenClaw2026.7.1-2和GLM-5.3-Flash，20分钟Reviewer、60分钟RC总窗口、10分钟Hook、k=3、格式修复3。独立目录和网关20012，原宿主设置/安装未改变。

故障是显式控制注入：预置9行标准库CLI默认打印BROKEN，正式R01要求READY；首轮按测试协议不改代码，先检查并收尾，不豁免正式标准。收到RC不通过反馈后，原始用户已经授权宿主实际改代码并复测。Reviewer和宿主都是真实模型，没有手工伪造DEVIATION/PASS、追加第二条用户指令或代宿主改App。这是续作链路实验，不是自然缺陷率或更大App的覆盖率结论。首轮宿主还执行了默认入口（保持代码只读），不把它误报为仅运行help。

第1次评审为STAGE_COMPLETE且DEVIATION，正式R01在当前阶段有效；第2次为TASK_COMPLETE且PASS。回执ADMITTED、sourceRecordId/modelObservedAt、原生工具事件及真实源码差分共同证明不是仅保存反馈。回执finishedAt和reviewStatus=PASS证明重修结束后又完成完整复验，而不只等到agent.wait返回。

代码差分仅将mini_app.py第6行print("BROKEN")改成print("READY")。保护文件AGENTS、RC config/reviewer和spec/requirements逐字节未改；原openclaw.json、exec-approvals及安装插件未改。引用核对使用冻结原始文件哈希与选择行原文；自然语言finding仍可能出现不准确的行号，本报告的第6行取自实际源码，不以模型生成的引文作证据。

证据目录/private/tmp/rc-native-stop-mini-20261012：summary.json、初/终CLI检查日志、初始seed、真实wire/history、Stop评估、原生反馈回执、两次独立RC任务回执、quote-audit和host-integrity。没有更改RC实现、重新运行回归套件、合并分支或替换安装。
