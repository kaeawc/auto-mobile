import type {
  BackStackInfo,
  BootedDevice,
  ElementBounds,
  ObserveResult,
  SwipeOnOptions,
  TaskInfo,
} from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { hasXrSystemUi } from "../../utils/android-cmdline-tools/androidXrDevice";

// Measured on the API 34 google-xr headset AVD (#17799/#17800): default-pose,
// home-space panels render at 61/64 around (shotWidth/2, 0.552*shotHeight).
export const XR_PANEL_SCALE = 61 / 64;
export const XR_PANEL_CENTER_Y = 0.552;

type Point = { x: number; y: number };
type Size = { width: number; height: number };
export type XrPanel = TaskInfo & { packageName: string; bounds: ElementBounds };

/**
 * Undefined means non-XR; a null panel means XR without an app panel. `androidXr` is the answer
 * of the shared `isAndroidXr` predicate; callers with no device handle (swipes) omit it and the
 * back stack's XR System UI decides, the same fallback the predicate uses.
 */
export function detectXrPanel(
  backStack: BackStackInfo | undefined,
  androidXr: boolean = hasXrSystemUi(backStack),
): { panel: XrPanel | null } | undefined {
  if (!androidXr) {
    return undefined;
  }
  return { panel: (backStack && appPanels(backStack)[0]) ?? null };
}

function appPanels(backStack: BackStackInfo): XrPanel[] {
  return backStack.tasks.filter((task): task is XrPanel => {
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
}

export const XR_DEFAULT_POSE_WARNING =
  "Android XR coordinates assume the app panel is in its default pose (not moved or scaled). If the panel was moved or scaled, the gesture lands on the wrong spot: keep the panel in its default position, or reopen the app to restore it, then observe again before retrying.";

/** Cheap pre-dispatch signals that the default pose cannot hold; undefined when none fires. */
function nonDefaultPoseReason(
  backStack: BackStackInfo,
  panel: XrPanel | null,
  screenshot: Size,
): string | undefined {
  const panels = appPanels(backStack);
  if (panels.length > 1) {
    return `${panels.length} app panels are open (${panels.map((p) => p.packageName).join(", ")}), and only one can sit at the default pose. Close the other app panels, observe again, and retry.`;
  }
  const rect = panel && panelRectInScreenshot(panel, screenshot);
  if (
    rect &&
    (rect.left < 0 ||
      rect.top < 0 ||
      rect.right > screenshot.width ||
      rect.bottom > screenshot.height)
  ) {
    return `the ${panel.packageName} panel (${panel.bounds.right - panel.bounds.left}x${panel.bounds.bottom - panel.bounds.top}) does not fit the screenshot at the default pose. Restore the panel to its default size and position, observe again, and retry.`;
  }
  return undefined;
}

/**
 * XR default-pose check for Android coordinate gestures. Undefined means non-XR; otherwise the
 * caveat every XR result carries. Throws when a cheap signal shows the pose is not the default.
 */
export function xrDefaultPoseWarning(
  // Undefined when the interaction ran without a pre-dispatch observation: nothing to check.
  observation: Pick<ObserveResult, "backStack" | "screenSize" | "screenshotImageSize"> | undefined,
  androidXr?: boolean,
): string | undefined {
  const xr = detectXrPanel(observation?.backStack, androidXr);
  if (!xr || !observation?.backStack) {
    return undefined;
  }
  const reason = nonDefaultPoseReason(
    observation.backStack,
    xr.panel,
    xrScreenshotSize(observation),
  );
  if (reason) {
    throw new ActionableError(
      `Android XR coordinates assume the default panel pose, which does not hold here: ${reason}`,
    );
  }
  return XR_DEFAULT_POSE_WARNING;
}

/** Join an optional caveat onto an existing warning, keeping each text once. */
export function appendWarning(warning: string | undefined, extra: string | undefined) {
  return [...new Set([warning, extra].filter((text) => text !== undefined))].join(" ") || undefined;
}

/** Refuses before `dispatch` on a visibly non-default XR pose; adds the caveat to its result. */
export async function withXrPoseWarning<
  O extends Pick<ObserveResult, "backStack" | "screenSize" | "screenshotImageSize">,
  A extends unknown[],
  T extends { warning?: string },
>(
  platform: BootedDevice["platform"],
  dispatch: (observation: O, ...rest: A) => Promise<T>,
  observation: O,
  ...rest: A
): Promise<T> {
  const xrWarning = platform === "android" ? xrDefaultPoseWarning(observation) : undefined;
  const result = await dispatch(observation, ...rest);
  return xrWarning ? { ...result, warning: appendWarning(result.warning, xrWarning) } : result;
}

function fullscreenTaskExtent(backStack: BackStackInfo | undefined): Size | undefined {
  let display: Size | undefined;
  for (const task of backStack?.tasks ?? []) {
    const bounds = task.bounds;
    if (
      task.windowingMode !== "fullscreen" ||
      !bounds ||
      !Object.values(bounds).every(Number.isFinite)
    ) {
      continue;
    }
    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    if (width > 0 && height > 0 && (!display || width * height > display.width * display.height)) {
      display = { width, height };
    }
  }
  return display;
}

/** The eye screenshot is square; fullscreen tasks recover display size when screenSize is the IME. */
export function xrScreenshotSize(observation: {
  screenSize: Size;
  screenshotImageSize?: Size;
  backStack?: BackStackInfo;
}): Size {
  if (observation.screenshotImageSize) {
    return observation.screenshotImageSize;
  }
  const display = fullscreenTaskExtent(observation.backStack);
  const side = Math.min(
    Math.max(observation.screenSize.width, display?.width ?? observation.screenSize.width),
    Math.max(observation.screenSize.height, display?.height ?? observation.screenSize.height),
  );
  return { width: side, height: side };
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
