import { describe, expect, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/ios/CtrlProxyHierarchy";
import type { HierarchyDelegateContext } from "../../../../src/features/observe/ios/types";
import {
  IOS_WINDOW_LAYER_EXTRA,
  iosWindowLayer,
  rankWithIosWindowLayer,
} from "../../../../src/features/observe/ios/iosWindowLayer";
import { SearchableHierarchy } from "../../../../src/features/utility/SearchableNode";
import { clipIosChromeBounds } from "../../../../src/features/action/swipeon/iosChromeInsets";
import type { ViewHierarchyResult } from "../../../../src/models";
import { iosFloatingOverlayOverSettings } from "../../../fixtures/observe/iosOverlayWindow";

const screen = { width: 402, height: 874 };

function convert(raw = iosFloatingOverlayOverSettings()): ViewHierarchyResult {
  return new CtrlProxyHierarchy({} as HierarchyDelegateContext).convertToViewHierarchyResult(raw);
}

/** The captured Settings window alone, as a single-window app would report it. */
function appWindowOnly(): ViewHierarchyResult {
  const raw = iosFloatingOverlayOverSettings();
  raw.hierarchy.node = (raw.hierarchy.node as unknown[]).slice(0, 1) as typeof raw.hierarchy.node;
  return convert(raw);
}

function entry(hierarchy: ViewHierarchyResult, nativeId: string) {
  const found = new SearchableHierarchy()
    .project(hierarchy)
    .find((node) => node.nativeId === nativeId && node.element);
  if (!found) {
    throw new Error(`no node ${nativeId}`);
  }
  return found;
}

function clip(hierarchy: ViewHierarchyResult, nativeId: string) {
  const node = entry(hierarchy, nativeId);
  return clipIosChromeBounds({
    bounds: node.bounds!,
    hierarchy,
    screen,
    elements: [node.element!],
    forTapTarget: true,
  });
}

describe("iOS window layers on a captured in-app overlay window", () => {
  test("stamps each window's top-level nodes front to back and leaves descendants unstamped", () => {
    const roots = convert().hierarchy.node as unknown as { extras?: Record<string, string> };
    const children = (roots as { node?: { extras?: Record<string, string> }[] }).node ?? [];
    const layers = children.map((child) => child.extras?.[IOS_WINDOW_LAYER_EXTRA]);
    expect(new Set(layers)).toEqual(new Set(["0", "1"]));
    expect(layers.lastIndexOf("1")).toBeLessThan(layers.indexOf("0"));
  });

  test("ranks overlay nodes, including descendants, above the app's own chrome", () => {
    const hierarchy = convert();
    const dismiss = entry(hierarchy, "automobile-overlay-dismiss");
    const like = entry(hierarchy, "like-button");
    const toolbar = entry(hierarchy, "Toolbar");
    const navigation = entry(hierarchy, "Settings");
    expect([dismiss.iosWindowLayer, like.iosWindowLayer]).toEqual([0, 0]);
    expect([toolbar.iosWindowLayer, navigation.iosWindowLayer]).toEqual([1, 1]);
    expect(dismiss.windowRank).toBeLessThan(navigation.windowRank);
    expect(like.windowRank).toBeLessThan(toolbar.windowRank);
  });

  test("app chrome does not clip overlay controls drawn over it", () => {
    const hierarchy = convert();
    for (const id of ["automobile-overlay-dismiss", "like-button", "close-button"]) {
      expect(clip(hierarchy, id)).toEqual({ bounds: entry(hierarchy, id).bounds! });
    }
  });

  test("app chrome still clips app content beneath it", () => {
    const hierarchy = convert();
    // StandBy [744-796] straddles the toolbar top; Screen Time [831-883] is wholly behind it.
    expect(clip(hierarchy, "com.apple.settings.standBy").bounds).toEqual(
      expect.objectContaining({ top: 744, bottom: 788 }),
    );
    expect(clip(hierarchy, "com.apple.settings.screenTime")).toEqual({
      bounds: null,
      coveredBy: "bottom toolbar or tab bar",
    });
  });

  test("without the window layer the toolbar-band overlay controls read as covered", () => {
    const hierarchy = convert();
    const stripped = JSON.parse(
      JSON.stringify(hierarchy).replaceAll(`"${IOS_WINDOW_LAYER_EXTRA}"`, '"unrelated"'),
    ) as ViewHierarchyResult;
    // A non-scrolling control wholly inside the navigation bar is bar-level content even
    // without its layer (#10635); the toolbar band has no such exemption.
    expect(clip(stripped, "automobile-overlay-dismiss")).toEqual({
      bounds: entry(stripped, "automobile-overlay-dismiss").bounds!,
    });
    expect(clip(stripped, "close-button").bounds).toEqual(
      expect.objectContaining({ top: 780, bottom: 788 }),
    );
  });

  test("a single-window capture carries no layer and keeps its existing ranks", () => {
    const hierarchy = appWindowOnly();
    expect(JSON.stringify(hierarchy)).not.toContain(IOS_WINDOW_LAYER_EXTRA);
    const nodes = new SearchableHierarchy().project(hierarchy);
    expect(nodes.every((node) => node.iosWindowLayer === undefined)).toBe(true);
    expect(new Set(nodes.map((node) => node.windowRank)).size).toBe(1);
  });
});

describe("iosWindowLayer parsing", () => {
  test("reads only non-negative integer layers", () => {
    expect(iosWindowLayer({ [IOS_WINDOW_LAYER_EXTRA]: "2" })).toBe(2);
    for (const value of ["-1", "1.5", "x", 3]) {
      expect(iosWindowLayer({ [IOS_WINDOW_LAYER_EXTRA]: value })).toBeUndefined();
    }
    expect(iosWindowLayer(undefined)).toBeUndefined();
  });

  test("orders layers inside one window group without crossing into the next", () => {
    expect(rankWithIosWindowLayer(1, undefined)).toBe(1);
    expect(rankWithIosWindowLayer(1, 0)).toBeLessThan(rankWithIosWindowLayer(1, 1));
    expect(rankWithIosWindowLayer(1, 5000)).toBeLessThan(2);
  });
});
