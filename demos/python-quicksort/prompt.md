请在当前项目实现一个很小的 Python 快速排序程序，并实际运行测试。

命令工具运行在 Windows PowerShell 中。请先直接用 write/edit 工具创建代码和测试文件，再用 `python run_tests.py` 执行测试。列目录使用 `Get-ChildItem`。项目工作目录已由宿主绑定，无需额外探测环境或安装工具。

读取项目根目录的 `./requirements.md`，在项目根目录交付 `./quicksort.py` 和 `./test_quicksort.py`。使用 Python 标准库 unittest，不安装依赖。
测试应覆盖空列表、单元素、重复元素、负数、已排序和逆序输入，并检查输入列表不被修改。
运行项目自带的 `python ./run_tests.py`。它使用标准库 unittest，在项目根目录保存真实输出及退出码到 `./test-output.txt`，并通过 stdout 展示结果。
保留 requirements.md、AGENTS.md 和 run_tests.py，不要增加与任务无关的功能。最后说明产物及测试结果。
