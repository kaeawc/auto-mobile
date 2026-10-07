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
  const data = Buffer.alloc(width * width * 4, LIGHT);
  for (let y = 0; y < width; y++) {
    const row = matrix[Math.floor(y / moduleSize) - quietZone] as boolean[] | undefined;
    for (let x = 0; row !== undefined && x < width; x++) {
      if (row[Math.floor(x / moduleSize) - quietZone] === true) {
        // Alpha stays 0xff; only RGB go dark.
        data.fill(DARK, (y * width + x) * 4, (y * width + x) * 4 + 3);
      }
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
