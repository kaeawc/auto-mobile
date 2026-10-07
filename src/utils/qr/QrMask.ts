/**
 * Data-mask patterns and mask penalty scoring (ISO/IEC 18004 section 7.8).
 * Matrices are row-major: `matrix[row][column]`, `true` = dark module.
 */

export type QrMatrix = boolean[][];

export const QR_MASK_COUNT = 8;

type MaskCondition = (row: number, column: number) => boolean;

/** ISO/IEC 18004 Table 10 mask conditions; i = row, j = column. */
const MASK_CONDITIONS: readonly MaskCondition[] = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (_i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];

export function qrMaskApplies(mask: number, row: number, column: number): boolean {
  return MASK_CONDITIONS[mask](row, column);
}

/** Penalty weights N1-N4 from ISO/IEC 18004 section 7.8.3.1. */
const N1 = 3;
const N2 = 3;
const N3 = 40;
const N4 = 10;

/** Per-rule penalty breakdown. */
export interface QrPenalty {
  adjacent: number;
  blocks: number;
  finderLike: number;
  balance: number;
  total: number;
}

function columnsOf(matrix: QrMatrix): boolean[][] {
  return matrix[0].map((_cell, column) => matrix.map((row) => row[column]));
}

/** Rule 1: each run of 5+ same-colour modules scores N1 + (length - 5). */
function lineRunPenalty(line: readonly boolean[]): number {
  let penalty = 0;
  let runLength = 1;
  for (let i = 1; i <= line.length; i++) {
    if (i < line.length && line[i] === line[i - 1]) {
      runLength++;
      continue;
    }
    if (runLength >= 5) {
      penalty += N1 + (runLength - 5);
    }
    runLength = 1;
  }
  return penalty;
}

/** Rule 2: each 2x2 block of one colour scores N2 (overlapping blocks all count). */
function blockPenalty(matrix: QrMatrix): number {
  let count = 0;
  for (let row = 0; row < matrix.length - 1; row++) {
    for (let column = 0; column < matrix.length - 1; column++) {
      const colour = matrix[row][column];
      const same =
        matrix[row][column + 1] === colour &&
        matrix[row + 1][column] === colour &&
        matrix[row + 1][column + 1] === colour;
      count += same ? 1 : 0;
    }
  }
  return count * N2;
}

const FINDER_LIKE_PATTERNS: readonly string[] = ["10111010000", "00001011101"];

/** Rule 3: each 1:1:3:1:1 pattern with four light modules on one side scores N3. */
function lineFinderPenalty(line: readonly boolean[]): number {
  const bits = line.map((dark) => (dark ? "1" : "0")).join("");
  let count = 0;
  for (const pattern of FINDER_LIKE_PATTERNS) {
    for (
      let index = bits.indexOf(pattern);
      index !== -1;
      index = bits.indexOf(pattern, index + 1)
    ) {
      count++;
    }
  }
  return count * N3;
}

/** Rule 4: N4 for every 5% the dark proportion deviates from 50%. */
function balancePenalty(matrix: QrMatrix): number {
  const total = matrix.length * matrix.length;
  const dark = matrix.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  // |dark/total*100 - 50| / 5, kept in integers.
  const steps = Math.floor(Math.abs(20 * dark - 10 * total) / total);
  return steps * N4;
}

/** Score a fully-formed (masked, format-filled) symbol. Lower is better. */
export function qrMaskPenalty(matrix: QrMatrix): QrPenalty {
  const lines = [...matrix, ...columnsOf(matrix)];
  const adjacent = lines.reduce((sum, line) => sum + lineRunPenalty(line), 0);
  const finderLike = lines.reduce((sum, line) => sum + lineFinderPenalty(line), 0);
  const blocks = blockPenalty(matrix);
  const balance = balancePenalty(matrix);
  return { adjacent, blocks, finderLike, balance, total: adjacent + blocks + finderLike + balance };
}
