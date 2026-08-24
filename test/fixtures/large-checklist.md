# 大型需求文档（回归夹具）

本夹具复现真实需求文档中出现的表格写法：带注解的单元格、与中文粘连的 Kit 名、
展示式大小写、顿号分隔的多 Kit、以及被材料自身标注为候选的条目。

### 10.1 Kit使用清单

| 功能 | 使用Kit | 代码文件 |
|------|---------|---------|
| 页面路由；P2跨设备接续 | ability-kit + distributed-service-kit（P2门禁） | EntryAbility.ets |
| 首页布局 | arkui | HomePage.ets |
| 本地持久化 | arkdata | Store.ets |
| 云端同步 | network-kit | SyncService.ets |
| 账号登录 | account-kit + 业务服务端 | AuthService.ets |
| 健康数据读取 | health-service-kit（平台审批，不是普通manifest权限） | HealthService.ets |
| 语音合成 | core-speech-kit短文本合成 | Voice.ets |
| 文件打印 | basic-services-kit Native文件打印 + PRINT权限 | Print.ets |
| 网络与后台 | Network Kit、Background Tasks Kit | Sync.ets |
| 穿戴联动 | wear-engine-kit | Wear.ets |
| 传感器 | sensor-service-kit | Sensor.ets |
| 相机 | camera-kit | Camera.ets |
| 端侧视觉 | core-vision-kit候选/经POC验证 | Vision.ets |
| 多模态感知 | 本地计时；multimodal-awareness-kit仅作候选信号 | Awareness.ets |
| 天气 | 合规服务端天气供应商；Weather Service Kit未来开放后候选 | Weather.ets |
| 近场连接 | nearlink-kit（能力检测、真机POC） | Nearlink.ets |
| 蓝牙 | connectivity-kit | Bluetooth.ets |
| 定位 | location-kit | Location.ets |
| 地图 | map-kit | Map.ets |
| 日历 | calendar-kit | Calendar.ets |
| 通讯录 | contacts-kit | Contacts.ets |
| 分享 | share-kit系统分享短链 | Share.ets |
| 通知 | notification-kit | Notify.ets |
| 推送 | push-kit | Push.ets |
| 实况窗 | live-view-kit | LiveView.ets |
| 桌面卡片 | form-kit | Card.ets |
| 媒体播放 | media-kit + avsession-kit | Player.ets |
| 音频 | audio-kit | Audio.ets |
| 图片处理 | image-kit | Image.ets |
| 相册选择 | media-library-kit | Picker.ets |
| 文件访问 | core-file-kit系统文件选择器 | Files.ets |
| 加密 | crypto-architecture-kit | Crypto.ets |
| 安全存储 | asset-store-kit | Secure.ets |
| 密钥 | universal-keystore-kit | Keystore.ets |
| 生物认证 | user-authentication-kit | Auth.ets |
| 在线认证 | online-authentication-kit | Online.ets |
| 数据保护 | data-protection-kit | Protect.ets |
| 内购 | iap-kit | Purchase.ets |
| 支付 | payment-kit | Pay.ets |
| 扫码 | scan-kit | Scan.ets |
| 无障碍 | accessibility-kit | A11y.ets |
| 本地化 | localization-kit | I18n.ets |
| 后台任务 | background-tasks-kit（`LOCATION`/`AUDIO_PLAYBACK`） | Background.ets |
| 端侧推理 | mindspore-lite-kit | Infer.ets |
| 意图 | intents-kit | Intents.ets |

### 10.2 Kit与平台能力可行性矩阵

| 能力 | 候选Kit/方案 | 状态 |
|------|-------------|------|
| 企业管控 | MDM Kit + EnterpriseAdminExtensionAbility | C |
| 系统级DLP | Enterprise DataGuard Kit/企业策略 | B/C |
| 企业SSO | 企业IdP OIDC/SAML + 服务端 | D |

