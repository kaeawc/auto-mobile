import type { ObserveResult } from "../../models";

/** Reconcile launch identity signals, using foregroundActivity only as fallback. */
export function getLaunchObservationPackageNames(observation: ObserveResult | undefined): string[] {
  if (!observation) {
    return [];
  }

  const primaryPackageNames = [
    observation.activeWindow?.appId,
    observation.viewHierarchy?.packageName,
  ].filter((packageName): packageName is string => !!packageName);

  if (primaryPackageNames.length > 0) {
    return [...new Set(primaryPackageNames)];
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
