import { promptAction, router } from '@kit.ArkUI';

@Entry
@Component
struct Personal {
  @State loggedIn: boolean = false;
  @State nickname: string = '';
  @State avatarUrl: string = '';

  // 华为账号登录（AGC 未配置时降级提示）
  onLogin(): void {
    if (!this.loggedIn) {
      promptAction.showToast({ message: '华为账号登录：需在 AGC 配置 Client ID 与签名指纹，未配置时不可用' });
      return;
    }
    this.loggedIn = false;
    this.nickname = '';
    promptAction.showToast({ message: '已退出登录' });
  }

  build() {
    Column({ space: 14 }) {
      Text('我的')
        .fontSize(20)
        .fontWeight(FontWeight.Bold)
        .width('100%')
        .padding(12)

      Row({ space: 12 }) {
        Image(this.avatarUrl.length > 0 ? this.avatarUrl : $r('app.media.startIcon'))
          .width(64)
          .height(64)
          .borderRadius(32)
          .alt('用户头像')
        Column({ space: 4 }) {
          Text(this.loggedIn ? (this.nickname.length > 0 ? this.nickname : '华为账号用户') : '未登录（游客）')
            .fontSize(17)
            .fontWeight(FontWeight.Medium)
          Text(this.loggedIn ? '已登录' : '游客可浏览、扫码、语音、定位')
            .fontSize(12)
            .fontColor(Color.Gray)
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
      }
      .width('100%')
      .padding(12)
      .backgroundColor(Color.White)
      .borderRadius(8)

      Button(this.loggedIn ? '退出登录' : '华为账号登录')
        .width('100%')
        .onClick(() => this.onLogin())

      Button('支付安全')
        .width('100%')
        .onClick(() => router.pushUrl({ url: 'pages/PaySecurity' }))

      Button('我的订单')
        .width('100%')
        .onClick(() => promptAction.showToast({ message: '订单管理功能预留' }))

      Button('设置')
        .width('100%')
        .onClick(() => promptAction.showToast({ message: '设置功能预留' }))

      Text(this.loggedIn ? '登录用户可使用：下单、收藏、通知、支付' : '注册/登录华为账号可解锁完整电商功能')
        .fontSize(12)
        .fontColor(Color.Gray)
        .padding(12)
    }
    .width('100%')
    .height('100%')
    .padding(12)
  }
}
