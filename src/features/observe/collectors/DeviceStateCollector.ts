import { logger } from "../../../utils/logger";
import { NoOpPerformanceTracker, PerformanceTracker } from "../../../utils/PerformanceTracker";
import { appendObserveError } from "../ObserveError";
import type { BootedDevice, ExecResult, ObserveResult } from "../../../models";
import type { ScreenSize } from "../interfaces/ScreenSize";
import type { SystemInsets } from "../interfaces/SystemInsets";
import type { Window } from "../interfaces/Window";
import type { BackStack } from "../interfaces/BackStack";
import type { Timer } from "../../../utils/SystemTimer";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";

export interface DeviceStateCollectorOptions {
  device: BootedDevice;
  screenSize: ScreenSize;
  systemInsets: SystemInsets;
  window: Window;
  backStack: BackStack;
  adb: AdbExecutor;
  timer: Timer;
}

/**
 * Collects device-level state into an ObserveResult:
 * screen size, system insets, rotation, wakefulness, back stack, active window.
 */
export class DeviceStateCollector {
  constructor(private opts: DeviceStateCollectorOptions) {}

  async collectScreenSize(dumpsysWindow: ExecResult, result: ObserveResult): Promise<void> {
    const { screenSize, timer } = this.opts;
    try {
      const screenSizeStart = timer.now();
      result.screenSize = await screenSize.execute(dumpsysWindow);
      logger.debug(`Screen size retrieval took ${timer.now() - screenSizeStart}ms`);
    } catch (error) {
      logger.warn("Failed to get screen size:", error);
      appendObserveError(result, {
        phase: "screenSize",
        message: "Failed to retrieve screen dimensions",
        cause: String(error)
      });
    }
  }

  async collectSystemInsets(dumpsysWindow: ExecResult, result: ObserveResult): Promise<void> {
    const { systemInsets, timer } = this.opts;
    try {
      const insetsStart = timer.now();
      result.systemInsets = await systemInsets.execute(dumpsysWindow);
      logger.debug(`System insets retrieval took ${timer.now() - insetsStart}ms`);
    } catch (error) {
      logger.warn("Failed to get system insets:", error);
      appendObserveError(result, {
        phase: "systemInsets",
        message: "Failed to retrieve system insets",
        cause: String(error)
      });
    }
  }

  async collectRotationInfo(dumpsysWindow: ExecResult, result: ObserveResult): Promise<void> {
    const { timer } = this.opts;
    try {
      const rotationStart = timer.now();
      const rotationMatch = dumpsysWindow.stdout.match(/mRotation=(\d)/);
      if (rotationMatch) {
        result.rotation = parseInt(rotationMatch[1], 10);
      }
      logger.debug(`Rotation info retrieval took ${timer.now() - rotationStart}ms`);
    } catch (error) {
      logger.warn("Failed to get rotation info:", error);
    }
  }

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

  async collectBackStack(
    result: ObserveResult,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal
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
        cause: String(error)
      });
    }
  }

  async collectActiveWindow(result: ObserveResult): Promise<void> {
    const { window, timer } = this.opts;
    try {
      logger.debug("[OBSERVER] collectActiveWindow");
      const windowStart = timer.now();
      const activeWindow = await window.getActive();
      logger.debug(`Active window retrieval took ${timer.now() - windowStart}ms`);
      if (activeWindow) {
        result.activeWindow = activeWindow;
      }
    } catch (error) {
      logger.warn("Failed to get active window:", error);
      appendObserveError(result, {
        phase: "activeWindow",
        message: "Failed to retrieve active window information",
        cause: String(error)
      });
    }
  }
}
