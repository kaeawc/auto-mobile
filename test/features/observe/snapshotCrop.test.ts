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

  test.each([
    [1, { left: 906, top: 0, right: 1206, bottom: 600 }, 270],
    [3, { left: 0, top: 2022, right: 300, bottom: 2622 }, 90],
  ] as const)(
    "maps rotated iOS landscape points into portrait framebuffer (rotation %s)",
    async (rotation, rasterBounds, degrees) => {
      const image = backend(1206, 2622);
      const result = await cropSnapshot(
        source,
        { left: 0, top: 0, right: 200, bottom: 100 },
        { platform: "ios", screenSize: { width: 874, height: 402 }, rotation, nativeScale: 3 },
        image,
      );
      // #8780 device evidence: rotation 1's display top-left is the native raster top-right.
      expect(result.rasterBounds).toEqual(rasterBounds);
      expect(result.imageSize).toEqual({ width: 600, height: 300 });
      expect(result.screenshotOrientation).toBe("display");
      expect(image.lastPipeline?.operations).toEqual([
        { type: "crop", x: rasterBounds.left, y: rasterBounds.top, width: 300, height: 600 },
        { type: "rotate", degrees },
      ]);
    },
  );

  test("maps and normalizes an upside-down native iOS framebuffer", async () => {
    const image = backend(8, 12);
    const result = await cropSnapshot(
      source,
      { left: 0, top: 1, right: 3, bottom: 3 },
      { platform: "ios", screenSize: { width: 4, height: 6 }, rotation: 2 },
      image,
    );
    expect(result.rasterBounds).toEqual({ left: 2, top: 6, right: 8, bottom: 10 });
    expect(result.imageSize).toEqual({ width: 6, height: 4 });
    expect(result.screenshotOrientation).toBe("display");
    expect(image.lastPipeline?.operations).toEqual([
      { type: "crop", x: 2, y: 6, width: 6, height: 4 },
      { type: "rotate", degrees: 180 },
    ]);
  });

  test.each([
    [1, [120, 0, 0, 255, 120, 40, 0, 255]],
    [3, [0, 200, 0, 255, 0, 160, 0, 255]],
    [2, [120, 120, 0, 255, 80, 120, 0, 255]],
  ] as const)(
    "real PNG rotation %s returns the correct corner upright",
    async (rotation, expectedPixels) => {
      // Synthetic coordinate-colored raster, not a captured hierarchy/parser fixture.
      const sharp = await loadSharp();
      const pixels = Buffer.alloc(4 * 6 * 4);
      for (let y = 0; y < 6; y++) {
        for (let x = 0; x < 4; x++) {
          pixels.set([x * 40, y * 40, 0, 255], (y * 4 + x) * 4);
        }
      }
      const png =
        rotation === 2
          ? realPng
          : await sharp(pixels, { raw: { width: 4, height: 6, channels: 4 } })
              .png()
              .toBuffer();
      const result = await cropSnapshot(
        png,
        { left: 0, top: 0, right: 2, bottom: 1 },
        {
          platform: "ios",
          screenSize: rotation === 2 ? { width: 4, height: 4 } : { width: 6, height: 4 },
          rotation,
        },
        realBackend,
      );
      const raw = await realBackend.rawPixels(result.png);
      expect(result.imageSize).toEqual({ width: 2, height: 1 });
      expect({ width: raw.width, height: raw.height }).toEqual(result.imageSize);
      // Check every output pixel: wrong corner, swapped direction, or sideways output all fail.
      expect([...raw.data]).toEqual([...expectedPixels]);
    },
  );

  test.each([1, 2, 3])(
    "already display-oriented iOS rotation %s stays unchanged",
    async (rotation) => {
      const image = backend(12, 8);
      const result = await cropSnapshot(
        source,
        { left: 1, top: 0, right: 3, bottom: 1 },
        {
          platform: "ios",
          screenSize: { width: 6, height: 4 },
          rotation,
          rasterOrientation: "display",
        },
        image,
      );
      expect(result.imageSize).toEqual({ width: 4, height: 2 });
      expect(image.lastPipeline?.operations).toEqual([
        { type: "crop", x: 2, y: 0, width: 4, height: 2 },
      ]);
    },
  );

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
