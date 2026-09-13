import { BaseActionResult } from "./BaseActionResult";

/**
 * WHO produced an append failure.
 *
 * `"runner"` -- the device-side runner answered with a VERDICT about the device
 * (a stale `frameContext`, say). The helper worked; the answer is "no".
 * `"helper"` -- the host-side helper could not complete the call at all (it
 * threw, its transport died, or it is a stale cached helper bound to a device
 * that is no longer there). Absent means the same as `"helper"`.
 *
 * The daemon's cached-helper self-heal (`UnixSocketServer.executeAndroidAppendText`)
 * turns on exactly this distinction: a HELPER failure is the first evidence the
 * cached helper is stale, so it is evicted, rebuilt and given one more attempt;
 * a RUNNER verdict is about the device state, and rebuilding and replaying would
 * type into a UI the runner explicitly refused
 * ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
 */
export type AppendTextFailureSource = "runner" | "helper";

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
  /**
   * For the Android `append` mode only: who produced this failure. See
   * {@link AppendTextFailureSource}; omitted on success and by non-append modes.
   */
  failureSource?: AppendTextFailureSource;
}
