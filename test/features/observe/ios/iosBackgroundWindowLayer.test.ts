import { describe, expect, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/ios/CtrlProxyHierarchy";
import type {
  CtrlProxyNode,
  HierarchyDelegateContext,
  XCTestHierarchy,
} from "../../../../src/features/observe/ios/types";
import {
  IOS_WINDOW_LAYER_EXTRA,
  IOS_WINDOW_PACKAGE_EXTRA,
  focusedAppWindowsOnly,
} from "../../../../src/features/observe/ios/iosWindowLayer";
import { SearchableHierarchy } from "../../../../src/features/utility/SearchableNode";
import { clipIosChromeBounds } from "../../../../src/features/action/swipeon/iosChromeInsets";
import type { ViewHierarchyResult } from "../../../../src/models";

/**
 * #18830: the runner merges other apps' visible iPad windows under the focused app's root. Here
 * Files fills the screen behind a floating Settings window [200,388,704,1320] that shows a
 * keyboard (its own windows stamped 0 and 1); Files' tab bar centre lies outside Settings, so it
 * survives occlusion and overlaps Settings' bottom button.
 */
const screen = { width: 1032, height: 1376 };

function bounds(left: number, top: number, right: number, bottom: number) {
  return { left, top, right, bottom };
}

function capture(backgroundExtras: Record<string, string> | undefined): XCTestHierarchy {
  const files: CtrlProxyNode = {
    className: "XCUIApplication",
    text: "Files",
    bounds: bounds(0, 0, 1032, 1376),
    ...(backgroundExtras ? { extras: backgroundExtras } : {}),
    node: [
      { className: "UITabBar", resourceId: "files-tabs", bounds: bounds(0, 1290, 1032, 1376) },
      { className: "UIButton", resourceId: "browse", bounds: bounds(20, 1300, 120, 1360) },
    ],
  };
  return {
    updatedAt: 1,
    packageName: "com.apple.Preferences",
    hierarchy: {
      className: "XCUIApplication",
      text: "Settings",
      bounds: bounds(0, 0, 1032, 1376),
      node: [
        files,
        {
          className: "UIScrollView",
          resourceId: "form",
          bounds: bounds(200, 388, 704, 1320),
          extras: { [IOS_WINDOW_LAYER_EXTRA]: "1" },
          node: [
            { className: "UIButton", resourceId: "save", bounds: bounds(300, 1295, 500, 1315) },
          ],
        },
        {
          className: "UIInputSetHostView",
          resourceId: "keyboard",
          bounds: bounds(200, 1000, 704, 1290),
          extras: { [IOS_WINDOW_LAYER_EXTRA]: "0" },
        },
      ],
    },
  };
}

/** The runner's stamp after the fix: a layer behind both focused windows, and the owner. */
const stamped = {
  [IOS_WINDOW_LAYER_EXTRA]: "2",
  [IOS_WINDOW_PACKAGE_EXTRA]: "com.apple.DocumentsApp",
};

function convert(raw: XCTestHierarchy): ViewHierarchyResult {
  return new CtrlProxyHierarchy({} as HierarchyDelegateContext).convertToViewHierarchyResult(raw);
}

function entry(hierarchy: ViewHierarchyResult, id: string) {
  const found = new SearchableHierarchy()
    .project(hierarchy)
    .find((node) => node.nativeId === id && node.element);
  if (!found) {
    throw new Error(`no node ${id}`);
  }
  return found;
}

function clipSave(hierarchy: ViewHierarchyResult) {
  const save = entry(hierarchy, "save");
  return clipIosChromeBounds({
    bounds: save.bounds!,
    hierarchy,
    screen,
    elements: [save.element!],
    forTapTarget: true,
  });
}

describe("merged background iPad windows rank behind the focused app", () => {
  test("a stamped background root and its descendants rank behind every focused window", () => {
    const hierarchy = convert(capture(stamped));
    const tabBar = entry(hierarchy, "files-tabs");
    expect(tabBar.iosWindowLayer).toBe(2);
    expect(tabBar.windowRank).toBeGreaterThan(entry(hierarchy, "save").windowRank);
    expect(tabBar.windowRank).toBeGreaterThan(entry(hierarchy, "keyboard").windowRank);
  });

  test("background chrome does not clip a focused target it overlaps", () => {
    const hierarchy = convert(capture(stamped));
    expect(clipSave(hierarchy)).toEqual({ bounds: entry(hierarchy, "save").bounds! });
  });

  test("an unstamped background root would rank topmost and clip the focused target", () => {
    const hierarchy = convert(capture(undefined));
    expect(entry(hierarchy, "files-tabs").windowRank).toBeLessThan(
      entry(hierarchy, "save").windowRank,
    );
    expect(clipSave(hierarchy).bounds).not.toEqual(entry(hierarchy, "save").bounds);
  });
});

describe("focusedAppWindowsOnly", () => {
  test("drops other apps' merged window roots and keeps the focused app's nodes", () => {
    const scoped = focusedAppWindowsOnly(capture(stamped));
    expect(scoped.hierarchy.node as CtrlProxyNode[]).toHaveLength(2);
    expect(JSON.stringify(scoped)).not.toContain("files-tabs");
    expect(JSON.stringify(scoped)).toContain("save");
  });

  test("returns the same object when no other app's window is merged", () => {
    const single = capture(undefined);
    single.hierarchy.node = (single.hierarchy.node as CtrlProxyNode[]).slice(1);
    expect(focusedAppWindowsOnly(single)).toBe(single);
    const own = capture({ [IOS_WINDOW_PACKAGE_EXTRA]: "com.apple.Preferences" });
    expect(focusedAppWindowsOnly(own)).toBe(own);
  });
});
