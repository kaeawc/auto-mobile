import { DUMPSYS_MAX_BUFFER } from "../../../utils/android-cmdline-tools/dumpsysLimits";
import { isAndroidPackageRunning } from "../../../utils/android-cmdline-tools/androidProcessState";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../../utils/logger";
import type { Timer } from "../../../utils/SystemTimer";
import type { CachedHierarchy } from "./types";

/**
 * How long a "package is running" answer is reused. A post-tap settle poll reads the hierarchy
 * every 150 ms, and each read used to pull the full `dumpsys activity processes` table (about
 * 460 KB) again (#18902). A package that dies inside this window is caught by the next probe.
 */
export const PACKAGE_LIVENESS_REUSE_MS = 1_000;

/**
 * Whether the package behind a cached hierarchy still has a process. Only a positive probe is
 * reused; a dead package or a failed probe is always asked again.
 */
export class CachedPackageLiveness {
  private lastRunning: { key: string; at: number } | undefined;

  constructor(
    private readonly adb: () => AdbExecutor,
    private readonly timer: Timer,
  ) {}

  async isRunning(
    cachedHierarchy: CachedHierarchy,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const { packageName, userId } = cachedHierarchy.hierarchy;
    if (!packageName || !/^[A-Za-z0-9._]+$/.test(packageName)) {
      return true;
    }
    const key = `${packageName}\0${userId ?? ""}`;
    const now = this.timer.now();
    if (this.lastRunning?.key === key && now - this.lastRunning.at < PACKAGE_LIVENESS_REUSE_MS) {
      return true;
    }
    try {
      const result = await this.adb().executeCommand("shell dumpsys activity processes", {
        timeoutMs,
        maxBuffer: DUMPSYS_MAX_BUFFER,
        noRetry: true,
        signal,
      });
      const running = isAndroidPackageRunning(result.stdout, packageName, userId);
      this.lastRunning = running ? { key, at: now } : undefined;
      return running;
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      // Liveness is best-effort; an ADB error must not destroy otherwise usable
      // cache state when process presence could not be determined.
      logger.debug(
        `[CTRL_PROXY] Could not verify cached package ${packageName} is running: ${error}`,
      );
      return true;
    }
  }
}
