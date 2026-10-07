/**
 * Failures-timeline bucketing and labelling (#10120).
 *
 * ONE time basis, UTC, is used for both bucket boundaries and labels, so a
 * bucket's label always names the period the bucket actually covers:
 *
 * - minute / hour / day buckets start on the UTC minute / hour / midnight (these
 *   coincide with epoch alignment).
 * - week buckets start on Monday 00:00 UTC (ISO-8601). The Unix epoch is a
 *   Thursday, so plain epoch alignment would start weeks on Thursday; the bucket
 *   origin is shifted to the first Monday after the epoch instead.
 * - labels are read from the bucket start with the UTC calendar fields. UTC has no
 *   DST, so a label never shifts or repeats across a local DST change, and the
 *   daemon needs no reliable client timezone.
 */

export type TimelineBucketAggregation = "minute" | "hour" | "day" | "week";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/**
 * 1970-01-05 (the first Monday after the epoch) is 4 days after the epoch. Adding
 * `WEEK_MS - 4 days` (3 days) before dividing keeps the dividend non-negative for
 * every timestamp >= 0, because SQLite integer division truncates toward zero.
 */
const WEEK_ORIGIN_SHIFT_MS = 3 * DAY_MS;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Bucket length in milliseconds. */
export function timelineBucketMs(aggregation: TimelineBucketAggregation): number {
  switch (aggregation) {
    case "minute":
      return MINUTE_MS;
    case "hour":
      return HOUR_MS;
    case "day":
      return DAY_MS;
    case "week":
      return WEEK_MS;
  }
}

/**
 * Milliseconds added to a timestamp before dividing by the bucket length so the
 * quotient indexes buckets that start on the labelled boundary.
 */
export function timelineBucketShiftMs(aggregation: TimelineBucketAggregation): number {
  return aggregation === "week" ? WEEK_ORIGIN_SHIFT_MS : 0;
}

/** Start (epoch ms, UTC) of the bucket containing `timestamp`. */
export function timelineBucketStart(
  timestamp: number,
  aggregation: TimelineBucketAggregation,
): number {
  const bucketMs = timelineBucketMs(aggregation);
  const shift = timelineBucketShiftMs(aggregation);
  return Math.floor((timestamp + shift) / bucketMs) * bucketMs - shift;
}

/** Start of the bucket whose SQL index is `bucketIndex` (`(ts + shift) / bucketMs`). */
export function timelineBucketStartFromIndex(
  bucketIndex: number,
  aggregation: TimelineBucketAggregation,
): number {
  return bucketIndex * timelineBucketMs(aggregation) - timelineBucketShiftMs(aggregation);
}

function formatClock(hours: number, minutes: number | null): string {
  const ampm = hours >= 12 ? "PM" : "AM";
  const displayHours = hours % 12 || 12;
  return minutes === null
    ? `${displayHours} ${ampm}`
    : `${displayHours}:${minutes.toString().padStart(2, "0")} ${ampm}`;
}

/** Label for the bucket that starts at `bucketStart`, in UTC. */
export function formatTimelineBucketLabel(
  bucketStart: number,
  aggregation: TimelineBucketAggregation,
): string {
  const date = new Date(bucketStart);
  switch (aggregation) {
    case "minute":
      return formatClock(date.getUTCHours(), date.getUTCMinutes());
    case "hour":
      return formatClock(date.getUTCHours(), null);
    case "day":
    case "week":
      // A week bucket starts on its Monday, so the start date IS the label.
      return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  }
}
