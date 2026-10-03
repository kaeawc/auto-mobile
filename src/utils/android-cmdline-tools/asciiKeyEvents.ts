/**
 * Shared ASCII → Android key-event mapping.
 *
 * Extracted from InputText so both text input (`eventAll`/`eventLast` modes) and
 * keyguard credential entry (WakeAndUnlock) map characters to `adb shell input
 * keyevent ...` commands through one canonical table rather than two drifting
 * copies.
 *
 * The mapping is a pure function of the character and whether the device
 * supports `input keycombination` (Android 12 / API 31+), which is required to
 * hold SHIFT for uppercase and shifted symbols. Callers resolve that capability
 * once (via the device API level) and pass it in, keeping this module free of
 * any device I/O.
 */

/** A sequence of `adb shell input ...` commands that types a single character. */
export interface KeyEventPlan {
  commands: string[];
}

/** API level at which `input keycombination` (used for SHIFT chords) is available. */
export const ANDROID_KEYCOMBINATION_MIN_API_LEVEL = 31;

const DIRECT_KEY_CODES: Record<string, string> = {
  " ": "KEYCODE_SPACE",
  "-": "KEYCODE_MINUS",
  "=": "KEYCODE_EQUALS",
  "[": "KEYCODE_LEFT_BRACKET",
  "]": "KEYCODE_RIGHT_BRACKET",
  "\\": "KEYCODE_BACKSLASH",
  ";": "KEYCODE_SEMICOLON",
  "'": "KEYCODE_APOSTROPHE",
  ",": "KEYCODE_COMMA",
  ".": "KEYCODE_PERIOD",
  "/": "KEYCODE_SLASH",
  "`": "KEYCODE_GRAVE",
  "@": "KEYCODE_AT",
};

const SHIFTED_KEY_CODES: Record<string, string> = {
  "!": "KEYCODE_1",
  "#": "KEYCODE_3",
  $: "KEYCODE_4",
  "%": "KEYCODE_5",
  "^": "KEYCODE_6",
  "&": "KEYCODE_7",
  "*": "KEYCODE_8",
  "(": "KEYCODE_9",
  ")": "KEYCODE_0",
  _: "KEYCODE_MINUS",
  "+": "KEYCODE_EQUALS",
  "{": "KEYCODE_LEFT_BRACKET",
  "}": "KEYCODE_RIGHT_BRACKET",
  "|": "KEYCODE_BACKSLASH",
  ":": "KEYCODE_SEMICOLON",
  '"': "KEYCODE_APOSTROPHE",
  "<": "KEYCODE_COMMA",
  ">": "KEYCODE_PERIOD",
  "?": "KEYCODE_SLASH",
  "~": "KEYCODE_GRAVE",
};

function shiftedPlan(baseKeyCode: string, supportsKeyCombination: boolean): KeyEventPlan | null {
  if (!supportsKeyCombination) {
    return null;
  }
  return { commands: [`shell input keycombination KEYCODE_SHIFT_LEFT ${baseKeyCode}`] };
}

/**
 * Whether typing `char` as a key event needs `input keycombination` (API 31+).
 *
 * Only uppercase letters and shifted symbols require holding SHIFT; lowercase
 * letters, digits, space and unshifted punctuation map to a plain `keyevent`
 * regardless of the capability. Callers use this to avoid an API-level probe when
 * no character in the batch needs the capability (issue #3351): the probe is a
 * device round trip, and for a lowercase/digit/space/unshifted keystroke it is
 * pure waste that can even consume the caller's budget and drop the keystroke.
 *
 * This is exactly the set of characters for which [buildAsciiKeyEventPlan]'s result
 * depends on `supportsKeyCombination`; the two must stay in step.
 */
export function asciiKeyEventNeedsKeyCombination(char: string): boolean {
  return /^[A-Z]$/.test(char) || Object.hasOwn(SHIFTED_KEY_CODES, char);
}

/**
 * Map a single character to a key-event plan.
 *
 * @param char - The character to type (a single-code-unit ASCII character)
 * @param supportsKeyCombination - Whether `input keycombination` is available
 *   (API 31+); when false, characters that need SHIFT return `null`.
 * @returns The plan, or `null` when the character cannot be typed as a key event
 *   (non-ASCII, or a shifted character on a device without keycombination).
 */
export function buildAsciiKeyEventPlan(
  char: string,
  supportsKeyCombination: boolean,
): KeyEventPlan | null {
  if (/^[a-z]$/.test(char)) {
    return { commands: [`shell input keyevent KEYCODE_${char.toUpperCase()}`] };
  }

  if (/^[A-Z]$/.test(char)) {
    return shiftedPlan(`KEYCODE_${char}`, supportsKeyCombination);
  }

  if (/^[0-9]$/.test(char)) {
    return { commands: [`shell input keyevent KEYCODE_${char}`] };
  }

  const direct = DIRECT_KEY_CODES[char];
  if (direct) {
    return { commands: [`shell input keyevent ${direct}`] };
  }

  const shifted = SHIFTED_KEY_CODES[char];
  if (shifted) {
    return shiftedPlan(shifted, supportsKeyCombination);
  }

  return null;
}
