# Runtime Corrector Ground Truth

- Task: `oc-scope-0866f084-6f54-421b-b600-a1a57708af09`
- Version: `1`
- Digest: `6feebc4ac28fc3596b9122af165bd359c1d7b001fe15b605e049343a4886267d`
- Frozen at version: `1`

## acceptanceCriteria

- **acceptanceCriteria-0bf1ed9ef7d7d8c2** [ACTIVE/HARD/MATERIAL_DERIVED] Accept section 9.6 account and services: Personal page shows Huawei-login entry; when not logged in, clicking login pops the Huawei authorization page; share, contacts and Bluetooth-status-query functions work.
  - Source: `app-requirements.md`
- **acceptanceCriteria-0dc4100e1e0deea1** [ACTIVE/HARD/MATERIAL_DERIVED] Accept section 9.3 scan and voice: scan icon launches camera interface; scanning a product QR code auto-navigates to the matching detail page; microphone captures a spoken product name and searches the corresponding product.
  - Source: `app-requirements.md`
- **acceptanceCriteria-2805ab6a04d58ce2** [ACTIVE/HARD/MATERIAL_DERIVED] Accept section 9.1 home: product list displays normally; pull refresh works with loading shown; local cache data shown on network failure; placeholder shown while image loads; browse-history area shows recently browsed products.
  - Source: `app-requirements.md`
- **acceptanceCriteria-892cb31c2acc83fd** [ACTIVE/HARD/MATERIAL_DERIVED] Accept section 9.2 product detail: image, price and description display normally; favorite toggles and persists after app restart; buy sends a system notification; delivery-calendar, share, recipient and photo-review entries are clickable.
  - Source: `app-requirements.md`
- **acceptanceCriteria-ed66fe26d9df36ec** [ACTIVE/HARD/MATERIAL_DERIVED] Accept section 9.5 payment security: can set a 6-digit payment password; password remains valid after reopening the app; can clear the set password; biometric authentication can be initiated on real device (emulator not supported).
  - Source: `app-requirements.md`
- **acceptanceCriteria-fc5ce12b84aed17d** [ACTIVE/HARD/MATERIAL_DERIVED] Accept section 9.4 location and map: clicking location pops a permission request (first time); after authorization the current position latitude/longitude shows; clicking the map icon navigates to the store-map page with store markers.
  - Source: `app-requirements.md`

## capabilityChecklist

- **capabilityChecklist-224574e680603644** [ACTIVE/HARD/MATERIAL_DERIVED] Order-confirmation notification requires a notification kit sending system notifications.
  - Capability: notification-kit → @kit.NotificationKit
  - Source: `app-requirements.md`
- **capabilityChecklist-31b38e2fb1220d5f** [ACTIVE/HARD/MATERIAL_DERIVED] Voice search requires voice/speech recognition input capability (microphone permission).
  - Capability: speech-recognition → (unresolved) [catalogUnmatched]
  - Source: `app-requirements.md`
- **capabilityChecklist-3ad5e3bdaef9c27c** [ACTIVE/HARD/MATERIAL_DERIVED] Image picker capability (system picker, no storage permission) for 晒图评价 image selection from camera/album.
  - Capability: photo-picker → (unresolved) [catalogUnmatched]
  - Source: `app-requirements.md`
- **capabilityChecklist-5373ef783f516e91** [ACTIVE/HARD/MATERIAL_DERIVED] Use Huawei Map service for the store-map page (requires AGC API Key).
  - Capability: huawei-map-service → (unresolved) [catalogUnmatched]
  - Source: `app-requirements.md`
- **capabilityChecklist-540a78ea6b69c3e3** [ACTIVE/HARD/MATERIAL_DERIVED] Payment-security biometric authentication uses a biometric-auth capability (ACCESS_BIOMETRIC permission).
  - Capability: biometric-auth → (unresolved) [catalogUnmatched]
  - Source: `app-requirements.md`
- **capabilityChecklist-65c5ce64f8b01070** [ACTIVE/HARD/MATERIAL_DERIVED] Use Preferences (arkdata) for favorites and browse-history local storage per section 5.1.
  - Capability: preferences → (unresolved) [catalogUnmatched]
  - Source: `app-requirements.md`
- **capabilityChecklist-688cfa1e72e3ed3d** [ACTIVE/HARD/MATERIAL_DERIVED] Scan-purchase requires a camera/scan capability to scan product QR codes.
  - Capability: scan-kit → @kit.ScanKit
  - Source: `app-requirements.md`
- **capabilityChecklist-7f8cc0377b37fdd2** [ACTIVE/HARD/MATERIAL_DERIVED] Location service for nearby store lookup and current location display (approximate and precise location permissions).
  - Capability: location-service → (unresolved) [catalogUnmatched]
  - Source: `app-requirements.md`
- **capabilityChecklist-80f54a1b0e802748** [ACTIVE/HARD/USER_EXPLICIT] Use DevEco Studio (via DEVECO_STUDIO or default install) for building, SDK, Preview and debugging.
  - Capability: deveco-studio → (unresolved) [catalogUnmatched]
  - Source: `transcript:18f884fd`
- **capabilityChecklist-86a349d62c8a53d5** [ACTIVE/HARD/MATERIAL_DERIVED] Contacts capability to add recipient info to contacts via the 通讯录 (contacts) Picker.
  - Capability: contacts-kit → @kit.ContactsKit
  - Source: `app-requirements.md`
- **capabilityChecklist-adf5af414de17d3b** [ACTIVE/HARD/MATERIAL_DERIVED] Smart-vase status uses Bluetooth BLE capability (not available on emulator).
  - Capability: bluetooth → (unresolved) [catalogUnmatched]
  - Source: `app-requirements.md`
- **capabilityChecklist-b507a3afdcb55bb4** [ACTIVE/HARD/MATERIAL_DERIVED] Use Huawei account login kit for Huawei-account authorization (requires AGC Client ID and signature fingerprint).
  - Capability: huawei-account-login → (unresolved) [catalogUnmatched]
  - Source: `app-requirements.md`
- **capabilityChecklist-c009dfbd88cfa68f** [ACTIVE/HARD/USER_EXPLICIT] Use HarmonyOS command-line tools (via COMMAND_LINE_TOOL_PATH or default install) including hvigorw, ohpm, hdc, codelinter, hstack and Emulator.
  - Capability: harmonyos-command-line-tools → (unresolved) [catalogUnmatched]
  - Source: `transcript:18f884fd`
- **capabilityChecklist-c589a75519757dc3** [ACTIVE/HARD/MATERIAL_DERIVED] Share capability to share the product link/image to WeChat/QQ for the share-to-friends feature.
  - Capability: share-capability → (unresolved) [catalogUnmatched]
  - Source: `app-requirements.md`
- **capabilityChecklist-c7da9914c0e7be67** [ACTIVE/HARD/MATERIAL_DERIVED] Use Asset (asset-store-kit) for AES-encrypted payment password storage per section 5.1.
  - Capability: asset-store-kit → @kit.AssetStoreKit
  - Source: `app-requirements.md`
- **capabilityChecklist-d9ce1fda4f58a67f** [ACTIVE/HARD/MATERIAL_DERIVED] Delivery-calendar reminder requires calendar read/write capability via a calendar kit.
  - Capability: calendar-kit → @kit.CalendarKit
  - Source: `app-requirements.md`

## constraints

- **constraints-0ccee97e23e867ee** [ACTIVE/HARD/USER_EXPLICIT] If an environment variable is missing, a path is invalid, the emulator cannot start, or a capability is inaccessible, truthfully record the blocking reason and the unexecuted acceptance items; do not fabricate execution results or screenshots.
  - Source: `transcript:18f884fd`
- **constraints-8178935982f5e0ee** [ACTIVE/HARD/MATERIAL_DERIVED] Huawei login requires AGC registration (app registered, Client ID obtained and signature fingerprint configured); if not configured, login click errors. Map display requires enabling Map service on AGC and obtaining an API Key; if absent the map renders blank.
  - Source: `app-requirements.md`
- **constraints-972387b45be6c35e** [ACTIVE/HARD/USER_EXPLICIT] Unattended mode applies for this stage: no user is online, so do not pause to ask questions; when requirements are unclear make reasonable decisions and continue, choosing the default closest to requirement intent, and briefly record decisions and reasons in the deliverables.
  - Source: `transcript:18f884fd`
- **constraints-bc54e38620029769** [ACTIVE/HARD/USER_EXPLICIT] Locate HarmonyOS Command Line Tools by checking the COMMAND_LINE_TOOL_PATH environment variable first, then falling back to the default install path C:\Program Files\Huawei\command-line-tools; tools include hvigorw, ohpm, hdc, codelinter, hstack, Emulator and others.
  - Source: `transcript:18f884fd`
- **constraints-bca6935f803a8c5f** [ACTIVE/HARD/USER_EXPLICIT] Acceptance evidence must come from actual runtime, click operations and screenshots; requirement satisfaction may not be inferred from code alone.
  - Source: `transcript:18f884fd`
- **constraints-de0dff7b181ad238** [ACTIVE/HARD/USER_EXPLICIT] Locate DevEco Studio by checking the DEVECO_STUDIO environment variable first, then falling back to the default install path C:\Program Files\Huawei\DevEco Studio; use it for SDK, Preview and dev/debug capabilities.
  - Source: `transcript:18f884fd`
- **constraints-fe78a056326f0637** [ACTIVE/HARD/USER_EXPLICIT] The change name is fixed as 'agent-main-session-1792650031357-alyeya'; do not decide or ask for the change name.
  - Source: `transcript:18f884fd`

## criticalJourneys

- **criticalJourneys-73e236f4f035e643** [ACTIVE/HARD/MATERIAL_DERIVED] Critical journey from 我的 (Personal): Huawei login -> Huawei authorization page; pay security -> pay security page (set password / verify password / biometric auth).
  - Source: `app-requirements.md`
- **criticalJourneys-772c71b52496a02b** [ACTIVE/HARD/MATERIAL_DERIVED] Critical journey Home: browse product list -> click product -> product detail -> favorite (state update + persist) / buy (send notification then jump to payment) / delivery calendar (calendar Picker) / share (share panel) / add recipient (contacts Picker) / image review (image Picker) / map (store map page).
  - Source: `app-requirements.md`
- **criticalJourneys-cb369ffff032b086** [ACTIVE/HARD/MATERIAL_DERIVED] Critical journeys from Home: scan -> scan UI -> product detail; microphone -> voice search -> search results -> product detail; location -> acquire location -> nearby store list; map -> store map page -> click marker -> detail popup.
  - Source: `app-requirements.md`

## decisions

- **decisions-6fdaf4ec1cb92280** [ACTIVE/SOFT/MATERIAL_DERIVED] The task combines an openspec change proposal workflow (proposal.md/design.md/tasks.md + /opsx-apply) with the actual HarmonyOS app implementation, build, emulator run, verification and report; both are part of this task's deliverables.
  - Source: `transcript:18f884fd`

## developmentStandards

- **developmentStandards-6c6c27ddecebef8b** [ACTIVE/HARD/MATERIAL_DERIVED] Accessibility: price element carries accessibilityText plus accessibilityLevel so screen reading announces it; favorite button carries accessibilityText plus accessibilityLevel reading 已收藏 or 未收藏; product images carry alt text describing the product name.
  - Source: `app-requirements.md`
- **developmentStandards-e4d737b86b16a1c5** [ACTIVE/HARD/MATERIAL_DERIVED] Compatibility: minimum system version HarmonyOS 4.0; target devices phone and tablet; some features (biometric authentication, Bluetooth BLE) are not available on the emulator.
  - Source: `app-requirements.md`
- **developmentStandards-e7dc23fccc06ee3f** [ACTIVE/HARD/MATERIAL_DERIVED] Performance: home first screen renders in under 2 seconds; route/page switch under 500ms; image loading shows placeholder first then progressive load.
  - Source: `app-requirements.md`

## evidenceObligations

- **evidenceObligations-66516380b4bad630** [ACTIVE/HARD/USER_EXPLICIT] Capture screenshot evidence for acceptance items via actual emulator run and click operations.
  - Source: `transcript:18f884fd`
- **evidenceObligations-6f9f586c18d5eeab** [ACTIVE/HARD/USER_EXPLICIT] Produce a final report stating requirement completion status, test and acceptance results, issues found and fixed, and items still incomplete.
  - Source: `transcript:18f884fd`

## goals

- **goals-1fbafd17670dd1ec** [ACTIVE/HARD/USER_EXPLICIT] Deliver a working HarmonyOS flower-shop e-commerce app implemented per ./app-requirements.md, covering browse, purchase, payment security, account, map and delivery-calendar capabilities.
  - Source: `transcript:18f884fd`
- **goals-3a3b1b07ffd2ca3d** [ACTIVE/HARD/USER_EXPLICIT] Execute the openspec change workflow first: switch the workspace to the flower_eshop directory, create one change named agent-main-session-1792650031357-alyeya, generate all its applyRequires artifacts in a single flow, then run /opsx-apply to begin implementation.
  - Source: `transcript:18f884fd`

## openQuestions

- **openQuestions-b88afa062d644143** [ACTIVE/SOFT/BASIS_PENDING] AGC dependency configuration (Huawei-login Client ID/fingerprint, Map API Key) may not be provisioned in this environment; implement the integration paths and during acceptance truthfully record which AGC-dependent features cannot be exercised due to missing configuration.
  - Source: `app-requirements.md`
- **openQuestions-de6cdc2705ed54ff** [ACTIVE/SOFT/AGENT_INFERRED] The user request names proposal.md, design.md and tasks.md as the artifacts, but openspec's applyRequires may include additional artifacts (e.g. requirements) as defined by the change schema. Default-safe reading: create all artifacts listed in applyRequires per the schema, not limited to the three named, and stop when all applyRequires artifacts are done.
  - Source: `transcript:18f884fd`
- **openQuestions-f6fc2ceb0410b2ff** [ACTIVE/SOFT/BASIS_PENDING] Emulator cannot support biometric authentication and Bluetooth BLE; implement the code paths but exclude those items from emulator acceptance, recording them as emulator-unsupported per the stated emulator-support limitation.
  - Source: `app-requirements.md`

## outOfScope

- **outOfScope-97d8609633f7d7be** [ACTIVE/SOFT/MATERIAL_DERIVED] Reserved/stub features are not required to be fully functional: payment page navigation, biometric authentication (real-device only), order management, settings, customer-service entry on the detail page, and phone/navigation actions from the map page.
  - Source: `app-requirements.md`

## requirements

- **requirements-04aef361d6aab8b2** [ACTIVE/HARD/MATERIAL_DERIVED] The app is a C-end flower-shop e-commerce app supporting core e-commerce capabilities (browse products, place orders, delivery reminders, social sharing) plus differentiated features: voice search, scan-to-buy, and store location.
  - Source: `app-requirements.md`
- **requirements-0d51e26d5d9dd38b** [ACTIVE/HARD/MATERIAL_DERIVED] Share-to-friends entry shares the product link/image to WeChat/QQ etc.
  - Source: `app-requirements.md`
- **requirements-0e0c473ab97466bf** [ACTIVE/HARD/MATERIAL_DERIVED] Favorite toggle on detail page must switch state (实心♥ when favorited, 空心♡ when not), update in real time, persist across app restarts, and support screen reading.
  - Source: `app-requirements.md`
- **requirements-0e29d94aa5debd57** [ACTIVE/HARD/MATERIAL_DERIVED] Smart-vase entry shows Bluetooth smart-vase status.
  - Source: `app-requirements.md`
- **requirements-10ae5da5ff1890fe** [ACTIVE/HARD/MATERIAL_DERIVED] Delivery calendar: user selects a delivery date from a calendar component, and the app creates a delivery-reminder event (requires calendar read/write authorization); event title is 花束配送 and contains product name and recipient info.
  - Source: `app-requirements.md`
- **requirements-13a79950f65cebf8** [ACTIVE/HARD/MATERIAL_DERIVED] Detail page bottom provides a 优惠与服务 card with functional entries: delivery-calendar reminder, share to friends, add recipient, smart vase, and photo review.
  - Source: `app-requirements.md`
- **requirements-39180bc66966a476** [ACTIVE/HARD/MATERIAL_DERIVED] Add-recipient entry adds recipient information to the contacts (通讯录 Picker).
  - Source: `app-requirements.md`
- **requirements-39a5fb4948451621** [ACTIVE/HARD/MATERIAL_DERIVED] Runtime (dynamic) permissions: location permission requested when the location button is clicked, with denial message 定位需要位置权限，请在设置中开启; notification permission requested when the buy button is clicked, with denial Toast 通知已关闭，可在设置中开启; calendar read/write requested when the delivery-calendar entry is clicked, with denial message 添加日历需要日历权限，请在设置中开启.
  - Source: `app-requirements.md`
- **requirements-3a514778a17002c3** [ACTIVE/HARD/MATERIAL_DERIVED] Privacy permission prompts on first use of each feature: location on location-button click (find nearby stores), notification on buy-button click (order-confirmation notification), calendar on delivery-calendar click (add delivery reminder), microphone on voice-search click (voice input product name).
  - Source: `app-requirements.md`
- **requirements-3e1172210314804d** [ACTIVE/HARD/MATERIAL_DERIVED] Network: GET /api/commodities returns the product list; GET /api/commodities/{id} returns product detail; when a network request fails, automatically degrade to local mock data to keep the app usable.
  - Source: `app-requirements.md`
- **requirements-401543d0adc5b295** [ACTIVE/HARD/MATERIAL_DERIVED] Home page must display the product list as product cards with image, name and price; a placeholder image is shown while the image loads.
  - Source: `app-requirements.md`
- **requirements-4b0ed4d955c868c4** [ACTIVE/HARD/MATERIAL_DERIVED] User roles: guests (not logged in) can browse products, locate stores, scan and search; registered users (Huawei account login) additionally get order, favorite, notification and payment capabilities.
  - Source: `app-requirements.md`
- **requirements-5d97215d0b39ccd5** [ACTIVE/HARD/MATERIAL_DERIVED] Home page bottom area must show recently browsed products; record the most recent 10 items and retain them after the app is closed.
  - Source: `app-requirements.md`
- **requirements-6caf3eb8715f623d** [ACTIVE/HARD/MATERIAL_DERIVED] Delivery-calendar reminder entry adds the delivery date to the system calendar.
  - Source: `app-requirements.md`
- **requirements-70867ecb639cc96b** [ACTIVE/HARD/USER_EXPLICIT] Acceptance must be done by actually running the app on the emulator, performing real click operations and capturing screenshots, checking each requirement item; inconsistencies found must be fixed and re-verified.
  - Source: `transcript:18f884fd`
- **requirements-7d6ef1b98f1d4694** [ACTIVE/HARD/MATERIAL_DERIVED] Order notification must contain product name and order number, with the notification ID managed by the system, and requires user notification authorization; when the user denies notification permission, prompt that it can be enabled in settings.
  - Source: `app-requirements.md`
- **requirements-7fb691c097dec6bd** [ACTIVE/HARD/MATERIAL_DERIVED] Local storage: payment password stored AES-encrypted in Asset (asset-store-kit), with the AES key stored alongside for decryption.
  - Source: `app-requirements.md`
- **requirements-86fca1080fc0b0c6** [ACTIVE/HARD/MATERIAL_DERIVED] Scan-purchase (find-flower method): home scan icon scans a QR code on flower/packaging and auto-navigates to the corresponding product detail page.
  - Source: `app-requirements.md`
- **requirements-871fc98aca7e404a** [ACTIVE/HARD/USER_EXPLICIT] Implement the HarmonyOS app according to ./app-requirements.md at the project root, then build, install and launch it on the HarmonyOS emulator.
  - Source: `transcript:18f884fd`
- **requirements-874b24d0d65cd492** [ACTIVE/HARD/MATERIAL_DERIVED] Huawei account login: Personal page offers a Huawei-account login button (shown when not logged in), pops up the Huawei authorization page, supports silent authorization for already-logged-in Huawei accounts, and displays user avatar and nickname after login.
  - Source: `app-requirements.md`
- **requirements-a10c978b08a701da** [ACTIVE/HARD/MATERIAL_DERIVED] Page structure per info architecture section 4.1: Home (product list, scan entry, voice-search entry, location/map entry, browse-history area), CommodityDetail (large image, price+favorite, 优惠与服务 card, buy button, reserved customer-service entry), StoreMap (map display, store marker list), PaySecurity (payment password setting, biometric auth, Kit verification note), Personal (Huawei account login, reserved order management and settings).
  - Source: `app-requirements.md`
- **requirements-a2bcf7d79609c918** [ACTIVE/HARD/MATERIAL_DERIVED] Local storage: favorites stored in Preferences (arkdata) under key favorites as a product-ID array; browse history stored in Preferences (arkdata) under key browse_history holding the most recent 10 items.
  - Source: `app-requirements.md`
- **requirements-a65e5afd8a84a876** [ACTIVE/HARD/MATERIAL_DERIVED] Biometric authentication is a reserved feature supporting fingerprint/PIN/face verification, to be tested on real devices only (emulator does not support it); on failure show a friendly error message without exposing raw error codes.
  - Source: `app-requirements.md`
- **requirements-aa8bd3833ead1e25** [ACTIVE/HARD/MATERIAL_DERIVED] Photo-review (晒图评价) entry lets the user choose images by camera or album via a system image picker that does not require storage permission, shows selected-image thumbnails, and supports deleting selected images.
  - Source: `app-requirements.md`
- **requirements-b2232d3587ff391f** [ACTIVE/HARD/MATERIAL_DERIVED] Nearby store map (find-flower method): map icon beside the location button navigates to a map page showing nearby flower-shop positions.
  - Source: `app-requirements.md`
- **requirements-c1e2546bcc725eb9** [ACTIVE/HARD/MATERIAL_DERIVED] Payment password: user sets a 6-digit payment password stored locally with AES encryption; verify the password on order placement by decrypting with the same stored key and comparing; support clearing the password, clearing both the encrypted data and the key.
  - Source: `app-requirements.md`
- **requirements-c24b1a9860a81329** [ACTIVE/HARD/MATERIAL_DERIVED] Declare in module.json5 the following permissions: ohos.permission.INTERNET, MICROPHONE, PUBLISH_AGENT_REMINDER, APPROXIMATELY_LOCATION, LOCATION, ACCESS_BIOMETRIC, READ_CALENDAR and WRITE_CALENDAR.
  - Source: `app-requirements.md`
- **requirements-c2bed7ae705748e2** [ACTIVE/HARD/MATERIAL_DERIVED] Product detail page must show a main image (large view support, default placeholder on load failure), price (with accessibility reading), and description including product name, flower language and specification.
  - Source: `app-requirements.md`
- **requirements-c89493ee9d3e9900** [ACTIVE/HARD/MATERIAL_DERIVED] Home page must support pull-to-refresh to load the latest products with loading feedback, and degrade to local cache when the network fails.
  - Source: `app-requirements.md`
- **requirements-c9bc5beb5fff4222** [ACTIVE/HARD/MATERIAL_DERIVED] Nearby stores: clicking the location button obtains the location and shows a nearby-stores list; requires user location authorization.
  - Source: `app-requirements.md`
- **requirements-e07af62bd9a38319** [ACTIVE/HARD/MATERIAL_DERIVED] Buy-now flow: click buy triggers an order-confirmation notification, sends an order-confirmation message to the system notification bar, then navigates to the payment page (payment page is a reserved/stub feature).
  - Source: `app-requirements.md`
- **requirements-f4ae019cd5d0c5b0** [ACTIVE/HARD/MATERIAL_DERIVED] Store map page displays store-location markers using Huawei Map service, shows the user's current location (requires location authorization), and clicking a marker shows store info including name, address and phone.
  - Source: `app-requirements.md`
- **requirements-f57931f0747a6ffc** [ACTIVE/HARD/MATERIAL_DERIVED] Voice search (find-flower method): home microphone button captures a spoken product name (e.g. 红玫瑰) and auto-searches.
  - Source: `app-requirements.md`

## workflowSteps

- **workflowSteps-4074935664a72bbb** [ACTIVE/HARD/USER_EXPLICIT] Follow the openspec change workflow: run 'openspec new change "agent-main-session-1792650031357-alyeya"', then 'openspec status --change ... --json' to read applyRequires and artifacts, and iterate over ready artifacts in dependency order fetching instructions and writing each artifact until all applyRequires artifacts have status done.
  - Source: `transcript:18f884fd`
- **workflowSteps-757f56bf9e31755c** [ACTIVE/HARD/USER_EXPLICIT] When all artifacts are done, display final status via 'openspec status --change "agent-main-session-1792650031357-alyeya"' (non-JSON) and summarize: change name and location, created artifacts with brief descriptions, readiness line '所有产出物已创建！准备好实现。', and prompt '运行 /opsx-apply 或要求我实现以开始处理任务。'.
  - Source: `transcript:18f884fd`
- **workflowSteps-a4fb9fb3132de4d1** [ACTIVE/HARD/USER_EXPLICIT] After artifacts are ready, run /opsx-apply to begin implementation.
  - Source: `transcript:18f884fd`
- **workflowSteps-cac2942b35b3df9a** [ACTIVE/HARD/USER_EXPLICIT] Create one change and generate all its artifacts in a single flow: proposal.md (what and why), design.md (implementation approach), tasks.md (implementation steps).
  - Source: `transcript:18f884fd`
- **workflowSteps-e5051e8cd9fdfd3c** [ACTIVE/HARD/USER_EXPLICIT] Switch the workspace to C:\Users\user\workspace\program_workspace\runtime-corrector-exp\experiments\ma-rc\run1\flower_eshop and propose a new change there.
  - Source: `transcript:18f884fd`
