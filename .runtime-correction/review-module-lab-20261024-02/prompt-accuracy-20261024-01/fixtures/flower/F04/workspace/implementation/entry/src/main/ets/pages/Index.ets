import { router } from '@kit.ArkUI';
import { promptAction } from '@kit.ArkUI';
import { common, abilityAccessCtrl, Permissions } from '@kit.AbilityKit';
import { geoLocationManager } from '@kit.LocationKit';
import { Commodity, MOCK_COMMODITIES, MOCK_STORES, queryCommodities, getCommodityById, StoreInfo } from '../model/Commodity';
import { StorageUtil } from '../data/StorageUtil';

@Entry
@Component
struct Index {
  @State commodities: Commodity[] = [];
  @State historyCommodities: Commodity[] = [];
  @State isLoading: boolean = false;
  @State locationText: string = '未定位';
  @State nearbyStores: StoreInfo[] = [];

  private storage: StorageUtil = StorageUtil.getInstance();

  aboutToAppear(): void {
    // 默认展示门店列表，避免定位权限未授权时门店区域不可见
    this.nearbyStores = MOCK_STORES;
    this.loadCommodities();
    this.loadHistory();
  }

  onPageShow(): void {
    this.loadHistory();
  }

  private loadCommodities(): void {
    this.isLoading = true;
    queryCommodities().then((list: Commodity[]) => {
      this.commodities = list;
      this.isLoading = false;
    }).catch(() => {
      // 网络失败降级本地 mock
      this.commodities = MOCK_COMMODITIES;
      this.isLoading = false;
      promptAction.showToast({ message: '网络不可用，已加载本地缓存商品' });
    });
  }

  private loadHistory(): void {
    const context = getContext(this) as common.UIAbilityContext;
    this.storage.getHistory(context).then((ids: number[]) => {
      const list: Commodity[] = [];
      for (const id of ids) {
        const c = getCommodityById(id);
        if (c) {
          list.push(c);
        }
      }
      this.historyCommodities = list;
    });
  }

  private onRefresh(): void {
    this.loadCommodities();
  }

  private goDetail(c: Commodity): void {
    const context = getContext(this) as common.UIAbilityContext;
    this.storage.recordHistory(context, c.id);
    router.pushUrl({ url: 'pages/CommodityDetail', params: { id: c.id } });
  }

  private requestLocation(): void {
    // 先展示默认门店列表，避免模拟器定位不可用时阻塞 UI
    this.nearbyStores = MOCK_STORES;
    const context = getContext(this) as common.UIAbilityContext;
    const atManager = abilityAccessCtrl.createAtManager();
    const perms: Array<Permissions> = ['ohos.permission.APPROXIMATELY_LOCATION', 'ohos.permission.LOCATION'];
    atManager.requestPermissionsFromUser(context, perms).then((result) => {
      const granted = result.authResults.every((code: number) => code === 0);
      if (!granted) {
        this.locationText = '未授权位置权限';
        promptAction.showToast({ message: '未授权位置权限，可在设置中开启' });
        return;
      }
      // 5 秒超时保护：模拟器无 GPS 时 getCurrentLocation 可能长时间无回调
      this.getLocationWithTimeout(5000).then((ok: boolean) => {
        if (ok) {
          promptAction.showToast({ message: `已定位：${this.locationText}` });
        } else {
          this.locationText = '定位失败（模拟器），展示默认门店';
          promptAction.showToast({ message: '模拟器定位不可用，已展示附近门店列表' });
        }
      });
    }).catch(() => {
      this.locationText = '未授权位置权限';
      promptAction.showToast({ message: '未授权位置权限，可在设置中开启' });
    });
  }

  private getLocationWithTimeout(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      }, timeoutMs);
      geoLocationManager.getCurrentLocation().then((loc) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          const lat = loc.latitude.toFixed(4);
          const lng = loc.longitude.toFixed(4);
          this.locationText = `纬度 ${lat} 经度 ${lng}`;
          resolve(true);
        }
      }).catch(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.locationText = '定位失败（模拟器），展示默认门店';
          resolve(false);
        }
      });
    });
  }

  build() {
    Column({ space: 8 }) {
      // 顶部标题
      Row() {
        Text('花店电商')
          .fontSize(22)
          .fontWeight(FontWeight.Bold)
        Blank()
        Text(this.locationText)
          .fontSize(12)
          .fontColor('#888888')
      }
      .width('100%')
      .padding(12)

      // 功能入口：扫一扫 / 语音搜索 / 定位 / 地图
      Row({ space: 8 }) {
        this.entry('📷', '扫一扫', () => router.pushUrl({ url: 'pages/Scan' }))
        this.entry('🎤', '语音搜索', () => router.pushUrl({ url: 'pages/SearchResult' }))
        this.entry('📍', '定位', () => this.requestLocation())
        this.entry('🗺️', '地图', () => router.pushUrl({ url: 'pages/StoreMap' }))
        this.entry('👤', '我的', () => router.pushUrl({ url: 'pages/Personal' }))
      }
      .width('100%')
      .padding({ left: 12, right: 12 })

      // 附近门店（置于商品列表上方，保证可见可达）
      if (this.nearbyStores.length > 0) {
        Column({ space: 4 }) {
          Text('附近门店')
            .fontSize(16)
            .fontWeight(FontWeight.Medium)
          ForEach(this.nearbyStores, (s: StoreInfo) => {
            Text(`${s.name}  ${s.address}`)
              .fontSize(13)
              .width('100%')
              .onClick(() => router.pushUrl({ url: 'pages/StoreMap' }))
          }, (s: StoreInfo) => `s${s.id}`)
        }
        .width('100%')
        .padding(12)
      }

      // 商品列表（支持下拉刷新）
      Refresh({ refreshing: $$this.isLoading }) {
        List({ space: 12 }) {
          ForEach(this.commodities, (c: Commodity) => {
            ListItem() {
              this.commodityCard(c)
            }
          }, (c: Commodity) => `${c.id}`)

          // 浏览历史区域
          if (this.historyCommodities.length > 0) {
            ListItem() {
              Column({ space: 6 }) {
                Text('最近浏览')
                  .fontSize(16)
                  .fontWeight(FontWeight.Medium)
                Row({ space: 8 }) {
                  ForEach(this.historyCommodities, (h: Commodity) => {
                    Column({ space: 2 }) {
                      Text(h.emoji)
                        .fontSize(32)
                        .width(56)
                        .height(56)
                        .textAlign(TextAlign.Center)
                        .backgroundColor('#FFF3F3')
                        .borderRadius(8)
                        .accessibilityText(`${h.name}，价格${h.price}元`)
                      Text(h.name)
                        .fontSize(12)
                    }
                    .onClick(() => this.goDetail(h))
                  }, (h: Commodity) => `h${h.id}`)
                }
              }
              .width('100%')
              .padding(12)
            }
          }
        }
        .width('100%')
        .layoutWeight(1)
      }
      .onRefreshing(() => this.onRefresh())
      .width('100%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#FFFFFF')
  }

  @Builder
  entry(icon: string, label: string, action: () => void) {
    Column({ space: 4 }) {
      Text(icon)
        .fontSize(26)
        .width(52)
        .height(52)
        .textAlign(TextAlign.Center)
        .backgroundColor('#FFF7EE')
        .borderRadius(10)
      Text(label)
        .fontSize(12)
    }
    .layoutWeight(1)
    .onClick(action)
  }

  @Builder
  commodityCard(c: Commodity) {
    Row({ space: 12 }) {
      // 图片占位（emoji 模拟图片，alt 文本说明商品）
      Text(c.emoji)
        .fontSize(48)
        .width(80)
        .height(80)
        .textAlign(TextAlign.Center)
        .backgroundColor('#FFF7EE')
        .borderRadius(8)
        .accessibilityText(`${c.name}图片`)
      Column({ space: 4 }) {
        Text(c.name)
          .fontSize(17)
          .fontWeight(FontWeight.Medium)
        Text(c.flowerLanguage)
          .fontSize(13)
          .fontColor('#888888')
        Text(`¥${c.price}`)
          .fontSize(18)
          .fontColor('#E5484D')
          .fontWeight(FontWeight.Bold)
          .accessibilityText(`价格${c.price}元`)
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
    }
    .width('100%')
    .padding(12)
    .backgroundColor('#F9F9F9')
    .borderRadius(12)
    .onClick(() => this.goDetail(c))
  }
}
