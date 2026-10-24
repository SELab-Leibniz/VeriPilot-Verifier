import { photoAccessHelper } from '@kit.MediaLibraryKit';

// 晒图评价：系统图片选择器（无需申请存储权限）
export class ImagePickerUtil {
  // 选择多张图片，返回 uri 列表
  static async pick(): Promise<string[]> {
    try {
      const picker = new photoAccessHelper.PhotoViewPicker();
      const result = await picker.select({
        MIMEType: photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE,
        maxSelectNumber: 9
      });
      return result.photoUris;
    } catch (e) {
      return [];
    }
  }
}
