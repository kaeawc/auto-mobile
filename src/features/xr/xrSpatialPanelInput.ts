import { ActionableError, type ObserveResult } from "../../models";
import { parseBounds } from "../../utils/bounds";
import { xrForegroundApp } from "./xrForegroundApp";
import { resolveViewHierarchyForSearch } from "../utility/viewHierarchySearch";

export function assertXrDisplayInputSupported(
  observation: Pick<ObserveResult, "activeWindow" | "backStack" | "viewHierarchy">,
  androidXr: boolean,
): void {
  assertDisplayInputSupported(
    observation,
    androidXr,
    "XR spatial-panel input injection is unsupported: display touches cannot reach this app's SpatialPanel. Use tapOn/tapAny (accessibility node click) or keyboard focus keys instead.",
  );
}

/** A foreground application window extending outside its task identifies a SpatialPanel, even without a host. */
function assertDisplayInputSupported(
  observation: Pick<ObserveResult, "activeWindow" | "backStack" | "viewHierarchy">,
  androidXr: boolean,
  message: string,
): void {
  if (findXrSpatialPanelWindow(observation, androidXr)) {
    throw new ActionableError(message);
  }
}

/** Shared geometry evidence for input refusal and output-only coordinate declarations. */
export function findXrSpatialPanelWindow(
  observation: Pick<ObserveResult, "activeWindow" | "backStack" | "viewHierarchy">,
  androidXr: boolean,
) {
  if (!androidXr) {
    return;
  }
  const hierarchy = resolveViewHierarchyForSearch(observation.viewHierarchy);
  const packageName = xrForegroundApp(observation);
  const task =
    observation.backStack?.tasks.find(
      (candidate) =>
        candidate.id === observation.backStack?.currentTaskId &&
        candidate.packageName === packageName,
    ) ?? observation.backStack?.tasks.find((candidate) => candidate.packageName === packageName);
  const taskBounds = parseBounds(task?.bounds);
  if (!packageName || packageName.startsWith("com.android.systemui") || !taskBounds) {
    return;
  }
  return hierarchy?.windows?.find((window) => {
    if (window.type !== 1 || window.packageName !== packageName) {
      return false;
    }
    const bounds = parseBounds(window.bounds);
    return (
      bounds &&
      (bounds.left < taskBounds.left ||
        bounds.top < taskBounds.top ||
        bounds.right > taskBounds.right ||
        bounds.bottom > taskBounds.bottom)
    );
  });
}

/** Swipe containers still inject display input unless a semantic node action succeeds. */
export function assertXrSwipeDisplayInputSupported(
  observation: Pick<ObserveResult, "activeWindow" | "backStack" | "viewHierarchy">,
  androidXr: boolean,
): void {
  assertDisplayInputSupported(
    observation,
    androidXr,
    "display-input swipe scrolling is unsupported on XR spatial panels; use tapOn/tapAny node click or keyboard focus keys instead",
  );
}
