/** Characters that trigger per-keystroke formatting in a WYSIWYG/markdown editor. */
export const WYSIWYG_TRIGGER_CHARS = new Set(["`", "*", "_", "~"]);

/** Whether text contains a WYSIWYG/markdown formatting trigger character. */
export function containsWysiwygTriggerChar(text: string): boolean {
  return Array.from(WYSIWYG_TRIGGER_CHARS).some((char) => text.includes(char));
}
