import { describe, expect, it } from '@ohos/hypium'
import { applyGridConfig, Difficulty } from '../main/ets/constants/GameConstants'
import { createDiagonalConfig, createStandardConfig, VariantConfig } from '../main/ets/models/VariantConfig'
import { decodeSeedId, GeneratedPuzzle, generatePuzzle, generatePuzzleFromSeed, Symmetry } from '../main/ets/utils/SudokuGenerator'
import { applyTopology } from '../main/ets/utils/Topology'

const size = 9
const allDigits = 0x3fe
// Recorded from the public task-start commit for the documented seed-sharing format.
const standardSeedOne = [
  '076051320', '320600091', '000037006',
  '034012800', '007060400', '009340170',
  '900420000', '140006038', '068190240',
].join('')

function selectMode(config: VariantConfig): void {
  applyGridConfig(config.grid)
  applyTopology(config)
}

function availableDigits(board: number[][], row: number, col: number, diagonal: boolean): number {
  let used = 0
  const boxRow = Math.floor(row / 3) * 3
  const boxCol = Math.floor(col / 3) * 3
  for (let i = 0; i < size; i++) {
    used |= 1 << board[row][i]
    used |= 1 << board[i][col]
    used |= 1 << board[boxRow + Math.floor(i / 3)][boxCol + i % 3]
    if (diagonal && row === col) used |= 1 << board[i][i]
    if (diagonal && row + col === size - 1) used |= 1 << board[i][size - 1 - i]
  }
  return allDigits & ~used
}

class SolutionCounter {
  private remainingVisits = 100000

  count(board: number[][], diagonal: boolean, limit: number): number {
    if (--this.remainingVisits <= 0) throw new Error('Independent Sudoku search limit reached')
    let bestRow = -1
    let bestCol = -1
    let bestMask = 0
    let bestCount = size + 1
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (board[row][col] !== 0) continue
        const mask = availableDigits(board, row, col, diagonal)
        if (mask === 0) return 0
        let count = 0
        for (let bits = mask; bits !== 0; bits &= bits - 1) count++
        if (count < bestCount) {
          bestRow = row
          bestCol = col
          bestMask = mask
          bestCount = count
        }
      }
    }
    if (bestRow === -1) return 1

    let found = 0
    for (let digit = 1; digit <= size && found < limit; digit++) {
      if ((bestMask & (1 << digit)) === 0) continue
      board[bestRow][bestCol] = digit
      found += this.count(board, diagonal, limit - found)
    }
    board[bestRow][bestCol] = 0
    return found
  }
}

function assertValidSolution(solution: number[][], diagonal: boolean): void {
  expect(solution.length).assertEqual(size)
  const checked: number[][] = []
  for (let row = 0; row < size; row++) {
    expect(solution[row].length).assertEqual(size)
    checked.push(new Array<number>(size).fill(0))
  }
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const digit = solution[row][col]
      expect(Number.isInteger(digit) && digit >= 1 && digit <= size).assertTrue()
      expect((availableDigits(checked, row, col, diagonal) & (1 << digit)) !== 0).assertTrue()
      checked[row][col] = digit
    }
  }
}

function assertHolesAndUnique(result: GeneratedPuzzle, diagonal: boolean): void {
  expect(result.solution.length).assertEqual(size)
  expect(result.puzzle.length).assertEqual(size)
  const givens: number[][] = []
  for (let row = 0; row < size; row++) {
    expect(result.solution[row].length).assertEqual(size)
    expect(result.puzzle[row].length).assertEqual(size)
    givens.push(new Array<number>(size).fill(0))
  }
  let holes = 0
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const given = result.puzzle[row][col]
      expect(Number.isInteger(given) && given >= 0 && given <= size).assertTrue()
      if (given === 0) holes++
      else {
        expect(given).assertEqual(result.solution[row][col])
        expect((availableDigits(givens, row, col, diagonal) & (1 << given)) !== 0).assertTrue()
        givens[row][col] = given
      }
    }
  }
  expect(holes > 0).assertTrue()
  expect(new SolutionCounter().count(givens, diagonal, 2)).assertEqual(1)
}

function lazyDiagonalPuzzle(generate: () => GeneratedPuzzle): () => GeneratedPuzzle {
  let result: GeneratedPuzzle | null = null
  return (): GeneratedPuzzle => {
    if (result !== null) return result
    selectMode(createDiagonalConfig())
    try {
      const generated = generate()
      result = generated
      return generated
    } finally {
      selectMode(createStandardConfig())
    }
  }
}

export default function publicSudokuVariantAcceptance(): void {
  describe('PublicSudokuVariantAcceptance', () => {
    // Each pair observes one result, and an isolated test can generate it on demand.
    const seeded = lazyDiagonalPuzzle(() => generatePuzzleFromSeed(1, Difficulty.EASY, Symmetry.ROTATIONAL_180))
    const normal = lazyDiagonalPuzzle(() => generatePuzzle(Difficulty.EASY, Symmetry.ROTATIONAL_180))
    it('generates_valid_sudoku_x_diagonals_through_configured_mode', 0, () => {
      assertValidSolution(seeded().solution, true)
    })
    it('generates_valid_sudoku_x_diagonals_through_normal_generation', 0, () => {
      assertValidSolution(normal().solution, true)
    })
    it('generates_sudoku_x_with_empty_cells_and_unique_solution_through_configured_mode', 0, () => {
      assertHolesAndUnique(seeded(), true)
    })
    it('generates_sudoku_x_with_empty_cells_and_unique_solution_through_normal_generation', 0, () => {
      assertHolesAndUnique(normal(), true)
    })
    it('preserves_playable_standard_sudoku', 0, () => {
      selectMode(createStandardConfig())
      const result = generatePuzzleFromSeed(1, Difficulty.EASY, Symmetry.ROTATIONAL_180)
      assertValidSolution(result.solution, false)
      assertHolesAndUnique(result, false)
    })
    it('preserves_existing_standard_seed_links', 0, () => {
      selectMode(createStandardConfig())
      const decoded = decodeSeedId('1:rot180:1')
      expect(decoded !== null).assertTrue()
      if (decoded === null) return
      const replay = generatePuzzleFromSeed(decoded.seed, decoded.difficulty, decoded.symmetry)
      expect(replay.puzzle.map((row: number[]) => row.join('')).join('')).assertEqual(standardSeedOne)
    })
  })
}
