# calendar-reminder Specification

## Purpose
TBD - created by archiving change agent-main-session-1792621726192-8kt0bj. Update Purpose after archive.
## Requirements
### Requirement: 选择配送日期
系统 SHALL 支持在商品详情页配送日历入口中选择配送日期，从日历组件选择。

#### Scenario: 选择配送日期
- **WHEN** 用户点击配送日历并选择一个日期
- **THEN** 记录所选配送日期

### Requirement: 添加到系统日历
系统 SHALL 支持将配送日期创建为系统日历日程，创建前 SHALL 申请日历读写权限；日程标题 SHALL 为「花束配送」，内容 SHALL 包含商品名称与收件人信息。用户拒绝权限后 SHALL 提示「添加日历需要日历权限，请在设置中开启」。

#### Scenario: 授权后创建日程
- **WHEN** 用户授权日历权限并确认添加配送提醒
- **THEN** 在系统日历创建标题为「花束配送」的日程，包含商品名称与收件人信息

#### Scenario: 拒绝日历权限
- **WHEN** 用户拒绝日历权限后添加配送提醒
- **THEN** 提示需要在设置中开启日历权限

