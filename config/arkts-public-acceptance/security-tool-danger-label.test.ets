import { describe, expect, it } from '@ohos/hypium'
import { ActionButtonStyles, AppColors } from '../main/ets/constants/AppConstants'
import { ThemeMode } from '../main/ets/theme/ThemeColors'

export default function publicSecurityToolDangerLabelAcceptance(): void {
  describe('PublicSecurityToolDangerLabelAcceptance', () => {
    it('uses_the_danger_color_for_the_light_theme_label', 0, () => {
      const foreground = ActionButtonStyles.getDangerForeground(ThemeMode.LIGHT)
      expect(foreground).assertEqual(AppColors.DANGER)
      expect(foreground).assertEqual(ActionButtonStyles.getDangerIconColor(ThemeMode.LIGHT))
      expect(foreground === ActionButtonStyles.getPrimaryForeground(ThemeMode.LIGHT)).assertFalse()
    })

    it('keeps_the_dark_theme_label_white', 0, () => {
      expect(ActionButtonStyles.getDangerForeground(ThemeMode.DARK)).assertEqual(Color.White)
    })
  })
}
