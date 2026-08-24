import { describe, expect, it } from "bun:test";
import {
  COORDINATE_SPACE_PX,
  canonicalPixelsToPoints,
  convertHierarchyToCanonicalPixels,
  roundHalfAwayFromZero,
} from "../../src/daemon/canonicalPixels";
import type { ViewHierarchyResult } from "../../src/models";
import { loadCoordinateMappingVectors } from "../parity/coordinateMappingGoldenVectors";

describe("roundHalfAwayFromZero", () => {
  it("rounds ties away from zero like Swift Double.rounded()", () => {
    expect(roundHalfAwayFromZero(0.5)).toBe(1);
    expect(roundHalfAwayFromZero(1.5)).toBe(2);
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(3.5)).toBe(4);
    expect(roundHalfAwayFromZero(-0.5)).toBe(-1);
    expect(roundHalfAwayFromZero(-1.5)).toBe(-2);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
  });

  it("rounds non-ties to the nearest integer", () => {
    expect(roundHalfAwayFromZero(0.49)).toBe(0);
    expect(roundHalfAwayFromZero(0.51)).toBe(1);
    expect(roundHalfAwayFromZero(937.5)).toBe(938);
    expect(roundHalfAwayFromZero(1667.5)).toBe(1668);
    expect(roundHalfAwayFromZero(-937.4)).toBe(-937);
  });

  it("normalizes -0 to 0 and passes non-finite values through", () => {
    expect(Object.is(roundHalfAwayFromZero(-0.4), 0)).toBe(true);
    expect(roundHalfAwayFromZero(Number.NaN)).toBeNaN();
    expect(roundHalfAwayFromZero(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("canonicalPixelsToPoints", () => {
  it("divides pixels by nativeScale EXACTLY, preserving fractional points for the runner", () => {
    expect(canonicalPixelsToPoints(1170, 3)).toBe(390);
    expect(canonicalPixelsToPoints(750, 2)).toBe(375);
    // The runner accepts fractional Double points, so the divide must NOT quantize.
    expect(canonicalPixelsToPoints(401, 2)).toBe(200.5); // not 200
    expect(canonicalPixelsToPoints(1, 3)).toBeCloseTo(1 / 3, 12); // not 0
    expect(canonicalPixelsToPoints(938, 2.5)).toBe(375.2); // not 375
  });

  it("is the identity for nativeScale 1 or a degenerate scale", () => {
    expect(canonicalPixelsToPoints(585, 1)).toBe(585);
    expect(canonicalPixelsToPoints(585, 0)).toBe(585);
    expect(canonicalPixelsToPoints(585, -3)).toBe(585);
    expect(canonicalPixelsToPoints(585, Number.NaN)).toBe(585);
  });
});

describe("convertHierarchyToCanonicalPixels", () => {
  const baseHierarchy = (): ViewHierarchyResult => ({
    hierarchy: {
      bounds: { left: 0, top: 0, right: 390, bottom: 844 },
      node: {
        $: { bounds: { left: 10, top: 20, right: 100, bottom: 60 } },
        node: [{ $: { bounds: { left: 5, top: 5, right: 15, bottom: 25 } } }],
      },
    },
    screenWidth: 390,
    screenHeight: 844,
  });

  it("scales element bounds by nativeScale and adopts reported pixel screen dims (iOS 3x)", () => {
    const hierarchy = baseHierarchy();
    convertHierarchyToCanonicalPixels(hierarchy, {
      nativeScale: 3,
      pixelWidth: 1170,
      pixelHeight: 2532,
    });

    expect(hierarchy.screenWidth).toBe(1170);
    expect(hierarchy.screenHeight).toBe(2532);
    expect(hierarchy.hierarchy.node!.$["bounds"]).toEqual({
      left: 30,
      top: 60,
      right: 300,
      bottom: 180,
    });
    expect(hierarchy.hierarchy.node!.node![0].$["bounds"]).toEqual({
      left: 15,
      top: 15,
      right: 45,
      bottom: 75,
    });
    expect(hierarchy.hierarchy.bounds).toEqual({ left: 0, top: 0, right: 1170, bottom: 2532 });
  });

  it("uses round-half-away-from-zero for fractional nativeScale (Display Zoom / Plus downsampling)", () => {
    const hierarchy: ViewHierarchyResult = {
      hierarchy: { node: { $: { bounds: { left: 0, top: 0, right: 375, bottom: 812 } } } },
      screenWidth: 375,
      screenHeight: 812,
    };
    convertHierarchyToCanonicalPixels(hierarchy, {
      nativeScale: 2.5,
      pixelWidth: 938,
      pixelHeight: 2030,
    });
    // 375*2.5 = 937.5 -> 938; 812*2.5 = 2030 (integral)
    expect(hierarchy.hierarchy.node!.$["bounds"]).toEqual({
      left: 0,
      top: 0,
      right: 938,
      bottom: 2030,
    });
  });

  it("leaves element bounds untouched at nativeScale 1 (Android) but still adopts reported screen dims", () => {
    const hierarchy = baseHierarchy();
    convertHierarchyToCanonicalPixels(hierarchy, {
      nativeScale: 1,
      pixelWidth: 390,
      pixelHeight: 844,
    });
    expect(hierarchy.hierarchy.node!.$["bounds"]).toEqual({
      left: 10,
      top: 20,
      right: 100,
      bottom: 60,
    });
    expect(hierarchy.screenWidth).toBe(390);
    expect(hierarchy.screenHeight).toBe(844);
  });

  it("does not corrupt non-object bounds forms (string/array)", () => {
    const hierarchy: ViewHierarchyResult = {
      hierarchy: { node: { $: { bounds: "[0,0][100,200]" } } as any },
      screenWidth: 100,
      screenHeight: 200,
    };
    convertHierarchyToCanonicalPixels(hierarchy, {
      nativeScale: 3,
      pixelWidth: 300,
      pixelHeight: 600,
    });
    expect(hierarchy.hierarchy.node!.$["bounds"]).toBe("[0,0][100,200]");
  });

  describe("golden iosPointToPixel: element bounds point->pixel conversion", () => {
    // Each flagged golden row is a (pointWidth x pointHeight) rect converted to canonical pixels via
    // the runner-reported nativeScale. scale=0 encodes a pre-#4548 runner (no metadata), so the
    // daemon leaves bounds untouched — the caller never invokes this conversion (see the
    // legacy-fallback pushHierarchyUpdate test); we assert that identity here for completeness.
    const vectors = loadCoordinateMappingVectors().iosPointToPixel;
    for (const [index, vector] of vectors.entries()) {
      it(`row ${index}: ${vector.pointWidth}x${vector.pointHeight} @ ${vector.scale || "no-metadata"} -> ${vector.expectedPixelWidth}x${vector.expectedPixelHeight}`, () => {
        const hierarchy: ViewHierarchyResult = {
          hierarchy: {
            node: {
              $: {
                bounds: { left: 0, top: 0, right: vector.pointWidth, bottom: vector.pointHeight },
              },
            },
          },
          screenWidth: vector.pointWidth,
          screenHeight: vector.pointHeight,
        };
        if (vector.scale === 0) {
          // No metadata: the daemon never converts; bounds stay point-space (identity).
          expect(vector.expectedPixelWidth).toBe(vector.pointWidth);
          expect(vector.expectedPixelHeight).toBe(vector.pointHeight);
          return;
        }
        convertHierarchyToCanonicalPixels(hierarchy, {
          nativeScale: vector.scale,
          pixelWidth: vector.expectedPixelWidth,
          pixelHeight: vector.expectedPixelHeight,
        });
        expect(hierarchy.hierarchy.node!.$["bounds"]).toEqual({
          left: 0,
          top: 0,
          right: vector.expectedPixelWidth,
          bottom: vector.expectedPixelHeight,
        });
      });
    }
  });

  describe("golden iosPointToPixel: point -> pixel -> point round-trip", () => {
    // The publish path converts a point bound to pixels (roundHalfAwayFromZero(point * nativeScale), integer
    // pixel coords); the input path converts a client pixel coordinate back to points by an EXACT
    // divide (/ nativeScale). Because the divide adds no rounding, the round-trip error is only the
    // single publish-side integer-pixel quantization: at most 0.5/nativeScale <= 0.5 of a point.
    const vectors = loadCoordinateMappingVectors().iosPointToPixel;
    for (const [index, vector] of vectors.entries()) {
      if (vector.scale === 0) {
        continue;
      }
      it(`row ${index}: nativeScale ${vector.scale}`, () => {
        for (const point of [
          0,
          1,
          vector.pointWidth / 2,
          vector.pointWidth - 1,
          vector.pointWidth,
        ]) {
          const pixels = roundHalfAwayFromZero(point * vector.scale);
          const back = canonicalPixelsToPoints(pixels, vector.scale);
          expect(Math.abs(back - point)).toBeLessThanOrEqual(0.5 / vector.scale + 1e-12);
        }
      });
    }

    it("is EXACT when the pixel product is integral (no divide-side rounding)", () => {
      // 390pt @ 3x -> 1170px -> 390.000pt exactly; 375pt @ 2x -> 750px -> 375pt exactly.
      expect(canonicalPixelsToPoints(roundHalfAwayFromZero(390 * 3), 3)).toBe(390);
      expect(canonicalPixelsToPoints(roundHalfAwayFromZero(375 * 2), 2)).toBe(375);
    });
  });

  describe("scaleAllBounds: every bounds-bearing wire field is converted", () => {
    // A pre-#4549 gap left windows[*].bounds (and other non-node-tree bounds) in points while the
    // node tree was pixels — a self-inconsistent px-stamped message. Convert them all.
    it("converts window bounds, nested window node trees, content-hidden regions, and the focused node", () => {
      const hierarchy: ViewHierarchyResult = {
        hierarchy: { node: { $: { bounds: { left: 0, top: 0, right: 10, bottom: 20 } } } },
        screenWidth: 390,
        screenHeight: 844,
        windows: [
          {
            bounds: { left: 0, top: 0, right: 390, bottom: 844 },
            hierarchy: { $: { bounds: { left: 5, top: 5, right: 15, bottom: 25 } } },
          },
        ],
        contentHiddenRegions: [
          { bounds: { left: 1, top: 2, right: 3, bottom: 4 }, reason: "x", areaPercent: 1 },
        ],
        "accessibility-focused-element": {
          $: { bounds: { left: 2, top: 4, right: 6, bottom: 8 } },
        },
      };
      convertHierarchyToCanonicalPixels(hierarchy, {
        nativeScale: 3,
        pixelWidth: 1170,
        pixelHeight: 2532,
      });

      expect(hierarchy.windows![0].bounds).toEqual({ left: 0, top: 0, right: 1170, bottom: 2532 });
      expect(hierarchy.windows![0].hierarchy!.$["bounds"]).toEqual({
        left: 15,
        top: 15,
        right: 45,
        bottom: 75,
      });
      expect(hierarchy.contentHiddenRegions![0].bounds).toEqual({
        left: 3,
        top: 6,
        right: 9,
        bottom: 12,
      });
      expect(hierarchy["accessibility-focused-element"]!.$["bounds"]).toEqual({
        left: 6,
        top: 12,
        right: 18,
        bottom: 24,
      });
    });

    it("converts the systemInsets alias (no units field) but leaves typed insets alone", () => {
      const hierarchy: ViewHierarchyResult = {
        hierarchy: { node: { $: { bounds: { left: 0, top: 0, right: 10, bottom: 20 } } } },
        screenWidth: 390,
        screenHeight: 844,
        systemInsets: { top: 47, right: 0, bottom: 34, left: 0 },
        // Typed insets self-describe via `units`, so they are NOT touched by the coordinateSpace stamp.
        insets: {
          available: true,
          source: "ios-sdk-safe-area",
          units: "points",
          safeArea: { top: 47, right: 0, bottom: 34, left: 0 },
        },
      };
      convertHierarchyToCanonicalPixels(hierarchy, {
        nativeScale: 3,
        pixelWidth: 1170,
        pixelHeight: 2532,
      });
      // systemInsets follows coordinateSpace -> pixels.
      expect(hierarchy.systemInsets).toEqual({ top: 141, right: 0, bottom: 102, left: 0 });
      // Typed insets untouched (points, self-describing).
      expect(hierarchy.insets).toEqual({
        available: true,
        source: "ios-sdk-safe-area",
        units: "points",
        safeArea: { top: 47, right: 0, bottom: 34, left: 0 },
      });
    });
  });
});

describe("COORDINATE_SPACE_PX", () => {
  it('is the literal "px"', () => {
    expect(COORDINATE_SPACE_PX).toBe("px");
  });
});
