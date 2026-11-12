import { afterEach, describe, expect, it } from '@ohos/hypium'
import { createDiagonalConfig, createStandardConfig } from '../main/ets/models/VariantConfig'
import { createEmptyGrid, isValidPlacement } from '../main/ets/utils/Common'
import { applyTopology } from '../main/ets/utils/Topology'

// Exercise the public placement predicate under the same active topology as puzzle generation.
export default function publicSudokuPlacementContract(): void {
  describe('RCPublicSudokuPlacementContract', () => {
    afterEach(() => { applyTopology(createStandardConfig()) })

    it('standard topology permits equal digits in unrelated diagonal cells', 0, () => {
      applyTopology(createStandardConfig())
      const board = createEmptyGrid()
      board[1][1] = 4
      board[2][6] = 7
      expect(isValidPlacement(board, 6, 6, 4)).assertTrue()
      expect(isValidPlacement(board, 7, 1, 7)).assertTrue()
    })

    it('active Sudoku-X topology rejects a main-diagonal duplicate', 0, () => {
      applyTopology(createDiagonalConfig())
      const board = createEmptyGrid()
      board[1][1] = 4
      expect(isValidPlacement(board, 6, 6, 4)).assertFalse()
    })

    it('active Sudoku-X topology rejects an anti-diagonal duplicate', 0, () => {
      applyTopology(createDiagonalConfig())
      const board = createEmptyGrid()
      board[2][6] = 7
      expect(isValidPlacement(board, 7, 1, 7)).assertFalse()
    })

    it('active Sudoku-X topology allows an unrelated placement', 0, () => {
      applyTopology(createDiagonalConfig())
      const board = createEmptyGrid()
      board[1][1] = 4
      expect(isValidPlacement(board, 6, 7, 4)).assertTrue()
    })
  })
}
