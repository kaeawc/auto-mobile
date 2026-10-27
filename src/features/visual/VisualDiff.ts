import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

/** A pixel rectangle inside the compared image: left/top inclusive, right/bottom exclusive. */
export interface PixelRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface VisualDiffOptions {
  /** Regions to leave out of the comparison (clock, avatars, ads, system bars). */
  ignore?: readonly PixelRect[];
  /** pixelmatch per-pixel colour distance, 0-1 (default 0.1). */
  perPixelDelta?: number;
  /** Largest share of compared pixels that may differ and still match (default 0). */
  pixelRatio?: number;
}

export interface VisualDiffResult {
  match: boolean;
  width: number;
  height: number;
  diffPixels: number;
  comparedPixels: number;
  /** diffPixels / comparedPixels; 0 when every pixel is masked. */
  diffRatio: number;
  /** PNG of the differences, only when they do not match. */
  diffPng?: Buffer;
}

export const DEFAULT_PER_PIXEL_DELTA = 0.1;
export const DEFAULT_PIXEL_RATIO = 0;

/** One byte per pixel; non-zero bytes are skipped by pixelmatch. */
export function buildIgnoreMask(
  width: number,
  height: number,
  rects: readonly PixelRect[],
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const rect of rects) {
    const left = Math.max(0, Math.floor(rect.left));
    const top = Math.max(0, Math.floor(rect.top));
    const right = Math.min(width, Math.ceil(rect.right));
    const bottom = Math.min(height, Math.ceil(rect.bottom));
    for (let y = top; y < bottom; y++) {
      mask.fill(1, y * width + left, y * width + Math.max(left, right));
    }
  }
  return mask;
}

/**
 * Compare two PNGs (#14083). A size difference is a different crop or layout, never something to
 * stretch away, so it is reported as `"size_mismatch"` rather than compared.
 */
export function diffPngs(
  baseline: Buffer,
  current: Buffer,
  options: VisualDiffOptions = {},
): VisualDiffResult | "size_mismatch" {
  const a = PNG.sync.read(baseline);
  const b = PNG.sync.read(current);
  if (a.width !== b.width || a.height !== b.height) {
    return "size_mismatch";
  }
  const { width, height } = a;
  const ignoreMask = buildIgnoreMask(width, height, options.ignore ?? []);
  const ignored = ignoreMask.reduce((count, value) => count + (value === 0 ? 0 : 1), 0);
  const comparedPixels = width * height - ignored;
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(a.data, b.data, diff.data, width, height, {
    threshold: options.perPixelDelta ?? DEFAULT_PER_PIXEL_DELTA,
    includeAA: false,
    ignoreMask,
  });
  const diffRatio = comparedPixels === 0 ? 0 : diffPixels / comparedPixels;
  const match = diffRatio <= (options.pixelRatio ?? DEFAULT_PIXEL_RATIO);
  return {
    match,
    width,
    height,
    diffPixels,
    comparedPixels,
    diffRatio,
    ...(match ? {} : { diffPng: PNG.sync.write(diff) }),
  };
}
