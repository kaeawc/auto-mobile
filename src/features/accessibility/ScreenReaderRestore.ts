import type { BootedDevice } from "../../models";
import type {
  ScreenReaderToggleOptions,
  TalkBackResult,
  VoiceOverResult,
} from "../../models/AccessibilityResult";
import { TALKBACK_TOGGLE_WORST_CASE_MS, TalkBackToggle } from "./TalkBackToggle";
import { VoiceOverToggle } from "./VoiceOverToggle";

/**
 * Budget for one screen-reader restore. A toggle is not a settings write: the
 * TalkBack path can spend its fallback hierarchy dump plus the dialog and
 * confirmation waits, so size to that worst case (plus slack for the ordinary
 * adb calls), not to the 1 s used for single `settings put` restores.
 */
export const SCREEN_READER_RESTORE_TIMEOUT_MS = TALKBACK_TOGGLE_WORST_CASE_MS + 2_000;

/**
 * Screen-reader state a session found before its first `accessibility` toggle.
 * Restored when the session releases or rebinds its device (#10146).
 */
export interface ScreenReaderRestoreState {
  platform: "android" | "ios";
  previousEnabled: boolean;
}

/** Session-owned slot the `accessibility` tool records into before it changes the state. */
export interface ScreenReaderRestoreSlot {
  get(): ScreenReaderRestoreState | undefined;
  record(state: ScreenReaderRestoreState): void;
  clear(): void;
}

/** Narrow seam over the two platform toggles, so restoration is unit-testable. */
export interface ScreenReaderToggles {
  talkBack(device: BootedDevice): {
    toggle(enabled: boolean, options?: ScreenReaderToggleOptions): Promise<TalkBackResult>;
  };
  voiceOver(device: BootedDevice): {
    toggle(enabled: boolean, options?: ScreenReaderToggleOptions): Promise<VoiceOverResult>;
  };
}

const defaultToggles: ScreenReaderToggles = {
  talkBack: (device) => new TalkBackToggle(device),
  voiceOver: (device) => new VoiceOverToggle(device),
};

/**
 * Put the screen reader back to the state the session found. Throws unless the
 * device is observed in that state, so the session manager treats it as a failed
 * restore exactly like the other device settings.
 */
export async function restoreScreenReaderState(
  device: BootedDevice,
  state: ScreenReaderRestoreState,
  signal?: AbortSignal,
  toggles: ScreenReaderToggles = defaultToggles,
): Promise<void> {
  signal?.throwIfAborted();
  const result =
    state.platform === "android"
      ? await toggles.talkBack(device).toggle(state.previousEnabled)
      : await toggles.voiceOver(device).toggle(state.previousEnabled);
  signal?.throwIfAborted();
  if (result.currentState === state.previousEnabled) {
    return;
  }
  const screenReader = state.platform === "android" ? "TalkBack" : "VoiceOver";
  const expected = state.previousEnabled ? "enabled" : "disabled";
  throw new Error(
    result.reason ??
      `${screenReader} was not confirmed ${expected} while restoring ${device.deviceId}`,
  );
}
