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
  limit: number = BODY_TRUNCATION_LIMIT,
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

/**
 * Maximum retained serialized size for a structured-JSON telemetry field, in
 * UTF-16 code units (10&nbsp;KB, mirrors {@link BODY_TRUNCATION_LIMIT}).
 */
export const STRUCTURED_FIELD_LIMIT = 10_240;

/**
 * Marker substituted for an oversized structured-JSON field. Blindly slicing a
 * JSON string (or a stringified object) mid-value produces invalid JSON that
 * breaks the dashboard's `JSON.parse` (#3182), so an over-budget structured
 * field is replaced wholesale with this small, always-valid marker instead.
 */
export interface TruncatedStructuredMarker {
  _truncated: true;
  bytes: number;
}

/**
 * Bound a structured-JSON telemetry value (object, array, or an already-
 * serialized JSON string) by total serialized size. When the value serializes
 * to more than `limit` UTF-16 code units it is replaced with a
 * {@link TruncatedStructuredMarker} carrying the original size; otherwise the
 * original value is returned unchanged. The result is always valid JSON — never
 * a mid-value slice — so the dashboard can still `JSON.parse` it.
 *
 * `isJsonString` selects how the input is measured: raw JSON strings (e.g.
 * layout `detailsJson`) are measured by their own length, while parsed
 * objects/arrays (os `details`, failure `stackTrace`) are measured by their
 * `JSON.stringify` length. `null`/`undefined` pass through untouched.
 */
export function boundStructuredField(
  value: unknown,
  isJsonString: boolean = false,
  limit: number = STRUCTURED_FIELD_LIMIT,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  let serializedLength: number;
  if (isJsonString) {
    if (typeof value !== "string") {
      return value;
    }
    serializedLength = value.length;
  } else {
    // A value that cannot be serialized (cycle, BigInt) cannot ship anyway;
    // treat it as within budget and leave it to the caller's serializer.
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return value;
    }
    if (serialized === undefined) {
      return value;
    }
    serializedLength = serialized.length;
  }
  if (serializedLength <= limit) {
    return value;
  }
  const marker: TruncatedStructuredMarker = { _truncated: true, bytes: serializedLength };
  return marker;
}
