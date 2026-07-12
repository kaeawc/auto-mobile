import type { AdbExecutor } from "./interfaces/AdbExecutor";
import { logger } from "../logger";


/**
 * Reads `ro.build.version.sdk` from the device, or null if unavailable.
 */
export async function readAndroidDeviceApiLevel(adb: AdbExecutor): Promise<number | null> {
  const extended = adb as AdbExecutor & { getAndroidApiLevel?: () => Promise<number | null> };
  if (typeof extended.getAndroidApiLevel === "function") {
    const fromClient = await extended.getAndroidApiLevel();
    if (fromClient !== null && fromClient !== undefined) {
      return fromClient;
    }
  }

  try {
    const r = await adb.executeCommand("shell getprop ro.build.version.sdk", undefined, undefined, true);
    const n = parseInt(r.stdout.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch (error) {
    // getprop can fail if the device disconnects mid-command; null lets the caller fall back to another detection path.
    logger.debug(`src/utils/android-cmdline-tools/readAndroidDeviceApiLevel.ts fallback failed: ${error}`, error);
    return null;
  }
}
