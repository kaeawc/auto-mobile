import { beforeAll, describe, expect, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import type { RawImage } from "../../../src/utils/image/backend/ImageBackend";
import { JimpBackend } from "../../../src/utils/image/backend/JimpBackend";
import { loadJimp } from "../../../src/utils/image/loadJimp";
import { encodeQr } from "../../../src/utils/qr/QrEncoder";
import {
  JimpQrPngEncoder,
  rasterizeQr,
  renderQrPng,
  type QrPngEncoder,
} from "../../../src/utils/qr/QrPngRenderer";

class FakeQrPngEncoder implements QrPngEncoder {
  readonly images: RawImage[] = [];

  async encodePng(image: RawImage): Promise<Buffer> {
    this.images.push(image);
    return Buffer.from("fake-png");
  }
}

function pixel(image: RawImage, x: number, y: number): number[] {
  const offset = (y * image.width + x) * 4;
  return [...image.data.subarray(offset, offset + 4)];
}

const DARK = [0, 0, 0, 255];
const LIGHT = [255, 255, 255, 255];

describe("rasterizeQr", () => {
  test("expands modules by moduleSize and surrounds them with a light quiet zone", () => {
    const image = rasterizeQr(
      [
        [true, false],
        [false, true],
      ],
      { moduleSize: 2, quietZone: 1 },
    );
    expect([image.width, image.height, image.data.length]).toEqual([8, 8, 8 * 8 * 4]);
    expect(pixel(image, 0, 0)).toEqual(LIGHT);
    expect(pixel(image, 1, 1)).toEqual(LIGHT);
    expect(pixel(image, 2, 2)).toEqual(DARK);
    expect(pixel(image, 3, 3)).toEqual(DARK);
    expect(pixel(image, 4, 2)).toEqual(LIGHT);
    expect(pixel(image, 4, 4)).toEqual(DARK);
    expect(pixel(image, 7, 7)).toEqual(LIGHT);
  });

  test("defaults to 16 px modules and a 4-module quiet zone", () => {
    const matrix = encodeQr("https://example.com");
    const image = rasterizeQr(matrix);
    expect(image.width).toBe((matrix.length + 8) * 16);
    expect(pixel(image, 4 * 16, 4 * 16)).toEqual(DARK);
    expect(pixel(image, 4 * 16 - 1, 4 * 16 - 1)).toEqual(LIGHT);
  });

  test("rejects invalid sizes and malformed matrices", () => {
    expect(() => rasterizeQr([[true]], { moduleSize: 0 })).toThrow(ActionableError);
    expect(() => rasterizeQr([[true]], { moduleSize: 2.5 })).toThrow(ActionableError);
    expect(() => rasterizeQr([[true]], { quietZone: -1 })).toThrow(ActionableError);
    expect(() => rasterizeQr([])).toThrow(ActionableError);
    expect(() => rasterizeQr([[true, false]])).toThrow(ActionableError);
  });
});

describe("renderQrPng", () => {
  beforeAll(async () => {
    // Warm the lazy jimp import so its one-time load is outside the per-test budget.
    await loadJimp();
  });

  test("hands the rasterized image to the injected encoder", async () => {
    const encoder = new FakeQrPngEncoder();
    const png = await renderQrPng([[true]], { moduleSize: 3, quietZone: 0 }, encoder);
    expect(png.toString()).toBe("fake-png");
    expect(encoder.images.map((image) => [image.width, image.height])).toEqual([[3, 3]]);
  });

  test("the jimp encoder writes a PNG that decodes to the same pixels", async () => {
    const matrix = encodeQr("auto-mobile");
    const png = await renderQrPng(matrix, { moduleSize: 4 }, new JimpQrPngEncoder());
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const decoded = await new JimpBackend().rawPixels(png);
    const expected = rasterizeQr(matrix, { moduleSize: 4 });
    expect([decoded.width, decoded.height]).toEqual([expected.width, expected.height]);
    expect(decoded.data.equals(expected.data)).toBe(true);
  });
});
