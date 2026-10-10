import { beforeAll, describe, expect, test } from "bun:test";
import {
  hasElementAnchors,
  hasPrototypeAnchors,
  pxToDp,
  resolvePrototypeAnchors,
} from "../../../src/features/prototype/prototypeAnchors";
import type { PrototypeAnchor, PrototypeSpec } from "../../../src/features/prototype/prototypeSpec";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { CtrlProxyHierarchy } from "../../../src/features/observe/ios/CtrlProxyHierarchy";
import type { HierarchyDelegateContext } from "../../../src/features/observe/ios/types";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import { iosFloatingOverlayOverSettings } from "../../fixtures/observe/iosOverlayWindow";
import { capturedFloatingCoverHierarchy } from "../../helpers/prototypeWindowCapture";

// Captured on API 36 at 420 dpi (2.625): a CtrlProxy floating prototype window (a box tagged
// coverBox) over the Playground app, whose button_elevated is at [550,1589,996,1715] px.
const ELEVATED_PX = { left: 550, top: 1589, right: 996, bottom: 1715 };

function anchoredSpec(anchor: PrototypeAnchor, nested = false): PrototypeSpec {
  const box = { type: "box" as const, children: [], anchor };
  return {
    id: "anchored",
    window: { placement: { type: "fullscreen" } },
    root: nested ? { type: "column", children: [{ type: "text", text: "a" }, box] } : box,
  } as PrototypeSpec;
}

function resolve(spec: PrototypeSpec, updatedAt?: number) {
  return resolvePrototypeAnchors(spec, { hierarchy: capturedFloatingCoverHierarchy(), updatedAt });
}

describe("pxToDp", () => {
  test.each([
    [420, 1050, 400],
    [440, 1100, 400],
    [160, 37, 37],
    [480, 3, 1],
    // A non-integer scale: 373 dpi is 2.33125.
    [373, 932.5, 400],
  ])("at %p dpi converts %p px to %p dp", (dpi, px, dp) => {
    expect(pxToDp(px, dpi)).toBeCloseTo(dp, 9);
  });

  test("round-trips through the device's dp-to-px scale at non-integer densities", () => {
    for (const dpi of [373, 420, 440, 560]) {
      for (const px of [0, 1, 42, 694, 1038, 2399]) {
        expect(Math.round(pxToDp(px, dpi) * (dpi / 160))).toBe(px);
      }
    }
  });

  test.each([0, -160, Number.NaN])("refuses density %p", (dpi) => {
    expect(() => pxToDp(10, dpi)).toThrow("display density");
  });
});

describe("resolvePrototypeAnchors", () => {
  test("covers an app element: px bounds from the capture, converted to dp once", () => {
    const resolution = resolve(
      anchoredSpec({
        type: "element",
        selector: { elementId: "button_elevated" },
        alignment: "cover",
      }),
      1791481170726,
    );
    expect(resolution.anchors).toHaveLength(1);
    const [anchor] = resolution.anchors;
    expect(anchor.path).toBe("root");
    expect(anchor.boundsPx).toEqual(ELEVATED_PX);
    expect(anchor.bounds.x).toBeCloseTo(550 / 2.625, 9);
    expect(anchor.bounds.y).toBeCloseTo(1589 / 2.625, 9);
    expect(anchor.bounds.width).toBeCloseTo(446 / 2.625, 9);
    expect(anchor.bounds.height).toBeCloseTo(48, 9);
    expect(resolution.hierarchyUpdatedAt).toBe(1791481170726);
    expect(resolution.spec.root.anchor).toEqual({
      type: "bounds",
      bounds: anchor.bounds,
      alignment: "cover",
    });
  });

  test("the resolved wire spec still validates against the shared contract", () => {
    const { spec } = resolve(
      anchoredSpec(
        {
          type: "element",
          selector: { text: "Elevated" },
          alignment: "bottom",
          offset: { x: 0, y: 8 },
        },
        true,
      ),
    );
    expect(validatePrototypeSpec(spec).success).toBe(true);
    expect(hasElementAnchors(spec)).toBe(false);
    expect(hasPrototypeAnchors(spec)).toBe(true);
  });

  test("a text selector resolves to the clickable element, as tapOn does, and keeps alignment and offset", () => {
    const resolution = resolve(
      anchoredSpec(
        {
          type: "element",
          selector: { text: "Elevated" },
          alignment: "bottom",
          offset: { x: 0, y: 8 },
        },
        true,
      ),
    );
    expect(resolution.anchors[0].path).toBe("root.children[1]");
    expect(resolution.anchors[0].boundsPx).toEqual(ELEVATED_PX);
    const node = (resolution.spec.root as { children: { anchor?: PrototypeAnchor }[] }).children[1];
    expect(node.anchor).toMatchObject({
      type: "bounds",
      alignment: "bottom",
      offset: { x: 0, y: 8 },
    });
  });

  test("a container scopes the selector", () => {
    const resolution = resolve(
      anchoredSpec({
        type: "element",
        selector: { elementId: "button_elevated", container: { elementId: "buttons_card" } },
        alignment: "cover",
      }),
    );
    expect(resolution.anchors[0].boundsPx).toEqual(ELEVATED_PX);
  });

  test("the prototype's own nodes are never anchor targets", () => {
    expect(() =>
      resolve(
        anchoredSpec({ type: "element", selector: { testTag: "coverBox" }, alignment: "cover" }),
      ),
    ).toThrow(
      'root.anchor: the app element {"testTag":"coverBox"} could not be resolved (Target not found). Only the app is searched',
    );
  });

  test("a missing element fails and says nothing was shown", () => {
    expect(() =>
      resolve(anchoredSpec({ type: "element", selector: { text: "Buy" }, alignment: "cover" })),
    ).toThrow("Nothing was shown");
  });

  test("an ambiguous selector fails with the candidates listed", () => {
    let message = "";
    try {
      resolve(anchoredSpec({ type: "element", selector: { text: "Text" }, alignment: "cover" }));
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("Target ambiguous: 2 matches");
    expect(message).toContain("Candidates:");
    expect(message).toContain("Nothing was shown");
  });

  test("an element below the visible screen fails instead of anchoring off screen", () => {
    const hierarchy = { ...capturedFloatingCoverHierarchy(), screenHeight: 1500 };
    expect(() =>
      resolvePrototypeAnchors(
        anchoredSpec({
          type: "element",
          selector: { elementId: "button_elevated" },
          alignment: "cover",
        }),
        { hierarchy },
      ),
    ).toThrow("is off screen");
  });

  test("a capture without a density fails rather than guessing a scale", () => {
    const hierarchy = { ...capturedFloatingCoverHierarchy(), density: undefined };
    expect(() =>
      resolvePrototypeAnchors(
        anchoredSpec({
          type: "element",
          selector: { elementId: "button_elevated" },
          alignment: "cover",
        }),
        { hierarchy },
      ),
    ).toThrow("display density");
  });

  test("bounds anchors and unanchored specs are returned as authored, without a capture", () => {
    const bounds = anchoredSpec({ type: "bounds", bounds: { x: 1, y: 2, width: 3, height: 4 } });
    const plain = { ...bounds, root: { type: "text", text: "hi" } } as PrototypeSpec;
    for (const spec of [bounds, plain]) {
      const resolution = resolvePrototypeAnchors(spec, {
        hierarchy: { hierarchy: { error: "unused" } } as never,
      });
      expect(resolution.spec).toBe(spec);
      expect(resolution.anchors).toEqual([]);
    }
    expect(hasPrototypeAnchors(bounds)).toBe(true);
    expect(hasPrototypeAnchors(plain)).toBe(false);
  });

  test("the authored spec is not mutated", () => {
    const spec = anchoredSpec({
      type: "element",
      selector: { elementId: "button_elevated" },
      alignment: "cover",
    });
    const before = structuredClone(spec);
    resolve(spec);
    expect(spec).toEqual(before);
  });
});

// Captured on an iPhone 17 simulator (iOS 26.5, 402x874 pt): Settings with the injected prototype
// agent's floating window (floating-card, like-button, close-button and the host dismiss control)
// above it. Settings' General row is at [16,380,386,432] in points, the unit iOS specs use.
describe("resolvePrototypeAnchors on an iOS capture", () => {
  let converted: ViewHierarchyResult;
  // Converting the 200 KB capture is setup, not part of any one test's budget.
  beforeAll(() => {
    converted = new CtrlProxyHierarchy({} as HierarchyDelegateContext).convertToViewHierarchyResult(
      iosFloatingOverlayOverSettings(),
    );
  });
  const iosCapture = () => converted;
  const GENERAL = { left: 16, top: 380, right: 386, bottom: 432 };

  function resolveIos(selector: Record<string, unknown>) {
    return resolvePrototypeAnchors(
      anchoredSpec({ type: "element", selector, alignment: "cover" } as PrototypeAnchor),
      { hierarchy: iosCapture(), updatedAt: 1791385231063, boundsUnit: "points" },
    );
  }

  test("keeps the element's point bounds: the capture has no density and needs none", () => {
    expect(iosCapture().density).toBeUndefined();
    const resolution = resolveIos({ elementId: "com.apple.settings.general" });
    expect(resolution.anchors).toEqual([
      {
        path: "root",
        alignment: "cover",
        boundsPx: GENERAL,
        bounds: { x: 16, y: 380, width: 370, height: 52 },
      },
    ]);
    expect(resolution.spec.root.anchor).toEqual({
      type: "bounds",
      bounds: { x: 16, y: 380, width: 370, height: 52 },
      alignment: "cover",
    });
    expect(validatePrototypeSpec(resolution.spec).success).toBe(true);
  });

  test("a text selector resolves to the row that owns it, as tapOn does", () => {
    expect(resolveIos({ text: "General" }).anchors[0].boundsPx).toEqual(GENERAL);
  });

  test("the agent's own window is excluded: its buttons and dismiss control are not targets", () => {
    for (const elementId of ["like-button", "close-button", "automobile-prototype-dismiss"]) {
      expect(() => resolveIos({ elementId })).toThrow("Only the app is searched");
    }
  });

  test("without the points unit an iOS capture is refused for its missing density", () => {
    expect(() =>
      resolvePrototypeAnchors(
        anchoredSpec({
          type: "element",
          selector: { elementId: "com.apple.settings.general" },
          alignment: "cover",
        }),
        { hierarchy: iosCapture() },
      ),
    ).toThrow("display density");
  });
});
