import { beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { resolveImageRelativePoint as resolve } from "../../../src/features/action/imageRelativePoint";
import { ActionableError } from "../../../src/models/ActionableError";
import type {
  ImageRelativePoint,
  ImagePointSource,
  ImageRotation,
} from "../../../src/models/ImageRelativePoint";
import { cropSource } from "../../helpers/imageRelativePoint";
import { SharpBackend } from "../../../src/utils/image/backend/SharpBackend";
import { loadSharp } from "../../../src/utils/image/loadSharp";

const screen = { width: 100, height: 200 };
const bounds = { left: 10, top: 20, right: 60, bottom: 100 };
const image = (
  source: ImagePointSource,
  x = 0.25,
  y = 0.5,
  unit: ImageRelativePoint["unit"] = "normalized",
): ImageRelativePoint => ({ unit, x, y, source });
const full = (
  extra: Partial<Extract<ImagePointSource, { screenshot: unknown }>["screenshot"]> = {},
): ImagePointSource => ({
  screenshot: { screenSize: screen, screenshotOrientation: "display", ...extra },
});

describe("image-relative native coordinates", () => {
  test("Android identity conversion", async () => {
    const source = await cropSource({ platform: "android", screenSize: screen }, screen, bounds);
    expect(resolve(image(source, 5, 10, "pixels"), "android", screen)).toEqual({ x: 15, y: 30 });
    expect(
      resolve(image(full({ imageSize: screen }), 25, 100, "pixels"), "android", screen),
    ).toEqual({ x: 25, y: 100 });
  });
  test.each([2, 3, 2.75, 1.5])(
    "iOS scale %s: Retina, Display Zoom, and downsampled",
    async (scale) => {
      const source = await cropSource(
        { platform: "ios", screenSize: screen, nativeScale: 3 },
        { width: 100 * scale, height: 200 * scale },
        bounds,
      );
      expect(resolve(image(source, 10 * scale, 20 * scale, "pixels"), "ios", screen)).toEqual({
        x: scale === 2.75 ? 19.818181818181817 : 20,
        y: 40,
      });
      expect(resolve(image(source), "ios", screen)).toEqual({ x: 22.5, y: 60 });
      expect(
        resolve(
          image(
            full({ imageSize: { width: 100 * scale, height: 200 * scale }, nativeScale: 3 }),
            20 * scale,
            40 * scale,
            "pixels",
          ),
          "ios",
          screen,
        ),
      ).toEqual({ x: 20, y: 40 });
    },
  );
  test("fractional crops: normalized spans clipped bounds; pixels preserve raster padding", async () => {
    const source = await cropSource(
      { platform: "ios", screenSize: screen },
      { width: 300, height: 600 },
      { left: 0.25, top: 1.5, right: 2.25, bottom: 3.1 },
    );
    expect(resolve(image(source, 0, 0), "ios", screen)).toEqual({ x: 0.25, y: 1.5 });
    expect(resolve(image(source, 0, 0, "pixels"), "ios", screen)).toEqual({ x: 0, y: 4 / 3 });
    expect(resolve(image(source, 0.5, 0.5), "ios", screen)).toEqual({ x: 1.25, y: 2.3 });
    expect(resolve(image(source, 6, 5, "pixels"), "ios", screen)).toEqual({ x: 2, y: 3 });
  });
  test.each([0, 1, 2, 3] as ImageRotation[])(
    "aligns native iOS orientation %s before normalized and pixel resolution",
    async (rotation) => {
      const landscape = rotation === 1 || rotation === 3;
      const screenSize = landscape ? { width: 200, height: 100 } : screen;
      const rawSize = { width: 300, height: 600 };
      const geometry = {
        platform: "ios" as const,
        screenSize,
        rotation,
        rasterOrientation: "native" as const,
      };
      const crop = await cropSource(geometry, rawSize, bounds);
      const fractions =
        rotation === 1
          ? { x: 0.5, y: 0.25 }
          : rotation === 3
            ? { x: 0.5, y: 0.75 }
            : rotation === 2
              ? { x: 0.75, y: 0.5 }
              : { x: 0.25, y: 0.5 };
      // Crop output is upright for every source rotation.
      expect(resolve(image(crop, 0.25, 0.5), "ios", screenSize)).toEqual({
        x: 22.5,
        y: 60,
      });
      expect(
        resolve(
          image(crop, 0.25 * crop.crop.imageSize.width, 0.5 * crop.crop.imageSize.height, "pixels"),
          "ios",
          screenSize,
        ),
      ).toEqual({ x: 22.5, y: 60 });
      const source: ImagePointSource = {
        screenshot: { screenSize, screenshotOrientation: "native", rotation, imageSize: rawSize },
      };
      expect(resolve(image(source, fractions.x, fractions.y), "ios", screenSize)).toEqual({
        x: screenSize.width * 0.25,
        y: screenSize.height * 0.5,
      });
      expect(
        resolve(image(source, fractions.x * 300, fractions.y * 600, "pixels"), "ios", screenSize),
      ).toEqual({ x: screenSize.width * 0.25, y: screenSize.height * 0.5 });
    },
  );
  test.each([0, 1, 2, 3] as ImageRotation[])(
    "normalized is invariant to viewed raster resolution, full screen and clipped crop rotation %s",
    async (rotation) => {
      const screenSize = rotation === 1 || rotation === 3 ? { width: 200, height: 100 } : screen;
      const geometry = {
        platform: "ios" as const,
        screenSize,
        rotation,
        rasterOrientation: "native" as const,
      };
      const small = await cropSource(
        geometry,
        { width: 200, height: 400 },
        { left: -10, top: 20, right: 60, bottom: 100 },
      );
      const large = await cropSource(
        geometry,
        { width: 300, height: 600 },
        small.crop.requestedBounds,
      );
      expect(resolve(image(small), "ios", screenSize)).toEqual(
        resolve(image(large), "ios", screenSize),
      );
      const source: ImagePointSource = {
        screenshot: { screenSize, screenshotOrientation: "native", rotation },
      };
      const withRaster: ImagePointSource = {
        screenshot: { ...source.screenshot, imageSize: { width: 300, height: 600 } },
      };
      expect(resolve(image(source), "ios", screenSize)).toEqual(
        resolve(image(withRaster), "ios", screenSize),
      );
    },
  );
  test("property: crop translation round trip and half-open edges", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -20, max: 80 }),
        fc.integer({ min: -20, max: 150 }),
        fc.integer({ min: 21, max: 100 }),
        fc.integer({ min: 21, max: 200 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        async (left, top, width, height, x, y) => {
          const source = await cropSource(
            { platform: "ios", screenSize: screen },
            { width: 300, height: 600 },
            { left, top, right: left + width, bottom: top + height },
          );
          const b = source.crop.clippedBounds;
          for (const [u, v] of [
            [x, y],
            [0, 0],
            [1, 1],
          ]) {
            const point = resolve(image(source, u, v), "ios", screen);
            expect(point.x).toBeGreaterThanOrEqual(b.left);
            expect(point.x).toBeLessThan(b.right);
            expect(point.y).toBeGreaterThanOrEqual(b.top);
            expect(point.y).toBeLessThan(b.bottom);
            expect(Math.abs((point.x - b.left) / (b.right - b.left) - u)).toBeLessThan(1e-12);
            expect(Math.abs((point.y - b.top) / (b.bottom - b.top) - v)).toBeLessThan(1e-12);
          }
        },
      ),
      { seed: 7341, numRuns: 40 },
    );
  });
  test("property: rotated normalized edges remain inside clipped bounds", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<ImageRotation>(1, 2, 3),
        fc.constantFrom(0, 0.25, 0.75, 1),
        fc.constantFrom(0, 0.25, 0.75, 1),
        async (rotation, x, y) => {
          const screenSize = rotation === 2 ? screen : { width: 200, height: 100 };
          const source = await cropSource(
            { platform: "ios", screenSize, rotation },
            { width: 300, height: 600 },
            bounds,
          );
          const point = resolve(image(source, x, y), "ios", screenSize);
          expect(point.x).toBeGreaterThanOrEqual(bounds.left);
          expect(point.x).toBeLessThan(bounds.right);
          expect(point.y).toBeGreaterThanOrEqual(bounds.top);
          expect(point.y).toBeLessThan(bounds.bottom);
        },
      ),
      { seed: 7342, numRuns: 30 },
    );
  });
  test("pixels half-open edge and unit mix-ups name the declared unit", async () => {
    const source = await cropSource({ platform: "android", screenSize: screen }, screen, bounds);
    for (const point of [
      image(source, 320, 0),
      image(source, -0.01, 0),
      image(source, NaN, 0),
      image(source, Infinity, 0),
    ]) {
      expect(() => resolve(point, "android", screen)).toThrow(
        "normalized coordinates must be in [0, 1]",
      );
    }
    for (const point of [
      image(source, 50, 0, "pixels"),
      image(source, 0, 80, "pixels"),
      image(source, -1, 0, "pixels"),
      image(source, Infinity, 0, "pixels"),
    ]) {
      expect(() => resolve(point, "android", screen)).toThrow(
        "pixels coordinates must be in [0, 50)",
      );
    }
    expect(resolve(image(source, 49.999, 79.999, "pixels"), "android", screen)).toEqual({
      x: 59.999,
      y: 99.999,
    });
    expect(() =>
      resolve(image(full({ imageSize: { width: 1, height: 2 } }), 1, 0, "pixels"), "ios", screen),
    ).toThrow("pixels coordinates");
  });
  test("rejects missing orientation, rotation, pixel dimensions, stale geometry and inconsistent scale", () => {
    for (const source of [
      full({ screenshotOrientation: undefined }),
      full({ screenshotOrientation: "native" }),
      full({ nativeScale: NaN }),
      full({ imageSize: { width: 300, height: 500 } }),
      full({ screenSize: { width: 101, height: 200 } }),
      full({ screenSize: { width: 0, height: 200 } }),
    ]) {
      expect(() => resolve(image(source), "ios", screen)).toThrow(ActionableError);
    }
    expect(() => resolve(image(full(), 0, 0, "pixels"), "ios", screen)).toThrow(
      "pixels requires imageSize",
    );
    expect(() =>
      resolve(image(full({ imageSize: { width: 200, height: 400 } })), "android", screen),
    ).toThrow("scale 1");
    expect(resolve(image(full({ imageSize: { width: 200, height: 403 } })), "ios", screen)).toEqual(
      { x: 25, y: 100 },
    );
    expect(() =>
      resolve(image(full({ imageSize: { width: 200, height: 405 } })), "ios", screen),
    ).toThrow("aspect ratio");
  });
  test.each([1, 2, 3] as ImageRotation[])(
    "pixel origin on reversed iOS crop axes is half-open for rotation %s",
    async (rotation) => {
      const screenSize = rotation === 2 ? screen : { width: 200, height: 100 };
      const source = await cropSource(
        { platform: "ios", screenSize, rotation },
        { width: 300, height: 600 },
        bounds,
      );
      const origin = resolve(image(source, 0, 0, "pixels"), "ios", screenSize);
      expect(origin.x).toBeGreaterThanOrEqual(bounds.left);
      expect(origin.x).toBeLessThan(bounds.right);
      expect(origin.y).toBeGreaterThanOrEqual(bounds.top);
      expect(origin.y).toBeLessThan(bounds.bottom);
      const fullOrigin = resolve(
        image(
          {
            screenshot: {
              screenSize,
              screenshotOrientation: "native",
              rotation,
              imageSize: { width: 300, height: 600 },
            },
          },
          0,
          0,
          "pixels",
        ),
        "ios",
        screenSize,
      );
      expect(fullOrigin.x).toBeGreaterThanOrEqual(0);
      expect(fullOrigin.x).toBeLessThan(screenSize.width);
      expect(fullOrigin.y).toBeGreaterThanOrEqual(0);
      expect(fullOrigin.y).toBeLessThan(screenSize.height);
    },
  );
  test("missing crop scale or orientation is an actionable failure", async () => {
    const source = await cropSource(
      { platform: "ios", screenSize: screen },
      { width: 300, height: 600 },
      bounds,
    );
    for (const field of [
      "pixelsPerNativeUnit",
      "scaleProvenance",
      "screenshotOrientation",
      "imageSize",
      "rasterBounds",
      "clippedBounds",
    ]) {
      const missing = structuredClone(source);
      Reflect.deleteProperty(missing.crop, field);
      expect(() => resolve(image(missing), "ios", screen)).toThrow(ActionableError);
    }
  });
  test("a tiny fractional crop retains an in-bounds representable endpoint", async () => {
    const tiny = { left: 50, top: 20, right: 50 + 8 * Number.EPSILON * 4, bottom: 100 };
    const source = await cropSource(
      { platform: "ios", screenSize: screen },
      { width: 300, height: 600 },
      tiny,
    );
    const point = resolve(image(source, 1, 1), "ios", screen);
    expect(point.x).toBeGreaterThanOrEqual(tiny.left);
    expect(point.x).toBeLessThan(tiny.right);
  });
  test("rejects inconsistent crop metadata", async () => {
    const source = await cropSource(
      { platform: "ios", screenSize: screen },
      { width: 300, height: 600 },
      bounds,
    );
    const changes: Array<Partial<typeof source.crop>> = [
      { imageSize: { width: 149, height: 240 } },
      { pixelsPerNativeUnit: { x: 2, y: 3 } },
      { pixelsPerNativeUnit: { x: NaN, y: 3 } },
      { rasterBounds: { left: 31, top: 60, right: 181, bottom: 300 } },
      { clippedBounds: { ...bounds, left: 11 } },
      { clipped: true },
      { unit: "pixels" },
    ];
    for (const change of changes) {
      expect(() =>
        resolve(image({ ...source, crop: { ...source.crop, ...change } }), "ios", screen),
      ).toThrow(ActionableError);
    }
    expect(() =>
      resolve(
        image({
          ...source,
          crop: { ...source.crop, screenshotOrientation: "native" },
          rotation: undefined,
        }),
        "ios",
        screen,
      ),
    ).toThrow("requires observe.rotation");
  });
  test("symmetric upright crops accept equivalent source mappings", async () => {
    const screenSize = { width: 200, height: 100 };
    const source = await cropSource(
      { platform: "ios", screenSize, rotation: 1 },
      { width: 200, height: 400 },
      { left: 20, top: 20, right: 80, bottom: 80 },
    );
    expect(resolve(image(source, 2, 4, "pixels"), "ios", screenSize)).toEqual({ x: 21, y: 22 });
  });
  test("ambiguous fractional source padding fails pixels without blocking normalized coordinates", async () => {
    const screenSize = { width: 400, height: 200 };
    const source = await cropSource(
      { platform: "ios", screenSize, rotation: 1 },
      { width: 399, height: 800 },
      { left: 40.12, top: 40.04, right: 159.96, bottom: 159.88 },
    );
    expect(source.crop.rasterBounds).toEqual({ left: 80, top: 80, right: 320, bottom: 320 });
    expect(() => resolve(image(source, 0, 0, "pixels"), "ios", screenSize)).toThrow(
      "pixel padding is ambiguous",
    );
    expect(resolve(image(source, 0, 0), "ios", screenSize)).toEqual({ x: 40.12, y: 40.04 });
  });
});

describe("upright framebuffer crop pixels resolve in native display space", () => {
  const backend = new SharpBackend();
  let source: Buffer;
  beforeAll(async () => {
    const pixels = Buffer.alloc(8 * 12 * 4);
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 8; x++) {
        pixels.set([x * 16, y * 16, 0, 255], (y * 8 + x) * 4);
      }
    }
    const sharp = await loadSharp();
    source = await sharp(pixels, { raw: { width: 8, height: 12, channels: 4 } })
      .png()
      .toBuffer();
  });
  test.each([
    [
      1,
      { left: 3, top: 1, right: 7, bottom: 7 },
      [
        [
          [6, 1],
          [6, 2],
          [6, 3],
          [6, 4],
          [6, 5],
          [6, 6],
        ],
        [
          [5, 1],
          [5, 2],
          [5, 3],
          [5, 4],
          [5, 5],
          [5, 6],
        ],
        [
          [4, 1],
          [4, 2],
          [4, 3],
          [4, 4],
          [4, 5],
          [4, 6],
        ],
        [
          [3, 1],
          [3, 2],
          [3, 3],
          [3, 4],
          [3, 5],
          [3, 6],
        ],
      ],
    ],
    [
      3,
      { left: 1, top: 5, right: 5, bottom: 11 },
      [
        [
          [1, 10],
          [1, 9],
          [1, 8],
          [1, 7],
          [1, 6],
          [1, 5],
        ],
        [
          [2, 10],
          [2, 9],
          [2, 8],
          [2, 7],
          [2, 6],
          [2, 5],
        ],
        [
          [3, 10],
          [3, 9],
          [3, 8],
          [3, 7],
          [3, 6],
          [3, 5],
        ],
        [
          [4, 10],
          [4, 9],
          [4, 8],
          [4, 7],
          [4, 6],
          [4, 5],
        ],
      ],
    ],
    [
      2,
      { left: 1, top: 7, right: 7, bottom: 11 },
      [
        [
          [6, 10],
          [5, 10],
          [4, 10],
          [3, 10],
          [2, 10],
          [1, 10],
        ],
        [
          [6, 9],
          [5, 9],
          [4, 9],
          [3, 9],
          [2, 9],
          [1, 9],
        ],
        [
          [6, 8],
          [5, 8],
          [4, 8],
          [3, 8],
          [2, 8],
          [1, 8],
        ],
        [
          [6, 7],
          [5, 7],
          [4, 7],
          [3, 7],
          [2, 7],
          [1, 7],
        ],
      ],
    ],
  ] as const)(
    "real synthetic crop rotation %s preserves pixels and snapping",
    async (rotation, rasterBounds, rows) => {
      const screenSize = rotation === 2 ? { width: 4, height: 6 } : { width: 6, height: 4 };
      const geometry = { platform: "ios" as const, screenSize, rotation };
      let output = Buffer.alloc(0);
      const crop = await cropSource(
        geometry,
        { width: 8, height: 12 },
        { left: 0.75, top: 0.75, right: 3.25, bottom: 2.25 },
        {
          source,
          backend,
          onPng: (png) => {
            output = png;
          },
        },
      );
      expect(crop.crop.rasterBounds).toEqual(rasterBounds);
      expect(crop.crop.imageSize).toEqual({ width: 6, height: 4 });
      expect(crop.crop.screenshotOrientation).toBe("display");
      const raw = await backend.rawPixels(output);
      expect({ width: raw.width, height: raw.height }).toEqual({ width: 6, height: 4 });
      expect([...raw.data]).toEqual(rows.flat().flatMap(([x, y]) => [x * 16, y * 16, 0, 255]));
      // Every turn snaps the upright native origin to (0.5, 0.5), at scale 2.
      expect(resolve(image(crop, 0, 0, "pixels"), "ios", screenSize)).toEqual({ x: 0.5, y: 0.5 });
      expect(resolve(image(crop, 2, 1, "pixels"), "ios", screenSize)).toEqual({ x: 1.5, y: 1 });
      // Normalized coordinates span the clipped request, excluding raster padding.
      expect(resolve(image(crop, 0.25, 0.5), "ios", screenSize)).toEqual({ x: 1.375, y: 1.5 });
    },
  );
});
