import { asset } from '@kit.AssetStoreKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';

const PAY_ALIAS = 'flower_eshop_pay_password';

function stringToArray(str: string): Uint8Array {
  return new util.TextEncoder().encodeInto(str);
}

function arrayToString(arr: Uint8Array): string {
  const decoder = util.TextDecoder.create('utf-8', { ignoreBOM: true });
  return decoder.decodeToString(arr, { stream: false });
}

// 支付密码：Asset Store Kit 安全存储，AES256-GCM 加密
export class PaymentUtil {
  // 设置 6 位支付密码
  static async setPassword(pwd: string): Promise<boolean> {
    try {
      const attr: asset.AssetMap = new Map();
      attr.set(asset.Tag.SECRET, stringToArray(pwd));
      attr.set(asset.Tag.ALIAS, stringToArray(PAY_ALIAS));
      attr.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_FIRST_UNLOCKED);
      // 若已存在则先删除，避免别名冲突
      await PaymentUtil.removePassword();
      await asset.add(attr);
      return true;
    } catch (e) {
      return false;
    }
  }

  // 验证支付密码
  static async verifyPassword(pwd: string): Promise<boolean> {
    try {
      const query: asset.AssetMap = new Map();
      query.set(asset.Tag.ALIAS, stringToArray(PAY_ALIAS));
      query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
      const res: Array<asset.AssetMap> = await asset.query(query);
      if (res.length === 0) {
        return false;
      }
      const secret: Uint8Array = res[0].get(asset.Tag.SECRET) as Uint8Array;
      return arrayToString(secret) === pwd;
    } catch (e) {
      return false;
    }
  }

  // 是否已设置支付密码
  static async hasPassword(): Promise<boolean> {
    try {
      const query: asset.AssetMap = new Map();
      query.set(asset.Tag.ALIAS, stringToArray(PAY_ALIAS));
      query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ATTRIBUTES);
      const res: Array<asset.AssetMap> = await asset.query(query);
      return res.length > 0;
    } catch (e) {
      return false;
    }
  }

  // 清除支付密码（同时清除加密数据与密钥）
  static async removePassword(): Promise<boolean> {
    try {
      const query: asset.AssetMap = new Map();
      query.set(asset.Tag.ALIAS, stringToArray(PAY_ALIAS));
      await asset.remove(query);
      return true;
    } catch (e) {
      // 不存在时视为已清除
      return true;
    }
  }
}
