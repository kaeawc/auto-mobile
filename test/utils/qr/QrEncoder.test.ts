import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  buildQrCodewords,
  encodeQr,
  encodeQrDataCodewords,
  encodeQrSymbol,
  qrFormatBits,
  qrVersionBits,
  selectQrVersion,
  type QrMatrix,
} from "../../../src/utils/qr/QrEncoder";
import { qrMaskPenalty } from "../../../src/utils/qr/QrMask";
import { rsComputeRemainder } from "../../../src/utils/qr/ReedSolomon";
import {
  QR_MAX_VERSION,
  qrByteCapacity,
  qrTotalCodewordCount,
  type QrErrorCorrectionLevel,
} from "../../../src/utils/qr/QrTables";

const LEVELS: QrErrorCorrectionLevel[] = ["L", "M", "Q", "H"];

function toRows(matrix: QrMatrix): string[] {
  return matrix.map((row) => row.map((dark) => (dark ? "#" : ".")).join(""));
}

function sha256Rows(matrix: QrMatrix): string {
  return createHash("sha256").update(toRows(matrix).join("\n")).digest("hex");
}

function bitString(value: number, length: number): string {
  return value.toString(2).padStart(length, "0");
}

/**
 * Thonky QR Code Tutorial, "Structure Final Message" worked example (5-Q, byte
 * mode): https://www.thonky.com/qr-code-tutorial/structure-final-message
 * The payload is decoded from that page's data codewords (the backslash is
 * part of the published message).
 */
const THONKY_5Q_PAYLOAD = "There\\'s a frood who really knows where his towel is.";
const THONKY_5Q_DATA = [
  67, 85, 70, 134, 87, 38, 85, 194, 119, 50, 6, 18, 6, 103, 38, 246, 246, 66, 7, 118, 134, 242, 7,
  38, 86, 22, 198, 199, 146, 6, 182, 230, 247, 119, 50, 7, 118, 134, 87, 38, 82, 6, 134, 151, 50, 7,
  70, 247, 118, 86, 194, 6, 151, 50, 224, 236, 17, 236, 17, 236, 17, 236,
];
const THONKY_5Q_EC_BLOCKS = [
  [213, 199, 11, 45, 115, 247, 241, 223, 229, 248, 154, 117, 154, 111, 86, 161, 111, 39],
  [87, 204, 96, 60, 202, 182, 124, 157, 200, 134, 27, 129, 209, 17, 163, 163, 120, 133],
  [148, 116, 177, 212, 76, 133, 75, 242, 238, 76, 195, 230, 189, 10, 108, 240, 192, 141],
  [140, 100, 250, 247, 108, 131, 37, 104, 253, 113, 111, 235, 197, 83, 6, 205, 89, 74],
];
const THONKY_5Q_INTERLEAVED_DATA = [
  67, 246, 182, 70, 85, 246, 230, 247, 70, 66, 247, 118, 134, 7, 119, 86, 87, 118, 50, 194, 38, 134,
  7, 6, 85, 242, 118, 151, 194, 7, 134, 50, 119, 38, 87, 224, 50, 86, 38, 236, 6, 22, 82, 17, 18,
  198, 6, 236, 6, 199, 134, 17, 103, 146, 151, 236, 38, 6, 50, 17, 7, 236,
];
const THONKY_5Q_INTERLEAVED_EC = [
  213, 87, 148, 140, 199, 204, 116, 100, 11, 96, 177, 250, 45, 60, 212, 247, 115, 202, 76, 108, 247,
  182, 133, 131, 241, 124, 75, 37, 223, 157, 242, 104, 229, 200, 238, 253, 248, 134, 76, 113, 154,
  27, 195, 111, 117, 129, 230, 235, 154, 209, 189, 197, 111, 17, 10, 83, 86, 163, 108, 6, 161, 163,
  240, 205, 111, 120, 192, 89, 39, 133, 141, 74,
];

describe("Reed-Solomon", () => {
  test("matches the Thonky 1-M HELLO WORLD error-correction example", () => {
    // https://www.thonky.com/qr-code-tutorial/error-correction-coding
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(rsComputeRemainder(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  test("matches the ISO/IEC 18004 Annex I '01234567' 1-M example", () => {
    const data = [16, 32, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17];
    expect(rsComputeRemainder(data, 10)).toEqual([165, 36, 212, 193, 237, 54, 199, 135, 44, 85]);
  });

  test("matches all four Thonky 5-Q blocks", () => {
    const blocks = [
      THONKY_5Q_DATA.slice(0, 15),
      THONKY_5Q_DATA.slice(15, 30),
      THONKY_5Q_DATA.slice(30, 46),
      THONKY_5Q_DATA.slice(46, 62),
    ];
    expect(blocks.map((block) => rsComputeRemainder(block, 18))).toEqual(THONKY_5Q_EC_BLOCKS);
  });
});

describe("data codewords and interleaving", () => {
  test("byte-mode data codewords match the Thonky 5-Q example", () => {
    const bytes = new TextEncoder().encode(THONKY_5Q_PAYLOAD);
    expect(selectQrVersion(bytes.length, "Q")).toBe(5);
    expect(encodeQrDataCodewords(bytes, 5, "Q")).toEqual(THONKY_5Q_DATA);
  });

  test("final interleaved message matches the Thonky 5-Q example", () => {
    expect(buildQrCodewords(THONKY_5Q_DATA, 5, "Q")).toEqual([
      ...THONKY_5Q_INTERLEAVED_DATA,
      ...THONKY_5Q_INTERLEAVED_EC,
    ]);
  });
});

describe("tables and version selection", () => {
  test("total codewords per version match ISO/IEC 18004 Table 1 at every level", () => {
    const expected = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
    for (const level of LEVELS) {
      const totals = expected.map((_total, index) => qrTotalCodewordCount(index + 1, level));
      expect(totals).toEqual(expected);
    }
  });

  test("byte capacities match the published capacity table", () => {
    // ISO/IEC 18004 Table 7 (byte mode); https://www.thonky.com/qr-code-tutorial/character-capacities
    const published: Record<number, number[]> = {
      1: [17, 14, 11, 7],
      2: [32, 26, 20, 14],
      5: [106, 84, 60, 44],
      10: [271, 213, 151, 119],
    };
    for (const [version, capacities] of Object.entries(published)) {
      expect(LEVELS.map((level) => qrByteCapacity(Number(version), level))).toEqual(capacities);
    }
  });

  test("selects the smallest version that fits, counting UTF-8 bytes", () => {
    expect(selectQrVersion(14, "M")).toBe(1);
    expect(selectQrVersion(15, "M")).toBe(2);
    expect(selectQrVersion(213, "M")).toBe(10);
    // "日本" is six UTF-8 bytes; 2 x 6 + 3 = 15 bytes overflows version 1-M.
    expect(encodeQrSymbol("日本日本abc").version).toBe(2);
  });

  test("rejects payloads beyond version 10 with an ActionableError naming the limit", () => {
    expect(() => encodeQr("x".repeat(214))).toThrow(ActionableError);
    expect(() => encodeQr("x".repeat(214))).toThrow(/at most 213 bytes .*level M .*version 10/);
    expect(() => encodeQr("x".repeat(120), { ecLevel: "H" })).toThrow(/at most 119 bytes/);
    expect(QR_MAX_VERSION).toBe(10);
  });

  test("rejects invalid options", () => {
    expect(() => encodeQr("hi", { mask: 8 })).toThrow(ActionableError);
    expect(() => encodeQr("hi", { mask: 1.5 })).toThrow(ActionableError);
    expect(() => encodeQr("hi", { ecLevel: "X" as QrErrorCorrectionLevel })).toThrow(
      ActionableError,
    );
  });
});

describe("format and version information", () => {
  // https://www.thonky.com/qr-code-tutorial/format-version-tables
  const PUBLISHED_FORMAT: Record<QrErrorCorrectionLevel, string[]> = {
    L: [
      "111011111000100",
      "111001011110011",
      "111110110101010",
      "111100010011101",
      "110011000101111",
      "110001100011000",
      "110110001000001",
      "110100101110110",
    ],
    M: [
      "101010000010010",
      "101000100100101",
      "101111001111100",
      "101101101001011",
      "100010111111001",
      "100000011001110",
      "100111110010111",
      "100101010100000",
    ],
    Q: [
      "011010101011111",
      "011000001101000",
      "011111100110001",
      "011101000000110",
      "010010010110100",
      "010000110000011",
      "010111011011010",
      "010101111101101",
    ],
    H: [
      "001011010001001",
      "001001110111110",
      "001110011100111",
      "001100111010000",
      "000011101100010",
      "000001001010101",
      "000110100001100",
      "000100000111011",
    ],
  };

  test("format bits match the published table for every level and mask", () => {
    for (const level of LEVELS) {
      const actual = PUBLISHED_FORMAT[level].map((_bits, mask) =>
        bitString(qrFormatBits(level, mask), 15),
      );
      expect(actual).toEqual(PUBLISHED_FORMAT[level]);
    }
  });

  test("version bits match the published table for versions 7-10", () => {
    expect([7, 8, 9, 10].map((version) => bitString(qrVersionBits(version), 18))).toEqual([
      "000111110010010100",
      "001000010110111100",
      "001001101010011001",
      "001010010011010011",
    ]);
  });

  test("both format copies carry the published string in the standard positions", () => {
    const matrix = encodeQr("auto-mobile", { ecLevel: "Q", mask: 5 });
    const size = matrix.length;
    const bit = (row: number, column: number): string => (matrix[row][column] ? "1" : "0");
    // MSB first: row 8 columns 0-5, 7, 8, then column 8 rows 7, 5..0.
    const nearFinder = [
      ...[0, 1, 2, 3, 4, 5, 7, 8].map((column) => bit(8, column)),
      ...[7, 5, 4, 3, 2, 1, 0].map((row) => bit(row, 8)),
    ].join("");
    // MSB first: column 8 rows size-1..size-7, then row 8 columns size-8..size-1.
    const split = [
      ...Array.from({ length: 7 }, (_unused, i) => bit(size - 1 - i, 8)),
      ...Array.from({ length: 8 }, (_unused, i) => bit(8, size - 8 + i)),
    ].join("");
    expect(nearFinder).toBe(PUBLISHED_FORMAT.Q[5]);
    expect(split).toBe(PUBLISHED_FORMAT.Q[5]);
    expect(matrix[size - 8][8]).toBe(true);
  });

  test("version 7 symbols carry version information in both 6x3 blocks", () => {
    const symbol = encodeQrSymbol("x".repeat(150), { ecLevel: "L" });
    expect(symbol.version).toBe(7);
    const size = symbol.modules.length;
    const lsbFirst = Array.from({ length: 18 }, (_unused, i) => {
      const near = Math.floor(i / 3);
      const far = size - 11 + (i % 3);
      expect(symbol.modules[near][far]).toBe(symbol.modules[far][near]);
      return symbol.modules[near][far] ? "1" : "0";
    });
    expect(lsbFirst.reverse().join("")).toBe("000111110010010100");
  });
});

describe("mask penalty", () => {
  function grid(size: number, dark: (row: number, column: number) => boolean): QrMatrix {
    return Array.from({ length: size }, (_r, row) =>
      Array.from({ length: size }, (_c, column) => dark(row, column)),
    );
  }

  test("an all-light 5x5 grid scores every rule", () => {
    // Rule 1: 10 lines x 3; rule 2: 16 blocks x 3; rule 4: 50% off balance -> 10 x 10.
    expect(qrMaskPenalty(grid(5, () => false))).toEqual({
      adjacent: 30,
      blocks: 48,
      finderLike: 0,
      balance: 100,
      total: 178,
    });
  });

  test("a checkerboard scores zero", () => {
    expect(qrMaskPenalty(grid(6, (row, column) => (row + column) % 2 === 0)).total).toBe(0);
  });

  test("a finder-like 1011101 run with four light modules scores 40", () => {
    const pattern = "10111010000";
    const matrix = grid(11, (row, column) =>
      row === 0 ? pattern[column] === "1" : (row + column) % 2 === 0,
    );
    expect(qrMaskPenalty(matrix).finderLike).toBe(40);
  });

  test("a 30% dark grid scores 40 for balance", () => {
    expect(qrMaskPenalty(grid(10, (row, column) => row * 10 + column < 30)).balance).toBe(40);
  });

  test("automatic mask selection picks the lowest-penalty mask", () => {
    for (const payload of ["HELLO WORLD", "https://example.com/a?b=c", "x".repeat(150)]) {
      const chosen = encodeQrSymbol(payload);
      const totals = Array.from(
        { length: 8 },
        (_unused, mask) => qrMaskPenalty(encodeQr(payload, { mask })).total,
      );
      expect(totals[chosen.mask]).toBe(Math.min(...totals));
      expect(chosen.mask).toBe(totals.indexOf(Math.min(...totals)));
    }
  });
});

describe("full symbols", () => {
  // Reference matrices: OpenCV 4.10 cv2.QRCodeEncoder (an independent ISO/IEC
  // 18004 implementation) in byte mode. Each one also decodes with OpenCV's
  // QRCodeDetector. Captured with scratch tooling on 2026-10-06.
  test("HELLO WORLD byte-mode version 1 symbols match the reference at L, M and Q", () => {
    expect(toRows(encodeQr("HELLO WORLD", { ecLevel: "L" }))).toEqual([
      "#######.#.###.#######",
      "#.....#...##..#.....#",
      "#.###.#.##.#..#.###.#",
      "#.###.#.##..#.#.###.#",
      "#.###.#.#..#..#.###.#",
      "#.....#..####.#.....#",
      "#######.#.#.#.#######",
      "...........##........",
      "####..#.######..###.#",
      ".#.###.#..######.##..",
      "####..#.#..#.#.#...##",
      "######.#...#...#.#.#.",
      "###...##.#..##....#.#",
      "........##.#..##..#.#",
      "#######...#######....",
      "#.....#......#.#.####",
      "#.###.#...#.#.#..#...",
      "#.###.#.#.#...#..###.",
      "#.###.#.###.#..#..#..",
      "#.....#.##.#.####...#",
      "#######.#..#.#.#.....",
    ]);
    expect(toRows(encodeQr("HELLO WORLD", { ecLevel: "M" }))).toEqual([
      "#######.##..#.#######",
      "#.....#....#..#.....#",
      "#.###.#..#.#..#.###.#",
      "#.###.#.#..#..#.###.#",
      "#.###.#.###.#.#.###.#",
      "#.....#.#..#..#.....#",
      "#######.#.#.#.#######",
      "........#..##........",
      "#...#.######.#####..#",
      "...#....#.###....####",
      "..######..##.##.#..#.",
      "#####...##...#.......",
      "#####.#.#.#.#.##..##.",
      "........#.#.####.#.##",
      "#######.###.#.#.##.#.",
      "#.....#..#.###.##..##",
      "#.###.#.##.#.##...##.",
      "#.###.#..#..#...##.##",
      "#.###.#..###...###...",
      "#.....#....#.#.......",
      "#######.#########.#.#",
    ]);
    expect(toRows(encodeQr("HELLO WORLD", { ecLevel: "Q" }))).toEqual([
      "#######.####..#######",
      "#.....#..####.#.....#",
      "#.###.#..##...#.###.#",
      "#.###.#...#.#.#.###.#",
      "#.###.#.#.#.#.#.###.#",
      "#.....#.##.##.#.....#",
      "#######.#.#.#.#######",
      ".....................",
      ".#######.##.#..##...#",
      "#####..#.#.#####.##..",
      "..###.#.#..####..###.",
      ".#.##...####.#..###..",
      ".##...#..#.#.#....#.#",
      "........####.....#...",
      "#######.#.#...#...##.",
      "#.....#.###..#.#.####",
      "#.###.#.#...#..#..#.#",
      "#.###.#.#.#.######...",
      "#.###.#.##..#..#..#..",
      "#.....#.#...##..###..",
      "#######..#.##...#.##.",
    ]);
  });

  test("multi-block symbols with alignment patterns match the reference", () => {
    const fiveL = encodeQrSymbol("a".repeat(100), { ecLevel: "L" });
    expect([fiveL.version, fiveL.mask]).toEqual([5, 7]);
    expect(sha256Rows(fiveL.modules)).toBe(
      "558c560622a707c189689a263b22e089fe967e6e5811817be761802f29b93aea",
    );
    const sixM = encodeQrSymbol("a".repeat(100), { ecLevel: "M" });
    expect([sixM.version, sixM.mask]).toEqual([6, 1]);
    expect(sha256Rows(sixM.modules)).toBe(
      "9dab43836af6eb933bc69854211b33d2b7aba942e20b183782b5c9f965abdc2e",
    );
    // The reference chose mask 6 here (its penalty scoring differs); force it to compare placement.
    const url = encodeQr("https://example.com/auto-mobile?x=1", { ecLevel: "Q", mask: 6 });
    expect(sha256Rows(url)).toBe(
      "2ceba57d65fe0d04a35d9aa21b83234e5be6e4a2dfb8aaeb7e4efb465bb0a357",
    );
  });

  test("symbols are square with the size implied by the version", () => {
    for (const level of LEVELS) {
      const symbol = encodeQrSymbol("https://example.com/" + "p".repeat(40), { ecLevel: level });
      expect(symbol.modules.length).toBe(17 + 4 * symbol.version);
      expect(symbol.modules.every((row) => row.length === symbol.modules.length)).toBe(true);
    }
  });
});
