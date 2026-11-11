/** `log show` emits chronological compact lines; the last matching verdict is the newest. */
export function watchNotificationDeliveryVerdict(
  output: string,
  bundleId: string,
  ignoreLines?: ReadonlySet<string>,
): "NO" | "YES" | null {
  let verdict: "NO" | "YES" | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (ignoreLines?.has(line)) {
      continue;
    }
    // The log tool can echo its own predicate; that is not a delivery verdict.
    if (line.includes("com.apple.log:")) {
      continue;
    }
    const match = /\[([^\]\r\n]+)\] Saving notification [^:\s]+: (NO|YES)(?:\s|$)/.exec(line);
    if (match?.[1] === bundleId && (match[2] === "NO" || match[2] === "YES")) {
      verdict = match[2];
    }
  }
  return verdict;
}
