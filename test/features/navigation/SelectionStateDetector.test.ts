import { describe, expect, test } from "bun:test";
import {
  SelectionStateDetector,
  SelectionDetectionContext,
} from "../../../src/features/navigation/SelectionStateDetector";
import testTagCapture from "../../fixtures/observe/android-test-tag.json";
import siblingTargetsCapture from "../../fixtures/observe/android-sibling-targets.json";
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
      compared: true,
      similarity: 90,
      pixelDifference: 10,
      totalPixels: 100,
    });

    const observation = createObservation(
      createHierarchy({
        text: "Tab1",
        "resource-id": "tab1",
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
  describe("visual fallback guards (#10185)", () => {
    // Real captures: the tapped "Submit form" button lives on the test-tag screen only; the
    // sibling-targets screen is a different screen that has no such element.
    // Screenshots are 1:1 with the captures' coordinate space, so the crop keeps its bounds.
    const screenSize = { width: 300, height: 330 };
    const sourceScreen = {
      ...createObservation(testTagCapture.viewHierarchy as ViewHierarchyResult),
      screenSize,
    };
    const destinationScreen = {
      ...createObservation(siblingTargetsCapture.viewHierarchy as ViewHierarchyResult),
      screenSize,
    };
    const tapped: Element = {
      bounds: { left: 20, top: 100, right: 220, bottom: 160 },
      text: "Submit form",
      "resource-id": "example.app:id/submit",
      clickable: true,
    };

    const setup = () => {
      const screenshotUtils = new FakeScreenshotUtils();
      const imageUtils = new FakeImageUtils();
      screenshotUtils.setCachedScreenshot("before.png", Buffer.from("before"), "hash-before");
      screenshotUtils.setCachedScreenshot("after.png", Buffer.from("after"), "hash-after");
      screenshotUtils.setImageDimensions(300, 330);
      screenshotUtils.setCompareImagesResult({
        compared: true,
        similarity: 10,
        pixelDifference: 90,
        totalPixels: 100,
      });
      const detector = new SelectionStateDetector({ screenshotUtils, imageUtils });
      const detect = (overrides: Partial<SelectionDetectionContext>) =>
        detector.detectSelectedElements({
          currentObservation: sourceScreen,
          previousObservation: sourceScreen,
          tappedElement: tapped,
          beforeScreenshotPath: "before.png",
          afterScreenshotPath: "after.png",
          ...overrides,
        });
      return { screenshotUtils, imageUtils, detect };
    };

    test("reports no selection when the tap navigated to a screen without the element", async () => {
      const { screenshotUtils, detect } = setup();

      const selected = await detect({ currentObservation: destinationScreen });

      expect(selected).toEqual([]);
      expect(screenshotUtils.wasMethodCalled("compareImages")).toBe(false);
    });

    test("reports no selection when the tap navigated even if a same-named node exists", async () => {
      const { screenshotUtils, detect } = setup();

      // The destination can carry a title with the tapped text; the tap flow's screen identity
      // change is what says the old element is gone.
      const selected = await detect({
        tapEffect: { screenChanged: true, basis: "screenIdentity changed" },
      });

      expect(selected).toEqual([]);
      expect(screenshotUtils.wasMethodCalled("getCachedScreenshot")).toBe(false);
    });

    test("reports no selection when the active window changed", async () => {
      const { detect } = setup();

      expect(
        await detect({ tapEffect: { screenChanged: true, basis: "activeWindow changed" } }),
      ).toEqual([]);
    });

    test("still reports a tab toggled on the same screen with a visual change", async () => {
      const { detect } = setup();

      const selected = await detect({
        tapEffect: { screenChanged: false, basis: "screenIdentity unchanged" },
      });

      expect(selected).toHaveLength(1);
      expect(selected[0].text).toBe("Submit form");
      expect(selected[0].selectedState?.method).toBe("visual");
    });

    test("a viewHierarchy-only change is not navigation: the tab content swap still counts", async () => {
      const { detect } = setup();

      const selected = await detect({
        tapEffect: { screenChanged: true, basis: "viewHierarchy changed" },
      });

      expect(selected).toHaveLength(1);
      expect(selected[0].selectedState?.method).toBe("visual");
    });

    test("does not treat a failed comparison as a 100% change", async () => {
      const { screenshotUtils, detect } = setup();
      screenshotUtils.setCompareImagesResult({ compared: false, error: "decode failed" });

      expect(await detect({})).toEqual([]);
      expect(screenshotUtils.wasMethodCalled("compareImages")).toBe(true);
    });

    test("does not compare screenshots of different sizes (rotation)", async () => {
      const { screenshotUtils, detect } = setup();
      screenshotUtils.setImageDimensionsForBuffer(Buffer.from("after"), 330, 300);

      expect(await detect({})).toEqual([]);
      expect(screenshotUtils.wasMethodCalled("compareImages")).toBe(false);
    });

    test("the accessibility selected attribute stays authoritative over the visual signal", async () => {
      const { screenshotUtils, detect } = setup();
      const withSelectedAttribute = createObservation(
        createHierarchy({
          text: "Other tab",
          selected: "true",
          bounds: { left: 0, top: 0, right: 50, bottom: 50 },
        }),
      );

      const selected = await detect({
        currentObservation: withSelectedAttribute,
        tapEffect: { screenChanged: true, basis: "screenIdentity changed" },
      });

      expect(selected).toHaveLength(1);
      expect(selected[0].text).toBe("Other tab");
      expect(selected[0].selectedState?.method).toBe("accessibility");
      expect(screenshotUtils.wasMethodCalled("compareImages")).toBe(false);
    });

    describe("same-text nodes elsewhere on screen", () => {
      // Real capture: two text-only "Go" buttons in the right column, at (160,10,280,60) and
      // (160,100,280,150), and no node in the left column with that text. Compose and other
      // single-activity apps keep the same app and activity across in-app navigation, so the
      // tap flow reports no screen change and only the element's place tells it apart.
      const siblingTargetsScreen = {
        ...createObservation(siblingTargetsCapture.viewHierarchy as ViewHierarchyResult),
        screenSize,
      };
      const goButton = (bounds: Element["bounds"]): Element => ({ bounds, text: "Go" });

      test("a row that navigated to a screen showing the same text elsewhere is not selected", async () => {
        const { screenshotUtils, detect } = setup();

        const selected = await detect({
          currentObservation: siblingTargetsScreen,
          tappedElement: goButton({ left: 10, top: 10, right: 140, bottom: 60 }),
          tapEffect: { screenChanged: true, basis: "viewHierarchy changed" },
        });

        expect(selected).toEqual([]);
        expect(screenshotUtils.wasMethodCalled("compareImages")).toBe(false);
      });

      test("a node that only partly overlaps the tapped bounds is not the tapped element", async () => {
        const { detect } = setup();

        // Half of the tapped (220,10)-(340,60) bounds is covered by the "Go" node.
        const selected = await detect({
          currentObservation: siblingTargetsScreen,
          tappedElement: goButton({ left: 220, top: 10, right: 340, bottom: 60 }),
        });

        expect(selected).toEqual([]);
      });

      test("an element that stays in place and changes visually is still selected", async () => {
        const { detect } = setup();

        const selected = await detect({
          currentObservation: siblingTargetsScreen,
          tappedElement: goButton({ left: 160, top: 10, right: 280, bottom: 60 }),
          tapEffect: { screenChanged: true, basis: "viewHierarchy changed" },
        });

        expect(selected).toHaveLength(1);
        expect(selected[0].text).toBe("Go");
        expect(selected[0].selectedState?.method).toBe("visual");
      });

      test("selection styling that nudges the node a few pixels still counts as the same element", async () => {
        const { detect } = setup();

        const selected = await detect({
          currentObservation: siblingTargetsScreen,
          tappedElement: goButton({ left: 156, top: 6, right: 276, bottom: 56 }),
        });

        expect(selected).toHaveLength(1);
        expect(selected[0].selectedState?.method).toBe("visual");
      });
    });
  });
});
