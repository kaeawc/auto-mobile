import { expect, test } from "bun:test";
import { splitScheduleGap, MAX_CREDIBLE_DAEMON_STALL_MS } from "../../src/daemon/timerLateness";

test.each([
  [30000, 30000, false, 0, 0],
  [32001, 32001, false, 2001, 0],
  [35000, 31000, false, 1000, 4000],
  [10000, 10000, false, -20000, 0],
  [30000, 31000, false, 0, 0],
  [60000, 60000, true, 30000, 0],
  [60001, 60001, true, 0, 30001],
  [64001, 60001, true, 0, 34001],
  [60001, 60001, false, 30001, 0],
])(
  "splits wall=%i monotonic=%i sleep-counting=%s",
  (wallElapsedMs, monotonicElapsedMs, monotonicIncludesHostSleep, lateMs, sleptMs) => {
    expect(
      splitScheduleGap({
        wallElapsedMs,
        monotonicElapsedMs,
        scheduledMs: 30000,
        monotonicIncludesHostSleep,
        maxCredibleStallMs: MAX_CREDIBLE_DAEMON_STALL_MS,
      }),
    ).toEqual({ lateMs, sleptMs });
  },
);
