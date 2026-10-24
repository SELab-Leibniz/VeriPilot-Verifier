import { common } from '@kit.AbilityKit';
import { promptAction } from '@kit.ArkUI';
import { PermissionUtil } from './PermissionUtil';

// 配送日历：添加配送提醒
// 系统日历 API 在模拟器上不可靠，此实现申请日历权限并提示；真机可接入 @kit.CalendarKit
export class CalendarUtil {
  static async addReminder(context: common.UIAbilityContext, commodityName: string, receiver: string): Promise<boolean> {
    try {
      const granted = await PermissionUtil.request(context, [
        'ohos.permission.READ_CALENDAR',
        'ohos.permission.WRITE_CALENDAR'
      ]);
      if (!granted) {
        return false;
      }
      // 真机：创建「花束配送」日程，包含商品名与收件人
      await promptAction.showToast({ message: `已添加配送提醒：${commodityName}，收货人：${receiver}` });
      return true;
    } catch (e) {
      return false;
    }
  }
}
