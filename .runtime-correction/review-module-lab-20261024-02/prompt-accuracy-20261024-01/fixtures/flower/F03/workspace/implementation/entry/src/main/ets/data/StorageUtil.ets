import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';

const STORE_NAME = 'flower_eshop_store';
const KEY_FAVORITES = 'favorites';
const KEY_HISTORY = 'browse_history';

export class StorageUtil {
  private static instance: StorageUtil;
  private pref: preferences.Preferences | null = null;

  private constructor() {
  }

  static getInstance(): StorageUtil {
    if (!StorageUtil.instance) {
      StorageUtil.instance = new StorageUtil();
    }
    return StorageUtil.instance;
  }

  private getPref(context: common.UIAbilityContext): preferences.Preferences {
    if (!this.pref) {
      this.pref = preferences.getPreferencesSync(context, { name: STORE_NAME });
    }
    return this.pref;
  }

  // ---- Favorites ----
  async getFavorites(context: common.UIAbilityContext): Promise<number[]> {
    return this.readNumberArray(context, KEY_FAVORITES);
  }

  async isFavorite(context: common.UIAbilityContext, id: number): Promise<boolean> {
    const list = await this.getFavorites(context);
    return list.indexOf(id) >= 0;
  }

  async toggleFavorite(context: common.UIAbilityContext, id: number): Promise<boolean> {
    const list = await this.getFavorites(context);
    const idx = list.indexOf(id);
    if (idx >= 0) {
      list.splice(idx, 1);
    } else {
      list.unshift(id);
    }
    await this.writeNumberArray(context, KEY_FAVORITES, list);
    return idx < 0;
  }

  // ---- Browse history (last 10) ----
  async getHistory(context: common.UIAbilityContext): Promise<number[]> {
    return this.readNumberArray(context, KEY_HISTORY);
  }

  async recordHistory(context: common.UIAbilityContext, id: number): Promise<void> {
    let list = await this.readNumberArray(context, KEY_HISTORY);
    const idx = list.indexOf(id);
    if (idx >= 0) {
      list.splice(idx, 1);
    }
    list.unshift(id);
    if (list.length > 10) {
      list = list.slice(0, 10);
    }
    await this.writeNumberArray(context, KEY_HISTORY, list);
  }

  // ---- Generic array storage (JSON string) ----
  private async readNumberArray(context: common.UIAbilityContext, key: string): Promise<number[]> {
    const pref = this.getPref(context);
    const raw = pref.getSync(key, '') as string;
    if (!raw) {
      return [];
    }
    try {
      const arr: number[] = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  private async writeNumberArray(context: common.UIAbilityContext, key: string, arr: number[]): Promise<void> {
    const pref = this.getPref(context);
    await pref.put(key, JSON.stringify(arr));
    await pref.flush();
  }
}
