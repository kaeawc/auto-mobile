import { describe, expect, test } from "bun:test";
import { SelectionStateDetector } from "../../../src/features/navigation/SelectionStateDetector";
import { FakeScreenshotUtils } from "../../fakes/FakeScreenshotUtils";
import { FakeImageUtils } from "../../fakes/FakeImageUtils";
import { Element, ObserveResult, ViewHierarchyResult } from "../../../src/models";

const createHierarchy = (node: Record<string, any>): ViewHierarchyResult =>
  ({
    hierarchy: {
      node,
    },
  }) as ViewHierarchyResult;

const createObservation = (viewHierarchy: ViewHierarchyResult): ObserveResult => ({
  updatedAt: Date.now(),
  screenSize: { width: 100, height: 100 },
  systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  viewHierarchy,
});

describe("SelectionStateDetector", () => {
  test("prefers accessibility-selected elements when available", async () => {
    const screenshotUtils = new FakeScreenshotUtils();
    const imageUtils = new FakeImageUtils();
    const detector = new SelectionStateDetector({ screenshotUtils, imageUtils });

    const observation = createObservation(
      createHierarchy({
        text: "Home",
        selected: "true",
        bounds: { left: 0, top: 0, right: 50, bottom: 50 },
      }),
    );

    const selected = await detector.detectSelectedElements({
      currentObservation: observation,
    });

    expect(selected).toHaveLength(1);
    expect(selected[0].text).toBe("Home");
    expect(selected[0].selectedState?.method).toBe("accessibility");
    expect(screenshotUtils.wasMethodCalled("getCachedScreenshot")).toBe(false);
  });

  test("uses visual fallback when accessibility-selected elements are missing", async () => {
    const screenshotUtils = new FakeScreenshotUtils();
    const imageUtils = new FakeImageUtils();
    const detector = new SelectionStateDetector({ screenshotUtils, imageUtils });

    screenshotUtils.setCachedScreenshot("before.png", Buffer.from("before"), "hash-before");
    screenshotUtils.setCachedScreenshot("after.png", Buffer.from("after"), "hash-after");
    screenshotUtils.setImageDimensions(100, 100);
    screenshotUtils.setCompareImagesResult({
      similarity: 90,
      pixelDifference: 10,
      totalPixels: 100,
    });

    const observation = createObservation(
      createHierarchy({
        text: "NotSelected",
        selected: "false",
        bounds: { left: 0, top: 0, right: 50, bottom: 50 },
      }),
    );

    const element: Element = {
      bounds: { left: 0, top: 0, right: 50, bottom: 50 },
      text: "Tab1",
      "resource-id": "tab1",
    };

    const selected = await detector.detectSelectedElements({
      currentObservation: observation,
      previousObservation: observation,
      tappedElement: element,
      beforeScreenshotPath: "before.png",
      afterScreenshotPath: "after.png",
    });

    expect(selected).toHaveLength(1);
    expect(selected[0].text).toBe("Tab1");
    // Exact envelope: similarity 90 -> diff 10.00%; confidence = min(1, 10/scale=5) = 1;
    // reason pins the diff string and the minDifferencePercent=1 threshold.
    expect(selected[0].selectedState?.method).toBe("visual");
    expect(selected[0].selectedState?.confidence).toBe(1);
    expect(selected[0].selectedState?.reason).toBe("visual diff 10.00% >= 1%");

    // Both the before and after regions are cropped to the element's exact 50x50
    // bounds at the origin (guards the crop rect that drives the visual diff).
    const cropCalls = imageUtils.getMethodCalls("crop");
    expect(cropCalls).toHaveLength(2);
    for (const call of cropCalls) {
      expect(call.width).toBe(50);
      expect(call.height).toBe(50);
      expect(call.x).toBe(0);
      expect(call.y).toBe(0);
    }
  });
});
