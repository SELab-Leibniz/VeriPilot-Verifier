import { common } from '@kit.AbilityKit';
import { promptAction, router } from '@kit.ArkUI';
import { Commodity } from '../model/Models';
import { CommodityRepository } from '../data/Repository';
import { PreferencesStore } from '../data/PreferencesStore';
import { NotificationUtil } from '../utils/NotificationUtil';
import { ShareUtil } from '../utils/ShareUtil';
import { CalendarUtil } from '../utils/CalendarUtil';
import { SmartVaseUtil } from '../utils/SmartVaseUtil';
import { ImagePickerUtil } from '../utils/ImagePickerUtil';
import { MockData } from '../data/MockData';

@Entry
@Component
struct CommodityDetail {
  @State commodity: Commodity | null = null;
  @State favorite: boolean = false;
  @State pickedImages: string[] = [];
  @State receiver: string = '收货人：张女士';
  private context: common.UIAbilityContext | null = null;
  private repo: CommodityRepository = new CommodityRepository();

  aboutToAppear(): void {
    this.context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const params = router.getParams() as Record<string, number>;
    const id = params && params['id'] ? params['id'] : 1;
    this.load(id);
  }

  async load(id: number): Promise<void> {
    if (this.context) {
      this.commodity = await this.repo.fetchDetail(this.context, id);
      this.favorite = (await PreferencesStore.getFavorites(this.context)).includes(id);
      PreferencesStore.recordBrowse(this.context, id);
    }
  }

  async toggleFavorite(): Promise<void> {
    if (!this.context || !this.commodity) {
      return;
    }
    this.favorite = !this.favorite;
    await PreferencesStore.setFavorite(this.context, this.commodity.id, this.favorite);
    promptAction.showToast({ message: this.favorite ? '已收藏' : '已取消收藏' });
  }

  async onBuy(): Promise<void> {
    if (!this.context || !this.commodity) {
      return;
    }
    const sent = await NotificationUtil.sendOrder(this.context, this.commodity.name);
    if (!sent) {
      promptAction.showToast({ message: '通知已关闭，可在设置中开启' });
    }
    // 跳转支付页（功能预留）
    router.pushUrl({ url: 'pages/PaySecurity' });
  }

  async onCalendar(): Promise<void> {
    if (!this.context || !this.commodity) {
      return;
    }
    const ok = await CalendarUtil.addReminder(this.context, this.commodity.name, this.receiver);
    promptAction.showToast({ message: ok ? '已添加配送日历提醒' : '添加日历需要日历权限，请在设置中开启' });
  }

  async onShare(): Promise<void> {
    if (this.commodity) {
      await ShareUtil.share(this.context as common.UIAbilityContext, this.commodity.name, this.commodity.price);
    }
  }

  async onSmartVase(): Promise<void> {
    await SmartVaseUtil.queryStatus();
  }

  async onPickImage(): Promise<void> {
    const uris = await ImagePickerUtil.pick();
    if (uris.length > 0) {
      this.pickedImages = this.pickedImages.concat(uris);
    }
  }

  @Builder
  ServiceCard() {
    Column({ space: 8 }) {
      Text('优惠与服务')
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
      Row({ space: 8 }) {
        Button('配送日历')
          .onClick(() => this.onCalendar())
        Button('分享好友')
          .onClick(() => this.onShare())
      }
      Row({ space: 8 }) {
        Button('智能花瓶')
          .onClick(() => this.onSmartVase())
        Button('晒图评价')
          .onClick(() => this.onPickImage())
      }
      if (this.pickedImages.length > 0) {
        Row({ space: 6 }) {
          ForEach(this.pickedImages, (uri: string) => {
            Image(uri)
              .width(48)
              .height(48)
          }, (uri: string, i: number) => `${uri}_${i}`)
        }
        Button('删除已选')
          .fontSize(13)
          .onClick(() => this.pickedImages = [])
      }
      Text(`· ${this.receiver} · 支付安全见「支付安全」页 · 客服预留`)
        .fontSize(12)
        .fontColor(Color.Gray)
    }
    .width('100%')
    .padding(12)
    .backgroundColor('#F5F5F5')
    .borderRadius(8)
  }

  build() {
    Column() {
      if (this.commodity) {
        Scroll() {
          Column({ space: 12 }) {
            Image($r('app.media.startIcon'))
              .width('100%')
              .height(240)
              .alt(this.commodity.name)
              .borderRadius(8)

            Row({ space: 8 }) {
              Text(this.commodity.name)
                .fontSize(22)
                .fontWeight(FontWeight.Bold)
                .layoutWeight(1)
                .accessibilityText(this.commodity.name)
              Button(this.favorite ? '♥ 已收藏' : '♡ 收藏')
                .fontSize(14)
                .onClick(() => this.toggleFavorite())
                .accessibilityText(this.favorite ? '已收藏' : '未收藏')
            }
            .width('100%')

            Text(`¥${this.commodity.price.toFixed(2)}`)
              .fontSize(24)
              .fontColor('#E53935')
              .accessibilityText(`价格 ${this.commodity.price} 元`)

            Text(`花语：${this.commodity.flowerLanguage}`)
              .fontSize(15)
            Text(`规格：${this.commodity.spec}`)
              .fontSize(14)
              .fontColor(Color.Gray)

            this.ServiceCard()
          }
          .padding(12)
        }
        .layoutWeight(1)

        Row({ space: 8 }) {
          Button('客服')
            .fontSize(14)
            .onClick(() => promptAction.showToast({ message: '客服功能预留' }))
          Button('立即购买')
            .fontSize(16)
            .fontWeight(FontWeight.Medium)
            .layoutWeight(1)
            .onClick(() => this.onBuy())
        }
        .width('100%')
        .padding(12)
        .backgroundColor(Color.White)
      } else {
        Text('商品加载中…')
          .fontSize(16)
          .margin({ top: 60 })
      }
    }
    .width('100%')
    .height('100%')
  }
}
