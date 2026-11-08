import { isTruthy, type Element } from "../../models/Element";
import type { ActiveWindowInfo } from "../../models/ActiveWindowInfo";
import type { ObserveResult } from "../../models/ObserveResult";

/** Packages that host Android's runtime permission grant dialog (AOSP and Google builds). */
const PERMISSION_CONTROLLER_PACKAGES: ReadonlySet<string> = new Set([
  "com.android.permissioncontroller",
  "com.google.android.permissioncontroller",
]);

const NOTIFICATION_PERMISSION = "android.permission.POST_NOTIFICATIONS";

export function isPermissionControllerPackage(packageName: string | undefined): boolean {
  return packageName !== undefined && PERMISSION_CONTROLLER_PACKAGES.has(packageName);
}

function isActivityInPackage(activityName: string, packageName: string): boolean {
  return activityName === packageName || activityName.startsWith(`${packageName}.`);
}

/**
 * Keep `activeWindow` describing one window (#17465). A permission controller
 * window can only host the permission controller's own activity, but CtrlProxy
 * pairs the captured root package with the last window-state class it heard, so
 * a grant dialog shown over a freshly launched app can come back as the
 * controller's appId with the app's activity. That activity belongs to the
 * window behind the dialog, so it is reported as unknown (empty) rather than
 * attributed to the dialog. Any other window is returned unchanged.
 */
export function pairPermissionDialogWindow<T extends ActiveWindowInfo | undefined>(window: T): T {
  if (!window || !isPermissionControllerPackage(window.appId) || window.activityName === "") {
    return window;
  }
  const ownActivity = [...PERMISSION_CONTROLLER_PACKAGES].some((packageName) =>
    isActivityInPackage(window.activityName, packageName),
  );
  return ownActivity ? window : { ...window, activityName: "" };
}

/** The typed obstacle a successful launch landed behind (#17465). */
export interface LaunchPermissionBlocker {
  kind: "permission_dialog";
  /** Package that owns the dialog window. */
  packageName: string;
  /** The requested permission, when the capture identifies it. */
  permission?: string;
  /** Visible dialog button labels, top to bottom; each is a `tapOn` text target. */
  actions: string[];
}

function buttonLabel(element: Element): string | undefined {
  const label = element.text ?? element["content-desc"];
  return typeof label === "string" && label.trim() !== "" ? label.trim() : undefined;
}

function isDialogButton(element: Element, dialogPackage: string): boolean {
  if (element.enabled !== undefined && !isTruthy(element.enabled)) {
    return false;
  }
  if (element.package !== undefined && element.package !== dialogPackage) {
    return false;
  }
  // The dialog panel itself is clickable too; only its buttons are next steps.
  const resourceId = element["resource-id"] ?? "";
  const className = typeof element.class === "string" ? element.class : "";
  return /button/i.test(resourceId) || /Button$/.test(className);
}

function dialogActions(observation: ObserveResult, dialogPackage: string): string[] {
  const labels = (observation.elements?.clickable ?? [])
    .filter((element) => isDialogButton(element, dialogPackage))
    .map(buttonLabel)
    .filter((label): label is string => label !== undefined);
  return [...new Set(labels)];
}

/**
 * Describe the permission dialog a successful launch of `appId` landed behind,
 * or `undefined` when the foreground is not one. A dialog counts when the
 * capture flagged a notification-permission dialog or a permission controller
 * owns the foreground window, and in either case the window is not the
 * requested app's own.
 */
export function resolveLaunchPermissionBlocker(
  appId: string,
  observation: ObserveResult | undefined,
): LaunchPermissionBlocker | undefined {
  const dialogPackage = foregroundPackage(observation);
  if (!observation || !dialogPackage || dialogPackage === appId) {
    return undefined;
  }
  const notificationDialog = isNotificationPermissionDialog(observation);
  if (!notificationDialog && !isPermissionControllerPackage(dialogPackage)) {
    return undefined;
  }
  return {
    kind: "permission_dialog",
    packageName: dialogPackage,
    ...(notificationDialog ? { permission: NOTIFICATION_PERMISSION } : {}),
    actions: dialogActions(observation, dialogPackage),
  };
}

function foregroundPackage(observation: ObserveResult | undefined): string | undefined {
  return observation?.activeWindow?.appId || observation?.viewHierarchy?.packageName;
}

function isNotificationPermissionDialog(observation: ObserveResult): boolean {
  return (
    observation.notificationPermissionDetected === true ||
    observation.activeWindow?.type === "notification_permission_dialog"
  );
}

/** The next-step sentence appended to the launch message for a blocked launch. */
export function describeLaunchPermissionBlocker(blocker: LaunchPermissionBlocker): string {
  const subject =
    blocker.permission === NOTIFICATION_PERMISSION
      ? "a notification permission dialog"
      : "a permission dialog";
  const taps =
    blocker.actions.length > 0
      ? `tap ${blocker.actions.map((action) => `"${action}"`).join(" or ")}`
      : "answer it with tapOn";
  return `blocked by ${subject} (${blocker.packageName}); ${taps}, or pre-grant with setAppPermissions`;
}
