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
 * Truncate `text` to at most `limit` UTF-16 code units without leaving a lone
 * surrogate at the cut. A naive `text.slice(0, limit)` can leave a lone high
 * surrogate when a pair (e.g. an emoji or astral-plane character) straddles the
 * boundary, which serializes to mojibake (`�`) on the wire — the latent bug
 * in the historical `getNetworkEventById` slice. This also drops a trailing
 * lone low surrogate (already-malformed input) so the boundary is never a lone
 * surrogate regardless of input well-formedness. Byte semantics are otherwise
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
  const lastCode = text.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    // Trailing high surrogate: its low-surrogate mate sits just past the
    // boundary, so keeping it would emit a lone surrogate — drop it.
    end -= 1;
  } else if (lastCode >= 0xdc00 && lastCode <= 0xdfff) {
    // Trailing low surrogate: keep it only when the preceding unit is its high
    // mate (a complete pair ending exactly at the cut); otherwise it is a lone
    // low surrogate (malformed input) and is dropped.
    const prevCode = end >= 2 ? text.charCodeAt(end - 2) : 0;
    if (prevCode < 0xd800 || prevCode > 0xdbff) {
      end -= 1;
    }
  }
  return text.slice(0, end);
}
