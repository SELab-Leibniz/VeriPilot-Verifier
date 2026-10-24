import { http } from '@kit.NetworkKit';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { Commodity } from '../model/Models';
import { MockData } from './MockData';

// 商品仓库：优先网络，失败降级本地 mock
export class CommodityRepository {
  private baseUrl: string = 'http://127.0.0.1:8080/api';

  async fetchList(context: common.UIAbilityContext): Promise<Commodity[]> {
    try {
      const list = await this.request('/commodities');
      if (Array.isArray(list) && list.length > 0) {
        return list.map((it: Record<string, Object>) => this.toCommodity(it));
      }
      return MockData.commodities();
    } catch (e) {
      return MockData.commodities();
    }
  }

  async fetchDetail(context: common.UIAbilityContext, id: number): Promise<Commodity> {
    try {
      const it = await this.request(`/commodities/${id}`);
      if (it) {
        return this.toCommodity(it as Record<string, Object>);
      }
      return this.localDetailFallback(id);
    } catch (e) {
      return this.localDetailFallback(id);
    }
  }

  private localDetailFallback(id: number): Commodity {
    const existing = MockData.commodityById(id);
    if (existing) {
      return existing;
    }
    const sample = MockData.commodities()[0];
    return new Commodity(id, sample.name, sample.flowerLanguage,
      sample.spec, sample.price, sample.imageUrl);
  }

  private async request(path: string): Promise<Record<string, Object> | Record<string, Object>[]> {
    return new Promise<Record<string, Object> | Record<string, Object>[]>((resolve, reject) => {
      const httpRequest = http.createHttp();
      httpRequest.request(
        `${this.baseUrl}${path}`,
        { method: http.RequestMethod.GET, connectTimeout: 3000, readTimeout: 3000 },
        (err: BusinessError, data: http.HttpResponse) => {
          httpRequest.destroy();
          if (err) {
            reject(err);
            return;
          }
          try {
            if (data.responseCode === 200) {
              const body: Record<string, Object> | Record<string, Object>[] =
                JSON.parse(data.result as string) as Record<string, Object> | Record<string, Object>[];
              resolve(body);
            } else {
              reject(new Error(`HTTP ${data.responseCode}`));
            }
          } catch (e) {
            reject(e);
          }
        });
    });
  }

  private toCommodity(it: Record<string, Object>): Commodity {
    return new Commodity(
      Number(it['id']),
      String(it['name']),
      String(it['flowerLanguage'] ?? ''),
      String(it['spec'] ?? ''),
      Number(it['price']),
      String(it['imageUrl'] ?? 'app.media.startIcon')
    );
  }
}
