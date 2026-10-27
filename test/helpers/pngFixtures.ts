import { PNG } from "pngjs";

export type Rgba = readonly [number, number, number, number];

/** A solid PNG, optionally with single pixels painted over it. */
export function solidPng(
  width: number,
  height: number,
  color: Rgba,
  paint: ReadonlyArray<{ x: number; y: number; color: Rgba }> = [],
): Buffer {
  const png = new PNG({ width, height });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data.set(color, offset);
  }
  for (const pixel of paint) {
    png.data.set(pixel.color, (pixel.y * width + pixel.x) * 4);
  }
  return PNG.sync.write(png);
}
