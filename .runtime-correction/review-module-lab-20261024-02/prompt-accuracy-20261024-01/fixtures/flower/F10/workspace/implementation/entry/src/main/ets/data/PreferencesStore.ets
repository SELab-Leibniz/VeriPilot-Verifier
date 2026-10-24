import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';

// 收藏 + 浏览历史持久化（Preferences）
export class PreferencesStore {
  private static pref: preferences.Preferences | undefined;
  private static readonly FAV_KEY = 'favorites';
  private static readonly HIS_KEY = 'browse_history';
  private static readonly MAX_HISTORY = 10;

  private static async ensure(context: common.UIAbilityContext): Promise<preferences.Preferences> {
    if (!PreferencesStore.pref) {
      PreferencesStore.pref = await preferences.getPreferences(context, 'flower_store');
    }
    return PreferencesStore.pref;
  }

  static async getFavorites(context: common.UIAbilityContext): Promise<number[]> {
    try {
      const pref = await PreferencesStore.ensure(context);
      const raw = pref.getSync(PreferencesStore.FAV_KEY, '[]') as string;
      return JSON.parse(raw) as number[];
    } catch (e) {
      return [];
    }
  }

  static async setFavorite(context: common.UIAbilityContext, id: number, fav: boolean): Promise<void> {
    try {
      const pref = await PreferencesStore.ensure(context);
      const list = await PreferencesStore.getFavorites(context);
      const idx = list.indexOf(id);
      if (fav && idx < 0) {
        list.push(id);
      }
      if (!fav && idx >= 0) {
        list.splice(idx, 1);
      }
      pref.putSync(PreferencesStore.FAV_KEY, JSON.stringify(list));
      await pref.flush();
    } catch (e) {
    }
  }

  static async getHistory(context: common.UIAbilityContext): Promise<number[]> {
    try {
      const pref = await PreferencesStore.ensure(context);
      const raw = pref.getSync(PreferencesStore.HIS_KEY, '[]') as string;
      return JSON.parse(raw) as number[];
    } catch (e) {
      return [];
    }
  }

  // 记录浏览：去重后置顶，最多保留最近 10 条
  static async recordBrowse(context: common.UIAbilityContext, id: number): Promise<void> {
    try {
      const pref = await PreferencesStore.ensure(context);
      const list = await PreferencesStore.getHistory(context);
      const idx = list.indexOf(id);
      if (idx >= 0) {
        list.splice(idx, 1);
      }
      list.unshift(id);
      const trimmed = list.slice(0, PreferencesStore.MAX_HISTORY);
      pref.putSync(PreferencesStore.HIS_KEY, JSON.stringify(trimmed));
      await pref.flush();
    } catch (e) {
    }
  }
}
