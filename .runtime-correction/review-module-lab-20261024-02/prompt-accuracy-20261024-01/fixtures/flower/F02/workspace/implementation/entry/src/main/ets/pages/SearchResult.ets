import { router, promptAction } from '@kit.ArkUI';
import { MOCK_COMMODITIES, Commodity } from '../model/Commodity';

// 语音搜索结果页：真实语音识别依赖语音服务，本环境以关键词输入模拟语音搜索。
@Entry
@Component
struct SearchResult {
  @State keyword: string = '';
  @State results: Commodity[] = [];

  aboutToAppear(): void {
    const params = router.getParams() as Record<string, string>;
    this.keyword = params['keyword'] || '';
    this.search(this.keyword);
  }

  private search(kw: string): void {
    const k = kw.trim();
    const list: Commodity[] = MOCK_COMMODITIES.filter((c) => !k || c.name.indexOf(k) >= 0);
    this.results = list;
    if (list.length === 0) {
      promptAction.showToast({ message: '未找到相关商品' });
    }
  }

  build() {
    Column({ space: 12 }) {
      Row({ space: 8 }) {
        Text('🎤')
          .fontSize(20)
        TextInput({ text: this.keyword, placeholder: '语音识别到的关键词' })
          .fontSize(16)
          .layoutWeight(1)
          .onChange((v: string) => {
            this.keyword = v;
          })
        Button('搜索')
          .fontSize(14)
          .backgroundColor('#E5484D')
          .onClick(() => this.search(this.keyword))
      }
      .width('100%')
      .padding(12)

      Text(`搜索结果：${this.results.length} 个`)
        .fontSize(13)
        .fontColor('#888888')
        .width('100%')
        .padding({ left: 12 })

      List({ space: 12 }) {
        ForEach(this.results, (c: Commodity) => {
          ListItem() {
            Row({ space: 12 }) {
              Text(c.emoji)
                .fontSize(44)
                .width(64)
                .height(64)
                .textAlign(TextAlign.Center)
                .backgroundColor('#FFF7EE')
                .borderRadius(8)
              Column({ space: 4 }) {
                Text(c.name).fontSize(17).fontWeight(FontWeight.Medium)
                Text(`¥${c.price}`).fontSize(16).fontColor('#E5484D')
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)
            }
            .width('100%')
            .padding(12)
            .backgroundColor('#F9F9F9')
            .borderRadius(12)
            .onClick(() => router.pushUrl({ url: 'pages/CommodityDetail', params: { id: c.id } }))
          }
        }, (c: Commodity) => `${c.id}`)
      }
      .width('100%')
      .layoutWeight(1)
      .padding({ left: 12, right: 12 })

      Blank()
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#FFFFFF')
  }
}
