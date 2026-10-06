import type { Element } from "../../models/Element";
import type { ViewHierarchyWindowInfo } from "../../models/ViewHierarchyResult";
import { intersectBounds, parseBounds } from "../../utils/bounds";

/** AccessibilityWindowInfo.TYPE_APPLICATION / TYPE_INPUT_METHOD / TYPE_SYSTEM. */
const WINDOW_TYPE_APPLICATION = 1;
const WINDOW_TYPE_INPUT_METHOD = 2;
const WINDOW_TYPE_SYSTEM = 3;

/**
 * The device-side occlusion pass marks a node covered by another window `partial` (or `hidden`,
 * which it removes from the tree). It deliberately skips the IME window, so keyboard coverage is
 * found from the window list instead (see {@link isCoveredByAnotherWindow}).
 */
function hasDeviceOcclusion(element: Element): boolean {
  const state = element.occlusionState;
  return state === "partial" || state === "hidden";
}

function isAboveOwnWindow(
  occluder: ViewHierarchyWindowInfo,
  own: ViewHierarchyWindowInfo | undefined,
): boolean {
  if (occluder.type === WINDOW_TYPE_INPUT_METHOD) {
    // The keyboard is always stacked above application content. An element in a window layered
    // above it (a popup drawn over the keyboard) is not covered by it.
    return !(
      own?.type === WINDOW_TYPE_INPUT_METHOD ||
      (own?.windowLayer !== undefined &&
        occluder.windowLayer !== undefined &&
        own.windowLayer > occluder.windowLayer)
    );
  }
  if (occluder.type !== WINDOW_TYPE_APPLICATION && occluder.type !== WINDOW_TYPE_SYSTEM) {
    // Accessibility overlays (CtrlProxy's own highlight window included) draw over the screen
    // without hiding the app, so their pixels never replace the element's.
    return false;
  }
  return (
    own?.windowLayer !== undefined &&
    occluder.windowLayer !== undefined &&
    occluder.windowLayer > own.windowLayer
  );
}

/**
 * Whether another window is stacked above the element's window over the element's bounds, so the
 * screenshot pixels there belong to that window. Window ownership comes from the capture's own
 * `windowId` markers; an element whose window is unknown can only be proven covered by the keyboard.
 */
function isCoveredByAnotherWindow(
  element: Element,
  windowId: number | undefined,
  windows: readonly ViewHierarchyWindowInfo[],
): boolean {
  const own = windowId === undefined ? undefined : windows.find((window) => window.id === windowId);
  return windows.some((window) => {
    // Captures carry window bounds as an object or the compact tuple; one without usable bounds
    // cannot be proven to cover anything.
    const windowBounds = parseBounds(window.bounds);
    return (
      windowBounds !== null &&
      window !== own &&
      isAboveOwnWindow(window, own) &&
      intersectBounds(element.bounds, windowBounds) !== null
    );
  });
}

/**
 * Whether the screenshot can show this element's text at all: not under the soft keyboard or any
 * other window layered above its own, and not marked occluded by the device. A partly hidden
 * element is excluded rather than sampled in its visible part, because the capture does not say
 * which part that is (#10220).
 */
export function isContrastObservable(
  element: Element,
  windowId: number | undefined,
  windows: readonly ViewHierarchyWindowInfo[] = [],
): boolean {
  return !hasDeviceOcclusion(element) && !isCoveredByAnotherWindow(element, windowId, windows);
}
