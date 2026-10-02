import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { resolveImageRelativePoint as resolve } from "../../../src/features/action/imageRelativePoint";
import { ActionableError } from "../../../src/models/ActionableError";
import type {
  ImageRelativePoint,
  ImagePointSource,
  ImageRotation,
} from "../../../src/models/ImageRelativePoint";
import { cropSource } from "../../helpers/imageRelativePoint";

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
          ? { x: 0.5, y: 0.75 }
          : rotation === 3
            ? { x: 0.5, y: 0.25 }
            : rotation === 2
              ? { x: 0.75, y: 0.5 }
              : { x: 0.25, y: 0.5 };
      expect(resolve(image(crop, fractions.x, fractions.y), "ios", screenSize)).toEqual({
        x: 22.5,
        y: 60,
      });
      expect(
        resolve(
          image(
            crop,
            fractions.x * crop.crop.imageSize.width,
            fractions.y * crop.crop.imageSize.height,
            "pixels",
          ),
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
});
