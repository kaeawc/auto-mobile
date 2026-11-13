import { describe, expect, test } from "bun:test";
import { describeTransposedLayout } from "../../../src/features/observe/transposedLayoutGeometry";
import type { ObserveResult } from "../../../src/models";

type Bounds = { left: number; top: number; right: number; bottom: number };

function observationOf(
  size: { width: number; height: number },
  rotation: number | undefined,
  children: Bounds[],
  windowBounds?: Bounds,
): Pick<ObserveResult, "screenSize" | "rotation" | "viewHierarchy"> {
  const leaves = children.map((bounds) => ({ bounds }));
  return {
    screenSize: size,
    rotation,
    viewHierarchy: {
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: size.width, bottom: size.height },
          node: windowBounds ? [{ bounds: windowBounds, node: leaves }] : leaves,
        },
      },
    },
  };
}

// The captured #18245 sample: rotation 0, 669x951, elements laid out landscape up to x≈951.
const landscapeLayout: Bounds[] = [
  { left: 0, top: 0, right: 951, bottom: 64 },
  { left: 855, top: 380, right: 951, bottom: 428 },
  { left: 0, top: 609, right: 951, bottom: 669 },
];
const portraitLayout: Bounds[] = [
  { left: 0, top: 0, right: 669, bottom: 96 },
  { left: 20, top: 400, right: 649, bottom: 450 },
  { left: 0, top: 870, right: 669, bottom: 951 },
];

describe("describeTransposedLayout", () => {
  test("flags a portrait-reported observation whose elements are laid out landscape", () => {
    expect(
      describeTransposedLayout(observationOf({ width: 669, height: 951 }, 0, landscapeLayout)),
    ).toBe("observe reports rotation 0 and 669x951, but elements are laid out for 951x669");
  });

  test("ignores a stale full-screen window frame around the landscape layout", () => {
    const observation = observationOf({ width: 669, height: 951 }, 0, landscapeLayout, {
      left: 0,
      top: 0,
      right: 669,
      bottom: 951,
    });
    expect(describeTransposedLayout(observation)).toContain("laid out for 951x669");
  });

  test("allows a landscape-native app whose elements fit the reported size", () => {
    expect(
      describeTransposedLayout(observationOf({ width: 951, height: 669 }, 0, landscapeLayout)),
    ).toBeUndefined();
  });

  test("allows a landscape observation that reports rotation 1", () => {
    expect(
      describeTransposedLayout(observationOf({ width: 951, height: 669 }, 1, landscapeLayout)),
    ).toBeUndefined();
  });

  test("allows a portrait app", () => {
    expect(
      describeTransposedLayout(observationOf({ width: 669, height: 951 }, 0, portraitLayout)),
    ).toBeUndefined();
  });

  test("allows portrait content that runs past the bottom edge", () => {
    const scrolled = [...portraitLayout, { left: 0, top: 951, right: 900, bottom: 1400 }];
    expect(
      describeTransposedLayout(observationOf({ width: 669, height: 951 }, 0, scrolled)),
    ).toBeUndefined();
  });

  test("leaves the observed hierarchy unchanged", () => {
    const observation = observationOf({ width: 669, height: 951 }, 0, landscapeLayout);
    const before = structuredClone(observation);
    describeTransposedLayout(observation);
    expect(observation).toEqual(before);
  });

  test("allows an observation without hierarchy or size", () => {
    expect(describeTransposedLayout({ screenSize: { width: 0, height: 0 } })).toBeUndefined();
    expect(
      describeTransposedLayout({ screenSize: { width: 669, height: 951 }, rotation: 0 }),
    ).toBeUndefined();
  });
});
