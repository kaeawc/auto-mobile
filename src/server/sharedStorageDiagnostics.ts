import { SHARED_STORAGE_DIAGNOSTIC_TIMEOUT_MS } from "../features/storage/fileTransferTimeout";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { runOutsideRequestContext } from "../utils/AbortContext";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { Timer } from "../utils/SystemTimer";

const LOGCAT_TEXT_LIMIT = 1_500;
export const SHARED_STORAGE_RECYCLE_DEVICE =
  "device unresponsive: recycle this device (startDevice/killDevice) instead of launching the app on it";

export interface SharedStorageDiagnostics {
  collect(adb: AdbExecutor, timer: Timer): Promise<string>;
}

export function sharedStorageAdbErrorMessage(error: unknown): string {
  return errorMessage(error).trim() || "no error output from adb";
}

/** Failure-only probes run concurrently, outside the caller's cancellation and deadline. */
export class AdbSharedStorageDiagnostics implements SharedStorageDiagnostics {
  async collect(adb: AdbExecutor, timer: Timer): Promise<string> {
    return runOutsideRequestContext(async () => {
      const [echo, boot, space, logcat] = await Promise.all([
        this.probe(adb, timer, "shell echo ok"),
        this.probe(adb, timer, "shell getprop sys.boot_completed"),
        this.probe(adb, timer, "shell df /sdcard"),
        this.probe(adb, timer, "logcat -d -t 200"),
      ]);
      const markers = logcat.text
        .split(/\r?\n/)
        .filter((line) => /ANR|FATAL|MediaProvider|am_anr/i.test(line))
        .join("\n")
        .slice(-LOGCAT_TEXT_LIMIT);
      return [
        ...(!echo.ok || echo.text.trim() !== "ok" || !boot.ok || boot.text.trim() !== "1"
          ? [SHARED_STORAGE_RECYCLE_DEVICE]
          : []),
        `echo ok: ${echo.text}`,
        `sys.boot_completed: ${boot.text}`,
        `df /sdcard: ${space.text.slice(0, LOGCAT_TEXT_LIMIT)}`,
        `logcat (ANR/FATAL/MediaProvider/am_anr): ${logcat.ok ? markers || "no matching markers" : logcat.text}`,
      ].join("\n");
    });
  }

  private async probe(adb: AdbExecutor, timer: Timer, command: string) {
    const controller = new AbortController();
    try {
      const result = await raceWithDeadline(
        () =>
          adb.executeCommand(command, {
            timeoutMs: SHARED_STORAGE_DIAGNOSTIC_TIMEOUT_MS,
            signal: controller.signal,
            noRetry: true,
            maxBuffer: 256 * 1024,
          }),
        {
          timer,
          timeoutMs: SHARED_STORAGE_DIAGNOSTIC_TIMEOUT_MS,
          label: `Shared-storage diagnostic adb ${command}`,
          onTimeout: () => controller.abort(),
        },
      );
      return { ok: true, text: result.stdout.trim() || "no output" };
    } catch (error) {
      logger.warn(`[SharedStorage] Diagnostic adb ${command} failed`, error);
      return { ok: false, text: sharedStorageAdbErrorMessage(error).slice(0, LOGCAT_TEXT_LIMIT) };
    }
  }
}
