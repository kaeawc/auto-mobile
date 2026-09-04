import { logger } from "../../../utils/logger";
import { NoOpPerformanceTracker, PerformanceTracker } from "../../../utils/PerformanceTracker";
import { appendObserveError } from "../ObserveError";
import { isFocusedSystemUiSurface } from "../Window";
import type { BootedDevice, ObserveResult } from "../../../models";
import type { Window } from "../interfaces/Window";
import type { BackStack } from "../interfaces/BackStack";
import type { Timer } from "../../../utils/SystemTimer";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";

export interface DeviceStateCollectorOptions {
  device: BootedDevice;
  window: Window;
  backStack: BackStack;
  adb: AdbExecutor;
  timer: Timer;
}

/**
 * Collects device-level state into an ObserveResult:
 * wakefulness and back stack. CtrlProxy hierarchy metadata is the normal
 * active-window source; the Window source is retained only for first-run
 * bootstrap, before CtrlProxy is available.
 */
export class DeviceStateCollector {
  constructor(private opts: DeviceStateCollectorOptions) {}

  async collectWakefulness(result: ObserveResult, signal?: AbortSignal): Promise<void> {
    const { adb } = this.opts;
    try {
      const wakefulness = await adb.getWakefulness(signal);
      if (wakefulness) {
        result.wakefulness = wakefulness;
      }
    } catch (error) {
      logger.warn("Failed to get wakefulness state:", error);
    }
  }

  async collectDeviceLock(result: ObserveResult, signal?: AbortSignal): Promise<void> {
    const { adb } = this.opts;
    try {
      const deviceLock = await adb.getDeviceLock(signal);
      if (deviceLock) {
        result.deviceLock = deviceLock;
      }
    } catch (error) {
      // Best-effort observability: a lock read that fails leaves deviceLock
      // unset (the agent simply gets no signal) rather than failing observe.
      logger.warn("Failed to get device lock state:", error);
    }
  }

  async collectBackStack(
    result: ObserveResult,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
  ): Promise<void> {
    const { backStack, timer } = this.opts;
    try {
      const backStackStart = timer.now();
      const backStackInfo = await backStack.execute(perf, signal);
      result.backStack = backStackInfo;
      logger.debug(`Back stack retrieval took ${timer.now() - backStackStart}ms`);
    } catch (error) {
      logger.warn("Failed to get back stack:", error);
      appendObserveError(result, {
        phase: "backStack",
        message: "Failed to retrieve back stack information",
        cause: String(error),
      });
    }
  }

  /**
   * Ground-truth foreground app package from dumpsys (the resumed/focused
   * activity — `adb.getForegroundApp` reads `mResumedActivity` /
   * `mFocusedActivity` / `topResumedActivity`), used to validate that the
   * observed hierarchy actually belongs to the app currently resumed on the
   * device (issue #5867). Best-effort: a failed or absent read returns
   * `undefined`, which the caller treats as "cannot compare" (no false alarm)
   * rather than a mismatch.
   */
  async collectForegroundIdentity(signal?: AbortSignal): Promise<string | undefined> {
    const { adb } = this.opts;
    try {
      const foreground = await adb.getForegroundApp(signal);
      return foreground?.packageName ?? undefined;
    } catch (error) {
      // Best-effort window-identity check: a failed foreground read must not fail
      // the observation, only skip the comparison.
      logger.debug("Failed to get ground-truth foreground app:", error);
      return undefined;
    }
  }

  /**
   * Ground-truth check for a focused SystemUI surface (issue #6078). Reads
   * `dumpsys window` and reports whether `mCurrentFocus` is a package-less
   * SystemUI window (notification shade, quick settings, keyguard, status bar
   * owning focus) — the one signal that `getForegroundApp` (resumed activity)
   * and the accessibility `foregroundActivity` both miss. Best-effort: a failed
   * read returns `false` (treat as "no overlay"), never fails the observation.
   * Only invoked on the overlay-suspicion path, so it adds no cost to an
   * ordinary app-foreground observe.
   */
  async collectFocusedSystemUiSurface(signal?: AbortSignal): Promise<boolean> {
    const { adb } = this.opts;
    try {
      const { stdout } = await adb.executeCommand(
        `shell "dumpsys window"`,
        undefined,
        undefined,
        undefined,
        signal,
      );
      return isFocusedSystemUiSurface(stdout);
    } catch (error) {
      // Connection/read failure must not fail observe; absence of the signal is
      // treated as "no overlay" so attribution falls back to the normal path.
      logger.debug("Failed to read focused window surface from dumpsys:", error);
      return false;
    }
  }

  async collectActiveWindow(result: ObserveResult): Promise<void> {
    const { window, timer } = this.opts;
    try {
      const startedAt = timer.now();
      // Force a fresh read on the bootstrap path. The Window memory/disk cache
      // has no expiry, so a `getActive()` (non-forced) read can serve a frozen
      // record — an empty activityName with a stale `layoutSeqSum` — across a
      // real navigation, which the observe layer would then publish. This path
      // only runs during the lazy-CtrlProxy bootstrap interval (rare), so the
      // extra dumpsys is cheap; the cache must never win over current window
      // state (#6070).
      const activeWindow = await window.getActive(true);
      logger.debug(`Bootstrap active window retrieval took ${timer.now() - startedAt}ms`);
      if (activeWindow) {
        result.activeWindow = activeWindow;
      }
    } catch (error) {
      logger.warn("Failed to get bootstrap active window:", error);
      appendObserveError(result, {
        phase: "activeWindow",
        message: "Failed to retrieve active window information",
        cause: String(error),
      });
    }
  }
}
