import { SearchableHierarchy } from "../../../../src/features/utility/SearchableNode";
import { nodeAttributes } from "../../../../src/models/ViewHierarchyResult";
import { describe, expect, test } from "bun:test";
import {
  deriveIosChromeInsets,
  clipIosChromeBounds,
  effectiveSwipeInsets,
  iosSwipeStartWarning,
  swipeScreenSize,
} from "../../../../src/features/action/swipeon/iosChromeInsets";
import {
  loadAndroidHomeObserve,
  loadIosFractionalObserve,
  loadIosRemindersNoiseObservePair,
} from "../../../fixtures/observe/observeFixture";
import { AutoTargetSelector } from "../../../../src/features/action/swipeon/AutoTargetSelector";

const zero = { top: 0, right: 0, bottom: 0, left: 0 };
const pair = loadIosRemindersNoiseObservePair();
const fractional = loadIosFractionalObserve();

describe("shared iOS chrome clipping", () => {
  for (const [name, observation] of Object.entries({ fractional, ...pair })) {
    test(`clips content at the captured ${name} navigation edge, exempting its own controls`, () => {
      const hierarchy = observation.viewHierarchy!;
      const screen = swipeScreenSize({ observation, platform: "ios" })!;
      const nodes = new SearchableHierarchy().project(hierarchy);
      const nav = nodes.find((node) => node.className?.endsWith("NavigationBar"))!;
      // Synthetic content bounds inside a real captured bar; this is not a captured row.
      expect(clipIosChromeBounds({ bounds: nav.bounds!, hierarchy, screen }).coveredBy).toBe(
        "navigation bar",
      );
      const title = nodes.find((node) => node.parentIndex === nav.index && node.element) ?? nav;
      expect(
        clipIosChromeBounds({
          bounds: title.bounds!,
          hierarchy,
          screen,
          elements: [title.element!],
        }).bounds,
      ).toEqual(title.bounds!);
    });
  }
});

describe("iOS chrome inset derivation", () => {
  for (const [name, observation] of Object.entries(pair)) {
    test(`derives UIKit chrome from Reminders ${name}, ignoring keyboard and scroll-bar noise`, () => {
      expect(deriveIosChromeInsets(observation.viewHierarchy)).toEqual({
        ...zero,
        top: 104,
        bottom: 80,
      });
    });
  }
  test("accepts the XCUIElement vocabulary and fractional points", () => {
    expect(deriveIosChromeInsets(fractional.viewHierarchy)).toEqual({
      ...zero,
      top: 103.66666666666667,
    });
  });
  test("uses hierarchy point dimensions even when observation/metadata sizes are runner pixels", () => {
    const hierarchy = { ...pair.after.viewHierarchy!, screenWidth: 1179, screenHeight: 2556 };
    expect(
      deriveIosChromeInsets(hierarchy, { observationScreenSize: { width: 1179, height: 2556 } }),
    ).toEqual({ ...zero, top: 104, bottom: 80 });
    expect(
      swipeScreenSize({
        observation: {
          ...pair.after,
          viewHierarchy: hierarchy,
          screenSize: { width: 1179, height: 2556 },
        },
        platform: "ios",
      }),
    ).toEqual({ width: 393, height: 852 });
  });
  test("returns zeros for missing hierarchy and content without iOS chrome", () => {
    expect(deriveIosChromeInsets(undefined)).toEqual(zero);
    expect(deriveIosChromeInsets(loadAndroidHomeObserve().observe.viewHierarchy)).toEqual(zero);
  });
  test("merges each observed edge by max only for iOS", () => {
    const observation = {
      ...pair.after,
      systemInsets: { top: 120, right: 8, bottom: 20, left: 4 },
    };
    expect(effectiveSwipeInsets({ observation, platform: "ios" })).toEqual({
      top: 120,
      right: 8,
      bottom: 80,
      left: 4,
    });
    expect(effectiveSwipeInsets({ observation, platform: "android" })).toEqual(
      observation.systemInsets,
    );
    expect(
      effectiveSwipeInsets({ observation, platform: "ios", includeSystemInsets: true }),
    ).toBeUndefined();
  });
  test("clips auto-target screen bounds using the same chrome geometry", () => {
    const observation = { ...pair.after, systemInsets: zero };
    const selector = new AutoTargetSelector();
    expect(selector.getScreenBounds(observation, { platform: "ios" })).toEqual({
      left: 0,
      top: 104,
      right: 393,
      bottom: 772,
    });
    expect(selector.getScreenBounds(observation, { platform: "android" })).toEqual({
      left: 0,
      top: 0,
      right: 393,
      bottom: 852,
    });
  });
  test("warns only when an iOS start point actually lies in a chrome frame", () => {
    const observation = { ...pair.after, systemInsets: zero };
    expect(
      iosSwipeStartWarning({ observation, platform: "ios", startX: 196, startY: 85 }),
    ).toContain("navigation bar");
    expect(
      iosSwipeStartWarning({ observation, platform: "ios", startX: 196, startY: 800 }),
    ).toContain("bottom toolbar or tab bar");
    expect(
      iosSwipeStartWarning({ observation, platform: "ios", startX: 196, startY: 104 }),
    ).toBeUndefined();
    expect(
      iosSwipeStartWarning({ observation, platform: "ios", startX: 500, startY: 85 }),
    ).toBeUndefined();
    expect(
      iosSwipeStartWarning({ observation, platform: "android", startX: 196, startY: 85 }),
    ).toBeUndefined();
  });
});

describe("chrome frame filtering", () => {
  for (const className of [
    "UIStatusBarModern",
    "XCUIElementTypeStatusBar",
    "UITabBar",
    "XCUIElementTypeTabBar",
    "XCUIElementTypeToolbar",
  ]) {
    test(`recognizes ${className} using a fixture bar frame`, () => {
      const hierarchy = structuredClone(pair.after.viewHierarchy!);
      const bar = new SearchableHierarchy()
        .project(hierarchy)
        .find(
          (node) =>
            node.className === (className.includes("StatusBar") ? "UINavigationBar" : "UIToolbar"),
        )!;
      nodeAttributes(bar.source).class = className;
      expect(deriveIosChromeInsets(hierarchy)).toEqual({ ...zero, top: 104, bottom: 80 });
    });
  }
  test("ignores hidden bars and bars moved into the middle of content", () => {
    const hierarchy = structuredClone(pair.after.viewHierarchy!);
    const nodes = new SearchableHierarchy().project(hierarchy);
    const nav = nodes.find((node) => node.className === "UINavigationBar")!;
    nodeAttributes(nav.source).visible = "false";
    const toolbar = nodes.find((node) => node.className === "UIToolbar")!;
    toolbar.source.bounds = { ...toolbar.bounds!, top: 350, bottom: 430 };
    expect(deriveIosChromeInsets(hierarchy)).toEqual(zero);
  });
  test("returns unknown/zero when the canonical resolver cannot establish a screen size", () => {
    const hierarchy = structuredClone(pair.after.viewHierarchy!);
    hierarchy.hierarchy!.bounds = undefined;
    hierarchy.hierarchy!.node!.bounds = undefined;
    hierarchy.screenWidth = undefined;
    hierarchy.screenHeight = undefined;
    expect(deriveIosChromeInsets(hierarchy)).toEqual(zero);
  });
});

test("Android auto-target retains inset screen comparison when the gesture includes system insets", () => {
  const observation = { ...pair.after, systemInsets: { top: 20, right: 5, bottom: 30, left: 5 } };
  expect(
    new AutoTargetSelector().getScreenBounds(observation, {
      platform: "android",
      includeSystemInsets: true,
    }),
  ).toEqual({ left: 5, top: 20, right: 388, bottom: 822 });
});
