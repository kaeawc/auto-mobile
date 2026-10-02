import { DEFAULT_GESTURE_REQUEST_TIMEOUT_MS } from "../observe/shared/SharedGestureDelegate";
import { MAX_SETTIMEOUT_DELAY_MS } from "../../utils/SystemTimer";

/** Cover the native press and reply delivery with the same margin as tapAny. */
export const LONG_PRESS_TIMEOUT_HEADROOM_MS = 2000;

/** Preserve the request default and clamp delays above the Node/Bun timer ceiling. */
export function resolveGestureCtrlProxyTimeoutMs(pressDurationMs: number): number {
  return Math.min(
    Math.max(DEFAULT_GESTURE_REQUEST_TIMEOUT_MS, pressDurationMs + LONG_PRESS_TIMEOUT_HEADROOM_MS),
    MAX_SETTIMEOUT_DELAY_MS,
  );
}

/** Ordinary coordinate taps preserve the transport's existing default timeout. */
export const ORDINARY_TAP_DURATION_MS = 50;

export function resolveCoordinateTapCtrlProxyTimeoutMs(durationMs: number): number | undefined {
  return durationMs <= ORDINARY_TAP_DURATION_MS
    ? undefined
    : resolveGestureCtrlProxyTimeoutMs(durationMs);
}

/** Activation keeps the default timeout; a VoiceOver long press always covers its duration. */
export function resolveVoiceOverActivateCtrlProxyTimeoutMs(
  action: "activate" | "long_press",
  durationMs: number,
): number | undefined {
  return action === "long_press" ? resolveGestureCtrlProxyTimeoutMs(durationMs) : undefined;
}
