# commodity-browsing Specification

## Purpose
TBD - created by archiving change agent-main-session-1792621726192-8kt0bj. Update Purpose after archive.
## Requirements
### Requirement: 首页商品列表展示
系统 SHALL 在首页以商品卡片形式展示商品列表，每张卡片包含商品图片、名称与价格。图片加载时 SHALL 显示占位图，加载失败 SHALL 显示默认占位图。

#### Scenario: 正常展示商品列表
- **WHEN** 用户进入首页
- **THEN** 展示商品卡片列表，每张卡片包含图片、名称与价格

#### Scenario: 图片加载中或失败
- **WHEN** 商品图片正在加载或加载失败
- **THEN** 显示占位图，不阻塞列表其他内容展示

### Requirement: 下拉刷新
系统 SHALL 支持首页下拉刷新获取最新商品，刷新时 SHALL 显示 loading 反馈。网络请求失败时 SHALL 降级显示本地缓存数据。

#### Scenario: 下拉刷新成功
- **WHEN** 用户在首页执行下拉手势
- **THEN** 显示 loading 反馈，刷新完成后更新商品列表

#### Scenario: 网络失败降级
- **WHEN** 下拉刷新网络请求失败
- **THEN** 展示本地缓存数据，并提示当前为缓存数据

### Requirement: 浏览历史持久化
系统 SHALL 在首页底部区域展示最近浏览过的商品，记录最近 10 条，关闭 App 后仍保留（持久化存储）。

#### Scenario: 记录浏览历史
- **WHEN** 用户浏览商品详情
- **THEN** 该商品被记录进浏览历史，首页底部展示最近浏览商品，且关闭 App 后重新打开仍保留

#### Scenario: 历史数量上限
- **WHEN** 浏览历史超过 10 条
- **THEN** 仅保留最近 10 条

