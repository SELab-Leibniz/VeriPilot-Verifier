import { notificationManager } from '@kit.NotificationKit';
import { common } from '@kit.AbilityKit';
import { PermissionUtil } from './PermissionUtil';

// 订单确认通知
export class NotificationUtil {
  // 购买成功后发布订单确认通知；需先申请通知权限
  // 内容含商品名+订单号；通知 ID 由系统管理（不手写 id）
  static async sendOrder(context: common.UIAbilityContext, commodityName: string): Promise<boolean> {
    try {
      const granted = await PermissionUtil.requestNotification(context);
      if (!granted) {
        return false;
      }
      const orderNo = `FS${Date.now()}`;
      const request: notificationManager.NotificationRequest = {
        content: {
          notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
          normal: {
            title: '订单确认',
            text: `${commodityName} 已下单成功，感谢您的购买！`,
            additionalText: `订单号：${orderNo}`
          }
        }
      };
      await notificationManager.publish(request);
      return true;
    } catch (e) {
      return false;
    }
  }
}
