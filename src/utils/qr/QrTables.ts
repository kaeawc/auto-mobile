/**
 * Static QR Code tables (ISO/IEC 18004:2015) for the versions this encoder
 * supports. Values are transcribed from the standard's Table 9 (error
 * correction characteristics) and Annex E (alignment pattern positions).
 */

export type QrErrorCorrectionLevel = "L" | "M" | "Q" | "H";

export const QR_MIN_VERSION = 1;
export const QR_MAX_VERSION = 10;

/** One error-correction block layout: `count` blocks of `dataCodewords` each. */
export interface QrBlockGroup {
  count: number;
  dataCodewords: number;
}

/** Error-correction layout for one (version, level) pair. */
export interface QrBlockLayout {
  ecCodewordsPerBlock: number;
  groups: QrBlockGroup[];
}

type LayoutRow = [ec: number, g1Count: number, g1Data: number, g2Count?: number, g2Data?: number];

/** ISO/IEC 18004 Table 9, versions 1-10. */
const BLOCK_TABLE: Record<number, Record<QrErrorCorrectionLevel, LayoutRow>> = {
  1: { L: [7, 1, 19], M: [10, 1, 16], Q: [13, 1, 13], H: [17, 1, 9] },
  2: { L: [10, 1, 34], M: [16, 1, 28], Q: [22, 1, 22], H: [28, 1, 16] },
  3: { L: [15, 1, 55], M: [26, 1, 44], Q: [18, 2, 17], H: [22, 2, 13] },
  4: { L: [20, 1, 80], M: [18, 2, 32], Q: [26, 2, 24], H: [16, 4, 9] },
  5: { L: [26, 1, 108], M: [24, 2, 43], Q: [18, 2, 15, 2, 16], H: [22, 2, 11, 2, 12] },
  6: { L: [18, 2, 68], M: [16, 4, 27], Q: [24, 4, 19], H: [28, 4, 15] },
  7: { L: [20, 2, 78], M: [18, 4, 31], Q: [18, 2, 14, 4, 15], H: [26, 4, 13, 1, 14] },
  8: { L: [24, 2, 97], M: [22, 2, 38, 2, 39], Q: [22, 4, 18, 2, 19], H: [26, 4, 14, 2, 15] },
  9: { L: [30, 2, 116], M: [22, 3, 36, 2, 37], Q: [20, 4, 16, 4, 17], H: [24, 4, 12, 4, 13] },
  10: {
    L: [18, 2, 68, 2, 69],
    M: [26, 4, 43, 1, 44],
    Q: [24, 6, 19, 2, 20],
    H: [28, 6, 15, 2, 16],
  },
};

/** ISO/IEC 18004 Annex E row/column centres of alignment patterns. */
const ALIGNMENT_CENTRES: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

/** Two-bit error-correction indicator used in the format information. */
export const EC_LEVEL_BITS: Record<QrErrorCorrectionLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

export function qrBlockLayout(version: number, level: QrErrorCorrectionLevel): QrBlockLayout {
  const [ec, g1Count, g1Data, g2Count, g2Data] = BLOCK_TABLE[version][level];
  const groups: QrBlockGroup[] = [{ count: g1Count, dataCodewords: g1Data }];
  if (g2Count !== undefined && g2Data !== undefined) {
    groups.push({ count: g2Count, dataCodewords: g2Data });
  }
  return { ecCodewordsPerBlock: ec, groups };
}

export function qrDataCodewordCount(version: number, level: QrErrorCorrectionLevel): number {
  return qrBlockLayout(version, level).groups.reduce(
    (sum, group) => sum + group.count * group.dataCodewords,
    0,
  );
}

export function qrTotalCodewordCount(version: number, level: QrErrorCorrectionLevel): number {
  const layout = qrBlockLayout(version, level);
  const blocks = layout.groups.reduce((sum, group) => sum + group.count, 0);
  return qrDataCodewordCount(version, level) + blocks * layout.ecCodewordsPerBlock;
}

export function qrAlignmentCentres(version: number): number[] {
  return ALIGNMENT_CENTRES[version];
}

export function qrSymbolSize(version: number): number {
  return 17 + 4 * version;
}

/** Character-count indicator width for byte mode (8 bits for 1-9, 16 for 10-26). */
export function qrByteModeCountBits(version: number): number {
  return version < 10 ? 8 : 16;
}

/** Maximum payload bytes that fit in byte mode at this version and level. */
export function qrByteCapacity(version: number, level: QrErrorCorrectionLevel): number {
  const dataBits = qrDataCodewordCount(version, level) * 8;
  return Math.floor((dataBits - 4 - qrByteModeCountBits(version)) / 8);
}
