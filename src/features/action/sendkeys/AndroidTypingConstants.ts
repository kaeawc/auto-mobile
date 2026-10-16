/** Bounded settled re-reads used by the clear, eventLast caret and eventAll case read-backs. */
export const ANDROID_READ_BACK_ATTEMPTS = 3;
/** Inline-format markers a rich-text editor may consume while keys are typed. */
export const KEY_EVENT_FORMAT_MARKERS = /[*_~`]/g;
export const ANDROID_FOCUSED_INPUT_ERROR =
  "Android event delivery requires a focused editable field";
export const ANDROID_TYPE_FOCUSED_INPUT_ERROR = `${ANDROID_FOCUSED_INPUT_ERROR}. For printable ASCII, mode: "imeKeyEvents" types without requiring a focused editable node.`;
