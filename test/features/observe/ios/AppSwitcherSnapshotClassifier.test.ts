import { describe, expect, test } from "bun:test";
import { isIosAppSwitcherVisible } from "../../../../src/features/observe/ios/AppSwitcherSnapshotClassifier";
import { convertToViewHierarchyResult } from "../../../../src/features/observe/ios/IosHierarchyConverter";
import type { IosRunnerWireHierarchy } from "../../../../src/features/observe/ios/types";

function snapshot(cardWidth = 275, contentWidth = 402): IosRunnerWireHierarchy {
  return {
    packageName: "com.apple.springboard",
    updatedAt: 1,
    hierarchy: {
      node: [
        {
          "resource-id": "AppSwitcherContentView",
          bounds: [0, 0, contentWidth, 874],
          node: {
            "resource-id": "card:com.apple.Preferences:sceneID:com.apple.Preferences-default",
            bounds: [63, 128, 63 + cardWidth, 727],
            value: "Active",
          },
        },
      ],
    },
  };
}

describe("iOS App Switcher snapshot classifier", () => {
  test("recognizes a scaled card in raw wire and converted hierarchies", () => {
    const hierarchy = snapshot();
    expect(isIosAppSwitcherVisible(hierarchy.hierarchy)).toBe(true);
    expect(isIosAppSwitcherVisible(convertToViewHierarchyResult(hierarchy).hierarchy)).toBe(true);
  });

  test("home without cards and an empty hierarchy are not the switcher", () => {
    expect(isIosAppSwitcherVisible({ className: "XCUIApplication" })).toBe(false);
    expect(isIosAppSwitcherVisible(undefined)).toBe(false);
  });

  test("a card without a content view is not visible, matching Swift", () => {
    expect(
      isIosAppSwitcherVisible({
        resourceId: "card:com.apple.Preferences",
        bounds: { left: 63, top: 128, right: 338, bottom: 727 },
      }),
    ).toBe(false);
  });

  test.each([361.8, 402])("a full-size or exactly 90 percent card (%s) is not visible", (width) => {
    expect(isIosAppSwitcherVisible(snapshot(width).hierarchy)).toBe(false);
  });

  test.each([0, -1])("requires positive card and content dimensions (%s)", (size) => {
    expect(isIosAppSwitcherVisible(snapshot(size).hierarchy)).toBe(false);
    expect(isIosAppSwitcherVisible(snapshot(275, size).hierarchy)).toBe(false);
    const hierarchy = snapshot();
    hierarchy.hierarchy.node = [
      { "resource-id": "AppSwitcherContentView", bounds: [0, 0, 402, size] },
      { "resource-id": "card:app", bounds: [0, 0, 275, 599] },
    ];
    expect(isIosAppSwitcherVisible(hierarchy.hierarchy)).toBe(false);
    hierarchy.hierarchy.node[0].bounds = [0, 0, 402, 874];
    hierarchy.hierarchy.node[1].bounds = [0, 0, 275, size];
    expect(isIosAppSwitcherVisible(hierarchy.hierarchy)).toBe(false);
  });

  test("any positive content view can establish the scaled-card comparison", () => {
    const hierarchy = snapshot();
    hierarchy.hierarchy.node = [
      { resourceId: "AppSwitcherContentView", bounds: [0, 0, 100, 874] },
      ...[hierarchy.hierarchy.node].flat().filter((node) => node !== undefined),
    ];
    expect(isIosAppSwitcherVisible(hierarchy.hierarchy)).toBe(true);
  });
});
