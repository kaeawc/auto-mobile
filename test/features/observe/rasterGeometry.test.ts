import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  nativeToRasterPoint,
  rasterToNativePoint,
  rasterScreenSize,
} from "../../../src/features/observe/screenshot/rasterGeometry";

test.each([
  [0, { x: 2, y: 1 }],
  [1, { x: 3, y: 2 }],
  [2, { x: 4, y: 3 }],
  [3, { x: 1, y: 4 }],
] as const)("hand-computed point and inverse for turn %s", (turn, raster) => {
  const screen = { width: 6, height: 4 };
  expect(nativeToRasterPoint({ x: 2, y: 1 }, screen, turn)).toEqual(raster);
  expect(rasterToNativePoint(raster, screen, turn)).toEqual({ x: 2, y: 1 });
});

test("property: both directions round trip within rasterScreenSize for every turn", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 1000 }),
      fc.integer({ min: 1, max: 1000 }),
      fc.integer({ min: 0, max: 1000 }),
      fc.integer({ min: 0, max: 1000 }),
      (width, height, u, v) => {
        const screen = { width, height };
        for (const turn of [0, 1, 2, 3]) {
          const rawScreen = rasterScreenSize(screen, turn);
          const native = { x: u % (width + 1), y: v % (height + 1) };
          const raster = nativeToRasterPoint(native, screen, turn);
          expect(raster.x).toBeGreaterThanOrEqual(0);
          expect(raster.y).toBeGreaterThanOrEqual(0);
          expect(raster.x).toBeLessThanOrEqual(rawScreen.width);
          expect(raster.y).toBeLessThanOrEqual(rawScreen.height);
          expect(rasterToNativePoint(raster, screen, turn)).toEqual(native);
          const raw = { x: u % (rawScreen.width + 1), y: v % (rawScreen.height + 1) };
          expect(nativeToRasterPoint(rasterToNativePoint(raw, screen, turn), screen, turn)).toEqual(
            raw,
          );
        }
      },
    ),
    { seed: 8780, numRuns: 40 },
  );
});
