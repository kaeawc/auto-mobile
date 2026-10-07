import { ActionableError, type BootedDevice } from "../models";
import type { PlatformDeviceManager } from "../devices/deviceUtils";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import { DefaultRetryExecutor } from "../utils/retry/RetryExecutor";
import { reconcileDiscoveryObservation } from "./discoveryReconcile";

export async function resolveStreamDevice(
  deviceManager: Pick<PlatformDeviceManager, "getBootedDevices">,
  deviceId?: string,
  platform: "android" | "ios" | "either" = "android",
  timer: Timer = defaultTimer,
  signal?: AbortSignal,
  source = "webrtc-stream-resolve",
): Promise<BootedDevice> {
  // Explicit platforms avoid waiting on the other platform. Legacy video requests use either.
  let candidates = await deviceManager.getBootedDevices(platform);
  // FUNNEL 1, before the caller joins any of this to pooled identity. This can be
  // the first path to observe the `Unknown (<serial>)` placeholder or a different
  // AVD on a reused serial, and without folding it in the admission gate in
  // `handleStart` would re-read the pool state from BEFORE this discovery and
  // admit the stream onto an untrusted runtime
  // ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
  await reconcileDiscoveryObservation(candidates, source);

  if (candidates.length === 0) {
    if (platform === "either") {
      return selectStreamDevice(candidates, deviceId, platform);
    }
    if (platform === "android") {
      throw new ActionableError("No connected android devices found.");
    }
    candidates = await rediscoverStreamDevices(deviceManager, platform, timer, signal, source);
  }
  return selectStreamDevice(candidates, deviceId, platform);
}

function selectStreamDevice(
  candidates: BootedDevice[],
  deviceId: string | undefined,
  platform: "android" | "ios" | "either",
): BootedDevice {
  const scope = platform === "either" ? "" : `${platform} `;
  if (deviceId) {
    const match = candidates.find((device) => device.deviceId === deviceId);
    if (!match) {
      throw new ActionableError(`No connected ${scope}device with id ${deviceId}.`);
    }
    return match;
  }

  if (candidates.length === 0) {
    throw new ActionableError("No connected devices found.");
  }
  if (candidates.length > 1) {
    throw new ActionableError(
      `Multiple connected ${scope}devices; specify deviceId. Found: ${candidates
        .map((device) => device.deviceId)
        .join(", ")}`,
    );
  }
  return candidates[0];
}

async function rediscoverStreamDevices(
  deviceManager: Pick<PlatformDeviceManager, "getBootedDevices">,
  platform: "android" | "ios",
  timer: Timer,
  signal: AbortSignal | undefined,
  source: string,
): Promise<BootedDevice[]> {
  try {
    return await new DefaultRetryExecutor(timer).executeOrThrow(
      async () => {
        const candidates = await deviceManager.getBootedDevices(platform);
        if (candidates.length === 0) {
          throw new Error(`No connected ${platform} devices found.`);
        }
        await reconcileDiscoveryObservation(candidates, source);
        return candidates;
      },
      { delays: [250, 500, 1000, 2000], maxAttempts: 5, signal },
    );
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    throw new ActionableError(`No connected ${platform} devices found (after 5 attempts).`);
  }
}
