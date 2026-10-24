import { promptAction } from '@kit.ArkUI';
import { PaymentUtil } from '../utils/PaymentUtil';

@Entry
@Component
struct PaySecurity {
  @State pwd: string = '';
  @State confirm: string = '';
  @State hasPwd: boolean = false;

  aboutToAppear(): void {
    this.check();
  }

  async check(): Promise<void> {
    this.hasPwd = await PaymentUtil.hasPassword();
  }

  async onSet(): Promise<void> {
    if (this.pwd.length !== 6) {
      promptAction.showToast({ message: '请输入 6 位支付密码' });
      return;
    }
    if (this.pwd !== this.confirm) {
      promptAction.showToast({ message: '两次输入不一致' });
      return;
    }
    const ok = await PaymentUtil.setPassword(this.pwd);
    promptAction.showToast({ message: ok ? '支付密码设置成功（AES256-GCM 加密存储）' : '设置失败' });
    this.pwd = '';
    this.confirm = '';
    await this.check();
  }

  async onVerify(): Promise<void> {
    if (this.pwd.length !== 6) {
      promptAction.showToast({ message: '请输入 6 位支付密码' });
      return;
    }
    const ok = await PaymentUtil.verifyPassword(this.pwd);
    promptAction.showToast({ message: ok ? '密码验证通过' : '密码错误' });
    this.pwd = '';
  }

  async onClear(): Promise<void> {
    await PaymentUtil.removePassword();
    this.hasPwd = false;
    this.pwd = '';
    this.confirm = '';
    promptAction.showToast({ message: '已清除支付密码与密钥' });
  }

  async onBiometric(): Promise<void> {
    promptAction.showToast({ message: '生物认证：模拟器不支持，请在真机测试' });
  }

  build() {
    Column({ space: 14 }) {
      Text('支付安全')
        .fontSize(20)
        .fontWeight(FontWeight.Bold)
        .width('100%')
        .padding(12)

      Text(this.hasPwd ? '已设置支付密码' : '未设置支付密码')
        .fontSize(15)
        .fontColor(this.hasPwd ? Color.Green : Color.Gray)

      if (!this.hasPwd) {
        TextInput({ placeholder: '设置 6 位支付密码', text: this.pwd })
          .type(InputType.NUMBER_PASSWORD)
          .maxLength(6)
          .onChange((v: string) => this.pwd = v)
        TextInput({ placeholder: '确认 6 位支付密码', text: this.confirm })
          .type(InputType.NUMBER_PASSWORD)
          .maxLength(6)
          .onChange((v: string) => this.confirm = v)
        Button('设置密码')
          .width('100%')
          .onClick(() => this.onSet())
      } else {
        TextInput({ placeholder: '输入 6 位支付密码验证', text: this.pwd })
          .type(InputType.NUMBER_PASSWORD)
          .maxLength(6)
          .onChange((v: string) => this.pwd = v)
        Button('验证密码')
          .width('100%')
          .onClick(() => this.onVerify())
        Row({ space: 8 }) {
          Button('清除密码')
            .onClick(() => this.onClear())
          Button('生物认证')
            .onClick(() => this.onBiometric())
        }
        .width('100%')
      }

      Text('技术说明：支付密码经 Asset Store Kit 以 AES256-GCM 加密存储于安全环境，清除时同时移除加密数据与密钥。')
        .fontSize(12)
        .fontColor(Color.Gray)
        .padding(12)
    }
    .width('100%')
    .height('100%')
    .padding(12)
  }
}
