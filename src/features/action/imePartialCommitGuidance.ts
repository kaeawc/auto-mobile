/**
 * Formatting-aware reconciliation and next-step guidance for an Android IME partial commit
 * (#17462). A field that reformats input as you type (phone numbers, card numbers, dates) can
 * restart its input connection mid-commit: CtrlProxy then reports every unit dispatched while
 * the editor kept only some of them. The host read-back is authoritative; this module decides
 * whether the digits survived the reformat and what the client should try next.
 */

/** Characters an input formatter may add or rewrite: anything but letters, digits and marks. */
const FORMATTING = /[^\p{L}\p{N}\p{M}]/gu;
const DIGIT = /\p{Nd}/u;

export const IME_PARTIAL_COMMIT_NEXT_STEP =
  'Retry with operation: "replace", mode: "a11y" to set the whole value at once, or type the text in smaller chunks.';

export const IME_REFORMATTED_DIGITS_CONFIRMED_WARNING =
  "The field reformatted the input while it was typed; a digit-by-digit read-back confirmed every sent digit.";

function digitsOf(value: string): string[] {
  return Array.from(value.normalize("NFC")).filter((point) => DIGIT.test(point));
}

/** Text made only of digits and formatting (e.g. "5125550142", "+1 512-555-0142"). */
export function isFormattedNumericInput(text: string): boolean {
  const content = text.normalize("NFC").replace(FORMATTING, "");
  return content.length > 0 && Array.from(content).every((point) => DIGIT.test(point));
}

/**
 * True when a formatted-numeric request's digits all appear, in order and at the end of the
 * focused field, once formatting is ignored. Callers pass this only after the device reported a
 * complete commit, so a field that merely already held these digits cannot upgrade a failure the
 * device itself reported.
 */
export function reformattedDigitsPreserved(fieldText: string, sent: string): boolean {
  if (!isFormattedNumericInput(sent)) {
    return false;
  }
  const sentDigits = digitsOf(sent).join("");
  return sentDigits.length > 0 && digitsOf(fieldText).join("").endsWith(sentDigits);
}

/**
 * The sentence appended to an IME partial-commit error. `insertedText` is the device's delta
 * read-back (what this commit added), which is what digit counts are taken from; a whole-field
 * read-back may include text that was there before the commit, so it never produces a count.
 */
export function imePartialCommitGuidance(
  sent: string,
  evidence: { insertedText?: string; deviceReportedSuccess?: boolean; passwordField?: boolean },
): string {
  const reconcile =
    evidence.deviceReportedSuccess === true
      ? "The device reported the commit complete, but the editor's read-back does not match. "
      : "";
  if (evidence.passwordField === true || !isFormattedNumericInput(sent)) {
    return `${reconcile}${IME_PARTIAL_COMMIT_NEXT_STEP}`;
  }
  const sentDigits = digitsOf(sent).length;
  const kept = evidence.insertedText === undefined ? undefined : digitsOf(evidence.insertedText);
  const dropped =
    kept !== undefined && kept.length < sentDigits
      ? ` and kept ${kept.length} of ${sentDigits} digits`
      : "";
  return (
    `${reconcile}The field appears to reformat input as you type${dropped}. ` +
    'Retry with operation: "replace", mode: "a11y" to set the whole value at once, ' +
    "or type the missing digits in a separate command."
  );
}
