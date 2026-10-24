export class Commodity {
  id: number;
  name: string;
  price: number;
  flowerLanguage: string;
  spec: string;
  color: string;
  emoji: string;

  constructor(id: number, name: string, price: number, flowerLanguage: string, spec: string, color: string, emoji: string) {
    this.id = id;
    this.name = name;
    this.price = price;
    this.flowerLanguage = flowerLanguage;
    this.spec = spec;
    this.color = color;
    this.emoji = emoji;
  }
}

export class StoreInfo {
  id: number;
  name: string;
  address: string;
  phone: string;
  latitude: number;
  longitude: number;

  constructor(id: number, name: string, address: string, phone: string, latitude: number, longitude: number) {
    this.id = id;
    this.name = name;
    this.address = address;
    this.phone = phone;
    this.latitude = latitude;
    this.longitude = longitude;
  }
}

export const MOCK_COMMODITIES: Commodity[] = [
  new Commodity(1, '红玫瑰', 99, '热烈真挚的爱', '11枝/束 含包装', '#E5484D', '🌹'),
  new Commodity(2, '白百合', 128, '纯洁庄严', '6枝/束 含包装', '#EEEEEE', '🌷'),
  new Commodity(3, '向日葵', 88, '阳光开朗', '5枝/束 含包装', '#F5A623', '🌻'),
  new Commodity(4, '康乃馨', 66, '感恩与温馨', '12枝/束 含包装', '#F78FB3', '🌸'),
  new Commodity(5, '郁金香', 108, '博爱、体贴', '10枝/束 含包装', '#FF8A65', '🌷'),
  new Commodity(6, '满天星', 58, '纯洁思念', '300g/束 含包装', '#B0BEC5', '✨')
];

export const MOCK_STORES: StoreInfo[] = [
  new StoreInfo(1, '花语轩（中心店）', '人民中路 88 号', '010-88990001', 39.9042, 116.4074),
  new StoreInfo(2, '花间集（步行街店）', '步行街 25 号', '010-88990002', 39.9050, 116.4100),
  new StoreInfo(3, '花匠铺（东门店）', '东门大街 6 号', '010-88990003', 39.9020, 116.4150)
];

export function queryCommodities(): Promise<Commodity[]> {
  return new Promise<Commodity[]>((resolve) => {
    setTimeout(() => resolve(MOCK_COMMODITIES), 300);
  });
}

export function getCommodityById(id: number): Commodity | undefined {
  return MOCK_COMMODITIES.find((c) => c.id === id);
}
