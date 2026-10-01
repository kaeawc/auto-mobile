import { beforeAll, describe, expect, it } from "bun:test";
import { loadSharp } from "../../src/utils/image/loadSharp";
import {
  detectImageMimeType,
  readImageHeaderDimensions,
} from "../../src/utils/screenshot/imageHeaderDimensions";

/** Build a minimal PNG whose IHDR declares the given size. */
function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8); // IHDR data length, fixed by the PNG spec
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
  let encoded: {
    png: Buffer;
    jpeg: Buffer;
    progressiveJpeg: Buffer;
    webpLossy: Buffer;
    webpLossless: Buffer;
    webpExtended: Buffer;
  };

  beforeAll(async () => {
    const sharp = await loadSharp();
    const pixels = Buffer.alloc(37 * 53 * 4, 255);
    for (let pixel = 0; pixel < 37 * 53; pixel++) {
      pixels[pixel * 4] = pixel % 251;
      pixels[pixel * 4 + 1] = (pixel * 3) % 251;
      pixels[pixel * 4 + 2] = (pixel * 7) % 251;
    }
    encoded = {
      png: await sharp(pixels, { raw: { width: 37, height: 53, channels: 4 } })
        .png()
        .toBuffer(),
      jpeg: await sharp(pixels, { raw: { width: 37, height: 53, channels: 4 } })
        .jpeg()
        .toBuffer(),
      progressiveJpeg: await sharp(pixels, { raw: { width: 37, height: 53, channels: 4 } })
        .jpeg({ progressive: true })
        .toBuffer(),
      webpLossy: await sharp(pixels, { raw: { width: 37, height: 53, channels: 4 } })
        .webp()
        .toBuffer(),
      webpLossless: await sharp(pixels, { raw: { width: 37, height: 53, channels: 4 } })
        .webp({ lossless: true })
        .toBuffer(),
      webpExtended: await sharp(
        Buffer.from(pixels).map((value, index) => (index % 4 === 3 ? 128 : value)),
        { raw: { width: 37, height: 53, channels: 4 } },
      )
        .webp()
        .toBuffer(),
    };
    expect(encoded.webpLossy.toString("ascii", 12, 16)).toBe("VP8 ");
    expect(encoded.webpLossless.toString("ascii", 12, 16)).toBe("VP8L");
    expect(encoded.webpExtended.toString("ascii", 12, 16)).toBe("VP8X");
  });

  it.each([
    ["PNG", "png"],
    ["baseline JPEG", "jpeg"],
    ["progressive JPEG", "progressiveJpeg"],
    ["lossy WebP", "webpLossy"],
    ["lossless WebP", "webpLossless"],
    ["extended WebP", "webpExtended"],
  ] as const)("reads dimensions from real %s encoder output", (_name, key) => {
    expect(readImageHeaderDimensions(encoded[key])).toEqual({ width: 37, height: 53 });
  });

  it("returns null or the dimensions once available for every WebP prefix", () => {
    const fixture = encoded.webpLossy;
    for (let prefixLength = 0; prefixLength <= fixture.length; prefixLength++) {
      const result = readImageHeaderDimensions(fixture.subarray(0, prefixLength));
      expect(result === null || (result.width === 37 && result.height === 53)).toBe(true);
    }
  });

  it("rejects a WebP with an unknown first chunk fourcc", () => {
    const wrongChunk = Buffer.from(encoded.webpLossy);
    wrongChunk.write("NOPE", 12, "ascii");
    expect(readImageHeaderDimensions(wrongChunk)).toBeNull();
  });

  it("rejects a WebP lossy header with zero width", () => {
    const zeroWidth = Buffer.from(encoded.webpLossy);
    zeroWidth.writeUInt16LE(0, 26);
    expect(readImageHeaderDimensions(zeroWidth)).toBeNull();
  });

  it("rejects garbage and a JPEG truncated before its frame header", () => {
    expect(readImageHeaderDimensions(Buffer.from("garbage"))).toBeNull();
    expect(readImageHeaderDimensions(encoded.jpeg.subarray(0, 20))).toBeNull();
  });

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

  it("rejects a PNG signature that is not followed by a valid IHDR chunk", () => {
    // The signature alone proves nothing: without validating the chunk type and its spec-mandated
    // length, whatever bytes sit at offset 16 would be handed back as dimensions.
    const wrongChunkType = png(1080, 2340);
    wrongChunkType.write("IDAT", 12, "ascii");
    expect(readImageHeaderDimensions(wrongChunkType)).toBeNull();

    const wrongChunkLength = png(1080, 2340);
    wrongChunkLength.writeUInt32BE(9, 8);
    expect(readImageHeaderDimensions(wrongChunkLength)).toBeNull();
  });

  it("rejects a JPEG start-of-frame whose declared segment length is too short", () => {
    // A segment shorter than precision + height + width + component count cannot contain the
    // fields, so reading them would return whatever bytes follow.
    const buffer = jpeg(1080, 2340);
    const sofLengthOffset = buffer.indexOf(Buffer.from([0xff, 0xc0])) + 2;
    buffer.writeUInt16BE(6, sofLengthOffset);
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

describe("detectImageMimeType", () => {
  it.each([
    ["JPEG", Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    ["PNG", png(1, 1), "image/png"],
    ["WebP", Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 ", "binary"), "image/webp"],
  ])("detects %s bytes", (_name, buffer, mimeType) => {
    expect(detectImageMimeType(buffer)).toBe(mimeType);
  });

  it("returns null for unknown bytes", () => {
    expect(detectImageMimeType(Buffer.from("not an image"))).toBeNull();
  });
});
