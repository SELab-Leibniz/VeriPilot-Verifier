import { scanBarcode, scanCore } from '@kit.ScanKit';
import { common } from '@kit.AbilityKit';
import { PermissionUtil } from './PermissionUtil';

// 扫码购：扫描花束/包装二维码，返回商品 id 字符串
export class ScanUtil {
  // 启动扫码界面（相机能力，模拟器可能不可用）
  static async scan(context: common.UIAbilityContext): Promise<string | null> {
    try {
      const granted = await PermissionUtil.request(context, ['ohos.permission.CAMERA']);
      if (!granted) {
        return null;
      }
      const options: scanBarcode.ScanOptions = {
        scanTypes: [scanCore.ScanType.ALL],
        enableMultiMode: true
      };
      const result: scanBarcode.ScanResult = await scanBarcode.startScanForResult(context, options);
      if (!result || !result.originalValue) {
        return null;
      }
      return result.originalValue;
    } catch (e) {
      return null;
    }
  }

  // 解析二维码内容为商品 id（形如 commodity:123）
  static parseCommodityId(raw: string): number | null {
    const m = /commodity:(\d+)/.exec(raw);
    if (m) {
      return Number(m[1]);
    }
    return null;
  }
}
