/**
 * Coerce an `ObserveResult.updatedAt` to a number of milliseconds since epoch.
 *
 * `updatedAt` is documented as ms-since-epoch but typed `string | number` (it
 * falls back to a server timestamp). A numeric string parses directly, an ISO
 * string via `Date.parse`, and anything unparseable falls back to 0 so a bad
 * timestamp degrades to "accept any fresh read" rather than throwing.
 *
 * Shared by `ObservePoll` (monotonic `minTimestamp` across polls) and the
 * touch-latency inert-point re-validation (forcing a hierarchy strictly newer
 * than the enclosing observation, issue #6228).
 */
export function updatedAtToMillis(updatedAt: string | number): number {
  if (typeof updatedAt === "number") {
    return updatedAt;
  }
  const numeric = Number(updatedAt);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const parsed = Date.parse(updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}
