import { BaseActionResult } from "./BaseActionResult";

/**
 * Result of a send text operation
 */
export interface SendTextResult extends BaseActionResult {
  text: string;
  imeAction?: string;
  /**
   * For the Android `append` mode only: how many leading characters of `text`
   * were actually sent to the device as key events. Append is best-effort and
   * char-by-char, so on a partial failure (an adb reject/timeout mid-batch) this
   * is the length of the prefix that landed — a caller must retry only
   * `text.slice(charsSent)`, never the whole string, or it doubles the prefix
   * (issue #3351). Present on both success (== full length) and partial-failure
   * results; omitted by the non-append modes.
   */
  charsSent?: number;
}
