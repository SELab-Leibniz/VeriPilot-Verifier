import { router, promptAction } from '@kit.ArkUI';

@Entry
@Component
struct Personal {
  @State loggedIn: boolean = false;

  build() {
    Column({ space: 16 }) {
      Text('我的')
        .fontSize(22)
        .fontWeight(FontWeight.Bold)
        .width('100%')
        .padding(12)

      // 华为账号登录入口
      Column({ space: 8 }) {
        Text(this.loggedIn ? '👤 已登录' : '👤 未登录')
          .fontSize(64)
        Text(this.loggedIn ? '华为账号已登录' : '登录华为账号，同步订单与收藏')
          .fontSize(15)
          .fontColor('#666666')
        Button(this.loggedIn ? '退出登录' : '华为账号登录')
          .width('80%')
          .height(46)
          .backgroundColor('#E5484D')
          .onClick(() => {
            if (this.loggedIn) {
              this.loggedIn = false;
              promptAction.showToast({ message: '已退出登录' });
            } else {
              // AGC 未配置，降级提示
              promptAction.showToast({ message: '华为登录需在 AGC 配置后可用（演示环境未配置）' });
            }
          })
      }
      .width('100%')
      .padding(20)
      .backgroundColor('#F9F9F9')
      .borderRadius(12)

      // 导航入口
      Column({ space: 10 }) {
        this.navItem('🔒', '支付安全', () => router.pushUrl({ url: 'pages/PaySecurity' }))
        this.navItem('📦', '我的订单', () => promptAction.showToast({ message: '订单中心（预留）' }))
        this.navItem('⚙️', '设置', () => promptAction.showToast({ message: '设置（预留）' }))
      }
      .width('100%')
      .padding(16)
      .backgroundColor('#F9F9F9')
      .borderRadius(12)

      Blank()
    }
    .width('100%')
    .height('100%')
    .padding({ left: 12, right: 12 })
    .backgroundColor('#FFFFFF')
  }

  @Builder
  navItem(icon: string, label: string, action: () => void) {
    Row({ space: 10 }) {
      Text(icon).fontSize(22)
      Text(label).fontSize(16)
      Blank()
      Text('›').fontSize(20).fontColor('#BBBBBB')
    }
    .width('100%')
    .height(44)
    .onClick(action)
  }
}
