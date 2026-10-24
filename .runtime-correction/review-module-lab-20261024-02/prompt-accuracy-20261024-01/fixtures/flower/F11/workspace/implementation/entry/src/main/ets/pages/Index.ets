import { common } from '@kit.AbilityKit';
import { promptAction } from '@kit.ArkUI';
import { Commodity } from '../model/Models';
import { CommodityRepository } from '../data/Repository';
import { PreferencesStore } from '../data/PreferencesStore';
import { PermissionUtil } from '../utils/PermissionUtil';
import { LocationUtil } from '../utils/LocationUtil';
import { ScanUtil } from '../utils/ScanUtil';
import { VoiceUtil } from '../utils/VoiceUtil';
import { MockData } from '../data/MockData';
import { router } from '@kit.ArkUI';

@Entry
@Component
struct Index {
  @State list: Commodity[] = [];
  @State refreshing: boolean = false;
  @State history: Commodity[] = [];
  @State nearby: string = '';
  private repo: CommodityRepository = new CommodityRepository();
  private context: common.UIAbilityContext | null = null;

  aboutToAppear(): void {
    this.context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    this.loadData();
  }

  async loadData(): Promise<void> {
    if (this.context) {
      this.list = await this.repo.fetchList(this.context);
    }
    this.loadHistory();
  }

  async onRefresh(): Promise<void> {
    this.refreshing = true;
    // 模拟网络刷新失败降级：保留现有数据 + 本地缓存
    if (this.context) {
      this.list = await this.repo.fetchList(this.context);
    }
    this.refreshing = false;
  }

  async loadHistory(): Promise<void> {
    if (!this.context) {
      return;
    }
    const ids = await PreferencesStore.getHistory(this.context);
    const all = MockData.commodities();
    const found: (Commodity | undefined)[] = ids.map((id: number) => all.find((c: Commodity) => c.id === id));
    this.history = found.filter((c: Commodity | undefined): boolean => c !== undefined) as Commodity[];
  }

  async onLocate(): Promise<void> {
    if (!this.context) {
      return;
    }
    const granted = await PermissionUtil.request(this.context, [
      'ohos.permission.APPROXIMATELY_LOCATION', 'ohos.permission.LOCATION'
    ]);
    if (!granted) {
      promptAction.showToast({ message: '定位需要位置权限，请在设置中开启' });
      return;
    }
    const loc = await LocationUtil.getCurrent(this.context);
    if (loc) {
      this.nearby = `当前位置：经度 ${loc.lng.toFixed(4)}，纬度 ${loc.lat.toFixed(4)}，附近门店见地图页`;
    } else {
      this.nearby = '获取定位失败';
    }
  }

  async onScan(): Promise<void> {
    if (!this.context) {
      return;
    }
    const raw = await ScanUtil.scan(this.context);
    if (!raw) {
      promptAction.showToast({ message: '扫码未识别或相机不可用' });
      return;
    }
    const id = ScanUtil.parseCommodityId(raw);
    if (id) {
      router.pushUrl({ url: 'pages/CommodityDetail', params: { id } });
    }
  }

  async onVoice(): Promise<void> {
    if (!this.context) {
      return;
    }
    const text = await VoiceUtil.search(this.context);
    if (!text) {
      promptAction.showToast({ message: '语音搜索需要麦克风权限' });
      return;
    }
    const hit = MockData.commodities().find(c => c.name === text);
    if (hit) {
      router.pushUrl({ url: 'pages/CommodityDetail', params: { id: hit.id } });
    } else {
      promptAction.showToast({ message: `未找到「${text}」相关商品` });
    }
  }

  @Builder
  TopBar() {
    Row({ space: 8 }) {
      Text('花语')
        .fontSize(22)
        .fontWeight(FontWeight.Bold)
        .layoutWeight(1)
      Button('扫码')
        .onClick(() => this.onScan())
      Button('语音')
        .onClick(() => this.onVoice())
    }
    .width('100%')
    .padding(12)
  }

  build() {
    Column() {
      this.TopBar()
      Refresh({ refreshing: this.refreshing }) {
        List() {
          ForEach(this.list, (item: Commodity) => {
            ListItem() {
              this.CommodityCard(item)
            }
          }, (item: Commodity) => item.id.toString())
        }
      }
      .onRefreshing(() => this.onRefresh())
      .layoutWeight(1)

      Row({ space: 8 }) {
        Button('定位')
          .onClick(() => this.onLocate())
        Button('地图')
          .onClick(() => router.pushUrl({ url: 'pages/StoreMap' }))
      }
      .padding(12)

      if (this.nearby.length > 0) {
        Text(this.nearby)
          .fontSize(13)
          .padding(8)
      }

      Text('最近浏览')
        .fontSize(16)
        .fontWeight(FontWeight.Medium)
        .width('100%')
        .padding({ left: 12, top: 8, bottom: 4 })
      List() {
        ForEach(this.history, (item: Commodity) => {
          ListItem() {
            this.CommodityCard(item, true)
          }
        }, (item: Commodity) => `h${item.id}`)
      }
      .height(this.history.length > 0 ? 160 : 0)

      Row({ space: 12 }) {
        Button('我的')
          .onClick(() => router.pushUrl({ url: 'pages/Personal' }))
        Button('支付安全')
          .onClick(() => router.pushUrl({ url: 'pages/PaySecurity' }))
      }
      .padding(12)
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  CommodityCard(item: Commodity, compact: boolean = false) {
    Row({ space: 10 }) {
      Image($r('app.media.startIcon'))
        .width(compact ? 48 : 64)
        .height(compact ? 48 : 64)
        .alt(item.name)
      Column({ space: 4 }) {
        Text(item.name)
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
          .accessibilityText(item.name)
        Text(item.flowerLanguage)
          .fontSize(12)
          .fontColor(Color.Gray)
        Row() {
          Text(`¥${item.price.toFixed(2)}`)
            .fontSize(15)
            .fontColor('#E53935')
            .accessibilityText(`价格 ${item.price} 元`)
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
    }
    .padding(10)
    .backgroundColor(Color.White)
    .borderRadius(8)
    .margin({ bottom: 8 })
    .onClick(() => {
      if (this.context) {
        PreferencesStore.recordBrowse(this.context, item.id);
      }
      router.pushUrl({ url: 'pages/CommodityDetail', params: { id: item.id } });
    })
  }
}
