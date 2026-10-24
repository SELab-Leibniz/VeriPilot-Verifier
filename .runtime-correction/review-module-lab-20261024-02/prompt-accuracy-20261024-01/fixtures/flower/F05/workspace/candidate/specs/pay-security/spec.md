# pay-security Specification

## Purpose
TBD - created by archiving change agent-main-session-1792621726192-8kt0bj. Update Purpose after archive.
## Requirements
### Requirement: 设置支付密码
系统 SHALL 支持用户输入 6 位支付密码，密码 SHALL 使用本地 AES 加密存储（含密钥），设置后重新打开 App 密码仍有效。

#### Scenario: 设置 6 位密码
- **WHEN** 用户在支付安全页输入 6 位支付密码
- **THEN** 密码经 AES 加密后与密钥一起安全存储

#### Scenario: 重启后密码仍有效
- **WHEN** 用户设置密码后关闭并重新打开 App
- **THEN** 已设置的密码仍可用于验证

### Requirement: 验证支付密码
系统 SHALL 支持下单时验证支付密码，使用与存储时同一密钥解密比对。

#### Scenario: 正确密码通过
- **WHEN** 用户输入与存储一致的密码
- **THEN** 验证通过

#### Scenario: 错误密码拒绝
- **WHEN** 用户输入与存储不一致的密码
- **THEN** 验证失败并提示错误

### Requirement: 清除支付密码
系统 SHALL 支持清除已设置的支付密码，清除时 SHALL 同时删除加密数据与密钥。

#### Scenario: 清除密码
- **WHEN** 用户执行清除支付密码
- **THEN** 加密数据与密钥一并删除，密码不再有效

