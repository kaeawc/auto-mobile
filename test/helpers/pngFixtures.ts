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

/** PNG signature plus IHDR only: enough for header-dimension checks on full-size panels. */
export function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}
