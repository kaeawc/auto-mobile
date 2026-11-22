import type { XCTestHierarchy } from "./types";

/**
 * iOS window z-order, carried through hierarchy flattening.
 *
 * XCUITest lists an app's `UIWindow`s back to front (ascending window level), and the iOS
 * runner flattens those wrappers in normal captures, so every node would otherwise share one
 * window rank. An in-app prototype window, an alert window or the keyboard would then rank level
 * with the app's own
 * navigation bar and toolbars, and chrome clipping would treat app chrome as covering them.
 *
 * When two or more windows contribute nodes, each top-level node of a window is stamped with its
 * position counted from the front (0 = topmost). Normal captures are stamped by the runner while
 * flattening windows (`ElementLocator.optimizeHierarchy`, key `ElementLocator.iosWindowLayerExtra`).
 * The host converter stamps only raw captures that still carry `UIWindow` wrappers. Descendants
 * inherit the stamp in `SearchableHierarchy`.
 */
export const IOS_WINDOW_LAYER_EXTRA = "automobile:iosWindowLayer";

/** Front-to-back position, or undefined when the capture had a single contributing window. */
export function iosWindowLayer(extras: unknown): number | undefined {
  if (!extras || typeof extras !== "object" || Array.isArray(extras)) {
    return undefined;
  }
  const value = (extras as Record<string, unknown>)[IOS_WINDOW_LAYER_EXTRA];
  const layer = typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(layer) && layer >= 0 ? layer : undefined;
}

/**
 * A rank that keeps the capture's window-group order (integer part) and orders iOS windows within
 * it, topmost first. Layers stay below 1 so they never cross into another window group.
 */
export function rankWithIosWindowLayer(rank: number, layer: number | undefined): number {
  return layer === undefined ? rank : rank + Math.min(layer, 999) / 1000;
}

/**
 * Owner bundle id stamped by the runner on each other app's window root that an iPad observation
 * merges under the focused app's root (`ElementLocator.mergingBackgroundWindows`, #18830). Those
 * roots also carry a layer behind every focused window, so they never rank above the focused app.
 */
export const IOS_WINDOW_PACKAGE_EXTRA = "automobile:iosWindowPackage";

/**
 * The capture with other apps' merged window roots removed, so per-app screen identity sees only
 * the focused app. A capture without such roots is returned unchanged, as the same object.
 */
export function focusedAppWindowsOnly(capture: XCTestHierarchy): XCTestHierarchy {
  const children = capture.hierarchy.node;
  if (!children) {
    return capture;
  }
  const list = Array.isArray(children) ? children : [children];
  const kept = list.filter((child) => {
    const owner = child.extras?.[IOS_WINDOW_PACKAGE_EXTRA];
    return owner === undefined || owner === capture.packageName;
  });
  if (kept.length === list.length) {
    return capture;
  }
  return { ...capture, hierarchy: { ...capture.hierarchy, node: kept } };
}
