import { describe, expect, it } from '@ohos/hypium'
import { letterMetricsForLength } from '../main/ets/services/LetterMetrics'

function assertCellAndFontSizes(lengths: number[], width: number, height: number,
  filled: number, placeholder: number): void {
  for (const length of lengths) {
    const metrics = letterMetricsForLength(length)
    expect(metrics.width).assertEqual(width)
    expect(metrics.height).assertEqual(height)
    expect(metrics.fontFilled).assertEqual(filled)
    expect(metrics.fontPlaceholder).assertEqual(placeholder)
  }
}

export default function publicHappyWordLetterGapAcceptance(): void {
  describe('PublicHappyWordLetterGapAcceptance', () => {
    it('uses_compact_gaps_for_each_word_length_bucket', 0, () => {
      const lengths: number[] = [1, 6, 7, 9, 10, 11, 12, 13, 20]
      const gaps: number[] = [4, 4, 3, 3, 2, 2, 2, 2, 2]
      for (let i = 0; i < lengths.length; i++) {
        expect(letterMetricsForLength(lengths[i]).gap).assertEqual(gaps[i])
      }
    })

    it('preserves_letter_cell_and_font_sizes', 0, () => {
      assertCellAndFontSizes([1, 6], 36, 48, 32, 28)
      assertCellAndFontSizes([7, 9], 30, 42, 26, 24)
      assertCellAndFontSizes([10, 11, 12], 24, 36, 22, 20)
      assertCellAndFontSizes([13, 20], 20, 32, 18, 16)
    })

    it('fits_eleven_letter_word_within_question_width', 0, () => {
      const elevenLetters = letterMetricsForLength(11)
      expect(11 * elevenLetters.width + 10 * elevenLetters.gap < 380).assertTrue()
    })
  })
}
