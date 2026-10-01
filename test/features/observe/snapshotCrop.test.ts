import { beforeAll, describe, expect, test } from "bun:test";
import { cropSnapshot } from "../../../src/features/observe/screenshot/snapshotCrop";
import { SharpBackend } from "../../../src/utils/image/backend/SharpBackend";
import { loadSharp } from "../../../src/utils/image/loadSharp";
import { FakeImageBackend } from "../../fakes/FakeImageBackend";

const source = Buffer.from("in-memory-png");

function backend(width: number, height: number): FakeImageBackend {
  const fake = new FakeImageBackend();
  fake.setMetadataResult({ width, height, format: "png", size: source.length });
  return fake;
}

describe("snapshot crop geometry", () => {
  let realPng: Buffer;
  const realBackend = new SharpBackend();
  beforeAll(async () => {
    const pixels = Buffer.alloc(4 * 4 * 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const offset = (y * 4 + x) * 4;
        pixels.set([x * 40, y * 40, x === 2 && y === 2 ? 255 : 0, 255], offset);
      }
    }
    const sharp = await loadSharp();
    realPng = await sharp(pixels, { raw: { width: 4, height: 4, channels: 4 } })
      .png()
      .toBuffer();
  });

  test("real PNG crop preserves raster pixels including an overlay", async () => {
    const result = await cropSnapshot(
      realPng,
      { left: 1, top: 1, right: 3, bottom: 3 },
      { platform: "android", screenSize: { width: 4, height: 4 } },
      realBackend,
    );
    const raw = await realBackend.rawPixels(result.png);
    expect({ width: raw.width, height: raw.height }).toEqual({ width: 2, height: 2 });
    expect([...raw.data.subarray(0, 4)]).toEqual([40, 40, 0, 255]);
    expect([...raw.data.subarray(12, 16)]).toEqual([80, 80, 255, 255]);
  });
  test("Android crops physical pixels without resampling", async () => {
    const image = backend(8, 6);
    const result = await cropSnapshot(
      source,
      { left: 2, top: 1, right: 5, bottom: 4 },
      { platform: "android", screenSize: { width: 8, height: 6 } },
      image,
    );
    expect(result.imageSize).toEqual({ width: 3, height: 3 });
    expect(result.rasterBounds).toEqual({ left: 2, top: 1, right: 5, bottom: 4 });
    expect(image.lastPipeline?.operations).toEqual([
      { type: "crop", x: 2, y: 1, width: 3, height: 3 },
    ]);
    expect(image.lastPipeline?.encoding).toEqual({ mime: "image/png" });
  });

  test("iOS fractional points include every touched raster pixel", async () => {
    const result = await cropSnapshot(
      source,
      { left: 0.25, top: 1.5, right: 2.25, bottom: 3.1 },
      { platform: "ios", screenSize: { width: 4, height: 5 }, nativeScale: 3 },
      backend(12, 15),
    );
    expect(result.rasterBounds).toEqual({ left: 0, top: 4, right: 7, bottom: 10 });
    expect(result.scaleProvenance).toBe("native-scale-confirmed");
  });

  test("clips partially visible rectangles and keeps requested bounds", async () => {
    const requestedBounds = { left: -2, top: 2, right: 3, bottom: 7 };
    const result = await cropSnapshot(
      source,
      requestedBounds,
      { platform: "android", screenSize: { width: 5, height: 5 } },
      backend(5, 5),
    );
    expect(result.clipped).toBe(true);
    expect(result.requestedBounds).toEqual(requestedBounds);
    expect(result.clippedBounds).toEqual({ left: 0, top: 2, right: 3, bottom: 5 });
  });

  test("uses actual raster ratio on downsampled Display Zoom captures", async () => {
    const result = await cropSnapshot(
      source,
      { left: 1, top: 1, right: 3, bottom: 3 },
      { platform: "ios", screenSize: { width: 4, height: 4 }, nativeScale: 3 },
      backend(8, 8),
    );
    expect(result.pixelsPerNativeUnit).toEqual({ x: 2, y: 2 });
    expect(result.scaleProvenance).toBe("raster-dimensions");
    expect(result.imageSize).toEqual({ width: 4, height: 4 });
  });

  test("maps rotated iOS landscape points into portrait framebuffer", async () => {
    const result = await cropSnapshot(
      source,
      { left: 1, top: 0, right: 3, bottom: 2 },
      { platform: "ios", screenSize: { width: 6, height: 4 }, rotation: 1 },
      backend(8, 12),
    );
    expect(result.rasterBounds).toEqual({ left: 0, top: 6, right: 4, bottom: 10 });
    expect(result.screenshotOrientation).toBe("native");
  });

  test("rejects empty and out-of-screen rectangles", async () => {
    const geometry = { platform: "android" as const, screenSize: { width: 5, height: 5 } };
    await expect(
      cropSnapshot(source, { left: 1, top: 1, right: 1, bottom: 2 }, geometry, backend(5, 5)),
    ).rejects.toThrow("nonempty");
    await expect(
      cropSnapshot(source, { left: 7, top: 1, right: 8, bottom: 2 }, geometry, backend(5, 5)),
    ).rejects.toThrow("outside");
  });
});
