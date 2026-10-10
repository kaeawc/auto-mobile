import { describe, expect, test } from "bun:test";
import { CTRL_PROXY_PACKAGE } from "../../../src/ctrlProxy/constants";
import {
  assertAppGestureNotUnderPrototype,
  layerGestureRefusal,
  ownPrototypeCoversPoint,
} from "../../../src/features/observe/hierarchyLayer";
import {
  capturedFloatingCoverHierarchy,
  capturedTwoWindowHierarchy,
} from "../../helpers/prototypeWindowCapture";

// The highlight tool's system-layer window: TYPE_ACCESSIBILITY_OVERLAY, CtrlProxy's package, full
// screen, no nodes and no prototype metadata (see ownWindowFocus.ts). It is not a prototype.
const highlight = {
  id: 999,
  type: 4,
  isActive: false,
  packageName: CTRL_PROXY_PACKAGE,
  bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
};

describe("a full-screen highlight window must not count as a prototype window for gestures", () => {
  test('layer "app" tap is not refused as "prototype window covers that point" when only a highlight is showing', () => {
    const hierarchy = capturedTwoWindowHierarchy();
    hierarchy.windows = [...hierarchy.windows!, highlight];

    expect(ownPrototypeCoversPoint(hierarchy, { x: 540, y: 1200 })).toBe(false);
    expect(() =>
      assertAppGestureNotUnderPrototype(hierarchy, "app", { x: 540, y: 1200 }, "tap"),
    ).not.toThrow();
  });

  test('layer "prototype" gesture outside the prototype is still refused while a highlight is showing', () => {
    const hierarchy = capturedFloatingCoverHierarchy();
    const prototypeWindow = hierarchy.windows!.find((window) => window.prototypePlacement);
    // Fall back to any CtrlProxy-owned window when the capture carries no placement metadata.
    const own =
      prototypeWindow ?? hierarchy.windows!.find((w) => w.packageName === CTRL_PROXY_PACKAGE);
    expect(own).toBeDefined();
    const b = own!.bounds!;
    // A point on screen but outside the prototype's own bounds.
    const outside = { x: b.left > 5 ? 2 : b.right + 2, y: 2 };
    // Baseline: without the highlight the point is correctly refused.
    expect(layerGestureRefusal(hierarchy, "prototype", [outside], "tap")).toMatch(
      /no AutoMobile prototype window covers that point/,
    );
    hierarchy.windows = [...hierarchy.windows!, highlight];

    expect(layerGestureRefusal(hierarchy, "prototype", [outside], "tap")).toMatch(
      /no AutoMobile prototype window covers that point/,
    );
  });
});
