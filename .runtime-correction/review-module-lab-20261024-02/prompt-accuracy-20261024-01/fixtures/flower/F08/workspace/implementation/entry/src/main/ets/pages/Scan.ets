import { router, promptAction } from '@kit.ArkUI';

// 扫码页：真实扫码依赖摄像头与识别服务，本环境以「输入商品码/名称」模拟扫码交互。
@Entry
@Component
struct Scan {
  @State input: string = '';

  private doScan(): void {
    const keyword = this.input.trim();
    if (!keyword) {
      promptAction.showToast({ message: '请输入商品名称或扫码内容' });
      return;
    }
    // 解析扫码内容：支持「commodity:1」或直接商品名称
    let id = 0;
    const m = keyword.match(/commodity:(\d+)/);
    if (m) {
      id = Number(m[1]);
    }
    if (id > 0) {
      router.pushUrl({ url: 'pages/CommodityDetail', params: { id: id } });
    } else {
      router.pushUrl({ url: 'pages/SearchResult', params: { keyword: keyword } });
    }
  }

  build() {
    Column({ space: 20 }) {
      Text('扫一扫')
        .fontSize(22)
        .fontWeight(FontWeight.Bold)
        .width('100%')
        .padding(12)

      Text('📷')
        .fontSize(100)
        .backgroundColor('#F9F9F9')
        .width(200)
        .height(200)
        .textAlign(TextAlign.Center)
        .borderRadius(16)

      Text('真实扫码需摄像头支持，模拟器请输入商品码或名称')
        .fontSize(13)
        .fontColor('#888888')

      TextInput({ text: this.input, placeholder: '输入如 commodity:1 或 红玫瑰' })
        .fontSize(16)
        .width('90%')
        .onChange((v: string) => {
          this.input = v;
        })

      Button('识别')
        .width('90%')
        .height(48)
        .backgroundColor('#E5484D')
        .onClick(() => this.doScan())

      Blank()
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#FFFFFF')
  }
}
