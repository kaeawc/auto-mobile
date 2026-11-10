import type {
  BackStackInfo,
  BootedDevice,
  ElementBounds,
  SwipeOnOptions,
  TaskInfo,
} from "../../models";
import { ActionableError } from "../../models/ActionableError";

// Measured on the API 34 google-xr headset AVD (#17799/#17800): default-pose,
// home-space panels render at 61/64 around (shotWidth/2, 0.552*shotHeight).
export const XR_PANEL_SCALE = 61 / 64;
export const XR_PANEL_CENTER_Y = 0.552;

type Point = { x: number; y: number };
type Size = { width: number; height: number };
export type XrPanel = TaskInfo & { packageName: string; bounds: ElementBounds };

const isXrSystemUiName = (name: string | undefined): boolean =>
  !!name &&
  (name.startsWith("com.android.systemui.xr") || name.startsWith("com.android.systemui/.xr"));

/** Whether the observed back stack holds Android XR System UI tasks or activities. */
export function hasXrSystemUi(backStack: BackStackInfo | undefined): backStack is BackStackInfo {
  return (
    !!backStack &&
    (backStack.activities.some((activity) => isXrSystemUiName(activity.name)) ||
      backStack.tasks.some(
        (task) =>
          isXrSystemUiName(task.packageName) ||
          isXrSystemUiName(task.rootActivity) ||
          isXrSystemUiName(task.topActivity),
      ))
  );
}

/** Undefined means non-XR; a null panel means XR system UI without an app panel. */
export function detectXrPanel(
  backStack: BackStackInfo | undefined,
): { panel: XrPanel | null } | undefined {
  if (!hasXrSystemUi(backStack)) {
    return undefined;
  }
  const panel = backStack.tasks.find((task): task is XrPanel => {
    const bounds = task.bounds;
    return (
      !!task.packageName &&
      !task.packageName.startsWith("com.android.systemui") &&
      task.windowingMode === "freeform" &&
      !!bounds &&
      Object.values(bounds).every(Number.isFinite) &&
      bounds.right > bounds.left &&
      bounds.bottom > bounds.top
    );
  });
  return { panel: panel ?? null };
}

/** The measured eye screenshot is square even though wm size reports 2560x2558. */
export function xrScreenshotSize(observation: {
  screenSize: Size;
  screenshotImageSize?: Size;
}): Size {
  const side = Math.min(observation.screenSize.width, observation.screenSize.height);
  return observation.screenshotImageSize ?? { width: side, height: side };
}

export function panelRectInScreenshot(panel: XrPanel, screenshot: Size): ElementBounds {
  const halfWidth = ((panel.bounds.right - panel.bounds.left) * XR_PANEL_SCALE) / 2;
  const halfHeight = ((panel.bounds.bottom - panel.bounds.top) * XR_PANEL_SCALE) / 2;
  return {
    left: screenshot.width / 2 - halfWidth,
    right: screenshot.width / 2 + halfWidth,
    top: screenshot.height * XR_PANEL_CENTER_Y - halfHeight,
    bottom: screenshot.height * XR_PANEL_CENTER_Y + halfHeight,
  };
}

export function screenshotPointToPanelPoint(
  point: Point,
  panel: XrPanel | null,
  screenshot: Size,
): Point {
  const rect = panel && panelRectInScreenshot(panel, screenshot);
  if (
    !panel ||
    !rect ||
    point.x < rect.left ||
    point.x >= rect.right ||
    point.y < rect.top ||
    point.y >= rect.bottom
  ) {
    throw new ActionableError(
      "There is no app panel under that screenshot point. XR system UI (home-space launcher and environment buttons) cannot be tapped with tapAt. Open an app panel and choose a screenshot point inside it.",
    );
  }
  return {
    x: Math.min(
      panel.bounds.right - 1,
      Math.max(
        panel.bounds.left,
        Math.round(panel.bounds.left + (point.x - rect.left) / XR_PANEL_SCALE),
      ),
    ),
    y: Math.min(
      panel.bounds.bottom - 1,
      Math.max(
        panel.bounds.top,
        Math.round(panel.bounds.top + (point.y - rect.top) / XR_PANEL_SCALE),
      ),
    ),
  };
}

/** Display-space bounds for direction-based screen swipes; never start on XR system UI. */
export function xrSwipeBounds(
  backStack: BackStackInfo | undefined,
  fromEdge?: SwipeOnOptions["fromEdge"],
  platform: BootedDevice["platform"] = "android",
): ElementBounds | undefined {
  if (platform !== "android") {
    return undefined;
  }
  const xr = detectXrPanel(backStack);
  if (!xr) {
    return undefined;
  }
  if (fromEdge) {
    throw new ActionableError(
      "XR edge gestures hit the system. Omit fromEdge and swipe inside an open app panel.",
    );
  }
  if (!xr.panel) {
    throw new ActionableError(
      "No app panel is available. Swipes outside an app panel would dismiss XR home-space panels. Open an app panel and retry swipeOn inside it.",
    );
  }
  return xr.panel.bounds;
}
