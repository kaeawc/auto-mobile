import qrcode from "qrcode-generator";
import { PNG } from "pngjs";

/** A square QR module grid; `dark(row, col)` is true for a dark module. */
export interface QrMatrix {
  size: number;
  dark(row: number, col: number): boolean;
}

/** Byte mode at error correction M, smallest version that holds `text`. */
export function encodeQr(text: string): QrMatrix {
  const code = qrcode(0, "M");
  code.addData(text, "Byte");
  code.make();
  return { size: code.getModuleCount(), dark: (row, col) => code.isDark(row, col) };
}

/** The spec's four-module quiet zone on every side. */
const QUIET_ZONE = 4;

/** A black-on-white PNG, `scale` pixels per module, with the quiet zone. */
export function qrPng(matrix: QrMatrix, scale = 8): Buffer {
  const modules = matrix.size + QUIET_ZONE * 2;
  const side = modules * scale;
  const rowBytes = side * 4;
  const png = new PNG({ width: side, height: side });
  // White everywhere, then each module row is drawn once and copied down `scale` pixel rows.
  png.data.fill(255);
  for (let row = 0; row < matrix.size; row++) {
    const top = (row + QUIET_ZONE) * scale * rowBytes;
    for (let col = 0; col < matrix.size; col++) {
      if (matrix.dark(row, col)) {
        blacken(png.data, top + (col + QUIET_ZONE) * scale * 4, scale);
      }
    }
    for (let copy = 1; copy < scale; copy++) {
      png.data.copy(png.data, top + copy * rowBytes, top, top + rowBytes);
    }
  }
  return PNG.sync.write(png, { colorType: 0, deflateLevel: 6 });
}

/** Sets `pixels` RGBA pixels from `start` to black, leaving alpha opaque. */
function blacken(data: Buffer, start: number, pixels: number): void {
  for (let x = start; x < start + pixels * 4; x += 4) {
    data.fill(0, x, x + 3);
  }
}

/**
 * Two module rows per text line with half blocks. Light modules are drawn as blocks, so the code
 * reads correctly on a dark terminal; phone cameras also read the inverse on a light one.
 */
export function qrTerminal(matrix: QrMatrix): string {
  const lines: string[] = [];
  const first = -QUIET_ZONE;
  const last = matrix.size + QUIET_ZONE;
  for (let row = first; row < last; row += 2) {
    let line = "";
    for (let col = first; col < last; col++) {
      const top = !moduleDark(matrix, row, col);
      const bottom = row + 1 < last && !moduleDark(matrix, row + 1, col);
      line += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function moduleDark(matrix: QrMatrix, row: number, col: number): boolean {
  return row >= 0 && col >= 0 && row < matrix.size && col < matrix.size && matrix.dark(row, col);
}
