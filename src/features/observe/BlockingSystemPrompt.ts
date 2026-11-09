import type { ObserveResult, ViewHierarchyWindowInfo } from "../../models";
import type { BlockingSystemPrompt } from "../../models/BlockingSystemPrompt";

/** Packages that host the runtime permission prompt (Google build and AOSP). */
const PERMISSION_CONTROLLER_PACKAGES = new Set<string>([
  "com.google.android.permissioncontroller",
  "com.android.permissioncontroller",
]);

/**
 * Non-app packages whose focused window covers the app: SystemUI dialogs (screen capture,
 * USB, shade) and framework `android` dialogs (ANR, chooser, resolver).
 */
const SYSTEM_DIALOG_PACKAGES = new Set<string>(["com.android.systemui", "android"]);

/** Foreground activity identifies a runtime prompt, not the requested permission. */
export function isRuntimePermissionPrompt(app: {
  packageName: string;
  activityName?: string;
}): boolean {
  // Accept the AOSP package too: it hosts the same GrantPermissionsActivity.
  return (
    PERMISSION_CONTROLLER_PACKAGES.has(app.packageName) &&
    app.activityName?.split(".").at(-1) === "GrantPermissionsActivity"
  );
}

function promptFromFocusedWindow(
  windows: ViewHierarchyWindowInfo[] | undefined,
): BlockingSystemPrompt | undefined {
  const focused = windows?.find((window) => window.isFocused === true);
  const packageName = focused?.packageName;
  if (!packageName) {
    return undefined;
  }
  if (PERMISSION_CONTROLLER_PACKAGES.has(packageName)) {
    return { kind: "runtime-permission", package: packageName };
  }
  return SYSTEM_DIALOG_PACKAGES.has(packageName)
    ? { kind: "system-dialog", package: packageName }
    : undefined;
}

/**
 * A system window (permission controller, SystemUI, framework dialog) that holds focus over the
 * app in this observation. The focused accessibility window is checked first because
 * `activeWindow` can still name the app's activity while a dialog window is on top; the
 * foreground activity is the fallback for captures without window metadata.
 */
export function blockingSystemPromptIn(
  observation: Pick<ObserveResult, "activeWindow" | "viewHierarchy"> | undefined,
): BlockingSystemPrompt | undefined {
  const fromWindow = promptFromFocusedWindow(observation?.viewHierarchy?.windows);
  const active = observation?.activeWindow;
  if (fromWindow) {
    return active?.appId === fromWindow.package && active.activityName
      ? { ...fromWindow, activity: active.activityName }
      : fromWindow;
  }
  if (!active) {
    return undefined;
  }
  if (isRuntimePermissionPrompt({ packageName: active.appId, activityName: active.activityName })) {
    return { kind: "runtime-permission", package: active.appId, activity: active.activityName };
  }
  return active.systemOverlay === true
    ? { kind: "system-dialog", package: active.appId, activity: active.activityName }
    : undefined;
}

/** What a caller must do before retrying an action the prompt is covering. */
export function blockingSystemPromptHint(prompt: BlockingSystemPrompt): string {
  const subject =
    prompt.kind === "runtime-permission"
      ? `A system runtime permission prompt (${prompt.package}) is covering the app`
      : `A system window from ${prompt.package} is covering the app`;
  const action =
    prompt.kind === "runtime-permission"
      ? "answer it with tapOn on its permission_allow_button or permission_deny_button"
      : "dismiss it (tapOn its button, or pressButton back)";
  return `${subject}; scrolling will not reveal the field. Use observe to inspect it, ${action}, then retry.`;
}
