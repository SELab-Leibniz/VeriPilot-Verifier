import { geoLocationManager } from '@kit.LocationKit';
import { common } from '@kit.AbilityKit';
import { PermissionUtil } from './PermissionUtil';

// 定位结果
export class GeoPoint {
  lat: number = 0;
  lng: number = 0;

  constructor(lat: number, lng: number) {
    this.lat = lat;
    this.lng = lng;
  }
}

// 定位：获取当前位置经纬度
export class LocationUtil {
  // 申请定位权限并获取一次定位
  static async getCurrent(context: common.UIAbilityContext): Promise<GeoPoint | null> {
    try {
      const granted = await PermissionUtil.request(context, [
        'ohos.permission.APPROXIMATELY_LOCATION',
        'ohos.permission.LOCATION'
      ]);
      if (!granted) {
        return null;
      }
      const requestInfo: geoLocationManager.LocationRequest = {
        priority: geoLocationManager.LocationRequestPriority.FIRST_FIX,
        scenario: geoLocationManager.LocationRequestScenario.UNSET,
        timeInterval: 0,
        distanceInterval: 0,
        maxAccuracy: 0
      };
      const location = await geoLocationManager.getCurrentLocation(requestInfo);
      if (!location) {
        return null;
      }
      return new GeoPoint(location.latitude, location.longitude);
    } catch (e) {
      return null;
    }
  }
}
