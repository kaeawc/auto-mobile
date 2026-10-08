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
   * A monotonic clock reading in milliseconds, for measuring how long the process itself was
   * running. Unlike {@link now} it does not advance while the host is suspended (macOS and Linux
   * suspend; `performance.now()` is uptime-based there), so the gap between the two over an
   * interval is time the host spent asleep (#10699). Only differences between readings are
   * meaningful. Optional: a timer without it is treated as never sleeping.
   */
  monotonicNow?(): number;
}

/**
 * System timer implementation delegating to global timer functions
 */
export class SystemTimer implements Timer {
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
