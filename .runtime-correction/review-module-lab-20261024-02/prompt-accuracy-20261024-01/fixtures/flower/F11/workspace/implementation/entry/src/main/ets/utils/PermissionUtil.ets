import { abilityAccessCtrl, common, Permissions } from '@kit.AbilityKit';
import { notificationManager } from '@kit.NotificationKit';

export class PermissionUtil {
  // 动态申请普通权限（位置/麦克风/日历等）
  static async request(context: common.UIAbilityContext, perms: Array<Permissions>): Promise<boolean> {
    try {
      const atManager = abilityAccessCtrl.createAtManager();
      const res = await atManager.requestPermissionsFromUser(context, perms);
      if (!res || !res.authResults) {
        return false;
      }
      return res.authResults.every((r: number) => r === 0);
    } catch (e) {
      return false;
    }
  }

  // 动态申请通知权限（系统提供 requestEnableNotification）
  static async requestNotification(context: common.UIAbilityContext): Promise<boolean> {
    try {
      await notificationManager.requestEnableNotification(context);
      return true;
    } catch (e) {
      return false;
    }
  }
}
