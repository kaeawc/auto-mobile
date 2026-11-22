/**
 * Outcome of the watch notification pipeline for one push, read from the `Saving notification`
 * line of the delivery log:
 * - `YES`: delivered and presented.
 * - `NO`: not saved (`settingsShouldSave: NO`), which is what a denied authorization looks like.
 * - `NOT_PRESENTED`: saved, but the app's delegate declined the banner (`shouldPresentAlert: NO`),
 *   which is what a foreground app returning no presentation options looks like.
 */
export type WatchNotificationDeliveryVerdict = "NO" | "YES" | "NOT_PRESENTED";

/** `log show` emits chronological compact lines; the last matching verdict is the newest. */
export function watchNotificationDeliveryVerdict(
  output: string,
  bundleId: string,
  ignoreLines?: ReadonlySet<string>,
): WatchNotificationDeliveryVerdict | null {
  let verdict: WatchNotificationDeliveryVerdict | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (ignoreLines?.has(line)) {
      continue;
    }
    // The log tool can echo its own predicate; that is not a delivery verdict.
    if (line.includes("com.apple.log:")) {
      continue;
    }
    const match = /\[([^\]\r\n]+)\] Saving notification [^:\s]+: (NO|YES)(?:\s|$)/.exec(line);
    if (match?.[1] !== bundleId) {
      continue;
    }
    if (match[2] === "YES") {
      verdict = "YES";
    } else if (
      /\bshouldPresentAlert: NO\b/.test(line) &&
      /\bsettingsShouldSave: YES\b/.test(line)
    ) {
      verdict = "NOT_PRESENTED";
    } else {
      verdict = "NO";
    }
  }
  return verdict;
}
