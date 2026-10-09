import { setTimeout as sleep } from "node:timers/promises";

/**
 * Hard ceiling on any delay handed to `setTimeout` (Node/Bun and the browser
 * platforms they track). Both silently clamp any delay >= 2^31 to 1ms rather
 * than honoring it, so a derived delay anywhere near or above this value must
 * be capped before it is scheduled -- otherwise the timer fires almost
 * immediately instead of after the intended duration (issue #6248 review,
 * P2). One shared constant so every caller that clamps a computed delay
 * (`PlanValidator`, the daemon's MCP request-timeout budgeting, `TapAnyElement`'s
 * inner CtrlProxy request timeout) agrees on the same ceiling.
 */
export const MAX_SETTIMEOUT_DELAY_MS = 2_147_483_647;

/**
 * Interface for timer utilities
 * Provides sleep/delay functionality and timeout/interval management
 */
export interface Timer {
  /**
   * Sleep for a specified duration
   * @param ms Duration to sleep in milliseconds
   * @returns Promise that resolves after the specified duration
   */
  sleep(ms: number): Promise<void>;

  /**
   * Schedule a callback to be executed after a specified delay
   * @param callback Function to execute
   * @param ms Delay in milliseconds
   * @returns Timeout handle that can be passed to clearTimeout
   */
  setTimeout(callback: () => void, ms: number): NodeJS.Timeout;

  /**
   * Cancel a scheduled timeout
   * @param handle The timeout handle returned by setTimeout
   */
  clearTimeout(handle: NodeJS.Timeout): void;

  /**
   * Schedule a callback to be executed repeatedly at a specified interval
   * @param callback Function to execute
   * @param ms Interval in milliseconds
   * @returns Interval handle that can be passed to clearInterval
   */
  setInterval(callback: () => void, ms: number): NodeJS.Timeout;

  /**
   * Cancel a scheduled interval
   * @param handle The interval handle returned by setInterval
   */
  clearInterval(handle: NodeJS.Timeout): void;

  /**
   * Get the current time in milliseconds
   * @returns Current time in milliseconds (for testing, can return fake time)
   */
  now(): number;

  /**
   * A monotonic clock reading in milliseconds. Only differences between readings are meaningful.
   * Where it pauses while the host is suspended (see {@link monotonicIncludesHostSleep}), the gap
   * between it and {@link now} over an interval is time the host spent asleep (#10699). Optional:
   * a timer without it is treated as never sleeping.
   */
  monotonicNow?(): number;

  /**
   * True when {@link monotonicNow} keeps running while the host is suspended, so the two clocks
   * cannot tell host sleep from a stall of this process. Absent or false: it pauses during
   * suspend and the difference is a reliable sleep measurement.
   */
  readonly monotonicIncludesHostSleep?: boolean;
}

/**
 * Whether `performance.now()` keeps running across a host suspend on `platform` (#10699 follow-up).
 *
 * Bun 1.3.x (the pinned runtime) reads every monotonic clock (`performance.now()`,
 * `process.hrtime`, `Bun.nanoseconds()`) from one Zig `std.time.Timer`, whose `Instant` uses:
 *
 * - darwin: `CLOCK_UPTIME_RAW`, which does not advance while the Mac sleeps;
 * - win32: `QueryPerformanceCounter`, which Microsoft documents as including standby, hibernate
 *   and connected standby;
 * - linux: `CLOCK_BOOTTIME`, which includes suspend (unlike `CLOCK_MONOTONIC`).
 *
 * No runtime API exposes a suspend-excluding clock on Windows or Linux without native code
 * (`QueryUnbiasedInterruptTime` / `CLOCK_MONOTONIC`): `os.uptime()` and `process.uptime()` include
 * sleep too. So only darwin is trusted to measure sleep; everywhere else the heartbeat monitor
 * falls back to a length ceiling (see `SessionHeartbeatMonitorConfig.maxCredibleStallMs`).
 */
export function monotonicClockIncludesHostSleep(platform: NodeJS.Platform): boolean {
  return platform !== "darwin";
}

/**
 * The Bun release line whose clock sources {@link monotonicClockIncludesHostSleep} was verified
 * against (#10962). A different line may read its monotonic clocks from another source, silently
 * inverting the sleep/stall judgement; `test/utils/SystemTimer.monotonicSleep.test.ts` fails when
 * the running or pinned Bun leaves this line, so a runtime upgrade re-verifies the table.
 */
export const MONOTONIC_CLOCK_SEMANTICS_VERIFIED_BUN = "1.3";

/**
 * A warning when the running Bun is not the release line the clock-semantics table was verified
 * against, else undefined. Not a Bun runtime (undefined) is not drift: there is nothing to compare.
 */
export function monotonicClockSemanticsDrift(bunVersion: string | undefined): string | undefined {
  if (bunVersion === undefined) {
    return undefined;
  }
  const line = bunVersion.split(".").slice(0, 2).join(".");
  if (line === MONOTONIC_CLOCK_SEMANTICS_VERIFIED_BUN) {
    return undefined;
  }
  return (
    `Bun ${bunVersion} is not the release line (${MONOTONIC_CLOCK_SEMANTICS_VERIFIED_BUN}.x) whose ` +
    "monotonic clock semantics were verified; whether performance.now() runs through host sleep " +
    "may have changed, so host sleep and daemon stalls may be judged wrongly (#10962)"
  );
}

/**
 * System timer implementation delegating to global timer functions
 */
export class SystemTimer implements Timer {
  readonly monotonicIncludesHostSleep: boolean;

  constructor(platform: NodeJS.Platform = process.platform) {
    this.monotonicIncludesHostSleep = monotonicClockIncludesHostSleep(platform);
  }

  async sleep(ms: number): Promise<void> {
    return sleep(ms);
  }

  setTimeout(callback: () => void, ms: number): NodeJS.Timeout {
    return global.setTimeout(callback, ms);
  }

  clearTimeout(handle: NodeJS.Timeout): void {
    global.clearTimeout(handle);
  }

  setInterval(callback: () => void, ms: number): NodeJS.Timeout {
    return global.setInterval(callback, ms);
  }

  clearInterval(handle: NodeJS.Timeout): void {
    global.clearInterval(handle);
  }

  now(): number {
    return Date.now();
  }

  monotonicNow(): number {
    return performance.now();
  }
}

/**
 * Global default timer instance
 */
export const defaultTimer: Timer = new SystemTimer();
