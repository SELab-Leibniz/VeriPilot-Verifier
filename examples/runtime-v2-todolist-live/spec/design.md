# TodoList 方案设计

> 消费 `spec/requirements.md`，沿用稳定的 R01–R09 标识。

## 状态模型

待办状态为纯数据，不依赖 DOM。一条待办：

```js
{ id: string, title: string, completed: boolean }
```

整体状态为一个待办数组 + 当前筛选视图：

```js
{ todos: Todo[], filter: 'all' | 'active' | 'completed' }
```

核心由 `src/todo-model.mjs` 导出的纯函数驱动（接收状态、返回新状态，不就地突变入参）：

- `createTodo(state, title)`：标题 trim 后为空 → 不创建（返回原 state）；否则生成稳定唯一 ID 并追加。
- `ID 生成`：模块内单调自增计数器拼接前缀（如 `t1`, `t2`…），保证单次会话内唯一且稳定；编辑/切换不重新分配。
- `toggleTodo(state, id)`：翻转目标项 `completed`；其余项与所有 ID 不变。
- `editTodo(state, id, title)`：标题 trim 为空 → 视为无效编辑，不破坏原标题；非空则更新 `title`。ID 不变。
- `deleteTodo(state, id)`：仅移除目标项；其余项数量与 ID 不变。
- `setFilter(state, filter)`：切换视图。
- `filterTodos(state)`：依据 `filter` 返回当前应显示的子集。
- `counts(state)`：返回 `{ total, active, completed }`，用于视图计数。

“非空标题”统一按 `String(value).trim().length > 0` 判定，覆盖 R01/R04 的空白拒绝语义。

## 模块与文件

| 文件 | 角色 | 职责 |
|------|------|------|
| `src/todo-model.mjs` | 纯状态逻辑 | ID 生成与全部状态变换（R01–R06、R08），无 DOM、无网络 |
| `test/todo-model.test.mjs` | Node 测试 | 原子行为 + R09 关键旅程（`node --test`） |
| `index.html` | 结构 | 语义化骨架：输入框、筛选器、列表、计数 |
| `styles.css` | 样式 | 清晰、响应式布局 |
| `src/app.mjs` | UI 绑定 | 订阅模型、渲染、事件委派，无业务规则（规则全部在模型层） |
| `package.json` | 工程配置 | `npm test` = `node --test`，无第三方依赖 |

依赖关系：`app.mjs` → `todo-model.mjs`；`test/*` → `todo-model.mjs`。HTML/CSS/UI 不被测试直接导入，符合 R08。

## 交互与可访问性

- 新增：文本输入框 + “新增”按钮；输入框 `id="new-todo"`，配 `<label>`；按 Enter 等价于点击“新增”（键盘可用）。
- 每项：复选框（`aria-label` 含标题与完成态，如“标记『买菜』为完成/未完成”）+ 标题（可编辑）+ 编辑/删除按钮。
- 完成态表达：复选框 checked 状态 + 文案（如标题加删除线并追加 “（已完成）” 文字标记），不**仅**依赖颜色。
- 筛选：三个按钮组（全部/进行中/已完成），当前视图按钮加 `aria-pressed="true"`，配 `aria-label`。
- 计数：实时显示当前视图计数与各分类计数，数字以文本呈现。
- 响应式：使用流式布局/最大宽度容器，窄屏可用。

## 测试契约

`test/todo-model.test.mjs` 覆盖：

- R01：空白/纯空格不创建；非空创建。
- R02：ID 唯一；编辑/切换后 ID 不变。
- R03：双向切换完成态。
- R04：空白编辑不破坏原标题；非空编辑成功。
- R05：按 ID 删除仅移除目标项。
- R06：三视图筛选与计数一致。
- R08：测试在 Node 下无 DOM 运行（结构性保证）。
- R09：单用例串联关键旅程全步骤断言。

测试只 import `todo-model.mjs`，不得 import DOM 相关模块。

## 追踪矩阵

| ID | 实现位置 | 验证方式 |
|----|----------|----------|
| R01 | `src/todo-model.mjs` `createTodo` | `test/todo-model.test.mjs` 空白/非空用例 |
| R02 | `src/todo-model.mjs` ID 生成 + 变换不变性 | `test` 唯一性与 ID 不变用例 |
| R03 | `src/todo-model.mjs` `toggleTodo` | `test` 双向切换用例 |
| R04 | `src/todo-model.mjs` `editTodo` | `test` 空白保护/非空更新用例 |
| R05 | `src/todo-model.mjs` `deleteTodo` | `test` 删除目标用例 |
| R06 | `src/todo-model.mjs` `setFilter`/`filterTodos`/`counts` | `test` 三视图筛选计数用例 |
| R07 | `index.html`（label/aria/Enter）/`styles.css`/`src/app.mjs`（`renderItem` 完成态文字标记、`aria-label`、`aria-pressed`） | 结构性（人工确认，无自动化断言） |
| R08 | 模型与 UI 分离：`src/todo-model.mjs` 无 DOM 依赖 | `test/todo-model.test.mjs` “R08: model is usable under node…” 在 Node 通过 |
| R09 | `src/todo-model.mjs` `createTodo`→`toggleTodo`→`setFilter`→`editTodo`→`deleteTodo` 串联 | `test/todo-model.test.mjs` “R09 critical journey…” 通过；证据 `evidence/test-output.txt` |

> 实现状态（Stage E 回填）：以上“实现位置/测试”列与当前仓库真实文件一致，并已由 `npm test`（`evidence/test-output.txt`，12/12 通过）验证。R07 为结构性需求，由 `index.html`/`styles.css`/`src/app.mjs` 满足，无自动化断言。
