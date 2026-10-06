import { CTRL_PROXY_PACKAGE } from "../../ctrlProxy/constants";
import type { ObserveResult } from "../../models";
import { isOwnOverlayFocused } from "../observe/ownOverlayFocus";

/**
 * The package that owns the foreground task, from the adb back stack. Used to
 * name the app behind CtrlProxy's own overlay, whose window labels the capture
 * with the CtrlProxy package.
 */
function foregroundTaskPackage(observation: ObserveResult): string | undefined {
  const currentTaskId = observation.backStack?.currentTaskId;
  if (currentTaskId === undefined) {
    return undefined;
  }
  return observation.backStack?.tasks.find((task) => task.id === currentTaskId)?.packageName;
}

/**
 * Reconcile launch identity signals, using foregroundActivity only as fallback.
 *
 * While CtrlProxy's own focusable overlay holds window focus the capture is
 * labelled with the CtrlProxy package although the launched app is resumed
 * behind it (issue #10000); that package is not a competing foreground app, so
 * it is dropped in favour of the app behind the overlay. When no app behind the
 * overlay can be named, the overlay package is kept so the launch fails closed.
 */
export function getLaunchObservationPackageNames(observation: ObserveResult | undefined): string[] {
  if (!observation) {
    return [];
  }

  const overlayFocused = isOwnOverlayFocused(observation.viewHierarchy);
  const reported = [observation.activeWindow?.appId, observation.viewHierarchy?.packageName].filter(
    (packageName): packageName is string => !!packageName,
  );
  const primaryPackageNames = overlayFocused
    ? reported.filter((packageName) => packageName !== CTRL_PROXY_PACKAGE)
    : reported;

  if (primaryPackageNames.length > 0) {
    return [...new Set(primaryPackageNames)];
  }

  if (overlayFocused) {
    const behindOverlay = foregroundTaskPackage(observation);
    return [behindOverlay ?? CTRL_PROXY_PACKAGE];
  }

  const foregroundActivity = observation.viewHierarchy?.foregroundActivity;
  const fallbackPackageName = foregroundActivity?.split("/")[0];
  return fallbackPackageName ? [fallbackPackageName] : [];
}

/** Whether launch observation is showing the accepted notification permission surface. */
export function isLaunchPermissionDialogObservation(
  observation: Pick<ObserveResult, "notificationPermissionDetected" | "activeWindow"> | undefined,
): boolean {
  return (
    observation?.notificationPermissionDetected === true &&
    observation.activeWindow?.type === "notification_permission_dialog"
  );
}
