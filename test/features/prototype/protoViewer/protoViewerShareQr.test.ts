import { describe, expect, test } from "bun:test";
import { PNG } from "pngjs";
import {
  encodeQr,
  qrPng,
  qrTerminal,
  type QrMatrix,
} from "../../../../src/features/prototype/protoViewer/protoViewerShareQr";

const LINK = `automobile-proto://import?url=${encodeURIComponent("https://example.com/demo.automobile-proto")}&sha256=${"0".repeat(64)}`;

/** The 7x7 finder pattern: dark ring, light ring, dark 3x3 core. */
function finderAt(matrix: QrMatrix, top: number, left: number): boolean {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      if (matrix.dark(top + r, left + c) !== (ring !== 2)) {
        return false;
      }
    }
  }
  return true;
}

describe("share QR", () => {
  test("encodes a link as a QR grid with the three finder patterns", () => {
    const matrix = encodeQr(LINK);
    expect((matrix.size - 17) % 4).toBe(0);
    expect(finderAt(matrix, 0, 0)).toBe(true);
    expect(finderAt(matrix, 0, matrix.size - 7)).toBe(true);
    expect(finderAt(matrix, matrix.size - 7, 0)).toBe(true);
  });

  test("PNG is black on white with a four-module quiet zone", () => {
    const matrix = encodeQr(LINK);
    const png = PNG.sync.read(qrPng(matrix, 2));
    expect(png.width).toBe((matrix.size + 8) * 2);
    expect(png.height).toBe(png.width);
    const pixel = (x: number, y: number) => png.data[(y * png.width + x) * 4];
    expect(pixel(0, 0)).toBe(255);
    expect(pixel(7, 7)).toBe(255);
    // The top-left finder's corner module starts right after the quiet zone.
    expect(pixel(8, 8)).toBe(0);
  });

  test("terminal rendering packs two module rows per line, light modules as blocks", () => {
    const matrix = encodeQr(LINK);
    const lines = qrTerminal(matrix).split("\n");
    const side = matrix.size + 8;
    expect(lines).toHaveLength(Math.ceil(side / 2));
    expect(lines.every((line) => [...line].length === side)).toBe(true);
    // Quiet zone rows are fully light.
    expect(lines[0]).toBe("█".repeat(side));
    expect(lines[2]?.slice(0, 4)).toBe("████");
  });
});
