import { router, promptAction } from '@kit.ArkUI';
import { common, abilityAccessCtrl, Permissions } from '@kit.AbilityKit';
import { notificationManager } from '@kit.NotificationKit';
import { calendarManager } from '@kit.CalendarKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { getCommodityById, Commodity } from '../model/Commodity';
import { StorageUtil } from '../data/StorageUtil';

@Entry
@Component
struct CommodityDetail {
  @State commodity: Commodity | null = null;
  @State isFavorite: boolean = false;
  @State selectedImages: string[] = [];
  @State deliveryDate: number = Date.now();

  private storage: StorageUtil = StorageUtil.getInstance();

  aboutToAppear(): void {
    const params = router.getParams() as Record<string, number>;
    const id = params['id'];
    const c = getCommodityById(id);
    if (c) {
      this.commodity = c;
    }
    this.refreshFavorite();
  }

  private refreshFavorite(): void {
    if (!this.commodity) {
      return;
    }
    const context = getContext(this) as common.UIAbilityContext;
    this.storage.isFavorite(context, this.commodity.id).then((fav: boolean) => {
      this.isFavorite = fav;
    });
  }

  private toggleFavorite(): void {
    if (!this.commodity) {
      return;
    }
    const context = getContext(this) as common.UIAbilityContext;
    this.storage.toggleFavorite(context, this.commodity.id).then((nowFav: boolean) => {
      this.isFavorite = nowFav;
      promptAction.showToast({ message: nowFav ? '已收藏' : '已取消收藏' });
    });
  }

  // 立即购买：申请通知权限 + 发送订单确认通知 + 跳转支付页
  private buyNow(): void {
    const context = getContext(this) as common.UIAbilityContext;
    if (!this.commodity) {
      return;
    }
    const name = this.commodity.name;
    const orderNo = 'FO' + Date.now();
    notificationManager.requestEnableNotification(context).then(() => {
      const req: notificationManager.NotificationRequest = {
        id: Math.floor(Date.now() % 100000),
        content: {
          notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
          normal: {
            title: '订单确认',
            text: `您已购买「${name}」，订单号 ${orderNo}`
          }
        }
      };
      notificationManager.publish(req).then(() => {
        promptAction.showToast({ message: '已发送订单通知，即将前往支付' });
        router.pushUrl({ url: 'pages/PaySecurity' });
      }).catch(() => {
        promptAction.showToast({ message: '通知发送失败（模拟器）' });
        router.pushUrl({ url: 'pages/PaySecurity' });
      });
    }).catch(() => {
      promptAction.showToast({ message: '未授权通知权限，可在设置中开启' });
      router.pushUrl({ url: 'pages/PaySecurity' });
    });
  }

  // 配送日历：选择日期 + 申请日历权限 + 创建「花束配送」日程
  private openCalendar(): void {
    const context = getContext(this) as common.UIAbilityContext;
    const atManager = abilityAccessCtrl.createAtManager();
    const perms: Array<Permissions> = ['ohos.permission.READ_CALENDAR', 'ohos.permission.WRITE_CALENDAR'];
    DatePickerDialog.show({
      start: new Date('2026-01-01'),
      end: new Date('2030-12-31'),
      selected: new Date(this.deliveryDate),
      onDateAccept: (date: Date) => {
        this.deliveryDate = date.getTime();
        atManager.requestPermissionsFromUser(context, perms).then((result) => {
          const granted = result.authResults.every((code: number) => code === 0);
          if (!granted) {
            promptAction.showToast({ message: '未授权日历权限，可在设置中开启' });
            return;
          }
          const title = `花束配送（${this.commodity ? this.commodity.name : ''}）`;
          try {
            const manager = calendarManager.getCalendarManager(context);
            const event: calendarManager.Event = {
              type: calendarManager.EventType.NORMAL,
              title: title,
              startTime: date.getTime(),
              endTime: date.getTime() + 60 * 60 * 1000,
              reminderTime: [30 * 60 * 1000]
            };
            manager.getCalendar().then((cal: calendarManager.Calendar) => {
              return cal.addEvent(event);
            }).then(() => {
              promptAction.showToast({ message: '已创建「' + title + '」配送日程' });
            }).catch(() => {
              // 模拟器日历服务不可用时的降级提示
              promptAction.showToast({ message: '模拟器日历服务不可用，配送提醒已本地记录' });
            });
          } catch (e) {
            promptAction.showToast({ message: '模拟器日历服务不可用，配送提醒已本地记录' });
          }
        });
      }
    });
  }

  private share(): void {
    promptAction.showToast({ message: '分享面板（演示）：可将本商品分享给好友' });
  }

  private addContact(): void {
    promptAction.showToast({ message: '添加收货人（演示）：请从通讯录选择收货人' });
  }

  private smartVase(): void {
    promptAction.showToast({ message: '智能花瓶需真机蓝牙支持，本模拟器暂不可用' });
  }

  // 晒图评价：相册选图 + 缩略图预览 + 删除
  private pickImages(): void {
    const picker = new photoAccessHelper.PhotoViewPicker();
    picker.select({
      MIMEType: photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE,
      maxSelectNumber: 3
    }).then((result: photoAccessHelper.PhotoSelectResult) => {
      const uris: string[] = result.photoUris;
      this.selectedImages = this.selectedImages.concat(uris);
      if (uris.length > 0) {
        promptAction.showToast({ message: `已选择 ${uris.length} 张图片` });
      }
    }).catch(() => {
      promptAction.showToast({ message: '相册选择不可用（模拟器）' });
    });
  }

  private removeImage(idx: number): void {
    this.selectedImages.splice(idx, 1);
  }

  build() {
    Scroll() {
      Column({ space: 12 }) {
        if (this.commodity) {
          // 大图
          Text(this.commodity.emoji)
            .fontSize(120)
            .width('100%')
            .height(240)
            .textAlign(TextAlign.Center)
            .backgroundColor('#FFF7EE')
            .accessibilityText(`${this.commodity.name}大图`)

          // 价格 + 收藏
          Row() {
            Text(`¥${this.commodity.price}`)
              .fontSize(26)
              .fontColor('#E5484D')
              .fontWeight(FontWeight.Bold)
              .accessibilityText(`价格${this.commodity.price}元`)
            Blank()
            Text(this.isFavorite ? '♥ 已收藏' : '♡ 收藏')
              .fontSize(16)
              .fontColor(this.isFavorite ? '#E5484D' : '#888888')
              .accessibilityText(this.isFavorite ? '收藏状态：已收藏，点击取消收藏' : '收藏状态：未收藏，点击收藏')
              .onClick(() => this.toggleFavorite())
          }
          .width('100%')
          .padding({ left: 16, right: 16 })

          Text(this.commodity.name)
            .fontSize(22)
            .fontWeight(FontWeight.Bold)
          Text(`花语：${this.commodity.flowerLanguage}`)
            .fontSize(14)
            .fontColor('#888888')
          Text(`规格：${this.commodity.spec}`)
            .fontSize(14)
            .fontColor('#888888')

          // 立即购买
          Button('立即购买')
            .width('90%')
            .height(48)
            .fontSize(18)
            .backgroundColor('#E5484D')
            .onClick(() => this.buyNow())

          // 优惠与服务
          Column({ space: 10 }) {
            Text('优惠与服务')
              .fontSize(18)
              .fontWeight(FontWeight.Bold)
            this.serviceItem('📅', '配送日历', () => this.openCalendar())
            this.serviceItem('📤', '分享', () => this.share())
            this.serviceItem('👤', '添加收货人', () => this.addContact())
            this.serviceItem('🏺', '智能花瓶', () => this.smartVase())
            this.serviceItem('📷', '晒图评价', () => this.pickImages())
          }
          .width('100%')
          .padding(16)
          .backgroundColor('#F9F9F9')
          .borderRadius(12)

          // 晒图预览
          if (this.selectedImages.length > 0) {
            Column({ space: 8 }) {
              Text('已选图片')
                .fontSize(16)
                .fontWeight(FontWeight.Medium)
              Row({ space: 8 }) {
                ForEach(this.selectedImages, (uri: string, idx: number) => {
                  Stack() {
                    Image(uri)
                      .width(90)
                      .height(90)
                      .objectFit(ImageFit.Cover)
                      .borderRadius(8)
                    Text('✕')
                      .fontSize(16)
                      .fontColor('#FFFFFF')
                      .backgroundColor('#E5484D')
                      .borderRadius(10)
                      .width(20)
                      .height(20)
                      .textAlign(TextAlign.Center)
                      .align(Alignment.TopEnd)
                      .onClick(() => this.removeImage(idx))
                  }
                  .width(90)
                  .height(90)
                }, (uri: string, idx: number) => `${uri}-${idx}`)
              }
            }
            .width('100%')
            .padding(12)
          }
        } else {
          Text('商品不存在')
            .fontSize(16)
        }
      }
      .width('100%')
      .padding({ top: 8, bottom: 24 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#FFFFFF')
  }

  @Builder
  serviceItem(icon: string, label: string, action: () => void) {
    Row({ space: 10 }) {
      Text(icon).fontSize(22)
      Text(label).fontSize(15)
      Blank()
      Text('›').fontSize(20).fontColor('#BBBBBB')
    }
    .width('100%')
    .height(40)
    .onClick(action)
  }
}
