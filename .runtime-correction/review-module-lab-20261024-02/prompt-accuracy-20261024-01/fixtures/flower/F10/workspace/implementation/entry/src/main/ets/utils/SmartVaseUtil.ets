import { promptAction } from '@kit.ArkUI';

// 智能花瓶：蓝牙 BLE 状态查询（模拟器不支持，降级提示）
export class SmartVaseUtil {
  static async queryStatus(): Promise<string> {
    try {
      // 真机接入 @kit.ConnectivityKit BLE 扫描花瓶设备
      await promptAction.showToast({ message: '蓝牙智能花瓶：模拟器不支持，请在真机测试' });
      return 'unsupported';
    } catch (e) {
      return 'unsupported';
    }
  }
}
