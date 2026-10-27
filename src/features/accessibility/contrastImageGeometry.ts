import type { Element } from "../../models/Element";
import type { RawImage } from "../../utils/image/backend/ImageBackend";
import { clamp } from "../../utils/bounds";

/** The text size in px the capture reported for this element, or null when absent or unusable. */
export function reportedTextSizePx(element: Element): number | null {
  const size: unknown = element.textSize;
  return typeof size === "number" && Number.isFinite(size) && size > 0 ? size : null;
}

/** Summed-area table of opaque (alpha 255) pixels: `(width + 1) * (height + 1)` running counts. */
const opaquePixelTables = new WeakMap<RawImage, Int32Array>();

export function opaquePixelTable(image: RawImage): Int32Array {
  let table = opaquePixelTables.get(image);
  if (!table) {
    const stride = image.width + 1;
    table = new Int32Array(stride * (image.height + 1));
    for (let y = 0; y < image.height; y++) {
      let row = 0;
      for (let x = 0; x < image.width; x++) {
        row += image.data[(image.width * y + x) * 4 + 3] === 255 ? 1 : 0;
        table[(y + 1) * stride + x + 1] = table[y * stride + x + 1] + row;
      }
    }
    opaquePixelTables.set(image, table);
  }
  return table;
}

/**
 * Whether the square of `radius` around (x, y), sampled the way `underlyingColorAtRadius`
 * samples it (round, then clamp to the image), holds any opaque pixel. Those samples are
 * exactly the pixels of one clamped rectangle, so the table answers in constant time.
 */
export function squareHasOpaquePixel(
  image: RawImage,
  table: Int32Array,
  x: number,
  y: number,
  radius: number,
): boolean {
  const x0 = Math.round(clamp(x - radius, 0, image.width - 1));
  const x1 = Math.round(clamp(x + radius, 0, image.width - 1));
  const y0 = Math.round(clamp(y - radius, 0, image.height - 1));
  const y1 = Math.round(clamp(y + radius, 0, image.height - 1));
  const stride = image.width + 1;
  const count =
    table[(y1 + 1) * stride + x1 + 1] -
    table[y0 * stride + x1 + 1] -
    table[(y1 + 1) * stride + x0] +
    table[y0 * stride + x0];
  return count > 0;
}

/** Whether the whole element rectangle lies inside the decoded image (hierarchy px == raster px on Android). */
export function boundsInsideImage(image: RawImage, bounds: Element["bounds"]): boolean {
  return (
    bounds.left >= 0 &&
    bounds.top >= 0 &&
    bounds.right <= image.width &&
    bounds.bottom <= image.height
  );
}
