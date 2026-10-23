import { opaqueIntentKey } from "../daemon/sessionBroker/mutations/types";
import type { Platform } from "../models";
import { SCREEN_STATE_MUTATION_KEY } from "../daemon/sessionBroker/mutations/screenStateMutation";
import { isRecord } from "./pipeline/isRecord";
import type { ToolMutation } from "./deviceMutationAdapters";

/**
 * Input events that change no device state a later session could observe. Verified against what
 * each tool executes: `input tap/swipe/touchscreen/stylus/keyevent`, CtrlProxy accessibility
 * actions and gestures, `cmd statusbar expand/collapse`, a CtrlProxy overlay window that removes
 * itself, an emulator accelerometer vector the call restores in a `finally`, and wake/dismiss-
 * keyguard key events that move the device toward the ready state. Effects the target app causes
 * (a tapped Settings switch, a notification's content intent, text typed into a field) are
 * app-owned and outside the journal's scope; the keep-booted baseline clean still covers shared
 * settings, packages and files.
 */
const PURE_INPUT_TOOLS: ReadonlySet<string> = new Set([
  "accessibilityFocus",
  "dragAndDrop",
  "dragPath",
  "highlight",
  "homeScreen",
  "multiTouch",
  "pinchOn",
  "recentApps",
  "selectAllText",
  "shake",
  "swipeAt",
  "swipeOn",
  "systemTray",
  "tapAny",
  "tapAt",
  "tapOn",
  "wakeAndUnlock",
]);

function opaqueBreadcrumb(...parts: readonly string[]): ToolMutation {
  return { kind: "opaque", key: ["tool", ...parts].join(":") };
}

/**
 * pressButton changes persistent state only for some buttons:
 * - `power` and `lock` (Android) sleep or lock the device. A reset can wake and dismiss a keyguard
 *   with no credential, so the screen state is journaled with a readable prior.
 * - `volume_up` and `volume_down` change the audio stream volume. Android persists it in settings
 *   rows the baseline clean restores; the live level and the iOS level have no revert. A fallback
 *   intent prevents a clean keep-booted reset on both platforms.
 * - iOS `power` locks the simulator and iOS `action` runs the user's Action button shortcut; neither
 *   has a simctl revert, so they retain diagnostic breadcrumbs.
 * Back, home, recent, menu, camera and the transient system UI actions (power menu, quick settings,
 * shade dismissal, split screen) change nothing persistent; `screenshot` writes under
 * /sdcard/Pictures, which the baseline clean's file sweep removes.
 */
function pressButtonMutations(args: Record<string, unknown>, platform?: Platform): ToolMutation[] {
  const button = typeof args.button === "string" ? args.button.toLowerCase() : "";
  if (button === "volume_up" || button === "volume_down") {
    return [{ kind: "opaque", key: opaqueIntentKey("pressButton", "volume") }];
  }
  if (platform === "ios") {
    return button === "power" || button === "action"
      ? [opaqueBreadcrumb("pressButton", button)]
      : [];
  }
  return button === "power" || button === "lock"
    ? [{ kind: "device-setting", key: SCREEN_STATE_MUTATION_KEY }]
    : [];
}

/**
 * A `type` command with `keyboardProfile` switches the CtrlProxy keyboard profile (persisted in its
 * preferences) for the call and restores it afterwards, the same row `keyboard setProfile` journals.
 * The commit-IME switch every Android `type`/`clear` performs rewrites secure settings
 * (`default_input_method`, `enabled_input_methods`) that the call restores and the baseline clean
 * restores again, so it adds no row.
 */
function sendKeysMutations(args: Record<string, unknown>, platform?: Platform): ToolMutation[] {
  const commands = Array.isArray(args.commands) ? args.commands : [];
  const switchesProfile = commands.some(
    (command) => isRecord(command) && command.action === "type" && command.keyboardProfile,
  );
  return platform !== "ios" && switchesProfile ? [{ kind: "keyboard", key: "profile" }] : [];
}

/**
 * Interaction tool families: the journal intents recorded before the tool acts (#14359).
 * Returns undefined for a tool this family does not own, [] for an owned call that changes
 * nothing, and the intents otherwise.
 */
export function interactionToolMutations(
  name: string,
  args: Record<string, unknown>,
  platform?: Platform,
): ToolMutation[] | undefined {
  if (name === "pressButton") {
    return pressButtonMutations(args, platform);
  }
  if (name === "sendKeys") {
    return sendKeysMutations(args, platform);
  }
  return PURE_INPUT_TOOLS.has(name) ? [] : undefined;
}
