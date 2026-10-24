import { common } from '@kit.AbilityKit';
import { PermissionUtil } from './PermissionUtil';

// 语音搜索：申请麦克风权限并返回识别文本
// 模拟器 ASR 不可靠，返回演示文本；真机可接入 @kit.CoreSpeechKit
export class VoiceUtil {
  static async search(context: common.UIAbilityContext): Promise<string | null> {
    try {
      const granted = await PermissionUtil.request(context, ['ohos.permission.MICROPHONE']);
      if (!granted) {
        return null;
      }
      // 演示：返回固定商品名，真机替换为语音识别结果
      return '红玫瑰';
    } catch (e) {
      return null;
    }
  }
}
