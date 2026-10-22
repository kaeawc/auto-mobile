import {
  GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE_CAPABILITY,
  GLOBAL_ACTION_LOCK_SCREEN_CAPABILITY,
  GLOBAL_ACTION_POWER_DIALOG_CAPABILITY,
  GLOBAL_ACTION_QUICK_SETTINGS_CAPABILITY,
  GLOBAL_ACTION_SCREENSHOT_CAPABILITY,
  GLOBAL_ACTION_SPLIT_SCREEN_CAPABILITY,
} from "../observe/android/ctrlProxyProtocol/capabilities";

/**
 * Android system actions reachable through `pressButton` (#14095): CtrlProxy performs them as
 * accessibility global actions, so none has an ADB keyevent fallback.
 *
 * Each action is gated on one capability flag the installed CtrlProxy advertises only when it
 * knows the action AND the device API level can perform it (the Kotlin side,
 * `SystemGlobalActions.advertisedFlags(sdkInt)`). The host therefore refuses with a single check
 * and never sends a global action an older APK or an older Android would silently drop.
 */
export interface AndroidSystemAction {
  /** `request_global_action` wire name. */
  readonly wireAction: string;
  /** Capability flag in the CtrlProxy handshake `supportedCommands`. */
  readonly capability: string;
  /** Lowest Android API level that can perform it (documentation and refusal wording). */
  readonly minApi: number;
  /** Advisory note returned with a successful press, when the effect outlives the call. */
  readonly successWarning?: string;
}

export const ANDROID_SYSTEM_ACTIONS: Readonly<Record<string, AndroidSystemAction>> = Object.assign(
  Object.create(null),
  {
    lock: {
      wireAction: "lock_screen",
      capability: GLOBAL_ACTION_LOCK_SCREEN_CAPABILITY,
      minApi: 28,
      successWarning:
        "The device is now locked; call wakeAndUnlock to unlock it. Locking is not undone by session cleanup.",
    },
    power_dialog: {
      wireAction: "power_dialog",
      capability: GLOBAL_ACTION_POWER_DIALOG_CAPABILITY,
      minApi: 21,
      successWarning: "The power menu stays open until dismissed; press back or home to close it.",
    },
    quick_settings: {
      wireAction: "quick_settings",
      capability: GLOBAL_ACTION_QUICK_SETTINGS_CAPABILITY,
      minApi: 21,
      successWarning:
        "Quick Settings stays open until dismissed; press dismiss_notification_shade (API 31+), back or home to close it.",
    },
    screenshot: {
      wireAction: "screenshot",
      capability: GLOBAL_ACTION_SCREENSHOT_CAPABILITY,
      minApi: 28,
    },
    split_screen: {
      wireAction: "split_screen",
      capability: GLOBAL_ACTION_SPLIT_SCREEN_CAPABILITY,
      minApi: 24,
      successWarning:
        "split_screen is the raw system toggle: it splits or restores the current task with no control over the second app. Use windowMode to place a chosen app in split screen.",
    },
    dismiss_notification_shade: {
      wireAction: "dismiss_notification_shade",
      capability: GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE_CAPABILITY,
      minApi: 31,
    },
  } satisfies Record<string, AndroidSystemAction>,
);

export function resolveAndroidSystemAction(button: string): AndroidSystemAction | undefined {
  return ANDROID_SYSTEM_ACTIONS[button.toLowerCase()];
}

export function isAndroidSystemActionButton(button: unknown): boolean {
  return typeof button === "string" && resolveAndroidSystemAction(button) !== undefined;
}

export const ANDROID_SYSTEM_ACTION_BUTTONS = Object.keys(ANDROID_SYSTEM_ACTIONS);

/** Refusal text for a device whose CtrlProxy does not advertise the action's capability. */
export function androidSystemActionRefusal(button: string, action: AndroidSystemAction): string {
  return (
    `"${button}" is unavailable on this device: it needs Android API ${action.minApi}+ and a ` +
    `CtrlProxy APK that advertises ${action.capability}. Restart the daemon so it installs the ` +
    "current APK; if the device is below that API level the action cannot run there."
  );
}
