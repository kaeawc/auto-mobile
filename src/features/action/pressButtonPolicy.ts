import { ANDROID_SYSTEM_ACTION_BUTTONS } from "./androidSystemActions";

// iOS action runs a user-chosen shortcut and camera opens the camera: both can change the UI.
// The Android system actions (#14095) open or close system UI, lock the device or split the task.
const NAVIGATION_PRESS_BUTTONS = new Set([
  "back",
  "home",
  "recent",
  "power",
  "action",
  "camera",
  // Remote select activates the focused item, like rotary_select.
  "select",
  // The rotary press activates the focused item, which usually navigates (#14920).
  "rotary_select",
  ...ANDROID_SYSTEM_ACTION_BUTTONS,
]);
const IN_PLACE_PRESS_BUTTONS = new Set([
  "menu",
  "volume_up",
  "volume_down",
  // Remote directions move focus; play/pause controls playback in place.
  "up",
  "down",
  "left",
  "right",
  "playpause",
  // Media transport keys act on the current playback session in place (#16734).
  "fastforward",
  "rewind",
  "next",
  "previous",
  // Rotary rotation and nudges move focus only.
  "rotary_rotate_cw",
  "rotary_rotate_ccw",
  "rotary_nudge_up",
  "rotary_nudge_down",
  "rotary_nudge_left",
  "rotary_nudge_right",
]);

export function isNavigationPressButton(button: unknown): boolean {
  return typeof button === "string" && NAVIGATION_PRESS_BUTTONS.has(button.toLowerCase());
}

export function isInPlacePressButton(button: unknown): boolean {
  return typeof button === "string" && IN_PLACE_PRESS_BUTTONS.has(button.toLowerCase());
}

/**
 * Android keyevent codes for the supported hardware/navigation buttons.
 *
 * Null-prototype map: a `{}` map inherits `Object.prototype`, so a button named
 * `constructor`/`toString`/`__proto__`/... would read back as the inherited member
 * (truthy) and slip past the "unsupported button" guard straight into
 * `shell input keyevent <function Object() { [native code] }>` (issue #4187).
 */
const ANDROID_KEY_CODES: Record<string, number> = Object.assign(Object.create(null), {
  home: 3,
  back: 4,
  menu: 82,
  power: 26,
  volume_up: 24,
  volume_down: 25,
  recent: 187,
  // D-pad and media transport keys for Android TV remotes (#16734); names match the tvOS remote.
  up: 19,
  down: 20,
  left: 21,
  right: 22,
  select: 23,
  playpause: 85,
  next: 87,
  previous: 88,
  rewind: 89,
  fastforward: 90,
});

/** Buttons that accept a hold `durationMs`: D-pad center, for TV context menus (#16734). */
export const HOLDABLE_PRESS_BUTTONS: ReadonlySet<string> = new Set(["select"]);
export const PRESS_HOLD_MIN_MS = 100;
export const PRESS_HOLD_MAX_MS = 10_000;
/** `input keyevent --duration` exists from Android 15 (API 35); Android 14 parses it as keycodes. */
export const ANDROID_KEY_HOLD_MIN_API_LEVEL = 35;

export function isHoldablePressButton(button: unknown): boolean {
  return typeof button === "string" && HOLDABLE_PRESS_BUTTONS.has(button.toLowerCase());
}

/**
 * Resolve an Android keyevent code for a button name, or `undefined` when the
 * button is not supported.
 */
export function resolveAndroidKeyCode(button: string): number | undefined {
  return ANDROID_KEY_CODES[button.toLowerCase()];
}
