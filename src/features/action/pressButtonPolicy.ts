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
  // The rotary press activates the focused item, which usually navigates (#14920).
  "rotary_select",
  ...ANDROID_SYSTEM_ACTION_BUTTONS,
]);
const IN_PLACE_PRESS_BUTTONS = new Set([
  "menu",
  "volume_up",
  "volume_down",
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
});

/**
 * Resolve an Android keyevent code for a button name, or `undefined` when the
 * button is not supported.
 */
export function resolveAndroidKeyCode(button: string): number | undefined {
  return ANDROID_KEY_CODES[button.toLowerCase()];
}
