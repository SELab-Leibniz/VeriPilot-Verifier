# Runtime Corrector Ground Truth

- Task: `oc-scope-6ada1545-314a-46b4-9e5f-7310a278c80c`
- Version: `1`
- Digest: `edd296506f05a893804fdfa8410cff65d917e1f7547e37930f9506b011f86ab7`
- Frozen at version: `1`

## acceptanceCriteria

- **gt-040** [ACTIVE/HARD/MATERIAL_DERIVED] 首页浏览验收：商品列表正常显示；下拉刷新正常且加载中显示loading；网络失败时显示本地缓存数据；图片加载时显示占位图；浏览历史区域显示最近浏览商品。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-041** [ACTIVE/HARD/MATERIAL_DERIVED] 商品详情验收：商品图片、价格、描述正常显示；点击收藏状态切换且关闭App后重新打开仍保留；点击购买发送系统通知；配送日历、分享、收货人、晒图各功能入口可点击。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-042** [ACTIVE/HARD/MATERIAL_DERIVED] 扫码+语音验收：点击扫一扫相机界面正常拉起；扫描商品二维码自动跳转到对应商品详情页；点击麦克风说出商品名能搜索到对应商品。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-043** [ACTIVE/HARD/MATERIAL_DERIVED] 定位+地图验收：点击定位弹出权限申请（首次）；授权后显示当前位置经纬度；点击地图图标跳转到门店地图页并显示门店标记。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-044** [ACTIVE/HARD/MATERIAL_DERIVED] 支付安全验收：能设置6位支付密码；设置后重新打开App密码仍有效；能清除已设置的密码；真机上能发起生物认证（模拟器不支持）。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-045** [ACTIVE/HARD/MATERIAL_DERIVED] 账号+服务验收："我的"页面显示华为登录入口；未登录时点击登录弹出华为授权页；分享、通讯录、蓝牙状态查询功能正常。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`

## capabilityChecklist

- **capabilityChecklist-3bd2f04a5b0c1ff0** [ACTIVE/HARD/MATERIAL_DERIVED] 语音搜索依赖麦克风录音与语音识别能力（MICROPHONE 权限）。
  - Capability: speech-recognition → (unresolved) [catalogUnmatched]
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **capabilityChecklist-3cb4c7d25c9e6253** [ACTIVE/HARD/MATERIAL_DERIVED] 晒图评价依赖系统图片选择器，无需申请存储权限。
  - Capability: photo-picker → (unresolved) [catalogUnmatched]
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **capabilityChecklist-49a5b9c78f0572cf** [ACTIVE/HARD/USER_EXPLICIT] 使用 DevEco Studio（DEVECO_STUDIO）定位和使用 DevEco Studio、HarmonyOS SDK、Preview 及开发调试能力。
  - Capability: deveco-studio → (unresolved) [catalogUnmatched]
  - Source: `transcript:613091b1`
- **capabilityChecklist-5519756fca7bd7c6** [ACTIVE/HARD/MATERIAL_DERIVED] 生物认证依赖系统生物认证能力（ACCESS_BIOMETRIC），真机可用模拟器不支持。
  - Capability: biometric-auth → (unresolved) [catalogUnmatched]
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **capabilityChecklist-9a8b65e4e72ad44c** [ACTIVE/HARD/USER_EXPLICIT] 使用 HarmonyOS Command Line Tools（COMMAND_LINE_TOOL_PATH）提供的 hvigorw、ohpm、hdc、codelinter、hstack、Emulator 等工具。
  - Capability: harmonyos-command-line-tools → (unresolved) [catalogUnmatched]
  - Source: `transcript:613091b1`
- **capabilityChecklist-d900732358225232** [ACTIVE/HARD/USER_EXPLICIT] 使用 openspec CLI 创建变更与产出物（openspec new/status/instructions）。
  - Capability: openspec-cli → (unresolved) [catalogUnmatched]
  - Source: `transcript:613091b1`
- **capabilityChecklist-eb146c4217d73d63** [ACTIVE/HARD/MATERIAL_DERIVED] 配送日历功能依赖系统日历读写能力（日历权限）。
  - Capability: calendar-kit → @kit.CalendarKit
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **capabilityChecklist-f99be75def15df98** [ACTIVE/HARD/MATERIAL_DERIVED] 扫码购依赖系统扫码/相机能力拉起扫码界面。
  - Capability: scan-kit → @kit.ScanKit
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **capabilityChecklist-feba78b47b73650f** [ACTIVE/HARD/MATERIAL_DERIVED] 支付密码与AES密钥依赖 Asset (asset-store-kit) 加密存储
  - Capability: asset-store-kit → @kit.AssetStoreKit
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-030** [ACTIVE/HARD/MATERIAL_DERIVED] 华为登录依赖配置：在华为开发者联盟(AGC)注册应用、获取 Client ID 并配置签名指纹；未配置时点击登录报错。
  - Capability: huawei-account-login → (unresolved) [catalogUnmatched]
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-031** [ACTIVE/HARD/MATERIAL_DERIVED] 地图展示依赖配置：在 AGC 开通 Map 服务并获取 API Key；未配置时地图显示空白。
  - Capability: huawei-map-service → (unresolved) [catalogUnmatched]
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-033** [ACTIVE/HARD/MATERIAL_DERIVED] 收藏列表与浏览历史使用 Preferences (arkdata) 本地存储。
  - Capability: preferences-storage → (unresolved) [catalogUnmatched]
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`

## constraints

- **gt-027** [ACTIVE/HARD/MATERIAL_DERIVED] 最低系统版本 HarmonyOS 4.0；目标设备为手机、平板；模拟器不支持部分功能（生物认证、蓝牙BLE不可用）。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-035** [ACTIVE/HARD/USER_EXPLICIT] 开发环境与工具优先使用环境变量 DEVECO_STUDIO 与 COMMAND_LINE_TOOL_PATH，其次尝试默认安装路径（C:\Program Files\Huawei\DevEco Studio 与 C:\Program Files\Huawei\command-line-tools）。
  - Source: `transcript:613091b1`
- **gt-036** [ACTIVE/HARD/USER_EXPLICIT] 必须完成应用实现、构建、安装、启动及模拟器验收；验收须以实际运行、点击操作和截屏证据为依据，不得仅凭代码推断需求已满足。
  - Source: `transcript:613091b1`
- **gt-037** [ACTIVE/HARD/USER_EXPLICIT] 若环境变量不存在、路径无效、模拟器无法启动或相关能力不可访问，须如实记录阻塞原因及未执行的验收项，不得伪造执行结果或截图。
  - Source: `transcript:613091b1`
- **gt-039** [ACTIVE/HARD/USER_EXPLICIT] 本阶段无人值守、全程无用户在线：遇需求不明确处自行做合理决策并继续执行，不要提问等待用户；涉及选项取舍时选最贴近需求意图的合理默认方案，并在产物中简要记录所做决策与理由。
  - Source: `transcript:613091b1`

## decisions

- **gt-047** [ACTIVE/SOFT/AGENT_INFERRED] openspec 流程与鸿蒙实现流程的关系处理：用户消息含两步指令（先创建变更产出物、后实现并模拟器验收）。默认解读为按序执行——先生成 proposal.md/design.md/tasks.md 产出物，再进入实现与验收阶段。
  - Source: `transcript:613091b1`

## evidenceObligations

- **gt-038** [ACTIVE/HARD/USER_EXPLICIT] 最终报告须说明：需求完成情况、测试与验收结果、发现及修复的问题、仍未完成的项目。
  - Source: `transcript:613091b1`

## goals

- **gt-001** [ACTIVE/HARD/USER_EXPLICIT] 按项目根目录 app-requirements.md 实现鸿蒙花店电商App，覆盖商品浏览、下单购买、配送提醒、社交分享、语音搜索、扫码购、定位门店等核心与差异化功能。
  - Source: `transcript:613091b1`

## openQuestions

- **gt-046** [ACTIVE/SOFT/AGENT_INFERRED] app-requirements.md 中多个功能依赖 AGC 配置（华为登录、地图）或真机（生物认证、蓝牙BLE），而本阶段无人值守且模拟器不支持这些能力，具体实现与验收深度不明确。默认安全解读：实现可在模拟器验证的全部功能；对依赖 AGC/真机的功能按功能预留实现并在产物与报告中如实标注配置要求与未验收项（含生物认证无法在模拟器执行验收、扫一扫/语音依赖模拟器能力），不以代码推断代替实机验收。
  - Source: `transcript:613091b1`
- **openQuestions-44cb3817447e4727** [ACTIVE/SOFT/AGENT_INFERRED] 部分功能（跳转支付页、生物认证、客服入口、订单管理、设置）标注为功能预留，其是否纳入本次必须实现与验收范围需求文档未明确；默认安全处理为：预留功能不作为必验项，报告中说明其预留状态。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`

## requirements

- **gt-007** [ACTIVE/HARD/MATERIAL_DERIVED] 首页商品列表展示商品卡片（图片、名称、价格）；图片加载时显示占位图。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-008** [ACTIVE/HARD/MATERIAL_DERIVED] 首页支持下拉刷新获取最新商品，刷新时有 loading 反馈；网络失败时降级显示本地缓存。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-009** [ACTIVE/HARD/MATERIAL_DERIVED] 首页底部区域展示最近浏览过的商品，记录最近10条，关闭App后仍保留（Preferences 存储，key=browse_history）。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-010** [ACTIVE/HARD/MATERIAL_DERIVED] 点击定位按钮获取位置并展示附近门店列表，需用户授权位置权限。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-011** [ACTIVE/HARD/MATERIAL_DERIVED] 扫码购：首页扫一扫图标，扫描花束/包装二维码后自动跳转到对应商品详情页。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-012** [ACTIVE/HARD/MATERIAL_DERIVED] 语音搜索：首页麦克风按钮，点击后说话说出商品名称（如红玫瑰），自动搜索对应商品。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-013** [ACTIVE/HARD/MATERIAL_DERIVED] 门店地图：定位按钮旁地图图标跳转地图页，展示附近花店位置，使用华为地图服务；地图页显示当前位置（需用户授权位置权限），点击门店标记显示名称、地址、电话。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-014** [ACTIVE/HARD/MATERIAL_DERIVED] 商品详情页：大图展示（加载失败显示默认占位图）、价格展示（价格数字支持屏幕朗读无障碍）、商品描述（名称、花语、规格）。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-015** [ACTIVE/HARD/MATERIAL_DERIVED] 收藏功能：点击收藏按钮切换状态，状态实时更新且关闭App后重新打开仍保留（Preferences key=favorites 存商品ID数组）；已收藏显示实心♥，未收藏显示空心♡；收藏按钮支持屏幕朗读。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-016** [ACTIVE/HARD/MATERIAL_DERIVED] 商品详情页底部"优惠与服务"卡片提供入口：配送日历提醒、分享给好友（微信/QQ）、添加收货人到通讯录、智能花瓶（蓝牙状态查看）、晒图评价。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-017** [ACTIVE/HARD/MATERIAL_DERIVED] 晒图评价：拍照或从相册选择图片，系统弹出图片选择器且无需申请存储权限；显示已选图片缩略图预览，支持删除已选图片。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-018** [ACTIVE/HARD/MATERIAL_DERIVED] 立即购买流程：点击购买触发订单确认通知并发送订单确认消息到系统通知栏，随后跳转支付页面（功能预留）。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-019** [ACTIVE/HARD/MATERIAL_DERIVED] 订单通知：购买成功后发送系统通知，需用户授权通知权限；通知内容包含商品名称、订单号，通知ID由系统管理；用户拒绝通知权限时提示用户可在设置中开启。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-020** [ACTIVE/HARD/MATERIAL_DERIVED] 支付密码设置：用户输入6位支付密码，本地AES加密存储（Asset, asset-store-kit，密钥与密码一起存储解密时使用）；下单时验证支付密码，使用存储时同一密钥解密比对；支持清除密码，同时清除加密数据和密钥。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-021** [ACTIVE/HARD/MATERIAL_DERIVED] 生物认证（功能预留）：支持指纹/PIN/人脸验证，仅真机测试、模拟器不支持；认证失败显示友好错误提示，不直接显示错误码。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-022** [ACTIVE/HARD/MATERIAL_DERIVED] 华为账号登录："我的"页面提供华为账号登录按钮（未登录时显示）；弹出华为账号登录授权页面，支持已登录华为账号静默授权；登录后显示头像、昵称。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-023** [ACTIVE/HARD/MATERIAL_DERIVED] 配送日历：从日历组件选择配送日期，创建配送提醒日程，需用户授权日历读写权限；日程标题为"花束配送"，包含商品名称、收件人信息。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-024** [ACTIVE/HARD/MATERIAL_DERIVED] 商品列表网络接口 /api/commodities(GET) 与 /api/commodities/{id}(GET)；网络请求失败时自动降级到本地mock数据保障可用性。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-025** [ACTIVE/HARD/MATERIAL_DERIVED] 声明式权限（module.json5）需声明：INTERNET、MICROPHONE、PUBLISH_AGENT_REMINDER、APPROXIMATELY_LOCATION、LOCATION、ACCESS_BIOMETRIC、READ_CALENDAR、WRITE_CALENDAR。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-026** [ACTIVE/HARD/MATERIAL_DERIVED] 运行时权限动态申请：位置权限在点击定位按钮时申请，用户拒绝后提示"定位需要位置权限，请在设置中开启"；通知权限在点击购买按钮时申请，拒绝后Toast提示"通知已关闭，可在设置中开启"；日历读写权限在点击配送日历功能时申请，拒绝后提示"添加日历需要日历权限，请在设置中开启"。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-028** [ACTIVE/HARD/MATERIAL_DERIVED] 性能要求：首页首屏加载 < 2秒；路由切换 < 500ms；图片占位图先行、渐进加载。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`
- **gt-029** [ACTIVE/HARD/MATERIAL_DERIVED] 无障碍要求：价格元素设 accessibilityText+accessibilityLevel 供屏幕朗读正确播报；收藏按钮朗读"已收藏"或"未收藏"；商品图片设 alt 文本描述商品名称。
  - Source: `C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop/app-requirements.md`

## workflowSteps

- **gt-002** [ACTIVE/HARD/USER_EXPLICIT] 将工作区切换到 flower_eshop 目录（C:\Users\user\workspace\program_workspace\runtime-corrector-exp\experiments\ma-rc\run0\flower_eshop）。
  - Source: `transcript:613091b1`
- **gt-003** [ACTIVE/HARD/USER_EXPLICIT] 创建 openspec 变更，名称为 agent-main-session-1792621726192-8kt0bj（不得自行决定或询问变更名称），执行 openspec new change 生成含 proposal.md/design.md/tasks.md 产出物的变更。
  - Source: `transcript:613091b1`
- **gt-004** [ACTIVE/HARD/USER_EXPLICIT] 按依赖顺序创建产出物直至 applyRequires 全部完成：使用 openspec status/instructions 获取顺序与模板，解析 applyRequires 与 artifacts，读取已完成依赖文件获取上下文，用 template 结构填充产出物，写入后验证文件存在，每个产出物创建后检查 applyRequires 中产出物 status 为 done。
  - Source: `transcript:613091b1`
- **gt-005** [ACTIVE/HARD/USER_EXPLICIT] 产出物完成后运行 /opsx-apply（或由代理实现）开始实现任务；不将 context/rules 约束块复制进产出物文件，也不要将 context/rules/project_context 块复制到产出物中。
  - Source: `transcript:613091b1`
- **gt-006** [ACTIVE/HARD/USER_EXPLICIT] 完成开发后使用鸿蒙模拟器运行应用，通过实际点击操作和截屏，对照需求逐项检查并验收，确认功能、页面布局及交互行为与需求一致；发现不一致须修复并重新验证。
  - Source: `transcript:613091b1`
- **workflowSteps-2ef28f65b5f98f67** [ACTIVE/HARD/USER_EXPLICIT] 完成所有产出物后总结变更名称和位置、已创建产出物列表及简要描述，提示运行 /opsx-apply。
  - Source: `transcript:613091b1`
