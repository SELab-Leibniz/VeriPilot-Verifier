import { common } from '@kit.AbilityKit';
import { systemShare } from '@kit.ShareKit';
import { promptAction } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';

// 分享给好友：拉起系统分享面板（ShareKit systemShare）
export class ShareUtil {
  static async share(context: common.UIAbilityContext, commodityName: string, price: number): Promise<void> {
    const content: string = `我在花店看到了「${commodityName}」，¥${price}，快来看看吧`;
    try {
      const data = new systemShare.SharedData({
        utd: 'general.text',
        content: content,
        title: commodityName,
        description: `花店商品分享：${commodityName} ¥${price}`
      });
      const controller = new systemShare.ShareController(data);
      await controller.show(context, {
        selectionMode: systemShare.SelectionMode.SINGLE
      });
    } catch (e) {
      // 分享面板拉起失败（系统无分享应用等）时降级提示
      const err = e as BusinessError;
      await promptAction.showToast({ message: `分享「${commodityName}」链接到微信/QQ` });
    }
  }
}
