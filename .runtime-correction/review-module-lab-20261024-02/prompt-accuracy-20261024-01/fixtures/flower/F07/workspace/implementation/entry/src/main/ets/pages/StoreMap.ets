import { promptAction } from '@kit.ArkUI';
import { MOCK_STORES, StoreInfo } from '../model/Commodity';

@Entry
@Component
struct StoreMap {
  @State selected: StoreInfo | null = null;

  build() {
    Column({ space: 12 }) {
      Text('门店地图')
        .fontSize(22)
        .fontWeight(FontWeight.Bold)
        .width('100%')
        .padding(12)

      Text('（地图渲染依赖 AGC 配置，本环境以门店列表 + 经纬度呈现）')
        .fontSize(12)
        .fontColor('#888888')
        .width('100%')
        .padding({ left: 12, right: 12 })

      List({ space: 12 }) {
        ForEach(MOCK_STORES, (s: StoreInfo) => {
          ListItem() {
            Column({ space: 6 }) {
              Row() {
                Text('📍').fontSize(28)
                Text(s.name)
                  .fontSize(17)
                  .fontWeight(FontWeight.Medium)
                Blank()
                Text('查看详情 ›')
                  .fontSize(13)
                  .fontColor('#E5484D')
              }
              .width('100%')

              Text(`地址：${s.address}`)
                .fontSize(13)
                .fontColor('#666666')
              Text(`经纬度：${s.latitude.toFixed(4)}, ${s.longitude.toFixed(4)}`)
                .fontSize(13)
                .fontColor('#666666')
              Text(`电话：${s.phone}`)
                .fontSize(13)
                .fontColor('#666666')
            }
            .width('100%')
            .padding(14)
            .backgroundColor('#F9F9F9')
            .borderRadius(12)
            .onClick(() => {
              this.selected = s;
              promptAction.showDialog({
                title: s.name,
                message: `地址：${s.address}\n经纬度：${s.latitude}, ${s.longitude}\n电话：${s.phone}`,
                buttons: [{ text: '知道了', color: '#E5484D' }]
              });
            })
          }
        }, (s: StoreInfo) => `${s.id}`)
      }
      .width('100%')
      .layoutWeight(1)
      .padding({ left: 12, right: 12 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#FFFFFF')
  }
}
