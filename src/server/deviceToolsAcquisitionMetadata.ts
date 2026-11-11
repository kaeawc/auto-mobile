import type { DeviceBootResult } from "../devices/deviceBootSelection";
import {
  type DeviceToolsDependencies,
  initializedDevicePool,
} from "../features/deviceLifecycle/core/dependencies";
import { androidSourceImageWithBootedMetadata } from "../features/deviceLifecycle/core/inventory";
import type { DeviceInfo } from "../models";
import { isAndroidEmulatorSerial } from "../utils/androidSerial";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";

// Allow slow host process-table reads while keeping optional metadata bounded.
const ACQUIRED_PROCESS_ID_TIMEOUT_MS = 5_000;
const ACQUIRED_PROCESS_ID_RESPONSE_HEADROOM_MS = 250;

class AcquiredProcessIdTimeoutError extends Error {}

export async function resolveAcquiredProcessId(
  { device, source, processId }: DeviceBootResult,
  avdName: string,
  deps: Pick<DeviceToolsDependencies, "timer" | "androidEmulatorProcessStopper">,
  { deadlineMs, signal }: { deadlineMs: number; signal?: AbortSignal },
): Promise<number | undefined> {
  if (
    source !== "booted" ||
    device.platform !== "android" ||
    !isAndroidEmulatorSerial(device.deviceId)
  ) {
    return processId;
  }
  // Leave response delivery headroom rather than spending the acquisition's final milliseconds.
  const timeoutMs = Math.min(
    ACQUIRED_PROCESS_ID_TIMEOUT_MS,
    deadlineMs - deps.timer.now() - ACQUIRED_PROCESS_ID_RESPONSE_HEADROOM_MS,
  );
  if (timeoutMs <= 0 || signal?.aborted) {
    return undefined;
  }
  const controller = new AbortController();
  const lookupSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const identity = await raceWithDeadline(
      () =>
        deps.androidEmulatorProcessStopper.identify(
          { serial: device.deviceId, avdName },
          { deadlineMs: deps.timer.now() + timeoutMs, signal: lookupSignal },
        ),
      {
        timer: deps.timer,
        timeoutMs,
        signal: lookupSignal,
        label: "Acquired emulator process identification",
        timeoutError: () =>
          new AcquiredProcessIdTimeoutError(
            `Acquired emulator process identification timed out after ${timeoutMs}ms`,
          ),
        onTimeout: () => controller.abort(),
      },
    );
    return identity.kind === "match" ? identity.pid : undefined;
  } catch (error) {
    if (error instanceof AcquiredProcessIdTimeoutError) {
      // Slow process-table reads are expected; optional metadata may safely be omitted.
      logger.info(
        `[DeviceTools] Could not identify the host process for ${device.deviceId}: ${errorMessage(error)}`,
      );
      return undefined;
    }
    logger.warn(
      `[DeviceTools] Could not identify the host process for ${device.deviceId}: ${errorMessage(error)}`,
      error,
    );
    return undefined;
  }
}

export function sourceImageForAcquiredBoot(
  boot: DeviceBootResult,
  androidAvdName: string | undefined,
): DeviceInfo | undefined {
  // A warm AVD has no cold-boot source image, but its explicit getAndroid
  // identifier is still the stable identity needed for later recovery.
  const sourceImage: DeviceInfo | undefined =
    boot.sourceImage ??
    (androidAvdName
      ? { name: androidAvdName, platform: "android", isRunning: true, source: "local" }
      : undefined);
  return androidSourceImageWithBootedMetadata(
    boot.device,
    sourceImage,
    initializedDevicePool()?.getDevice(boot.device.deviceId)?.androidImage,
  );
}
