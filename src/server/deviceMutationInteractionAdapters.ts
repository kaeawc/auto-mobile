import { opaqueIntentKey } from "../daemon/sessionBroker/mutations/types";
import type { Platform } from "../models";
import { SCREEN_STATE_MUTATION_KEY } from "../daemon/sessionBroker/mutations/screenStateMutation";
import {
  VOLUME_KEY_PRESS_MUTATION_KEY,
  volumeStreamMutationKey,
} from "../daemon/sessionBroker/mutations/volumeMutation";
import { MEDIA_VOLUME_STREAMS } from "../features/media/MediaSessionTypes";
import { isRecord } from "./pipeline/isRecord";
import type { ToolMutation } from "./deviceMutationAdapters";

function opaqueBreadcrumb(...parts: readonly string[]): ToolMutation {
  return { kind: "opaque", key: ["tool", ...parts].join(":") };
}

/**
 * pressButton changes persistent state only for some buttons:
 * - `power` and `lock` (Android) sleep or lock the device. A reset can wake and dismiss a keyguard
 *   with no credential, so the screen state is journaled with a readable prior.
 * - `volume_up` and `volume_down` change an audio stream volume. On Android the stream depends on
 *   audio focus and call state, so the press journals the level of every stream a key can change
 *   (one `volume:key-press` row) and the reset sets them back. The iOS level has no simctl revert,
 *   so an iOS press records a fallback intent.
 * - iOS `power` locks the simulator and iOS `action` runs the user's Action button shortcut; neither
 *   has a simctl revert, so they retain diagnostic breadcrumbs.
 * Back, home, recent, menu, camera and the transient system UI actions (power menu, quick settings,
 * shade dismissal, split screen) change nothing persistent; `screenshot` writes under
 * /sdcard/Pictures, which the baseline clean's file sweep removes.
 */
function pressButtonMutations(args: Record<string, unknown>, platform?: Platform): ToolMutation[] {
  const button = typeof args.button === "string" ? args.button.toLowerCase() : "";
  if (button === "volume_up" || button === "volume_down") {
    return platform === "ios"
      ? [{ kind: "opaque", key: opaqueIntentKey("pressButton", "volume") }]
      : [{ kind: "device-setting", key: VOLUME_KEY_PRESS_MUTATION_KEY }];
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
 * mediaSession `volume` sets a music, ring or alarm stream index: the Android row journals that
 * stream's level (`volume:<stream>`) and the reset sets it back. The tool is Android-only; an iOS
 * call or an unknown stream keeps a fallback intent.
 * `dispatch` sends a transport key to the app holding the media session: its effect is app-owned,
 * so it keeps a diagnostic breadcrumb. `get` is a read.
 */
function mediaSessionMutations(args: Record<string, unknown>, platform?: Platform): ToolMutation[] {
  const action = args.action;
  if (isRecord(action) && "volume" in action) {
    const stream = isRecord(action.volume) ? action.volume.stream : undefined;
    const known = MEDIA_VOLUME_STREAMS.find((candidate) => candidate === stream);
    return platform !== "ios" && known
      ? [{ kind: "device-setting", key: volumeStreamMutationKey(known) }]
      : [{ kind: "opaque", key: opaqueIntentKey("mediaSession", "volume") }];
  }
  return isRecord(action) && "dispatch" in action
    ? [opaqueBreadcrumb("mediaSession", "dispatch")]
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
  if (name === "mediaSession") {
    return mediaSessionMutations(args, platform);
  }
  return undefined;
}
