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

import { shellQuote } from "../shellQuote";

/** A sequence of `adb shell input ...` commands that types a single character. */
export interface KeyEventPlan {
  commands: string[];
  /** Longest input-text command length; omitted for single-character key-event plans. */
  textLength?: number;
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

/**
 * Whether `input text` can carry `next` right after `previous` in one argument.
 *
 * `input text` decodes `%s` to a space and has no escape for a literal `%s`, so a
 * literal `%` followed by `s` must be split across two `input text` calls. Any
 * other `%` is kept literally, including `%` before an encoded space (`%%s` → `% `).
 */
export function canJoinAndroidInputText(previous: string, next: string): boolean {
  return !(previous.endsWith("%") && next.startsWith("s"));
}

/**
 * Build one `adb shell input text ...` command that types `text` in a single device
 * process, so the keyboard sees one continuous stream instead of one process per
 * character (#9888).
 *
 * Spaces are encoded as `%s` (the form `input text` decodes back to a space), so the
 * argument has no whitespace for adb or the device shell to split on, and the whole
 * argument is single-quoted for the device shell, which keeps quotes, `$`, backticks
 * and backslashes literal.
 *
 * @param text - Printable ASCII text that never contains a literal `%s`; split
 *   such text with {@link canJoinAndroidInputText} first.
 * @throws Error when `text` is empty or contains a literal `%s`.
 */
export function buildAndroidInputTextCommand(text: string): string {
  if (!text || text.includes("%s")) {
    throw new Error("input text cannot carry an empty value or a literal %s");
  }
  return `shell input text ${shellQuote(text.replaceAll(" ", "%s"))}`;
}

/** Longest `input text` command on API 31+, so a cancel stops between commands (#12599). */
export const ANDROID_INPUT_TEXT_CHUNK_CHARS = 32;

/**
 * Longest `input text` command on API 30 and older. The host `adb shell` process types, so a
 * cancel needs no short commands, but one adb argv element must stay far below the OS argument
 * limit (about 128 KiB per argument on Linux, smaller on some adb transports); single-quote
 * escaping can quadruple the length, so the argv is not the binding limit here.
 *
 * The binding limit is time: `input text` types about 13 ms per character on an API 30 emulator
 * (1000 chars took 13 s, 4096 took 47 s) and one command must finish inside the 15 s ADB command
 * timeout. 512 characters take about 6.7 s, under half the timeout, so slower devices still fit (#13172).
 */
export const ANDROID_INPUT_TEXT_PRE31_CHUNK_CHARS = 512;

/**
 * Plan for a run of printable ASCII.
 *
 * On API 30 and older the host `adb shell` process is the one typing, so killing the host
 * client stops typing immediately and one `input text` command per run is enough (#12733).
 * Chunking there only adds per-process overhead, so it is bounded only by
 * {@link ANDROID_INPUT_TEXT_PRE31_CHUNK_CHARS} to keep each argv below OS limits. On API 31+ (and when the level is unknown)
 * the host `cmd` client exits once the events are handed to the system, long before the app
 * consumes them, so only a short command bounds how much typing a cancel can leave behind:
 * one command per {@link ANDROID_INPUT_TEXT_CHUNK_CHARS} characters.
 *
 * @param apiLevel - Device API level, or null when it could not be read.
 */
export function buildAndroidInputTextPlan(text: string, apiLevel: number | null): KeyEventPlan {
  const chunks = splitAndroidInputText(text, apiLevel);
  return {
    commands: chunks.map(buildAndroidInputTextCommand),
    textLength: Math.min(text.length, androidInputTextChunkChars(apiLevel)),
  };
}

/**
 * The `input text` chunks {@link buildAndroidInputTextPlan} sends, in order. A caller that
 * dispatches them one at a time knows exactly how many characters a failed run had delivered.
 */
export function splitAndroidInputText(text: string, apiLevel: number | null): string[] {
  const chunkChars = androidInputTextChunkChars(apiLevel);
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = chunkEnd(text, start, chunkChars);
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function androidInputTextChunkChars(apiLevel: number | null): number {
  return apiLevel !== null && apiLevel <= 30
    ? ANDROID_INPUT_TEXT_PRE31_CHUNK_CHARS
    : ANDROID_INPUT_TEXT_CHUNK_CHARS;
}

/**
 * End of the chunk starting at `start`. A space must travel in the same process as the
 * character after it: a keyboard re-capitalises a letter that follows a space delivered by an
 * earlier process (#9888), so a boundary that would strand trailing spaces moves in front of them.
 */
function chunkEnd(text: string, start: number, chunkChars: number): number {
  const hardEnd = start + chunkChars;
  if (hardEnd >= text.length) {
    return text.length;
  }
  let end = hardEnd;
  while (end > start + 1 && text[end - 1] === " ") {
    end--;
  }
  // An all-space chunk has no earlier boundary: leave its final space for the next chunk so
  // that space still travels with the character after it.
  return text[end - 1] === " " ? hardEnd - 1 : end;
}
