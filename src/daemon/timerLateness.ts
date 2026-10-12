/**
 * Longest credible daemon stall when monotonic time also runs through host sleep (#10962).
 * A longer gap is treated as sleep rather than forgiven as an awake stall.
 */
export const MAX_CREDIBLE_DAEMON_STALL_MS = 30_000;

/** Timer jitter tolerated before a schedule gap matters. */
export const DEFAULT_STALL_MARGIN_MS = 2_000;

export interface ScheduleGap {
  lateMs: number;
  sleptMs: number;
}

/** Split the same schedule gap for heartbeat forgiveness and database timeout judgement. */
export function splitScheduleGap(input: {
  wallElapsedMs: number;
  monotonicElapsedMs: number;
  scheduledMs: number;
  monotonicIncludesHostSleep?: boolean;
  maxCredibleStallMs: number;
}): ScheduleGap {
  const awakeMs = Math.min(input.wallElapsedMs, input.monotonicElapsedMs);
  const lateMs = awakeMs - input.scheduledMs;
  const sleptMs = input.wallElapsedMs - awakeMs;
  if (input.monotonicIncludesHostSleep === true && lateMs > input.maxCredibleStallMs) {
    return { lateMs: 0, sleptMs: sleptMs + lateMs };
  }
  return { lateMs, sleptMs };
}
