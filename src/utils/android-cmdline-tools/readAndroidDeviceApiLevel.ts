import type { AdbExecutor } from "./interfaces/AdbExecutor";
import { logger } from "../logger";


/**
 * Reads `ro.build.version.sdk` from the device, or null if unavailable.
 *
 * @param timeoutMs - Optional bound on the getprop subprocess. Callers running under
 *   a request deadline (e.g. the daemon's append-text path) pass their remaining
 *   budget so a wedged adb cannot outlive the request that asked for it.
 */
export async function readAndroidDeviceApiLevel(
  adb: AdbExecutor,
  timeoutMs?: number
): Promise<number | null> {
  const extended = adb as AdbExecutor & {
    getAndroidApiLevel?: (timeoutMs?: number) => Promise<number | null>;
  };

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
    const r = await adb.executeCommand("shell getprop ro.build.version.sdk", timeoutMs, undefined, true);
    const n = parseInt(r.stdout.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch (error) {
    // getprop can fail if the device disconnects mid-command; null lets the caller fall back to another detection path.
    logger.debug(`src/utils/android-cmdline-tools/readAndroidDeviceApiLevel.ts fallback failed: ${error}`, error);
    return null;
  }
}
