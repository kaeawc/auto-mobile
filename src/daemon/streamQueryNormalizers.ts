/**
 * Canonical normalization for the query parameters every polling stream socket
 * server accepts on the wire (`since`/`until` timestamps and `limit`).
 *
 * One primitive per concern: the failures and performance stream servers used to
 * carry near-duplicate copies, and the performance copy parsed a bare numeric
 * string with `new Date(...)` — reading `"1000"` as the year 1000 instead of
 * 1000ms after the epoch (#6677).
 */

import type { DateRangePreset, TimeAggregation } from "./failuresStreamSocketTypes";

/** Upper bound on a single stream page; mirrors the repositories' own clamp. */
export const STREAM_LIMIT_MAX = 500;

/**
 * Normalize a wire timestamp to epoch milliseconds.
 *
 * A bare numeric string is parsed as an epoch-ms number FIRST: `new Date("1000")`
 * yields the year 1000 (a large negative epoch), not 1000ms after the epoch, so a
 * numeric cursor like `"1000"` or `" 1 "` must be read as a Number, and `"-5"` must
 * trip the negative guard rather than becoming a year. Non-numeric strings fall back
 * to date parsing.
 *
 * @param value Raw value straight off the wire.
 * @param label Field name, used in the thrown message.
 * @returns Epoch milliseconds, or undefined when the field is absent or blank.
 */
export function normalizeStreamTimestampMs(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid ${label}: ${value}`);
    }
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return undefined;
    }
    const num = Number(trimmed);
    if (Number.isFinite(num)) {
      if (num < 0) {
        throw new Error(`Invalid ${label}: ${value}`);
      }
      return num;
    }
    const date = new Date(trimmed);
    if (!Number.isNaN(date.getTime())) {
      return date.getTime();
    }
    throw new Error(`Invalid ${label}: ${value}`);
  }
  throw new Error(`Invalid ${label}: ${String(value)}`);
}

/**
 * Normalize a wire timestamp to an ISO-8601 string, for repositories whose
 * query bounds are stored as ISO text rather than epoch millis.
 */
export function normalizeStreamTimestampIso(value: unknown, label: string): string | undefined {
  const ms = normalizeStreamTimestampMs(value, label);
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

/**
 * Normalize a page size, capping it at {@link STREAM_LIMIT_MAX} so a client asking
 * for a million rows cannot pull an unbounded result set into memory and over the
 * socket in one response.
 */
export function normalizeStreamLimit(value: unknown, defaultLimit: number): number {
  if (value === undefined || value === null) {
    return defaultLimit;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid limit: ${String(value)}`);
  }
  return Math.min(parsed, STREAM_LIMIT_MAX);
}

/**
 * Normalize a monotonic row-id cursor. Shared by the stream servers so `sinceId`
 * validation cannot drift between them.
 */
export function normalizeStreamSinceId(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid sinceId: ${String(value)}`);
  }
  return parsed;
}

/**
 * Failures-timeline query vocabulary, shared by the `poll_timeline` stream route
 * and the `automobile:failures/timeline` resource so the two cannot drift (#10119).
 */
export const TIMELINE_AGGREGATIONS: readonly TimeAggregation[] = ["minute", "hour", "day", "week"];
export const TIMELINE_DATE_RANGES: readonly DateRangePreset[] = ["1h", "24h", "3d", "7d", "30d"];

const DATE_RANGE_DURATION_MS: Record<DateRangePreset, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/** Duration in milliseconds of a validated date-range preset. */
export function getDateRangeDurationMs(preset: DateRangePreset): number {
  return DATE_RANGE_DURATION_MS[preset];
}

/**
 * Validate a timeline aggregation. Absent means the default (`hour`); any other
 * value must be one of {@link TIMELINE_AGGREGATIONS}.
 */
export function normalizeAggregation(value: unknown): TimeAggregation {
  if (value === undefined || value === null) {
    return "hour";
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid aggregation: ${String(value)}`);
  }
  if (!TIMELINE_AGGREGATIONS.includes(value as TimeAggregation)) {
    throw new Error(
      `Invalid aggregation: ${value}. Must be one of: ${TIMELINE_AGGREGATIONS.join(", ")}`,
    );
  }
  return value as TimeAggregation;
}

/**
 * Validate a date-range preset. Absent yields undefined so each caller applies
 * its own default; any other value must be one of {@link TIMELINE_DATE_RANGES}.
 */
export function normalizeDateRange(value: unknown): DateRangePreset | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid dateRange: ${String(value)}`);
  }
  if (!TIMELINE_DATE_RANGES.includes(value as DateRangePreset)) {
    throw new Error(
      `Invalid dateRange: ${value}. Must be one of: ${TIMELINE_DATE_RANGES.join(", ")}`,
    );
  }
  return value as DateRangePreset;
}
