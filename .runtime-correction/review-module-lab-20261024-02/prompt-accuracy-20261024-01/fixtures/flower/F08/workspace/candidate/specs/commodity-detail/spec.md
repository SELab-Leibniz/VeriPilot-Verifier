# commodity-detail Specification

## Purpose
TBD - created by archiving change agent-main-session-1792621726192-8kt0bj. Update Purpose after archive.
## Requirements
### Requirement: 商品详情展示
系统 SHALL 在商品详情页展示商品主图（支持查看大图）、售价与商品信息（名称、花语、规格）。图片加载失败 SHALL 显示默认占位图，价格数字 SHALL 支持屏幕朗读（无障碍）。

#### Scenario: 展示详情信息
- **WHEN** 用户从首页点击商品进入详情页
- **THEN** 展示商品大图、售价、名称、花语与规格信息

#### Scenario: 价格无障碍朗读
- **WHEN** 屏幕朗读聚焦到价格
- **THEN** 正确播报价格数字

### Requirement: 收藏切换与持久化
系统 SHALL 支持在详情页点击收藏按钮切换收藏状态，状态实时更新并持久化，关闭 App 后重新打开仍保留。已收藏 SHALL 显示实心 ♥，未收藏 SHALL 显示空心 ♡，收藏按钮 SHALL 支持屏幕朗读。

#### Scenario: 收藏与取消
- **WHEN** 用户点击收藏按钮
- **THEN** 收藏状态实时切换，图标在 ♥ 与 ♡ 之间切换，并持久化保存

#### Scenario: 重启后保留收藏
- **WHEN** 用户收藏商品后关闭并重新打开 App
- **THEN** 收藏状态仍为已收藏

### Requirement: 优惠与服务功能入口
商品详情页底部 SHALL 提供「优惠与服务」卡片，包含配送日历提醒、分享给好友、添加收货人、智能花瓶、晒图评价五个功能入口，各入口 SHALL 可点击。

#### Scenario: 展示优惠与服务入口
- **WHEN** 用户打开商品详情页并滚动到底部
- **THEN** 展示配送日历、分享、添加收货人、智能花瓶、晒图评价五个可点击入口

### Requirement: 晒图评价选图与预览
系统 SHALL 支持从拍照或相册选择图片用于晒图评价（无需申请存储权限），并 SHALL 显示已选图片缩略图且支持删除。

#### Scenario: 选择并预览图片
- **WHEN** 用户点击晒图评价并选择图片
- **THEN** 显示所选图片的缩略图预览

#### Scenario: 删除已选图片
- **WHEN** 用户删除某张已选图片
- **THEN** 该图片从预览中移除

