import type { AdbExecutor } from "./interfaces/AdbExecutor";
import { logger } from "../logger";
import { defaultTimer, type Timer } from "../SystemTimer";

/**
 * Reads `ro.build.version.sdk` from the device, or null if unavailable.
 *
 * @param timeoutMs - Optional bound on the WHOLE read (primary probe + fallback),
 *   not per-subprocess. Callers running under a request deadline (the daemon's
 *   append-text path) pass their remaining budget so a wedged adb cannot outlive
 *   the request that asked for it.
 * @param timer - Clock for charging the fallback against the remaining budget;
 *   injectable so tests stay deterministic.
 */
export async function readAndroidDeviceApiLevel(
  adb: AdbExecutor,
  timeoutMs?: number,
  timer: Timer = defaultTimer,
): Promise<number | null> {
  const extended = adb as AdbExecutor & {
    getAndroidApiLevel?: (timeoutMs?: number) => Promise<number | null>;
  };
  // Single deadline for the whole read. The fallback is charged against what is
  // LEFT after the primary probe, never a fresh full budget.
  const deadline = timeoutMs === undefined ? undefined : timer.now() + timeoutMs;

  try {
    // The budget must reach BOTH branches. Production AdbClient takes this
    // extended path, so leaving it unbounded reproduces the append-path wedge
    // the fallback's timeout exists to prevent: a stalled getprop holds the
    // daemon's per-device queue for as long as the subprocess lives.
    if (typeof extended.getAndroidApiLevel === "function") {
      const fromClient = await extended.getAndroidApiLevel(timeoutMs);
      if (fromClient !== null && fromClient !== undefined) {
        return fromClient;
      }
    }

    // The primary probe (real AdbClient) already ran a getprop and may have spent
    // the whole budget on a timeout. Charging the fallback the FULL original
    // timeout would let a stalled device hold its answer — and the daemon's
    // per-device queue — for ~2x the request deadline. Charge the remainder
    // instead, and when nothing is left, skip the re-probe entirely: re-probing a
    // device that just timed out is unlikely to succeed and only extends the hold.
    let fallbackTimeoutMs = timeoutMs;
    if (deadline !== undefined) {
      const remaining = deadline - timer.now();
      if (remaining <= 0) {
        return null;
      }
      fallbackTimeoutMs = remaining;
    }

    const r = await adb.executeCommand(
      "shell getprop ro.build.version.sdk",
      fallbackTimeoutMs,
      undefined,
      true,
    );
    const n = parseInt(r.stdout.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch (error) {
    // getprop can fail if the device disconnects mid-command; null lets the caller fall back to another detection path.
    logger.debug(
      `src/utils/android-cmdline-tools/readAndroidDeviceApiLevel.ts fallback failed: ${error}`,
      error,
    );
    return null;
  }
}
