/**
 * Render a QR module matrix to a black-on-white PNG with a light quiet zone.
 *
 * Rasterization is a pure function; PNG encoding goes through a narrow
 * `QrPngEncoder` seam whose default implementation uses the repository's
 * existing jimp backend (`loadJimp`).
 */
import { ActionableError } from "../../models/ActionableError";
import type { RawImage } from "../image/backend/ImageBackend";
import { loadJimp } from "../image/loadJimp";
import type { QrMatrix } from "./QrMask";

export interface QrRenderOptions {
  /** Pixels per module edge. Default 16, so a version-10 symbol is ~1 kpx wide. */
  moduleSize?: number;
  /** Light border in modules. The standard minimum (and default) is 4. */
  quietZone?: number;
}

/** Encodes raw RGBA pixels to PNG bytes. */
export interface QrPngEncoder {
  encodePng(image: RawImage): Promise<Buffer>;
}

export const DEFAULT_QR_MODULE_SIZE = 16;
export const DEFAULT_QR_QUIET_ZONE = 4;
const MAX_QR_MODULE_SIZE = 64;
const MAX_QR_QUIET_ZONE = 16;

const DARK = 0x00;
const LIGHT = 0xff;

export class JimpQrPngEncoder implements QrPngEncoder {
  async encodePng(image: RawImage): Promise<Buffer> {
    const Jimp = await loadJimp();
    const bitmap = Jimp.fromBitmap({ width: image.width, height: image.height, data: image.data });
    return bitmap.getBuffer("image/png");
  }
}

function requireIntegerInRange(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ActionableError(`QR ${name} must be an integer from ${min} to ${max}, got ${value}.`);
  }
  return value;
}

function requireSquareMatrix(matrix: QrMatrix): void {
  const size = matrix.length;
  if (size === 0 || matrix.some((row) => row.length !== size)) {
    throw new ActionableError("QR matrix must be a non-empty square grid of modules.");
  }
}

/** Expand modules to RGBA pixels: `moduleSize` px per module plus the quiet zone. */
export function rasterizeQr(matrix: QrMatrix, options: QrRenderOptions = {}): RawImage {
  requireSquareMatrix(matrix);
  const moduleSize = requireIntegerInRange(
    "moduleSize",
    options.moduleSize ?? DEFAULT_QR_MODULE_SIZE,
    1,
    MAX_QR_MODULE_SIZE,
  );
  const quietZone = requireIntegerInRange(
    "quietZone",
    options.quietZone ?? DEFAULT_QR_QUIET_ZONE,
    0,
    MAX_QR_QUIET_ZONE,
  );
  const modulesAcross = matrix.length + 2 * quietZone;
  const width = modulesAcross * moduleSize;
  const rowBytes = width * 4;
  const moduleBytes = moduleSize * 4;
  const data = Buffer.alloc(rowBytes * width, LIGHT);
  // One dark module span of one pixel row: RGB go dark, alpha stays 0xff.
  const darkSpan = Buffer.alloc(moduleBytes, LIGHT);
  for (let offset = 0; offset < moduleBytes; offset += 4) {
    darkSpan.fill(DARK, offset, offset + 3);
  }
  // Paint the first pixel row of each module row, then copy it down the module's
  // remaining rows, so the work scales with modules rather than pixels.
  for (let moduleY = 0; moduleY < matrix.length; moduleY++) {
    const row = matrix[moduleY];
    const firstRowStart = (moduleY + quietZone) * moduleSize * rowBytes;
    for (let moduleX = 0; moduleX < row.length; moduleX++) {
      if (row[moduleX] === true) {
        darkSpan.copy(data, firstRowStart + (moduleX + quietZone) * moduleBytes);
      }
    }
    for (let y = 1; y < moduleSize; y++) {
      data.copy(data, firstRowStart + y * rowBytes, firstRowStart, firstRowStart + rowBytes);
    }
  }
  return { width, height: width, data };
}

/** Rasterize `matrix` and encode it as PNG bytes. */
export async function renderQrPng(
  matrix: QrMatrix,
  options: QrRenderOptions = {},
  encoder: QrPngEncoder = new JimpQrPngEncoder(),
): Promise<Buffer> {
  return encoder.encodePng(rasterizeQr(matrix, options));
}
