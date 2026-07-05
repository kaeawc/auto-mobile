/**
 * Canonical body/text truncation for telemetry read paths (#2801).
 *
 * The network detail view (`getNetworkEventById`) has capped request/response
 * bodies at 10&nbsp;KB since #1624, but the list projection (`getNetworkEvents`)
 * and the telemetry backfill never did — so a burst of large payloads could
 * inflate a single backfill by megabytes the dashboard already caps to 10&nbsp;KB.
 * Centralize the cap here so every read path shares one primitive rather than
 * re-omitting it per repository ("one canonical primitive per concern").
 */

/** Maximum retained body length, in UTF-16 code units (10&nbsp;KB). */
export const BODY_TRUNCATION_LIMIT = 10_240;

/**
 * Truncate `text` to at most `limit` UTF-16 code units without splitting a
 * surrogate pair. A naive `text.slice(0, limit)` can leave a lone high
 * surrogate when a pair (e.g. an emoji or astral-plane character) straddles the
 * boundary, which serializes to mojibake (`�`) on the wire — the latent bug
 * in the historical `getNetworkEventById` slice. Byte semantics are otherwise
 * identical: an ASCII body over the limit is still capped to exactly `limit`.
 */
export function truncateBodyText(
  text: string | null,
  limit: number = BODY_TRUNCATION_LIMIT
): string | null {
  if (text === null || text.length <= limit) {
    return text;
  }
  let end = limit;
  // If the last retained code unit is a high surrogate, its low-surrogate mate
  // sits just past the boundary; drop it so we never emit a lone surrogate.
  const lastCode = text.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    end -= 1;
  }
  return text.slice(0, end);
}
