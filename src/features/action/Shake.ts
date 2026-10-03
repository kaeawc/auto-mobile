import { runWithAbortSignal } from "../../utils/AbortContext";
import { throwIfAborted, awaitWhileRequestIsLive } from "../../utils/toolUtils";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { BaseVisualChange, ProgressCallback } from "./BaseVisualChange";
import { BootedDevice, ShakeOptions, ShakeResult } from "../../models";
import { logger } from "../../utils/logger";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { Timer } from "../../utils/SystemTimer";
import { defaultTimer } from "../../utils/SystemTimer";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosSimulatorControlBackend";
import { IOSCtrlProxyClient } from "../observe/ios";

export class Shake extends BaseVisualChange {
  private shakeTimer: Timer;

  constructor(device: BootedDevice, adb: AdbExecutor | null = null, timer: Timer = defaultTimer) {
    super(device, adb, timer);
    this.shakeTimer = timer;
  }

  async execute(
    options: ShakeOptions = {},
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<ShakeResult> {
    throwIfAborted(signal);
    const perf = createGlobalPerformanceTracker();
    perf.serial("shake");

    const duration = options.duration ?? 1000; // Default 1 second
    const intensity = options.intensity ?? 100; // Default intensity of 100

    if (this.device.platform === "ios") {
      if (resolveIosDeviceKind({ deviceId: this.device.deviceId }) === "physical") {
        perf.end();
        return {
          success: false,
          duration,
          intensity,
          error:
            "shake is not supported on physical iOS devices: XCTest exposes no shake API for real devices.",
        };
      }

      return this.observedInteraction(
        async () => {
          try {
            await perf.track("shakeExecution", async () => {
              const client = IOSCtrlProxyClient.getInstance(this.device);
              throwIfAborted(signal);
              const result = await awaitWhileRequestIsLive(
                client.requestShake(duration + 2000, perf, signal),
                signal,
              );
              if (!result.success) {
                throw new Error(result.error ?? "Failed to shake iOS device");
              }
            });

            logger.info("iOS shake completed");

            return {
              success: true,
              duration,
              intensity,
            };
          } catch (error) {
            throwIfAborted(signal);
            perf.end();
            logger.warn("Failed to execute iOS shake", error);
            return {
              success: false,
              duration,
              intensity,
              error: `Failed to shake device: ${error}`,
            };
          }
        },
        {
          changeExpected: false,
          timeoutMs: duration + 2000,
          tolerancePercent: 0.0,
          progress,
          signal,
          perf,
        },
      );
    }

    return this.observedInteraction(
      async () => {
        try {
          // Start the shake by setting high acceleration values
          await perf.track("shakeExecution", async () => {
            throwIfAborted(signal);
            // Once acceleration is dispatched, always reset it, even on cancellation.
            try {
              await awaitWhileRequestIsLive(
                this.adb.executeCommand(
                  `emu sensor set acceleration ${intensity}:${intensity}:${intensity}`,
                ),
                signal,
              );
              throwIfAborted(signal);
              await awaitWhileRequestIsLive(this.shakeTimer.sleep(duration), signal);
            } finally {
              await this.resetAcceleration();
            }
          });

          logger.info("Shake completed");

          return {
            success: true,
            duration,
            intensity,
          };
        } catch (error) {
          throwIfAborted(signal);
          perf.end();
          logger.warn("Failed to execute shake", error);
          return {
            success: false,
            duration,
            intensity,
            error: `Failed to shake device: ${error}`,
          };
        }
      },
      {
        changeExpected: false, // Shake typically doesn't change UI directly
        timeoutMs: duration + 2000, // Give extra time beyond shake duration
        tolerancePercent: 0.0,
        progress,
        signal,
        perf,
      },
    );
  }
  private async resetAcceleration(): Promise<void> {
    // Cleanup must also escape AdbClient's ambient request signal.
    await runWithAbortSignal(undefined, () =>
      raceWithDeadline(() => this.adb.executeCommand("emu sensor set acceleration 0:0:0", 1000), {
        timer: this.shakeTimer,
        timeoutMs: 1000,
        label: "Reset shake acceleration",
      }),
    );
  }
}
