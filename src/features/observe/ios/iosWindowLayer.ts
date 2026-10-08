/**
 * iOS window z-order, carried through hierarchy flattening.
 *
 * XCUITest lists an app's `UIWindow`s back to front (ascending window level), and the iOS
 * converter collapses those wrappers, so every node would otherwise share one window rank. An
 * in-app overlay window, an alert window or the keyboard would then rank level with the app's own
 * navigation bar and toolbars, and chrome clipping would treat app chrome as covering them.
 *
 * When two or more windows contribute nodes, each top-level node of a window is stamped with its
 * position counted from the front (0 = topmost). Descendants inherit it in `SearchableHierarchy`.
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
