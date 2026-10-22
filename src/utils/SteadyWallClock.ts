import type { Timer } from "./SystemTimer";

/**
 * How far the wall clock may fall behind its high-water lead over the monotonic clock before
 * {@link SteadyWallClock} treats it as a backward step and re-baselines, rather than as reading
 * jitter between the two clocks.
 */
export const STEADY_WALL_CLOCK_STEP_TOLERANCE_MS = 1_000;

/**
 * How far the wall clock may move relative to the session clock before {@link
 * SteadyWallClock.toWall} re-anchors its reported frame. Reading jitter between the integer wall
 * clock and the fractional monotonic clock is a few ms (#11368); a wall step or sleep is far more.
 */
export const WALL_REPORT_ANCHOR_TOLERANCE_MS = 50;

/**
 * A wall-anchored clock for session lease and idle deltas (#11080): it starts at the wall clock's
 * reading and then advances only with the monotonic clock, plus measured host sleep where the
 * monotonic clock pauses for it (darwin, Linux), because host sleep counts toward idle (owner rule).
 *
 * Wall-clock steps therefore do not move it: a backward NTP step neither extends a dead owner's
 * hold nor shrinks an idle window, and where the monotonic clock already includes sleep (Windows)
 * a forward step is ignored too. On darwin and Linux a forward step is indistinguishable from host
 * sleep and is counted as sleep: it moves idle accounting the way sleep does, and the heartbeat
 * monitor excuses it from the lease the way it excuses sleep.
 *
 * Sleep is the growth of the wall clock's lead over the monotonic clock past its high-water mark,
 * so reading jitter between the two clocks never accumulates; a lead that falls more than
 * {@link STEADY_WALL_CLOCK_STEP_TOLERANCE_MS} below the mark is a backward step and resets the mark
 * without moving the clock. Readings are whole milliseconds and never decrease while the timer's monotonic clock does not.
 * A timer without a monotonic clock is read as-is.
 */
export class SteadyWallClock {
  /** Steady reading minus the monotonic reading. */
  private offsetMs: number | undefined;
  /** The highest wall-minus-monotonic lead seen since the last backward step. */
  private leadHighWaterMs = 0;
  /** Wall minus session clock, captured when {@link toWall} last (re)anchored. */
  private wallReportOffsetMs: number | undefined;

  constructor(private readonly timer: Timer) {}

  now(): number {
    const wall = this.timer.now();
    const monotonic = this.timer.monotonicNow?.();
    if (monotonic === undefined) {
      return wall;
    }
    const lead = wall - monotonic;
    if (this.offsetMs === undefined) {
      this.offsetMs = lead;
      this.leadHighWaterMs = lead;
    } else if (lead > this.leadHighWaterMs) {
      if (this.timer.monotonicIncludesHostSleep !== true) {
        this.offsetMs += lead - this.leadHighWaterMs;
      }
      this.leadHighWaterMs = lead;
    } else if (lead < this.leadHighWaterMs - STEADY_WALL_CLOCK_STEP_TOLERANCE_MS) {
      this.leadHighWaterMs = lead;
    }
    // Whole milliseconds, like the wall clock the session timestamps were stamped with before.
    return Math.round(monotonic + this.offsetMs);
  }

  /**
   * An instant on this clock as wall-clock epoch ms, for reporting (#11368). The wall-minus-
   * session offset is captured once and reused while it stays within
   * {@link WALL_REPORT_ANCHOR_TOLERANCE_MS}, so one fixed instant reads back the same value on
   * every query instead of picking up the jitter between the two clocks' readings. A wall step or
   * host sleep moves the offset past the tolerance and re-anchors once, so the value then follows
   * the wall clock. Reporting only: no judgement reads this.
   */
  toWall(sessionMs: number): number {
    const offset = this.timer.now() - this.now();
    if (
      this.wallReportOffsetMs === undefined ||
      Math.abs(offset - this.wallReportOffsetMs) > WALL_REPORT_ANCHOR_TOLERANCE_MS
    ) {
      this.wallReportOffsetMs = offset;
    }
    return sessionMs + this.wallReportOffsetMs;
  }
}
