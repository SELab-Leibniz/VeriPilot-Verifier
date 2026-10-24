import { promptAction } from '@kit.ArkUI';
import { PaySecretUtil } from '../data/PaySecretUtil';

@Entry
@Component
struct PaySecurity {
  @State pwdSet: boolean = false;
  @State mode: number = 0; // 0 首页 1 设置 2 验证
  @State input: string = '';
  @State statusText: string = '';

  aboutToAppear(): void {
    PaySecretUtil.isSet().then((set: boolean) => {
      this.pwdSet = set;
    });
  }

  private refresh(): void {
    PaySecretUtil.isSet().then((set: boolean) => {
      this.pwdSet = set;
    });
  }

  private startSet(): void {
    this.mode = 1;
    this.input = '';
    this.statusText = '请设置 6 位支付密码';
  }

  private startVerify(): void {
    this.mode = 2;
    this.input = '';
    this.statusText = '请输入 6 位支付密码验证';
  }

  private submit(): void {
    if (this.input.length !== 6) {
      this.statusText = '请输入 6 位数字';
      return;
    }
    if (this.mode === 1) {
      PaySecretUtil.setPassword(this.input).then(() => {
        this.pwdSet = true;
        this.mode = 0;
        this.statusText = '支付密码设置成功（AES 加密存储于 Asset Store Kit）';
      }).catch(() => {
        this.statusText = '设置失败，请重试';
      });
    } else if (this.mode === 2) {
      PaySecretUtil.verifyPassword(this.input).then((ok: boolean) => {
        this.mode = 0;
        if (ok) {
          this.statusText = '验证通过 ✓';
        } else {
          this.statusText = '验证失败：密码错误';
        }
      });
    }
  }

  private clearPwd(): void {
    PaySecretUtil.clearPassword().then(() => {
      this.pwdSet = false;
      this.mode = 0;
      this.statusText = '支付密码已清除';
    });
  }

  private biometric(): void {
    promptAction.showToast({ message: '生物认证需真机支持（模拟器不可用）' });
  }

  build() {
    Column({ space: 20 }) {
      Text('支付安全')
        .fontSize(22)
        .fontWeight(FontWeight.Bold)
        .width('100%')
        .padding(12)

      Text(this.statusText || (this.pwdSet ? '已设置支付密码' : '尚未设置支付密码'))
        .fontSize(15)
        .fontColor(this.pwdSet ? '#2E9E5B' : '#888888')
        .width('100%')
        .padding({ left: 16 })

      if (this.mode !== 0) {
        TextInput({ text: this.input, placeholder: '请输入 6 位数字支付密码' })
          .type(InputType.NUMBER_PASSWORD)
          .maxLength(6)
          .fontSize(18)
          .width('90%')
          .onChange((v: string) => {
            this.input = v;
          })

        Button(this.mode === 1 ? '确认设置' : '确认验证')
          .width('90%')
          .height(46)
          .backgroundColor('#E5484D')
          .onClick(() => this.submit())
      }

      if (this.mode === 0) {
        if (this.pwdSet) {
          Button('验证支付密码')
            .width('90%')
            .height(46)
            .backgroundColor('#E5484D')
            .onClick(() => this.startVerify())
          Button('清除支付密码')
            .width('90%')
            .height(46)
            .backgroundColor('#EEEEEE')
            .fontColor('#333333')
            .onClick(() => this.clearPwd())
        } else {
          Button('设置支付密码')
            .width('90%')
            .height(46)
            .backgroundColor('#E5484D')
            .onClick(() => this.startSet())
        }

        Button('生物认证（指纹/人脸）')
          .width('90%')
          .height(46)
          .backgroundColor('#FFFFFF')
          .fontColor('#333333')
          .border({ width: 1, color: '#DDDDDD' })
          .onClick(() => this.biometric())
      }

      Blank()

      Text('密码经 AES 加密，密钥与密文安全存储于 Asset Store Kit')
        .fontSize(12)
        .fontColor('#AAAAAA')
        .padding(12)
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#FFFFFF')
  }
}
