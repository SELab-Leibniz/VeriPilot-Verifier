import { Commodity, Store } from '../model/Models';

// 本地 mock 数据：网络不可用时降级使用
export class MockData {
  static commodities(): Commodity[] {
    return [
      new Commodity(1, '红玫瑰', '热情似火，爱你永恒', '11枝/束', 99, 'app.media.startIcon'),
      new Commodity(2, '白百合', '纯洁高雅，百年好合', '10枝/束', 129, 'app.media.startIcon'),
      new Commodity(3, '向日葵', '阳光积极，爱慕忠诚', '5枝/束', 69, 'app.media.startIcon'),
      new Commodity(4, '满天星', '清纯致远，思念温柔', '整束', 49, 'app.media.startIcon'),
      new Commodity(5, '郁金香', '博爱体贴，聪颖善良', '12枝/束', 139, 'app.media.startIcon'),
      new Commodity(6, '康乃馨', '温馨祝福，母爱光辉', '10枝/束', 89, 'app.media.startIcon'),
      new Commodity(7, '紫罗兰', '永恒之美，爱的羁绊', '6枝/束', 79, 'app.media.startIcon'),
      new Commodity(8, '绣球花', '希望忠贞，圆满团聚', '单枝', 59, 'app.media.startIcon'),
    ];
  }

  static commodityById(id: number): Commodity | undefined {
    return MockData.commodities().find(c => c.id === id);
  }

  static stores(): Store[] {
    return [
      new Store(1, '花语总店', '幸福路100号', '010-88880001', 39.908, 116.397),
      new Store(2, '玫瑰花园分店', '朝阳大街88号', '010-88880002', 39.910, 116.410),
      new Store(3, '百合之恋分店', '人民广场旁', '010-88880003', 39.905, 116.391),
    ];
  }
}
