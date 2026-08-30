import { BaseActionResult } from "./BaseActionResult";

/**
 * Result of a send text operation
 */
export interface SendTextResult extends BaseActionResult {
  text: string;
  imeAction?: string;
  /** Identity of the field focused by an inputText selector, when available. */
  matchedId?: string;
  matchedText?: string;
  /**
   * For the Android `append` mode only: how many leading characters of `text`
   * were confirmed by adb as sent to the device as key events. Append is
   * best-effort and char-by-char, so after a definitive partial failure this is
   * the safe retry boundary: retry only `text.slice(charsSent)`, never the whole
   * string, or it doubles the prefix (issue #3351). Omitted if an in-flight key
   * event times out because adb cannot establish whether Android accepted it;
   * callers must re-observe before retrying in that case. Present on success
   * (== full length) and some failed append results; omitted by non-append modes.
   */
  charsSent?: number;
}
