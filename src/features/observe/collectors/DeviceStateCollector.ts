import { logger } from "../../../utils/logger";
import { NoOpPerformanceTracker, PerformanceTracker } from "../../../utils/PerformanceTracker";
import { appendObserveError } from "../ObserveError";
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

  async collectActiveWindow(result: ObserveResult): Promise<void> {
    const { window, timer } = this.opts;
    try {
      const startedAt = timer.now();
      const activeWindow = await window.getActive();
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
