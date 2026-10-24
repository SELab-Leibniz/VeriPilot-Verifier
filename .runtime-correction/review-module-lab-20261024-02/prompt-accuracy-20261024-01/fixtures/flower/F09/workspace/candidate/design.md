## Context

当前工程为标准的 HarmonyOS Stage 模型脚手架（`entry` 模块，含 `EntryAbility`、首页 `Index.ets`、`mock-config.json5`），尚无任何业务页面与功能逻辑。需求文档 `./app-requirements.md` 定义了完整的「花店电商 App」：商品浏览/详情、收藏、购买+通知、扫码/语音、定位/地图、支付安全、华为登录、配送日历、晒图评价、分享/通讯录等能力。

外部依赖约束：
- 华为登录（Account Kit）与地图服务（Map Kit）依赖 AGC 平台配置（Client ID、API Key、签名指纹），当前环境未配置。
- 生物认证（指纹/PIN/人脸）与蓝牙（智能花瓶）在模拟器上不可用。
- 本阶段为无人值守模式，无真实网络后端，需以本地 mock 数据为默认数据源。

## Goals / Non-Goals

**Goals:**
- 按需求文档实现全部业务页面与交互，页面布局与行为与需求一致。
- 实现本地数据层：收藏、浏览历史（arkdata 持久化）、支付密码（本地 AES 加密存储）。
- 实现权限动态申请（位置、通知、日历、麦克风）与拒绝后的降级提示。
- 未配置 AGC 的功能（华为登录、地图）以明确、不崩溃的降级表现呈现。
- 可在鸿蒙模拟器上构建、安装、运行并通过点击操作验收。

**Non-Goals:**
- 不接入真实网络后端与真实支付通道（支付页为功能预留）。
- 不做真实生物认证与真实蓝牙智能花瓶交互（模拟器不支持，预留入口）。
- 不接入真实华为账号 OAuth 与真实地图渲染（依赖 AGC 配置，环境缺失），仅保留入口与降级说明。

## Decisions

### 决策 1：页面与路由组织
采用单 `entry` 模块多页面，通过 `main_pages.json` 注册路由，页面包括：`Index`（首页/Home）、`CommodityDetail`、`StoreMap`、`PaySecurity`、`Personal`（我的）、`Scan`（扫码）、`SearchResult`（语音搜索结果）。
- 理由：需求为单模块 App，ArkUI 路由足够，避免多模块复杂度。
- 备选：`Navigation` 组件式路由 — 因页面较多且需各自独立可直达，采用集中式 `main_pages.json` + `router` 更直观、便于验收点击。

### 决策 2：数据源与降级
默认使用本地 mock 商品数据（`mock-config.json5` / 内置数据模型），模拟 `/api/commodities` 接口；网络请求失败自动降级本地缓存。
- 理由：无人值守、无真实后端，需求明确要求「网络失败降级本地缓存」。
- 备选：接入真实 http 请求 — 无可用服务，不可行。

### 决策 3：本地持久化
- 收藏列表与浏览历史：使用 `@ohos.data.preferences`（arkdata）存储（key：`favorites`、`browse_history`）。
- 支付密码：使用 `@ohos.security.cryptoFramework` 进行本地 AES 加密后，经 Asset Store Kit（`@kit.AssetStoreKit`）存储密钥与密文，解密时使用存储时同一密钥比对，清除时同时删除加密数据与密钥。
- 理由：满足「重启后保留」与「支付密码 Asset (asset-store-kit) AES 加密存储」验收要求；不依赖外部服务。

### 决策 4：权限处理
在 `module.json5` 声明所需权限（INTERNET、MICROPHONE、LOCATION、APPROXIMATELY_LOCATION、READ/WRITE_CALENDAR、ACCESS_BIOMETRIC、PUBLISH_AGENT_REMINDER），运行时通过 `@ohos.abilityAccessCtrl` + `@ohos.permissionManager` 动态申请；拒绝后按需求文案提示「可在设置中开启」。

### 决策 5：外部依赖降级（无人值守默认方案）
- 华为登录：保留「我的」页登录入口，因未配置 AGC，点击后提示「华为登录需在 AGC 配置后可用」，不崩溃。
- 门店地图：`StoreMap` 页以门店列表 + 位置信息呈现（经纬度展示），点击门店显示名称/地址/电话；不依赖真实 Map 渲染。
- 生物认证 / 蓝牙智能花瓶：保留入口，模拟器上提示「该功能需真机支持」。
- 理由：无人值守模式要求「自行做出合理决策并继续」，选择最贴近需求意图、且能在当前环境稳定运行的默认方案，并在产物中记录。

## Risks / Trade-offs

- [AGC 未配置导致华为登录/地图无法真实演示] → 以明确降级提示 + 本地呈现（门店列表/经纬度）替代，验收时如实记录为「未完全实现项」。
- [模拟器不支持生物认证/BLE] → 保留入口并提示需真机，验收标注为「不支持项」。
- [权限在模拟器上的授予行为差异] → 采用标准动态申请流程，拒绝分支以 Toast/弹窗提示，验收以实际点击结果为准。
- [真实扫码/语音依赖硬件与识别服务] → 模拟器上以可控 mock 结果（输入/模拟数据）呈现交互流程，标注局限。

## Migration Plan

- 本变更为全新功能实现，无旧逻辑迁移。构建/安装/验收步骤：`hvigorw assembleHap` → `hdc install` → 启动 → 模拟器点击验收。
- 回滚：删除变更目录或还原脚手架即可，无状态破坏风险。

## Open Questions

- 无阻塞性问题；华为登录、地图、生物认证、蓝牙等依赖 AGC/真机/外设的能力，在无人值守且环境受限下按「决策 5」降级处理。
