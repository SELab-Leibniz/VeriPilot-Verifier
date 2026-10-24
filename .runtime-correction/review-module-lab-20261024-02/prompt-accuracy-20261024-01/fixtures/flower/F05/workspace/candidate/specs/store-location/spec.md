# store-location Specification

## Purpose
TBD - created by archiving change agent-main-session-1792621726192-8kt0bj. Update Purpose after archive.
## Requirements
### Requirement: 定位附近门店
系统 SHALL 支持首页定位按钮获取位置并展示附近门店列表。首次使用 SHALL 申请位置权限；用户拒绝后 SHALL 提示「定位需要位置权限，请在设置中开启」。

#### Scenario: 授权后获取位置
- **WHEN** 用户授权位置权限并点击定位
- **THEN** 获取位置并展示附近门店列表，显示当前经纬度

#### Scenario: 拒绝位置权限
- **WHEN** 用户拒绝位置权限后点击定位
- **THEN** 提示需要在设置中开启位置权限

### Requirement: 门店地图展示
系统 SHALL 支持从首页地图图标跳转到门店地图页，地图页 SHALL 展示附近门店位置标注；点击标注 SHALL 显示门店名称、地址、电话。

#### Scenario: 跳转地图页
- **WHEN** 用户点击首页地图图标
- **THEN** 跳转到门店地图页并展示附近门店标注

#### Scenario: 查看门店信息
- **WHEN** 用户点击某门店标注
- **THEN** 显示该门店的名称、地址与电话

