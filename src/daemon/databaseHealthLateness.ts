import type { Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import { DatabaseHealthProbeTimeoutError } from "../db/DatabaseHealthProbeTimeoutError";
import {
  DEFAULT_STALL_MARGIN_MS,
  MAX_CREDIBLE_DAEMON_STALL_MS,
  splitScheduleGap,
  type ScheduleGap,
} from "./timerLateness";

interface ClockReading {
  wall: number;
  monotonic: number;
}

/** A timeout cannot diagnose the database when the host failed to run its own timers on time. */
export class DatabaseHealthLateness {
  private previousTick: ClockReading;

  constructor(
    private readonly timer: Timer,
    private readonly intervalMs: number,
  ) {
    this.previousTick = this.readClock();
  }

  tick(): ScheduleGap {
    const now = this.readClock();
    const gap = this.gap(this.previousTick, now, this.intervalMs);
    this.previousTick = now;
    return gap;
  }

  /** Each probe owns its reading, even if the next interval fires before it settles. */
  beginProbe(tickGap: ScheduleGap): (error: unknown, strikeCount: number) => boolean {
    const started = this.readClock();
    return (error, strikeCount) => {
      if (!(error instanceof DatabaseHealthProbeTimeoutError)) {
        return false;
      }
      const probeGap = this.gap(started, this.readClock(), error.timeoutMs, error.startupMs ?? 0);
      const inconclusive = [
        tickGap.lateMs,
        tickGap.sleptMs,
        probeGap.lateMs,
        probeGap.sleptMs,
      ].some((ms) => ms > DEFAULT_STALL_MARGIN_MS);
      if (inconclusive) {
        logger.warn(
          `Database health probe timeout inconclusive: tick lateness=${tickGap.lateMs}ms, ` +
            `probe overrun=${probeGap.lateMs}ms, tick host sleep=${tickGap.sleptMs}ms, ` +
            `probe host sleep=${probeGap.sleptMs}ms, timeout=${error.timeoutMs}ms; ` +
            `strike count stays at ${strikeCount}`,
        );
      }
      return inconclusive;
    };
  }

  private readClock(): ClockReading {
    return { wall: this.timer.now(), monotonic: this.timer.monotonicNow?.() ?? this.timer.now() };
  }

  private gap(
    start: ClockReading,
    end: ClockReading,
    scheduledMs: number,
    startupMs = 0,
  ): ScheduleGap {
    return splitScheduleGap({
      wallElapsedMs: Math.max(0, end.wall - start.wall - startupMs),
      monotonicElapsedMs: Math.max(0, end.monotonic - start.monotonic - startupMs),
      scheduledMs,
      monotonicIncludesHostSleep: this.timer.monotonicIncludesHostSleep,
      maxCredibleStallMs: MAX_CREDIBLE_DAEMON_STALL_MS,
    });
  }
}
