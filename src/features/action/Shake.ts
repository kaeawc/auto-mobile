import { runWithAbortSignal } from "../../utils/AbortContext";
import { throwIfAborted, awaitWhileRequestIsLive } from "../../utils/toolUtils";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { BaseVisualChange, ProgressCallback } from "./BaseVisualChange";
import { BootedDevice, ShakeOptions, ShakeResult } from "../../models";
import {
  SHAKE_DURATION_MAX_MS,
  SHAKE_DURATION_MIN_MS,
  SHAKE_INTENSITY_MAX,
  SHAKE_INTENSITY_MIN,
} from "../../models/ShakeOptions";
import { logger } from "../../utils/logger";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { Timer } from "../../utils/SystemTimer";
import { defaultTimer } from "../../utils/SystemTimer";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import { IOSCtrlProxyClient } from "../observe/ios";
import { emulatorConsoleReportsFailure } from "../utility/DeviceState";

// Issue #10250 reports this as the emulator's default resting gravity vector.
const FALLBACK_RESTING_ACCELERATION = "0:9.77622:0";

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

    if (!isValidShakeOptions(duration, intensity, this.device.platform)) {
      return {
        success: false,
        duration,
        intensity,
        error: `Shake duration must be an integer from ${SHAKE_DURATION_MIN_MS} to ${SHAKE_DURATION_MAX_MS}ms and intensity must be from ${SHAKE_INTENSITY_MIN} to ${SHAKE_INTENSITY_MAX}.`,
      };
    }

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
          usesObservationForResolution: false,
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
        let restoreError: string | undefined;
        let restoreWarning: string | undefined;
        try {
          // Start the shake by setting high acceleration values
          await perf.track("shakeExecution", async () => {
            throwIfAborted(signal);
            const { acceleration: originalAcceleration, warning } =
              await this.readAcceleration(signal);
            restoreWarning = warning;
            try {
              const result = await awaitWhileRequestIsLive(
                this.adb.executeCommand(
                  `emu sensor set acceleration ${intensity}:${intensity}:${intensity}`,
                ),
                signal,
              );
              throwIfAborted(signal);
              if (emulatorConsoleReportsFailure(result.stdout, result.stderr)) {
                throw new Error(
                  `Emulator rejected shake acceleration: ${[result.stdout, result.stderr].filter(Boolean).join("\n").trim()}. Verify that the emulator supports the acceleration sensor.`,
                );
              }
              await awaitWhileRequestIsLive(this.shakeTimer.sleep(duration), signal);
            } finally {
              restoreError = await this.restoreAcceleration(originalAcceleration);
            }
          });

          if (restoreError) {
            return { success: false, duration, intensity, error: restoreError, restoreError };
          }

          logger.info("Shake completed");

          return {
            success: true,
            duration,
            intensity,
            ...(restoreWarning ? { restoreWarning } : {}),
          };
        } catch (error) {
          throwIfAborted(signal);
          perf.end();
          logger.warn("Failed to execute shake", error);
          return {
            success: false,
            duration,
            intensity,
            error: `Failed to shake device: ${error}${restoreError ? `; ${restoreError}` : ""}`,
            ...(restoreError ? { restoreError } : {}),
            ...(!restoreError && restoreWarning ? { restoreWarning } : {}),
          };
        }
      },
      {
        usesObservationForResolution: false,
        changeExpected: false, // Shake typically doesn't change UI directly
        timeoutMs: duration + 2000, // Give extra time beyond shake duration
        tolerancePercent: 0.0,
        progress,
        signal,
        perf,
      },
    );
  }
  private async restoreAcceleration(acceleration: string): Promise<string | undefined> {
    // Cleanup must also escape AdbClient's ambient request signal.
    try {
      const result = await runWithAbortSignal(undefined, () =>
        raceWithDeadline(
          () => this.adb.executeCommand(`emu sensor set acceleration ${acceleration}`, 1000),
          { timer: this.shakeTimer, timeoutMs: 1000, label: "Restore shake acceleration" },
        ),
      );
      if (emulatorConsoleReportsFailure(result.stdout, result.stderr)) {
        throw new Error(`${result.stdout}\n${result.stderr}`.trim());
      }
      return undefined;
    } catch (error) {
      const message = `Failed to restore pre-shake acceleration: ${error}`;
      logger.warn(message);
      return message;
    }
  }

  private async readAcceleration(
    signal?: AbortSignal,
  ): Promise<{ acceleration: string; warning?: string }> {
    try {
      const result = await awaitWhileRequestIsLive(
        this.adb.executeCommand("emu sensor get acceleration"),
        signal,
      );
      if (emulatorConsoleReportsFailure(result.stdout, result.stderr)) {
        throw new Error("emulator rejected acceleration read-back");
      }
      const acceleration = parseAccelerationReadback(result.stdout);
      if (acceleration) {
        return { acceleration };
      }
      throw new Error("unrecognized acceleration read-back");
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(
        `Could not read pre-shake acceleration; using ${FALLBACK_RESTING_ACCELERATION}`,
        error,
      );
      return {
        acceleration: FALLBACK_RESTING_ACCELERATION,
        warning: `Could not read pre-shake acceleration; restored fallback vector ${FALLBACK_RESTING_ACCELERATION}`,
      };
    }
  }
}

function parseAccelerationReadback(stdout: string): string | undefined {
  const accelerationLines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("acceleration ="));
  if (accelerationLines.length !== 1) {
    return undefined;
  }
  const value = accelerationLines[0].slice("acceleration =".length).trim();
  const components = value.split(":").map((component) => component.trim());
  if (
    components.length !== 3 ||
    components.some((component) => component.length === 0 || !Number.isFinite(Number(component)))
  ) {
    return undefined;
  }
  return components.map((component) => String(Number(component))).join(":");
}

function isValidShakeOptions(duration: number, intensity: number, platform: string): boolean {
  const validDuration =
    Number.isInteger(duration) &&
    duration >= SHAKE_DURATION_MIN_MS &&
    duration <= SHAKE_DURATION_MAX_MS;
  const validIntensity =
    platform === "ios" ||
    (Number.isFinite(intensity) &&
      intensity >= SHAKE_INTENSITY_MIN &&
      intensity <= SHAKE_INTENSITY_MAX);
  return validDuration && validIntensity;
}
