import { promptAction } from '@kit.ArkUI';
import { Store } from '../model/Models';
import { MockData } from '../data/MockData';

@Entry
@Component
struct StoreMap {
  @State stores: Store[] = MockData.stores();
  @State selected: Store | null = null;

  @Builder
  StoreItem(store: Store) {
    Column({ space: 6 }) {
      Text(store.name)
        .fontSize(16)
        .fontWeight(FontWeight.Medium)
        .width('100%')
      Text(`地址：${store.address}`)
        .fontSize(13)
        .fontColor(Color.Gray)
        .width('100%')
      Text(`电话：${store.phone}`)
        .fontSize(13)
        .fontColor(Color.Gray)
        .width('100%')
      Row({ space: 8 }) {
        Button('查看信息')
          .fontSize(13)
          .onClick(() => {
            this.selected = store;
            promptAction.showToast({ message: `${store.name}｜${store.address}｜${store.phone}` });
          })
        Button('导航')
          .fontSize(13)
          .onClick(() => promptAction.showToast({ message: '导航功能预留（真机可接入华为地图）' }))
      }
    }
    .width('100%')
    .padding(12)
    .backgroundColor(Color.White)
    .borderRadius(8)
    .margin({ bottom: 10 })
  }

  build() {
    Column({ space: 12 }) {
      Text('附近门店地图')
        .fontSize(20)
        .fontWeight(FontWeight.Bold)
        .width('100%')
        .padding(12)
      // 地图占位：AGC 未配置时显示占位，标注列表兜底
      Column() {
        Text('📍 门店地图（需 AGC 开通 Map 服务）')
          .fontSize(14)
          .fontColor(Color.Gray)
        Text(this.selected ? `${this.selected.name}` : '点击门店查看信息')
          .fontSize(13)
          .fontColor(Color.Gray)
          .margin({ top: 8 })
      }
      .width('100%')
      .height(160)
      .justifyContent(FlexAlign.Center)
      .backgroundColor('#EEEEEE')
      .borderRadius(8)

      List() {
        ForEach(this.stores, (store: Store) => {
          ListItem() {
            this.StoreItem(store)
          }
        }, (store: Store) => store.id.toString())
      }
      .layoutWeight(1)
    }
    .width('100%')
    .height('100%')
    .padding(12)
  }
}
