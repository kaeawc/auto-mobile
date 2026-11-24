import { describe, expect, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../src/features/observe/ios/CtrlProxyHierarchy";
import type {
  CtrlProxyNode,
  HierarchyDelegateContext,
  XCTestHierarchy,
} from "../../../src/features/observe/ios/types";
import {
  IOS_WINDOW_LAYER_EXTRA,
  IOS_WINDOW_PACKAGE_EXTRA,
} from "../../../src/features/observe/ios/iosWindowLayer";
import { IOS_FOCUSED_WINDOW_TOUCH_MARGIN } from "../../../src/features/action/iosBackgroundWindowTap";
import { TapPointPlanner } from "../../../src/features/action/tapPointPlanner";
import { TapTargetUnavailableError } from "../../../src/features/action/tapTargetSupport";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import type { Element, ViewHierarchyResult } from "../../../src/models";
import { DefaultElementGeometry } from "../../../src/features/utility/ElementGeometry";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";

/**
 * #19091: on an iPad, Files is tiled on the left half [0,0,511,1253] and focused; Settings floats
 * behind it at [258,246,773,1015], so only its right part shows. The "Optimizing Search and Siri"
 * row [278,487,753,539] has its centre (515,513) 4 pt right of the Files tile, where iPadOS still
 * gives the touch to Files. Bounds are from the mt0101a observation of that layout.
 */
const screen = { width: 1032, height: 1376 };
const filesFrame = bounds(0, 0, 511, 1253);
const settingsFrame = bounds(258, 246, 773, 1015);

function bounds(left: number, top: number, right: number, bottom: number) {
  return { left, top, right, bottom };
}

function capture(settingsRows: CtrlProxyNode[]): XCTestHierarchy {
  return {
    updatedAt: 1,
    packageName: "com.apple.DocumentsApp",
    screenWidth: screen.width,
    screenHeight: screen.height,
    windows: [
      {
        id: 0,
        type: 1,
        isActive: true,
        isFocused: true,
        bounds: filesFrame,
        packageName: "com.apple.DocumentsApp",
      },
      {
        id: 1,
        type: 1,
        isActive: false,
        isFocused: false,
        bounds: settingsFrame,
        packageName: "com.apple.Preferences",
      },
    ],
    hierarchy: {
      className: "XCUIApplication",
      text: "Files",
      bounds: filesFrame,
      node: [
        {
          className: "XCUIApplication",
          text: "Settings",
          bounds: settingsFrame,
          extras: {
            [IOS_WINDOW_LAYER_EXTRA]: "1",
            [IOS_WINDOW_PACKAGE_EXTRA]: "com.apple.Preferences",
          },
          node: settingsRows,
        },
        {
          className: "UIButton",
          resourceId: "DOC.recents",
          text: "Recents",
          clickable: "true",
          bounds: bounds(122, 1185, 216, 1239),
        },
      ],
    },
  };
}

function row(resourceId: string, text: string, rowBounds: ReturnType<typeof bounds>) {
  return { className: "UIButton", resourceId, text, clickable: "true", bounds: rowBounds };
}

const siri = row(
  "com.apple.settings.spotlightIndexingProgress",
  "Optimizing Search and Siri",
  bounds(278, 487, 753, 539),
);

function convert(raw: XCTestHierarchy): ViewHierarchyResult {
  return new CtrlProxyHierarchy({} as HierarchyDelegateContext).convertToViewHierarchyResult(raw);
}

function element(hierarchy: ViewHierarchyResult, id: string): Element {
  const found = new SearchableHierarchy()
    .project(hierarchy)
    .find((node) => node.nativeId === id && node.element)?.element;
  if (!found) {
    throw new Error(`no node ${id}`);
  }
  return found;
}

function planner(): TapPointPlanner {
  return new TapPointPlanner({
    device: { name: "fake iPad", deviceId: "fake-ipad", platform: "ios" },
    geometry: () => new DefaultElementGeometry(),
    strategy: () => FakeTapStrategy.ios(),
  });
}

function tapPoint(hierarchy: ViewHierarchyResult, target: Element) {
  return planner().resolveVisibleTapPoint(target, hierarchy, target.bounds, {
    options: { action: "tap" },
    screenSize: screen,
  });
}

describe("tapOn a background iPad window partly under the focused window (#19091)", () => {
  test("taps the background row clear of the focused window's edge, not at its centre", () => {
    const hierarchy = convert(capture([siri]));
    const point = tapPoint(hierarchy, element(hierarchy, siri.resourceId));
    expect(point).not.toBeNull();
    expect(point!.x).toBeGreaterThanOrEqual(filesFrame.right + IOS_FOCUSED_WINDOW_TOUCH_MARGIN);
    expect(point!.x).toBeLessThan(753);
    expect(point!.y).toBeGreaterThanOrEqual(487);
    expect(point!.y).toBeLessThan(539);
  });

  test("refuses a background row whose only visible part is at the focused window's edge", () => {
    const sliver = row("sliver", "Sliver", bounds(500, 600, filesFrame.right + 10, 640));
    const hierarchy = convert(capture([sliver]));
    let thrown: unknown;
    try {
      tapPoint(hierarchy, element(hierarchy, "sliver"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TapTargetUnavailableError);
    const refusal = thrown as TapTargetUnavailableError;
    expect(refusal.reason).toBe("no-visible-tap-area");
    expect(refusal.message).toContain("com.apple.Preferences");
    expect(refusal.message).toContain("com.apple.DocumentsApp");
  });

  test("a focused-window target keeps its centre", () => {
    const hierarchy = convert(capture([siri]));
    expect(tapPoint(hierarchy, element(hierarchy, "DOC.recents"))).toEqual({ x: 169, y: 1212 });
  });

  test("a background row well clear of the focused window keeps its centre", () => {
    const clear = row("clear", "Clear", bounds(560, 600, 760, 640));
    const hierarchy = convert(capture([clear]));
    expect(tapPoint(hierarchy, element(hierarchy, "clear"))).toEqual({ x: 660, y: 620 });
  });
});
