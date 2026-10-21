/** Bounded settled re-reads used by the clear, eventLast caret and eventAll case read-backs. */
export const ANDROID_READ_BACK_ATTEMPTS = 3;
/** Inline-format markers a rich-text editor may consume while keys are typed. */
export const KEY_EVENT_FORMAT_MARKERS = /[*_~`]/g;
export const ANDROID_FOCUSED_INPUT_ERROR =
  "Android event delivery requires a focused editable field";
export const ANDROID_TYPE_FOCUSED_INPUT_ERROR = `${ANDROID_FOCUSED_INPUT_ERROR}. For printable ASCII, mode: "imeKeyEvents" types without requiring a focused editable node.`;

// Give posted formatters/recomposition a bounded chance to finish after a mismatch.
export const IME_COMMIT_READ_BACK_SETTLE_MS = 150;
/** CtrlProxy's caret-unknown warning (InsertTextPlanner.kt), removed once the caret is proven. */
export const CARET_UNKNOWN_WARNING =
  /Text was inserted, but the caret could not be placed after it \([^)]*\); the caret position is unknown, so insert any further text with request_insert_text rather than key events/;

export function segmentGraphemes(text: string): string[] {
  return Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
    ({ segment }) => segment,
  );
}

export function isPrintableAscii(text: string): boolean {
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint < 0x20 || codePoint > 0x7e) {
      return false;
    }
  }
  return true;
}
