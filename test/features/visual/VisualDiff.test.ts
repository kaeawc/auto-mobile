import { describe, expect, test } from "bun:test";
import { buildIgnoreMask, diffPngs } from "../../../src/features/visual/VisualDiff";
import { solidPng, type Rgba } from "../../helpers/pngFixtures";

const WHITE: Rgba = [255, 255, 255, 255];
const BLACK: Rgba = [0, 0, 0, 255];

describe("diffPngs (#14083)", () => {
  test("identical images match with no diff image", () => {
    const result = diffPngs(solidPng(8, 8, WHITE), solidPng(8, 8, WHITE));
    expect(result).toEqual({
      match: true,
      width: 8,
      height: 8,
      diffPixels: 0,
      comparedPixels: 64,
      diffRatio: 0,
    });
  });

  test("a changed pixel is a mismatch with a diff image", () => {
    const result = diffPngs(
      solidPng(8, 8, WHITE),
      solidPng(8, 8, WHITE, [{ x: 3, y: 3, color: BLACK }]),
    );
    if (result === "size_mismatch") {
      throw new Error("unexpected size mismatch");
    }
    expect(result.match).toBe(false);
    expect(result.diffPixels).toBe(1);
    expect(result.diffRatio).toBe(1 / 64);
    expect(result.diffPng?.subarray(1, 4).toString()).toBe("PNG");
  });

  test("a masked change matches and masked pixels leave the denominator", () => {
    const result = diffPngs(
      solidPng(8, 8, WHITE),
      solidPng(8, 8, WHITE, [{ x: 3, y: 3, color: BLACK }]),
      { ignore: [{ left: 2, top: 2, right: 4, bottom: 4 }] },
    );
    expect(result).toMatchObject({ match: true, diffPixels: 0, comparedPixels: 60 });
  });

  test("pixelRatio tolerates a small share of differing pixels", () => {
    const changed = solidPng(8, 8, WHITE, [{ x: 0, y: 0, color: BLACK }]);
    expect(diffPngs(solidPng(8, 8, WHITE), changed, { pixelRatio: 0.02 })).toMatchObject({
      match: true,
      diffPixels: 1,
    });
  });

  test("perPixelDelta decides how far a colour may drift", () => {
    const grey = solidPng(4, 4, [250, 250, 250, 255]);
    expect(diffPngs(solidPng(4, 4, WHITE), grey)).toMatchObject({ match: true });
    expect(diffPngs(solidPng(4, 4, WHITE), grey, { perPixelDelta: 0 })).toMatchObject({
      match: false,
    });
  });

  test("different sizes are a size mismatch, not a stretched comparison", () => {
    expect(diffPngs(solidPng(8, 8, WHITE), solidPng(8, 9, WHITE))).toBe("size_mismatch");
  });
});

describe("buildIgnoreMask", () => {
  test("clamps rectangles to the image and rounds outward", () => {
    const mask = buildIgnoreMask(4, 2, [{ left: -1, top: 0.5, right: 1.2, bottom: 9 }]);
    expect([...mask]).toEqual([1, 1, 0, 0, 1, 1, 0, 0]);
  });
});
