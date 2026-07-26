import { describe, expect, it } from "bun:test";
import { readImageHeaderDimensions } from "../../src/utils/screenshot/imageHeaderDimensions";

/** Build a minimal PNG whose IHDR declares the given size. */
function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

/** Build a minimal JPEG with an APP0 segment followed by an SOF0 declaring the given size. */
function jpeg(width: number, height: number, sofMarker = 0xc0): Buffer {
  const parts: number[] = [0xff, 0xd8];
  // APP0 segment we must skip over to reach the frame header.
  parts.push(0xff, 0xe0, 0x00, 0x10);
  for (let i = 0; i < 14; i++) {
    parts.push(0x00);
  }
  parts.push(0xff, sofMarker, 0x00, 0x11, 0x08);
  parts.push((height >> 8) & 0xff, height & 0xff);
  parts.push((width >> 8) & 0xff, width & 0xff);
  for (let i = 0; i < 6; i++) {
    parts.push(0x00);
  }
  return Buffer.from(parts);
}

describe("readImageHeaderDimensions", () => {
  it("reads PNG dimensions from the IHDR chunk", () => {
    expect(readImageHeaderDimensions(png(1170, 2532))).toEqual({ width: 1170, height: 2532 });
  });

  it("reads JPEG dimensions from the first start-of-frame, skipping earlier segments", () => {
    expect(readImageHeaderDimensions(jpeg(1080, 2340))).toEqual({ width: 1080, height: 2340 });
  });

  it("reads progressive JPEG (SOF2) dimensions", () => {
    expect(readImageHeaderDimensions(jpeg(720, 1560, 0xc2))).toEqual({ width: 720, height: 1560 });
  });

  it("does not mistake a DHT segment for a frame header", () => {
    // 0xC4 sits inside the SOFn marker range but is a Huffman table, not a frame.
    const buffer = jpeg(720, 1560, 0xc4);
    expect(readImageHeaderDimensions(buffer)).toBeNull();
  });

  it("returns null for an unknown format, an empty buffer, or a truncated header", () => {
    expect(readImageHeaderDimensions(Buffer.alloc(0))).toBeNull();
    expect(readImageHeaderDimensions(Buffer.from("RIFF....WEBPVP8 "))).toBeNull();
    expect(readImageHeaderDimensions(png(1080, 2340).subarray(0, 18))).toBeNull();
  });

  it("returns null rather than guessing when a JPEG reaches scan data with no frame header", () => {
    // SOI then SOS: entropy-coded data follows and no SOFn can appear after it.
    expect(readImageHeaderDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeNull();
  });
});
