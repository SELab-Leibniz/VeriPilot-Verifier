# 离线借物台账：Python App 开发任务（50 条需求）

请从当前空工作区独立实现一个完全离线的 Python 命令行应用，帮助小团队登记工具/设备、借用人、借出和归还。以下 R01–R50 是我明确采纳的完整任务要求，不用外部服务、不复制过去的 App、不修改需求或 RC 设置。请实际编写、运行、测试和交付。以合理的小型实现完成需求，避免额外框架与过度设计。

代码包名为 `lending_app`，项目根目录包含 `README.md`、`ACCEPTANCE.md`、`tests/` 和 `scripts/smoke.py`。所有业务数据存入用户指定的 SQLite 文件。

## 固定命令接口

统一调用 `python -m lending_app --db FILE [--json] COMMAND`；`--db` 和 `--json` 是全局参数，放在业务命令前。下面命令和选项必须可用，允许增加别名，但不得替换它们。

```text
assets add --name TEXT --quantity N [--category TEXT]
assets list [--query TEXT]
assets show ID
assets edit ID [--name TEXT] [--category TEXT]
assets adjust ID --delta INTEGER --reason TEXT
assets maintenance ID --quantity N
assets disable ID / assets enable ID
borrowers add --name TEXT [--phone TEXT]
borrowers list
borrowers show ID
borrowers edit ID [--name TEXT] [--phone TEXT]
borrowers disable ID / borrowers enable ID
loans borrow --asset ID --borrower ID --quantity N --due YYYY-MM-DD [--date YYYY-MM-DD] [--notes TEXT]
loans list [--asset ID] [--borrower ID] [--status OPEN|PARTIAL|RETURNED] [--overdue] [--today YYYY-MM-DD]
loans show ID
loans return ID --quantity N [--date YYYY-MM-DD]
loans extend ID --due YYYY-MM-DD
stats [--today YYYY-MM-DD]
events [--asset ID] [--loan ID]
export --out FILE [--asset ID] [--borrower ID] [--status OPEN|PARTIAL|RETURNED] [--overdue] [--today YYYY-MM-DD]
backup --out FILE
restore --from FILE --yes
demo
```

`--json` 下，add/show/edit/adjust/maintenance/enable/disable/borrow/return/extend 返回一个对象，list/events 返回数组，stats 返回对象；成功操作不得向 JSON 前后混入日志。物品对象至少包含 `id,name,category,total_quantity,maintenance_quantity,borrowed_quantity,available_quantity,active`；借用人对象包含 `id,name,phone,active`；借用记录包含 `id,asset_id,borrower_id,asset_name,borrower_name,quantity,returned_quantity,borrow_date,due_date,status,notes`。ID 为正整数，active 为布尔值。其它操作可返回简短结果对象。

## 50 条正式需求

### R01 — 完全离线与运行环境
使用 Python 3.11+ 和标准库，包括 argparse、sqlite3、csv、unittest 等；无需 pip 安装、登录、联网、Docker 或后台服务。应用启动和业务操作不得发起网络请求。

### R02 — 可执行入口与帮助
`python -m lending_app` 是统一入口。提供整体和子命令 `--help`，列出参数和示例；没有业务命令时打印帮助并正常退出，不创建或修改数据库。

### R03 — 合理的项目结构
将命令解析、存储和业务逻辑合理分离，避免单个巨型入口；无需插件系统、Web 层或抽象工厂。包、测试、验证脚本和文档均应独立于 RC 项目运行。

### R04 — 数据库路径
`--db` 可指定绝对/相对路径，默认 `./data/lending.sqlite3`。首次需要业务操作时创建缺失父目录并初始化新库；再次启动使用原数据。帮助命令不得产生该副作用。

### R05 — Schema 版本
数据库明确保存 schema_version=1。打开已有不兼容版本或缺少必要应用结构的数据库时，报告路径及原因、非零退出，保留原文件，不自动清空、重建或迁移。

### R06 — 损坏文件保护
已有文件不是 SQLite 数据库、不可读或损坏时，应给出清楚的存储错误并保留原字节；不得把损坏文件当作第一次启动。正常空的新数据库可以初始化。

### R07 — 事务与失败原子性
借出、归还、数量调整、维护占用和状态变化以事务提交。业务校验失败不得留下半条记录、错误数量或多余成功流水；数据库写入失败回滚。

### R08 — 引用完整性
各连接启用 SQLite 外键约束。借用记录必须引用真实物品和借用人；未知 ID 应给出用户错误，不能产生孤立借用/归还/流水。

### R09 — 稳定标识和历史
物品、借用人、借用、归还和流水使用稳定正整数 ID；已交付的 ID 不得因重启或状态变更重新分配。持久化本地时间戳，业务日期严格采用 YYYY-MM-DD，不接入外部时钟服务。

### R10 — 输出和错误规范
成功退出码为 0，用户参数/业务错误为 2，存储错误为 1。错误写 stderr，说明对象或路径及原因，不打印 Python 堆栈；错误操作不能打印成功 JSON。正常文本输出可用中文，JSON 遵循上面的固定接口。

### R11 — 登记物品
新增物品保存名称、分类、总数量和启用状态。名称去首尾空白后非空，最长 100 字符；分类为空或省略时存“未分类”。允许不同物品使用相同名称，不凭名称合并库存。

### R12 — 数量输入边界
新增数量、借出数量和归还数量只接受正整数；维护占用只接受非负整数，调整差额接受非零整数。拒绝小数、负数、零（不允许的场景）和非数字，不得 int(1.5) 静默截断。

### R13 — 物品初始状态
新增物品的 total_quantity 等于输入数量，maintenance_quantity 和 borrowed_quantity 为 0，available_quantity 等于总数，active=true。登记时生成可追溯初始流水。

### R14 — 库存计算
每个物品的实物可用量始终为 total_quantity − maintenance_quantity − 尚未归还的借出量，不能为负。available_quantity 显示这个实物数量；停用物品仍可显示库存，但禁止新借出。

### R15 — 物品列表与搜索
列表默认包括启用和停用物品，按 ID 升序。`--query` 对名称和分类进行不区分大小写的子串匹配，中文正常工作；无结果返回空数组或清楚的文本提示。

### R16 — 物品详情
show 返回固定物品字段和实时库存。物品不存在时按 R10 处理；列表/详情仅查询，不更新库存或生成成功操作流水。

### R17 — 修改物品资料
可独立修改名称或分类；省略字段保持原值，名称校验仍适用。修改资料不改变数量、借用人、既有借用记录的历史名称快照或记录 ID。

### R18 — 调整实物总数
通过带原因的整数 delta 调整总数，正数入库、负数出库。原因去空白后非空；调整后的总数不能小于维护占用加未归还量。失败不改变数据，成功记录 delta 与原因。

### R19 — 物品停用与启用
停用只影响新的借出资格，不能删除物品或历史。仍允许已有借用归还和减少维护占用；重复 disable/enable 返回成功但不得重复产生状态变化流水。

### R20 — 维护占用
maintenance 将占用设置为指定绝对数量。占用不得大于总数减未归还量；设置为 0 释放维护占用。操作不改总数，借出时必须扣除维护占用；数量实际变化才记流水。

### R21 — 登记借用人
名称去首尾空白后非空、最长 100 字符；电话为可选普通文本（最长 64 字符），保留中文/符号，不引入复杂手机号规则。新增后 active=true，返回稳定 ID。

### R22 — 借用人列表与详情
列表按 ID 升序并显示启用状态，show 可查看姓名和电话。没有借用人时返回空列表；未知 ID 是用户错误，查询不改变资料。

### R23 — 修改借用人
可修改姓名、电话；省略字段保持原值，显式空电话可清除。姓名仍做非空校验；修改不更改既有借用记录的姓名快照。

### R24 — 借用人停用与启用
停用借用人不能发起新借用，但其既有借用仍允许归还或查看。重复切换到当前状态不重复记流水；不可通过停用删除未归还量。

### R25 — 发起借用
借出必须指定存在且启用的物品、存在且启用的借用人、正整数数量和到期日。借用日期省略时使用当天；校验不通过时不能产生借用记录或扣减库存。

### R26 — 借用日期校验
借用和到期日期必须是实际存在的 YYYY-MM-DD 日期，例如 2026-02-30 应拒绝；到期日不得早于借用日。允许为了登记历史而明确提供过去日期，不额外禁止过去记录。

### R27 — 借出与库存一致性
借出量不得超过当前实物可用量。在同一事务核验库存、写借用及流水，防止重复或多个操作造成超借；失败时记录数和库存都保持不变。

### R28 — 借用备注
备注可省略，最多 2,000 字符；保留中文、逗号、双引号和换行。保存、查询和 CSV 导出往返不能丢失或被擅自改成单行。

### R29 — 借用状态
新借用状态 OPEN；部分归还为 PARTIAL；全部归还为 RETURNED。状态由 quantity 和累计 returned_quantity 推导，不能独立改状态制造虚假归还。

### R30 — 借用列表过滤
按 ID 升序，支持物品、借用人、状态和逾期过滤，多条件使用 AND。不存在匹配返回空数组。`--today` 用于明确查询日期、默认当天，不修改实际借用数据。

### R31 — 借用详情与快照
记录固定字段，并在借出时冻结物品名称和借用人姓名。后续改名不能篡改该历史快照；详情能准确展示原数量、已归还量、日期和备注。

### R32 — 归还业务校验
归还必须指向真实借用，数量为正整数且不超过剩余未归还量；日期不得早于借出日期。已停用物品/借用人仍可归还。归还日期仅用于流水记录，实物库存于操作成功时立即释放。

### R33 — 部分归还
部分归还只释放本次数量，正确更新累计量和 PARTIAL 状态；保存独立归还记录与流水。原借用数量、到期日和名称快照保持不变。

### R34 — 完全归还与重复防护
全部归还后状态 RETURNED、未归还量为 0。再次归还应报用户错误，不得重复增加库存或生成多余归还记录；其它借用的未归还量不受影响。

### R35 — 归还失败原子性
超过未归还量、错误日期、错误 ID 等失败，必须同时保留原借用状态、累计归还、库存、归还记录和流水；不能只校验展示层而在业务层留下部分提交。

### R36 — 延长到期日
OPEN/PARTIAL 可以修改到期日，新日期有效且不早于借出日；RETURNED 不可修改。名称快照和借出数量不变，成功记录旧、新到期日；相同日期无需多余流水。

### R37 — 逾期判断
仅在未归还量大于 0 且 due_date 严格早于查询 today 时视为逾期。当天到期不逾期，全部归还永不逾期；部分归还的剩余量仍参与判断。

### R38 — 汇总统计
stats JSON 至少含 `assets,borrowers,loans_open,loans_overdue,quantity_borrowed,quantity_available,quantity_maintenance`。assets/borrowers 为所有记录数；loans_open 含 OPEN/PARTIAL；逾期数按 R37；quantity_borrowed 汇总剩余数量；quantity_available 只合计启用物品实物可用量；quantity_maintenance 合计所有物品维护量。

### R39 — 操作流水
events 展示稳定 ID、时间戳、动作、相关物品/借用 ID、数量变化或变更说明，按 ID 升序。可按物品或借用过滤；登记、借出、归还、调整、维护、状态变化及延期可追踪。只读查询和失败操作不添加成功流水。

### R40 — CSV 内容
export 使用 utf-8-sig 和 newline=''，固定列 `loan_id,asset_name,borrower_name,quantity,returned_quantity,borrow_date,due_date,status,notes`。逗号、双引号、中文和换行正确转义，整数与状态含义正确。

### R41 — 导出过滤与数据保护
导出过滤与 loans list 一致，空结果仍写表头。输出父目录不存在时报错；导出不能修改业务库。必须拒绝输出到业务数据库本身，包括规范化同路径、符号链接或已有硬链接，拒绝时保留原数据库字节。

### R42 — 有效备份
backup 创建可重新打开的 SQLite 备份，使用 SQLite backup API 等能保证一致性的方法，不简单复制正在写入的主文件。备份不得覆盖当前数据库或其同文件别名；失败不破坏主库或已有有效目标。

### R43 — 受控恢复
restore 必须显式 --yes；在替换前检查来源可读、本应用 schema_version=1、必要结构、SQLite integrity_check 和外键完整性。拒绝损坏、不兼容和与目标相同的来源，失败时保留当前业务库，不先清空它。

### R44 — 恢复与重启一致
有效备份恢复后再次启动，物品、借用人、借出、累计归还、状态、备注、姓名快照和流水与备份一致；库存由这些数据正确计算。恢复目标使用临时文件并安全替换，避免半个数据库。

### R45 — 演示数据
demo 在空库创建至少 3 个物品、2 个借用人、1 条 OPEN 和 1 条 PARTIAL 借用，数字和流水一致。重复运行本应用演示不增加重复数据；已有非演示业务数据时拒绝插入演示，不清除用户数据。

### R46 — 自带自动测试
提供标准库 unittest，命令 `python -m unittest discover -s tests -v` 可运行。用 TemporaryDirectory 建独立数据库，覆盖借还、停用、库存边界、逾期、CSV 只读及恢复失败；不能写用户默认数据库。

### R47 — 真实 CLI 验证
提供 scripts/smoke.py，用 subprocess 调用真实 `python -m lending_app`，在临时目录完成登记、借出、部分归还、停用后全部归还、导出、备份恢复等至少 10 条命令。每个子进程设合理超时（不超过 30 秒），记录真实返回码与结果；不能仅调用内部函数假装 CLI 验证。

### R48 — 使用文档
README 说明运行环境、入口、全部命令概览、--db、JSON、库存/逾期规则、CSV、备份恢复、demo 和测试命令，给出可复制的借还示例。不增加联网安装步骤，不把未实现选项写成可用。

### R49 — 可追溯验收表
ACCEPTANCE.md 逐项列出 R01–R50，按已验证/部分验证/未验证记录状态和真实依据（测试、命令或代码位置）。不能因为文件存在就全勾通过，不伪造测试、覆盖率或过去的提交。

### R50 — 如实交付与范围
最终交付说明文件位置、启动命令、实际借还操作、真实测试命令/结果和未完成点。应用开发只在当前工作区内完成，不修改 REQUIREMENTS.md、AGENTS.md、.runtime-corrector 配置、RC/OpenClaw 源码或旧运行记录。验收未完成时明确说明，宿主自行判断 RC 反馈并决定动作。

请现在开始实际实现；遇到普通实现选择自行做合理决定，完成后运行测试与真实 CLI 验证，再交付结果。
